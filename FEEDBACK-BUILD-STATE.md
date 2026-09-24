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
   **Every route must gate itself** — this remains the single most important auth fact here.
   *Updated 2026-09-21 (`9224f6d`, deployed):* `isPublic()` now has a **hard `/api/` floor** —
   `if (pathname.startsWith('/api/')) return false;` — so the print and file-extension patterns below
   it can no longer make an API route public. The old `pathname.includes('/print')` substring (which
   had exposed 7 API routes as publicly routable **and CSRF-exempt** — not 14, it needed a leading
   slash) is gone, replaced by four anchored page regexes. So a `print` substring in a new API path is
   no longer fatal, but **still avoid it**: the four public print PAGES are matched by pattern, and
   `isPublic()` returns *before* the `page_access` check.
   CSRF = cookie `fnb_csrf` + header `x-csrf-token`; **add this module's API prefix to
   `CSRF_REQUIRED_PREFIXES`** or every write is forgeable. *(Bill Handover shipped without that line
   and a POST with no CSRF header reached app code — measured.)*
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

✅ **THE GRE ROLE EXISTS AND IS ASSIGNED — production data, supplied by the owner 2026-09-21.**
This supersedes every earlier note in this file that said otherwise, and it supersedes the local
snapshot, which is badly out of date (it holds 9 users, all unassigned; production holds **36**).

| role | base_role | active | can_disc | max_pct | users_assigned |
|---|---|---|---|---|---|
| Administrator | admin | 1 | 1 | 100 | 2 |
| Bar Manager | manager | 1 | 0 | 0 | 1 |
| Captain | staff | 1 | 0 | 0 | 4 |
| Cashier | staff | 1 | **1** | 10 | 1 |
| **Floor Manager** | manager | 1 | 0 | 0 | **0** |
| **GRE** | **staff** | **1** | **0** | 0 | **4** |
| HR | manager | 1 | 0 | 0 | 2 |
| Head Chef | manager | 1 | 0 | 0 | 4 |
| Manager | manager | 1 | 1 | 30 | 1 |
| Staff | staff | 1 | 0 | 0 | 8 |
| Store Manager | manager | 1 | 0 | 0 | 1 |

**The gate is satisfied on every count:** name is exactly `GRE`, `base_role` is `staff` (so it does
NOT inherit the manager-tier powers — void, settle, hold, service-charge waiver), it is active, and
**`can_request_discount = 0`**, so `discount/route.ts:62` refuses it.

**The four GREs:** Bharath · Nisha Sharma · Pushpa · Swetha — all `tier: staff`.

⚠️ **CORRECTIONS THIS DATA FORCES — do not repeat the old claims:**
- "`role_id` is NULL for all 9 users" was true only of the **stale local snapshot**. In production
  **28 of 36 users carry an assigned role**. The named-role gate therefore **does fire**.
- It follows that "cashiers have never been able to print" is **FALSE in production**: Kishore holds
  `Cashier`, so `auth.ts:184`'s `role_name === 'Cashier'` branch evaluates true for them.
- There is an **`HR`** role (manager, 2 users) that does not exist in the local snapshot at all.
- **`Floor Manager` has ZERO users.** The spec says "GRE or Floor Manager", but nobody holds Floor
  Manager today, so GRE is the entire real audience. Keep Floor Manager in the allow-list, but do
  not rely on it for testing.
- **8 users still carry no role** (3 admins, 3 managers, 2 staff). They fall back to `users.role`,
  so the null-role path is still a REAL state worth testing — just not the only one.

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
| P2 | Page 1 Floor Feedback + the READ-ONLY guarantee, proved server-side | **DONE (A + B)** | §6 2026-09-22: GET-only routes (405 with CSRF, 403 without), 40 reads → census identical, 6-persona gate, all 5 statuses live, `tunable()` zero-default bug fixed, tsc 0. **Part (B) IS NOW APPLIED** — one prefix deny at ONE boundary (`src/lib/feedback/pos-readonly.ts` + `src/proxy.ts`), zero POS route handlers edited, 23/23 forbidden writes refused for an assigned GRE, 115/115 non-GRE writes untouched. **Lane B (read/board/catalog) closed its three HIGHs + 7 MEDIUMs** — elapsed proved against a known instant, a business-day exit for the never-settled order, tier flags proved per persona; 120 reads → census identical. **Probe `the-gre-is-denied` (2026-09-22, port 3954, no code changed): 87/87 state-changing POS requests refused against REAL rows with zero writes, the same requests measured WRITING for six other personas — but the claim is falsified once, by `POST /api/crm-calls/bookings/[id]/seat`, which opens/edits an order for any signed-in user (§6, §7 items 6-7).** **Probe `floor-managers-and-null-role` (2026-09-23, port 3955, no code changed): the deny is INERT in the null-role state and switches on and off with the assignment (0/27 → 26/27 → 0/27 on ONE login); 162 HTTP lines and a 33,407-line dump of all 217 tables are BYTE-IDENTICAL between the deny build and the deny reverted, for the Floor Manager and all three null-role tiers; the Page-1 truth table and the elapsed clock both pass. 🛑 But a **Floor Manager gets 403 on all four pages** while the API hands them the board — §6, and it is a config blocker, not a code one.** |
| P3 | Page 2 Take Feedback + item-level complaints + action + follow-up lifecycle | PENDING | |
| P4 | Page 3 Feedback Tracker + coverage | **LANE A DONE** | §6 2026-09-23: `GET /api/feedback/tracker` built (GET-only, 403 without CSRF / 405 with a valid pair, 40 reads → census identical), Page 3 reads it and the placeholder import is gone, and **the door is open** — a Floor Manager / Bar Manager / Head Chef / Store Manager now gets 200 on pages 1-3 where the same build without the one-line change gives 403 on all four (control run, every other row byte-identical). Analytics stays 403 for a GRE. tsc 0. |
| P5 | Page 4 Analytics + the 8 reports | **LANE C + LANE B DONE** | §6 2026-09-24: the CRITICAL is closed — a person filter now moves **4 payload paths (`filters.gre` · `person` · `meta.counts_scope` · `meta.person_filter_active`) instead of 13**, and the flip (records honestly vs records "everything good") leaves the person-filtered page BYTE-IDENTICAL to the unfiltered one in both worlds. Page 3 and Page 4 agree (`11/8/72.7%` both, was `12/9/75.0%` vs `11/8/72.7%`) including the new floor denominator and the per-person Tables/Taken columns. The workbook no longer contradicts itself (`Feedbacks recorded 9 = Rating split 9`, was `8` vs `9`). PDF menu names: **628 of 628 printed strings distinct**, was 58 names collapsing into 28 rows. 37 reads incl. all 16 downloads → DB byte-identical. tsc 0. **NO SERVER WAS BOOTED.** **LANE B (export/PDF half, independent second measurement, 2026-09-24):** the three HIGHs re-proved with controls — Page 3 vs Page 4 `7/5/71.4%` both, and reverting only the numerator restores the brief's exact pair `8 eligible/75.0%` vs `7/71.4%`; 184 workbook assertions across 8 reports x 4 filter states, 0 contradictions; 628 of 628 menu names print distinct (widening ALONE still left 22 colliding, so the label pass is load-bearing). **Then four defects nobody had measured, all only visible at the owner's real 292-table scale:** `Their floor` printed `188/188 1…` for a GRE who covered EVERY table on her floor (a truncated percentage inverts its meaning — proved in two real rendered PDFs), `Recovery` the same past 100 complaints, 4 KPI subs cut mid-word (one losing the word PRINTED, one losing the sentence that reconciles the Summary against the Rating split), and the venue's open-follow-up count printed on a named person's card. Exhaustive audit: **36,365 rendered strings, 0 truncated, 0 ambiguous** (control at `f83b30b`: 88). tsc 0. **NO SERVER WAS BOOTED.** |
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

- **2026-09-22 — P2 Lane A (Page 1 Floor Feedback + the READ rail).** New:
  `src/lib/feedback/read.ts` (SELECT-only), `src/lib/feedback/session.ts` (the server gate),
  `src/app/api/feedback/floor/route.ts`, `src/app/api/feedback/order/[orderId]/route.ts`; rewritten
  `src/app/feedback/page.tsx` (fixtures gone). Concurrent-lane note: Lane B had already moved the
  gate to `src/lib/feedback/access.ts` with a richer `feedbackAccess()` decision — **my own
  `feedback-gate.ts` was deleted rather than shipped as a second gate**, and `session.ts` only
  adapts the session to that one authority (it adds `roles.is_active`, which `getCurrentUser()`
  never reports, so a DEACTIVATED GRE role can no longer keep granting).
  - 🐞 **DEFECT FOUND AND FIXED IN THE SHARED MODULE — `tunable()` in `src/lib/feedback.ts`.** It
    read `Number(String(raw ?? '').trim())`, and `Number('')` is `0` — finite and ≥ 0 — so an
    **absent key returned 0, never the fallback**. This was the `captain_area_lock` failure the
    section's own comment was written to prevent, and it was LIVE: `feedback_item_threshold`
    resolved to 0, so `item_count >= 0` made every table instantly **Feedback Due** (0-item tables
    included) and **Not Ready was unreachable**; `feedback_settled_grace_minutes` resolved to 0,
    which the board reads as *grace disabled*, so a table settled one minute ago vanished.
    Measured before → `item_threshold 0 · grace 0 · counts {all 11, due 8, not_ready 0}`;
    after → `item_threshold 4 · grace 30 · counts {all 12, due 5, issue 1, taken 1, follow_up 1,
    not_ready 4}`. The blank check now precedes the numeric parse.
  - 🐞 **SECOND TRAP CLOSED — timestamps.** `orders.created_at` is `datetime('now')` →
    `2026-08-11 19:05:14` (UTC, space, no `Z`), and V8 parses that space form as **local** time:
    `Date.parse` lands 5 h 30 m early in IST, so a table open 10 min would have rendered **"5h 40m"**.
    Every stamp now leaves the API through `sqlUtcToIso()` (the same repair `bill-pdf.ts:32` and
    `central-cutover.ts:164` already use); the client never sees the raw column.
  - **READ-ONLY, PROVED TWICE.** Both route files export `GET` **and nothing else**, over a library
    with zero SQL writes. Measured on the booted server: POST/PUT/PATCH/DELETE on both routes → **403**
    (CSRF, the `/api/feedback` prefix is armed) and → **405** once a valid double-submit pair is
    supplied, i.e. the route genuinely has no such handler. 40 authenticated reads left the census
    byte-identical (`orders 48 · order_items 84 · gf_visits 3 · settings 64 · Σquantity 123`),
    `integrity_check ok`, `purchases=2165 raw_materials=952`. The ordered-items read is the module's
    OWN narrow SELECT — never a proxy to `/api/dine-in/orders/[id]`, the file that also exports the
    `PATCH` carrying add_item/set_qty/remove_item/fire — and it returns **no money at all** (keys:
    id, name, quantity, station, group, station_recognised, kitchen_status, fired_at, served_at,
    created_at).
  - **THE GATE FAILS CLOSED, measured across six personas** on `GET /api/feedback/floor`:
    no session → **401**; `role_id` NULL → **403 `no_role_assigned`**; Captain role → **403
    `role_not_gre`**; `users.section = 'GRE'` with no role → **403** (section is a hint, never a
    grant); assigned **GRE** role → **200** `scope: gre, read_only: true`; Floor Manager → **200**
    `scope: management`; Admin → **200** `scope: admin`. Every refusal carries `what_to_do`, printed
    verbatim on screen, and it says CREATING the role is not ASSIGNING it.
  - **Eligibility on real columns, all five statuses reachable:** `not_ready 4 · due 5 · taken 1 ·
    issue 1 · follow_up 1`. Triggers fire independently — a 2-item table went Due on
    `bill_requested_at`; a 5-item table went Due on `COUNT(order_items) >= 4`; a settled table
    5 min old stayed on the board (grace) while one 200 min old did not; a voided order with 6 items
    AND a bill request never appeared. Threshold proved administrable with **no write route in this
    module**: admin `PUT /api/settings {feedback_item_threshold: 6}` → 200 moved a 5-item table
    Due → Not Ready; the same PUT from a staff login → **403**.
  - **Food vs Drinks** resolves through `BAR_STATIONS` (not `station_departments`, whose Bar mapping
    lacks beer/wine/beverage). Unrecognised stations are **reported, never dropped**:
    `meta.unclassified = [{'(blank)': 4}, {'zz-unknown-station': 1}]` with the reason string on
    screen, and per-item a `?` marker — they land in Food because the shipped KDS rule says every
    non-bar station is Kitchen. `meta.excluded` likewise counts what is off the board
    (`takeaway_or_other 5 · table_row_missing 3`) instead of silently shrinking coverage.
  - **Floor = `restaurant_tables.zone`**, with `''` bucketed to `'Floor'` exactly as
    `captain-area.ts:30` does — proved live (`floors: ['Floor','Ground Floor','Rooftop']`). No filter
    was built on `section` (0/3 populated; it would have shipped dead).
  - **Ordering is the SERVER's** and the page only filters: `follow_up → due → issue → taken →
    not_ready`, and inside a group the guests who are about to leave (bill requested/printed) before
    the rest, then oldest-open first.
  - ⚠️ **OWNER ACTION, found while testing:** the `Floor Manager` role carries an explicit
    `page_access` list that does NOT contain `/feedback`, so that login gets **200 from the API and
    403 on the page**. Any role the owner expects to open this module — the production **GRE** role
    included — needs `/feedback` in its page list, or the page 403s while the gate says yes.
  - `npx tsc --noEmit` exit **0**. ⚠️ Port 3921 was assigned but Next 16.2.2 refuses a second dev
    server in one directory and this worktree already had Lane B's on 3922; once that one exited,
    3921 booted and every measurement above is from it. Killed at end of lane.
  - Fixtures live in the worktree DB only, every id prefixed `gfqa-` (7 tables, 11 orders, 49 items,
    3 visits, 6 sessions, 5 users, and a local `GRE` role mirroring production). Remove with
    `DELETE ... WHERE id LIKE 'gfqa-%'`.
  - ✅ The `src/app/feedback/enums.ts` duplication flagged by P1 is **already gone** — that file no
    longer exists; `placeholder.ts` imports its types from `@/lib/feedback`.
  - ⚠️ **NEW RESOLUTION TRAP:** `src/lib/feedback.ts` and `src/lib/feedback/` now both exist. TS and
    Node try the FILE first, so `@/lib/feedback` is always `feedback.ts` and a
    `src/lib/feedback/index.ts` would be **silently unreachable — never create one**. Deep paths
    (`@/lib/feedback/access`, `/read`, `/session`) are unambiguous; the carve grep
    `src/lib/feedback` still matches both spellings.

- **2026-09-22 — P2 Lane A part (B): THE POS DENY IS APPLIED.** New `src/lib/feedback/pos-readonly.ts`;
  `src/proxy.ts` hunk; comment repair in `src/lib/feedback/access.ts`. **Zero POS route handlers were
  edited** — the owner's read-only rule is ONE list and ONE test at ONE boundary.
  - **Where it lives.** `POS_WRITE_PREFIXES` = `/api/dine-in/orders` · `/customer-orders` · `/kds` ·
    `/discount-requests` · `/tables`. PREFIXES, not routes, so the next POS write route inherits the
    denial. `isPosWritePath()` is ANCHORED (`p === path || path.startsWith(p + '/')`), never
    `includes()` — `isPublic()`'s `'/print'` substring is the standing proof. The hunk sits INSIDE
    proxy step 2c, the block that already ran one query for every state-changing API call: the SELECT
    is merely widened with `LEFT JOIN roles`, so **no new query**. The actor mirrors
    `getCurrentUser()` (auth.ts:113-126) field for field.
  - **PROVED, as the assigned GRE (port 3951): 23 of 23 state-changing POS requests → 403
    `feedback_read_only`.** All six powers, including the two doors a per-handler fix forgets:
    `POST /api/dine-in/orders/replay` and `POST /api/dine-in/customer-orders/[id]`. Measured that
    both were open to a staff GRE before (`if (!me) return 401` and nothing else), as were
    `PATCH /api/dine-in/orders/[id]` (add_item·set_qty·remove_item·fire), print-bill and request-bill.
  - **A KDS BUMP IS AN INVENTORY WRITE, and it is covered.** `/api/dine-in/kds/[id]/bump` runs the
    deferred recipe consume (`kot-completion.ts`), stamping `order_items.recipe_deducted_at` and
    deducting raw-material stock — irreversible by design ("never clear recipe_deducted_at"), and it
    also locks the order out of being voided. Its own gate let a GRE through: the section test is
    `!privileged && me.section && …` and `users.section` is `''` for every user, so it never fires.
  - **CHANGED NOTHING FOR ANYONE ELSE: 115 of 115** state-changing POS requests across Captain,
    staff-with-no-role, section='GRE'-with-no-role, Floor Manager and Admin returned the HANDLER's own
    answer (404 · 400 · 403 "Manager role required" · 500 FK) and **0** returned `feedback_read_only`.
    `canWorkTable()` and the KDS section gate were left inert exactly as found. Six non-dine-in write
    families (vendors, requisitions, wastage, crm-calls, hr, kitchen-production) answer identically
    for all three personas, and step 2c still 401s a forged and a cookie-less token.
  - **Reads are untouched:** a GRE still gets 200 on `GET /api/dine-in/orders · /tables · /kds ·
    /customer-orders` and on `/api/feedback/floor`, and `POST /api/dine-in/service-requests/[id]`
    reaches the handler — answering the table's bell is the GRE's job and is DELIBERATELY not in the
    list.
  - 🐞 **DEFECT FOUND AND FIXED IN THE DESIGN ITSELF — deactivating the role was an ESCALATION.**
    `isNamedGre()` refuses to match a deactivated role (right for a GRANT, which only removes pages).
    Inherited by a DENY it meant: `UPDATE roles SET is_active=0` → the GRE lost the feedback pages
    **and got the POS back** — measured, `PATCH /api/dine-in/orders/zz-nope` → 404 (through to the
    handler). That is the very escalation `auth.ts:104-107` documents. `isPosReadOnlyActor()` now asks
    the same authority with the tri-state set to "not looked up", so the deny survives the role being
    switched off (re-measured: 403 on all four probes) while access still refuses (page → 403). No
    second copy of the role name or the management carve-out.
  - **WHICH WAY IT ERRS: toward ALLOWING.** Unresolved session, no role, wrong role, unreadable
    database → `false` → the POS write proceeds to the handler's own gate. A DB error cannot leak a
    write, because every POS handler opens with `getCurrentUser()` on the same `getDb()`.
  - **NOT COVERED, on purpose:** `/api/dine-in/service-requests` (the GRE's own job);
    `/api/dine-in/cashier-presence` and `/stale-tables` (already refuse a GRE on their own —
    `tillCapable()` and a manager tier); `/api/dine-in/offline-print`, `/print-agent`, `/kot-alerts`
    (counter-PC plumbing, not the six); every GET (the owner allows viewing); and every non-POS module
    (`/api/tasks`, `/api/crm-calls`, … — a GRE keeps their normal app). Also NOT covered: anything that
    does not pass through the proxy — a direct DB edit, or a future POS write placed outside
    `/api/dine-in/*`.
  - `npx tsc --noEmit` exit **0**, zero output. A 13-persona × 17-path predicate suite passes
    (`refusePosWrite` false for Captain · Cashier · Floor Manager · Manager · HOD · Admin · no-role ·
    section-only · null · string · array · GRE-with-manager-tier). Census excluding the `gfqa-`
    fixture namespace: orders 37→37, order_items 35→35, restaurant_tables 3→3, Σqty 61→61,
    `recipe_deducted 0→0`, `purchases 2165`, `raw_materials 952`, `integrity_check ok`. (The 28 `gfqa-`
    rows that did appear are a CONCURRENT LANE's fixtures written straight into SQLite — every one has
    an empty `server_id`, which an API-created order never has.) Server on 3951 killed, port free; the
    owner's own preview on 3001 untouched.

- **2026-09-22 — P2 Lane B (the read rail, the board, the catalog: closing what P2 left open).**
  Files: `src/lib/feedback/read.ts`, `src/app/feedback/page.tsx`, `src/app/feedback/take/page.tsx`,
  `src/app/feedback/ui.tsx`. `src/lib/page-catalog.ts` needed **no change** — see (3). Nothing in
  `src/proxy.ts` or `pos-readonly.ts` was touched (Lane A's).

  - ⚠️ **AN ENVIRONMENT TRAP THAT WILL COST THE NEXT LANE AN HOUR.** The dev server in this worktree
    had been up 8 h across a machine SLEEP (the wall clock jumped ~7 h50 m mid-session), and its
    Turbopack **file watcher was dead**: it kept serving a module compiled hours earlier and silently
    ignored every edit. It was not obvious — the route still answered 200 with fresh DB data, so only
    the *code* was stale. Diagnose it in one shot: add a throwaway literal to a route's JSON response,
    curl it, and see whether the field appears. Lane A's server also held the per-directory dev lock
    (*"Another next dev server is already running"*), so the fix was an **isolated run copy**:
    `rsync` of `src/` into the scratchpad + `rsync -a --link-dest` for `node_modules` (hardlinks, no
    extra disk — same inode proved) + `VACUUM INTO` for the DB, then `next dev -p 3952` there. A
    watcher under `/private/tmp` does not fire either, so **restart that server after every edit**.

  - 🐞 **(1) HIGH — TIMESTAMPS, now proved against a known instant, and the CLIENT half closed.**
    `sqlUtcToIso()` (server) was already correct and is unchanged; what was missing was any defence on
    the *reading* side, and Pages 2-5 are still to be written against the same columns. `elapsed()` in
    `ui.tsx` was `Date.parse(fromIso)` + a finite check — which **accepts** the raw SQLite form and
    renders a confidently wrong number. New `zonedMs()` requires an explicit zone (`T` plus `Z`/`±HH:MM`);
    anything else is `NaN` and the card shows `—`. Measured with the shipped source extracted verbatim
    from `ui.tsx` (byte-identity asserted) and run under `TZ=Asia/Kolkata`:
    opened `2026-08-11 19:05:14` UTC, now `19:15:14` UTC ⇒ truth **10m**;
    OLD code on the raw column → parsed as `13:35:14Z` ⇒ **"340m"** (5 h 40 m, the lie);
    NEW code on the raw column → **"—"**; NEW code on the repaired ISO → **"10m"**. 12/12 cases pass
    (`Z`, fractional `Z`, `+05:30`, `+0530` all 10m/9m; space form, zone-less `T`, bare date, blank,
    null, junk all `—`; 65 min → `1h 05m`; a future stamp clamps to `0m`).
    Server half, end to end: raw column `2026-09-22 10:27:28` → API `2026-09-22T10:27:28Z` →
    **epoch 1790072848000**, identical to reading the column as UTC; the same string parsed unrepaired
    on an IST box is epoch 1790053048000 — **330 minutes apart**.
    Also re-measured: **100 % of the five timestamp columns this module reads are the space form with
    no fractional seconds** (0 ISO, 0 `%f`), so `sqlUtcToIso()` has no unhandled shape today.

  - 🐞 **(2) HIGH — THE NEVER-SETTLED ORDER NOW HAS AN EXIT** (`read.ts` §6, new). The board had an
    exit for `settled` (grace) and `void` (the WHERE) and **none for `open`** — and `stale-tables.ts`
    measured eleven such orders on the live database, one idle 765 hours. **The rule chosen:** a
    still-`open` order leaves the board when its **LAST ACTIVITY falls before the start of the current
    business day**, where the business day is the owner's existing `hr_day_cutoff` convention
    (default `04:00`) via HRMS's own `businessDateOf()` — no new settings key. Last activity is
    `MAX(last item punched, opened, bill requested, bill printed, settled)`, i.e. `stale-tables.ts:110`'s
    definition widened by the two bill stamps. Four deliberate non-properties: **it writes nothing**
    (no void, no settle — `stale-tables.ts` is explicit that a table WITH ITEMS must never be closed by
    a timer, and this does not); **it does not touch settled rows** (a table settled 03:59 IST would
    otherwise vanish 6 min into a 30-min grace); it is not measured from `created_at`; and it **does
    not close a complaint** — `gf_follow_ups` is untouched and the Tracker still carries it.
    Guarded: `hr_day_cutoff` is honoured **only as a NIGHT rollover (00:00–07:59)**, because HR may
    legitimately set `09:00` for payroll and a `20:00` value would blank the floor board mid-service.
    Measured on the booted server, two orders identical but for **60 minutes**:
    `QA203` last activity `04:30 IST` (30 min AFTER rollover) → **on the board, `due`**;
    `QA204` last activity `03:30 IST` (30 min BEFORE) → **not on the board**. Both carry 5 items, so
    both would be `due` if kept — the drop is the day rule, not ineligibility. Move the cutoff to
    `03:00` and `QA204` returns (`stale_open_order` 8→7, `due` 4→5); set `09:00` or `2500` and it falls
    back to `04:00` with `board_cutoff_source: "default"`.
    Nothing is hidden: `meta.excluded` gained `stale_open_order` (8) and `stale_with_open_issue` (1),
    the second rendered as its own violet banner naming the unresolved complaint. Every exclusion
    reconciles exactly against SQL: 14 stale open orders = 4 takeaway + 2 table-row-missing + **8**.
    After 20 board reads the four stale orders were still `open`, `voided_at` NULL,
    `auto_close_reason` NULL; `gf_visits.open_follow_ups` still 1.

  - ✅ **(3) HIGH — THE FOUR CATALOG FLAGS ARE RIGHT, and are proved per persona, not asserted.**
    `/feedback`, `/feedback/take`, `/feedback/tracker` carry `greOnly`; `/feedback/analytics` carries
    `mgmtOnly`; `bestEntry()` is longest-prefix so `/feedback/analytics` does NOT inherit `greOnly`,
    and `/feedback/take/<orderId>` DOES inherit it. Both gates run **before** the null-map
    backward-compat grant. **No code change was required.** Measured over HTTP, page by page
    (`307→login` / `403` / `200`):

    | persona | /feedback | /take | /take/&lt;id&gt; | /tracker | /analytics |
    |---|---|---|---|---|---|
    | no session | 307→login | 307→login | 307→login | 307→login | 307→login |
    | **null page_access map, no role** | **403** | **403** | **403** | **403** | **403** |
    | `users.section = 'GRE'`, no role | 403 | 403 | 403 | 403 | 403 |
    | Captain role | 403 | 403 | 403 | 403 | 403 |
    | **GRE role (assigned)** | **200** | **200** | **200** | **200** | **403** |
    | Manager role (null map) | 200 | 200 | 200 | 200 | 200 |
    | Administrator | 200 | 200 | 200 | 200 | 200 |

    The second row is the point: the backward-compat grant opens every *unflagged* page to a null-map
    user and it opens **none of these**. **Which way it errs, stated plainly:** with no role assigned
    the answer is **NO** (403 + the "creating the role is not assigning it" remedy, printed verbatim on
    screen), and with the role assigned the answer is YES — so the module is correct in both worlds,
    and the failure mode before assignment is a refusal that *explains itself*, never a silent grant
    and never a blank board. §2 now records that production has already assigned it to four people;
    the null-role path is still real for the 8 users who carry no role. The fifth row is the fairness ruling holding — a GRE is denied
    the league table. `GET /api/feedback/floor` agrees for all seven (401 · 403 `no_role_assigned` ·
    403 `no_role_assigned` · 403 `role_not_gre` · 200 `scope=gre read_only=true` · 200
    `scope=management` · 200 `scope=admin`).
    ⚠️ **Floor Manager is 403 on all four pages while its API says 200** — re-measured and now
    *diagnosed*: it is **role `page_access` config, not the catalog**. `Floor Manager` carries an
    explicit `page_access` list with **no `/feedback` entry**, so `canAccessPage`'s last line refuses
    — the four flag gates above never get a say. Proof: a fixture user on the existing **`Manager`**
    role (`page_access` NULL) gets **200 on all four**.
    🛑 **THIS IS NOW A FOUR-PERSON BLOCKER, NOT A FOOTNOTE.** §2 records that production has **4 users
    assigned the `GRE` role** (Bharath · Nisha Sharma · Pushpa · Swetha) and **0 on Floor Manager**, so
    GRE is the entire real audience. The gate and the API will say yes to all four — and if the
    PRODUCTION `GRE` role carries an explicit `page_access` list, every one of them still gets **403 on
    the page**. It happens to work on the local snapshot only because that copy's GRE row has
    `page_access` NULL; §2's production table does not report the column, so this is **unverified in
    production**. **OWNER ACTION, before this is useful to anybody:** in Settings → Roles, confirm the
    `GRE` role grants `/feedback`, `/feedback/take` and `/feedback/tracker` (leave `/feedback/analytics`
    off — `mgmtOnly` refuses a GRE anyway). Same for any manager role expected to open the module.

  - **MEDIUMs closed (4 of them were live lies on screen):**
    1. `/feedback/take` was still rendering **seven invented tables with invented order ids** from
       `placeholder.ts` behind a "P1 SHELL" note. On a coverage module that is not a harmless stub —
       tapping one routes to `/feedback/take/<id that does not exist>`, and "3 tables waiting" on a
       quiet night is the opposite of the truth. It now reads the same `GET /api/feedback/floor`,
       filtered to `due` + `follow_up`, with the same verbatim refusal card. Proved: `FLOOR_TABLES`
       gone from the file, `api('/api/feedback/floor')` present, and the SSR HTML contains **0**
       occurrences of any of the six fixture table labels (2 · 4 · 7 · 9 · 11 · 12) and no `P1 SHELL`.
    2. **The status chips counted the whole venue while the grid showed one floor.** Pick "Rooftop" and
       the chips read `All · 8` above 4 cards — on the numbers a GRE is measured by. Counts are now
       derived from exactly the rows the grid draws. Proved by extracting the three `useMemo` bodies
       **verbatim** from `page.tsx` (byte-identity asserted) and running them over a live payload:
       all=8/8 rows, Ground Floor=4/4, Rooftop=4/4 — AGREE on every floor. The server's *ranking* is
       still the server's; only the tally is local.
    3. **The floor `<select>` silently reset.** `meta.floors` is derived from the tables on the board,
       so a floor vanished from the options the moment its last table settled — and a `<select>` whose
       value is not among its options renders the FIRST option, moving the GRE to "All floors" without
       saying so. The selected floor is now kept, labelled `Rooftop (none open)`.
    4. **A typed `0` in `feedback_item_threshold` re-created the exact bug P2 fixed.** `tunable()`
       accepts any value ≥ 0, so `0` makes `item_count >= 0` true for every row — a table with nothing
       on it becomes "Feedback Due" and `Not Ready` becomes unreachable. New `MIN_ITEM_THRESHOLD = 1`
       clamps it and `meta.item_threshold_clamped` says so on screen. Measured:
       absent→4 · `'0'`→**1 clamped** · `'1'`→1 · `'4'`→4 · `'6'`→6 (due 4→2, not_ready 1→3) ·
       `'-3'`→4 · `'abc'`→4. A 0-item open table (`QA112`) stays **`not_ready`** at every setting.
    5. **`item_threshold_is_default` lied for an unusable value.** Storing `'abc'` fell back to 4 but
       dropped the "(default)" marker, so the footer read "becomes Feedback Due at 4 items" as if the
       admin's value had taken effect. `usable()` now means *stored AND parseable*: `'abc'`/`'-3'` →
       `is_default=true`, `'4'` → false, `'0'` → false + `clamped=true`.
    6. **`board_cutoff_source` claimed a provenance the settings table did not have** —
       `getHrDayCutoff()` returns `'04:00'` for an absent key, so the first cut credited
       `hr_day_cutoff` when nothing was set. The raw row is now read too: absent → `"default"`,
       `'03:00'` → `"hr_day_cutoff"`.
    7. **The expanded items list went stale.** The card's item count refreshes every 10 s; the cached
       detail never did, so a GRE could take feedback against a dish that was no longer on screen. It
       re-fetches when the board's `item_count` disagrees with the cached view's.

  - **MEDIUMs deliberately LEFT OPEN, with reasons:**
    · `readOrderForFeedback()` is not scoped to the board — any non-void order in the outlet can be
      read by id, including one months old. LOW: the read returns **no money at all** (keys verified:
      `id · name · quantity · station · group · station_recognised · kitchen_status · fired_at ·
      served_at · created_at`), and P3's revisit flow will legitimately need orders older than tonight.
    · The **Sidebar's** actor carries no `role_is_active`, so a DEACTIVATED GRE role still shows the
      three nav rows, which then 403. Cosmetic, and the fix is in `/api/auth/me` + `Sidebar.tsx` —
      Lane A's files.
    · `/feedback/tracker`, `/feedback/analytics` and `/feedback/take/[orderId]` still render
      `placeholder.ts`. P4 / P5 / P3 own those.
    · `FloorRow.in_grace` is derived from `order_status === 'settled'` alone. Correct only because the
      SQL already bounds settled rows to the grace window — documented, not changed.

  - **No regression.** 120 authenticated reads across four personas and both routes:
    `53 orders · 104 items · 4 visits · 0 item_fb · 0 follow_ups · 64 settings · 2165 purchases ·
    952 materials · Σquantity 150 · open 24 / settled 9 / void 20` — **identical before and after**,
    `PRAGMA integrity_check → ok`. Read-only re-proved after the edits: POST/PUT/PATCH/DELETE on both
    routes → **403** without a CSRF header and **405** with a valid double-submit pair (8/8); `GET` →
    200 on both; each route file exports `GET` and nothing else; and every SQL write verb in `read.ts`
    is inside a comment (the only non-comment hits are JavaScript `String.replace`).
    `npx tsc --noEmit` exit **0**, zero output.
    ⚠️ One `tsc` trap worth naming: a comment placed inside the SQL **template literal** must contain
    no backticks — a `` `datetime('now')` `` in prose terminated the string and produced
    `TS1005: ',' expected` 60 lines away.

  - **Fixtures** (worktree DB, all `gfqa-`, removable with `DELETE ... WHERE id LIKE 'gfqa-%'`):
    P2's set re-anchored to `datetime('now')` so the five statuses are reachable, plus **new**
    `gfqa-s1` (3 days old), `gfqa-s2` (last night + an OPEN follow-up), `gfqa-s3`/`gfqa-s4` (the 04:00
    boundary, 60 min apart), `gfqa-o12` (a 0-item open table), tables `gfqa-t8..t12`, and
    `gfqa-u-mgr` / `gfqa-tok-mgr` (a user on the existing `Manager` role — **no production role config
    was changed**). Server on **3952 killed, port free**; the owner's preview on 3001 untouched.

- **2026-09-22 — P2 ADVERSARIAL PROBE `the-gre-is-denied` (port 3954, no code changed).** The claim
  under test: *an assigned GRE cannot perform any of the owner's six forbidden actions.* Verdict:
  **TRUE for every POS path — and FALSE once, through a door outside the prefix list.**

  - **METHOD, and why it is stronger than Lane A's.** Every request was aimed at **REAL ROWS** on a
    throw-away `VACUUM INTO` copy (`purchases 2165 · raw_materials 952 · integrity ok`), not at
    `zz-nope`: open order `gfqa-o2` (5 items), KOT `gfqa-k1` in state `ready` (one bump from the
    stock move), a `pending_approval` customer order `gfqa-co1`, a pending discount request, a free
    table and a confirmed reservation. A failure of the deny is therefore a **measurable write**, not
    a 404. Run copy in the scratchpad (`rsync` + `rsync --link-dest` node_modules, same inode
    proved), so the worktree DB was only ever read (`?mode=ro`).
  - **THE SIX, AS THE ASSIGNED GRE: 29 of 29 refused, three times over (87/87), with
    `reason: feedback_read_only`.** place order · replay · customer-order approve/modify/reject ·
    add_item · set_qty · remove_item · fire · transfer · settle · void · hold · service-charge ·
    **print-bill** · **request-bill** · guests · discount · discount-request raise · decide · KDS
    bump/reprint/escalate/resend/undo · scan-out · tables create/rename/delete.
  - **NOTHING WAS WRITTEN.** Table digests (content hashes of orders, order_items, kots,
    restaurant_tables, order_guests, discount_requests, ct_bookings, print_jobs, raw-material stock)
    were **byte-identical before and after** each of the three 29-request runs and after the 14
    evasion attempts — 72 refusals with zero rows changed, `integrity_check ok`,
    `recipe_deducted 0 → 0`.
  - 🔑 **THE CONTROL — the refusals are the deny, not broken requests.** The identical bodies, the
    same minute: **POST /api/dine-in/orders created a real order for all six other personas**
    (Captain · staff-no-role · section='GRE' · Floor Manager · Manager · Admin — six orders, ids
    recorded and deleted) and was refused only for the GRE. And with the deny switched off by
    config (below) the very requests that had just 403'd **landed**: an item was added
    (`order_items` 106 → 107, Σqty 153 → 156), `gfqa-k1` was bumped to **served**, and `gfqa-o2` was
    **SETTLED** (`status=settled · payment_method=cash · total ₹5601`). All restored afterwards.
  - **CROSS-PERSONA: 0 of 29 refused** for Captain, staff-with-no-role, `section='GRE'`, Floor
    Manager, Manager and Administrator (they got the handler's own 200/201/400/403/404/500); a
    **forged cookie and a cookie-less request answered 401 × 29** — step 2c still holds.
  - **TRYING TO DEFEAT THE MATCH (14 attempts).** `%2F`, `%6F`, `%2f`, a query string and a
    `..`-segment are all **denied**. A trailing slash, a doubled leading slash and
    `/kds/<id>/bump/` are answered by Next with **308**, and following the redirect lands on
    **403 `feedback_read_only`** (`curl -L --post301`, three for three). Upper/mixed case and
    `orders;x=1` are **404** — Next's router never matches them, so there is no handler to deny.
    **The anchored negatives are proved negative:** `/api/dine-in/orders-extra`,
    `/api/dine-in/tablesX` and `/api/reports/dine-in/orders` answer **404, never 403** — a substring
    test would have caught all three.
  - **READS STILL WORK** for a feedback visit: `GET /api/feedback/floor` · `/api/feedback/order/<id>`
    · `/api/dine-in/orders` · `/orders/<id>` · `/tables` · `/kds` · `/customer-orders` ·
    `/orders/<id>/request-bill` all **200**; `HEAD` 200 and `OPTIONS` 204 on a denied path; pages
    **200 · 200 · 200 · 403** (analytics refused — the fairness ruling holds). The GRE's own job
    still works: `POST /api/dine-in/service-requests/<id>` → **200**, and that route writes only
    `service_requests` (proved by grep) so it cannot forge an eligibility trigger.
  - **THE ELIGIBILITY TRIGGERS ARE SEALED.** Exactly three places in the repo write
    `bill_requested_at` / `bill_printed_at`: `src/lib/bill-request.ts` (called **only** from
    `orders/[id]/request-bill`), `orders/[id]/print-bill:121` and `orders/[id]/settle:258` — all
    three under the denied prefix, all three measured 403. `GET …/bill-pdf` left
    `bill_printed_at` NULL (and 403s a GRE anyway). A GRE cannot manufacture their own coverage.
  - **THE DENY SURVIVES A DEACTIVATED ROLE** (Lane A's fix re-measured live): `is_active=0` →
    still `403 feedback_read_only` on PATCH/bump/settle while the page 403s `role_inactive`. Also
    unaffected by `section='Kitchen'`, by `can_request_discount=1`, and by ` gre ` (trim +
    case-fold). Unassigning the role turns it off, as designed.

  - 🐞 **HIGH — THE ONE CLAIM IS FALSIFIED BY `POST /api/crm-calls/bookings/[id]/seat`.** Its whole
    gate is `if (!me) return 401` ("Any signed-in user", its own header says), and it calls
    `seatBooking()` (`src/lib/ct/seating.ts:118`), which **`INSERT`s a row into `orders`**. Measured
    as the assigned GRE on 3954:
    `POST /api/crm-calls/bookings/9148a5f9…/seat {"table_id":"gfqa-t7"}` → **200
    `{"ok":true,"orderId":"cbd205af-…","reused":false}`** — a live dine-in order, `status=open`,
    `covers=2`, **`server_id=gfqa-u-gre`, `server_name="QA Gre"`** (the GRE is recorded as the
    table's captain), plus an `order_guests` row and the booking flipped to `seated`. On a table
    that ALREADY has an open order it takes the other branch (`seating.ts:107`) and **mutates the
    live order**: seated onto `gfqa-t2` it wrote `guest_name`, `guest_mobile`, `booking_id` and
    `updated_at` on **`gfqa-o2` — the same order `PATCH /api/dine-in/orders/gfqa-o2` had refused a
    minute earlier** — and inserted the booking's guest into that table's party. It can also fill
    `covers`, which is the **Pax** this module's own board prints.
    **NOT FIXED, deliberately, and this is an owner question, not a code question.** The obvious
    patch — adding `/api/crm-calls/bookings` to `POS_WRITE_PREFIXES` — would deny a GRE the entire
    reservations subtree, and seating reservations is plausibly the GRE's *actual day job*
    (`/dine-in/reservations`, the What's On board). Rule 5 territory. **Ask him: may a GRE seat a
    reservation, knowing that seating opens or edits the table's order?** If yes, the prefix list
    must say so in words; if no, deny the single `…/seat` path, not the subtree.
  - ⚠️ **CONFIG TRAP, MEDIUM — two ticks in Settings → Roles switch the whole deny OFF.** Measured:
    `users.is_head_chef=1` **or** `roles.is_head_chef=1` on the GRE role → `PATCH …/orders` **200**
    and `kds/…/bump` **200**; `roles.base_role='manager'` → those plus `settle` **200**. That is
    `isFeedbackManagement()`'s deliberate carve-out (a manager already holds those powers by tier),
    but **"HOD" is not a tier** — it is a checkbox about approvals, and ticking it on a login that
    still says GRE silently returns the POS write rail. Note also that the owner's own sentence is
    *"The GRE/**Manager** may view ordered items but has READ-ONLY ACCESS"*: the shipped deny covers
    the GRE only. Worth one line of copy next to that checkbox, or a rule that a login carrying the
    GRE role is read-only regardless of tier.
  - ⚠️ **ENVIRONMENT TRAP #1 — the `gfqa-tok-*` fixture sessions silently DELETE THEMSELVES, and it
    cost this lane a whole battery.** Their `expires_at` is the space form
    (`2026-09-22 19:40:02`). The proxy compares it in SQL (`expires_at > datetime('now')`, UTC, and
    it passes) but `getCurrentUser()` compares it in JS — `new Date('2026-09-22 19:40:02')` parses
    as **LOCAL** time, i.e. 5 h 30 m early on an IST box — decides the session is expired and calls
    **`destroySession()` (auth.ts:110)**, which `DELETE`s the row. Symptom: state-changing calls
    keep answering (the proxy sees the session) while **every GET 401s and `/api/auth/me` returns
    `user:null`**, and the token is gone from the table. **NOT a product defect** — the only two
    places that create sessions are `createSession()` (`expiresAt.toISOString()`, ISO+Z, parses
    correctly) and a test script — but any fixture session must be written as
    `strftime('%Y-%m-%dT%H:%M:%SZ','now','+2 days')`. This lane used `gfqa-tok2-*` tokens in that
    form; the seven `gfqa-tok-*` rows in the worktree DB are, by the same arithmetic, already dead.
  - ⚠️ **ENVIRONMENT TRAP #2 — `grep` LIES about `src/lib/bill-request.ts`.** The file contains a
    NUL byte at line 189 (`'\0none'`, a deliberate map-key sentinel in shipped `main` code), so BSD
    grep treats the whole file as binary and prints **nothing** — `grep -n "UPDATE orders"` on the
    file that writes `bill_requested_at` returns exit 1. This lane nearly concluded that nothing in
    the repo writes that column. **Use `rg -a` for any negative-result grep in this repo.**
  - **Server on 3954 killed, port free**; the isolated run copy is the only thing that was written
    to, and it was restored to its baseline digest after every destructive control (final:
    `orders 54 · items 106 · Σqty 153 · recipe_deducted 0 · order_guests 0 · ct_bookings seated 0 ·
    purchases 2165 · raw_materials 952 · integrity ok`). `npx tsc --noEmit` on the committed
    worktree → exit **0**, zero output. **No source file was changed by this lane.**

- **2026-09-22/23 — P2 ADVERSARIAL PROBE `captains-still-work` (port 3953, no code changed).** The
  claim under test is the one that outranks the deny itself: **nobody who works today stops working.**
  Method: the SAME script run TWICE from a BYTE-IDENTICAL database — once with the deny REVERTED
  (`git show 96f3b66^:src/proxy.ts`, `refusePosWrite` occurrences **0**), once with it as committed
  (byte-identical to HEAD's `src/proxy.ts`, occurrences **3**) — in two isolated run copies, each
  booted alone on 3953 with its own `.next`, its own `VACUUM INTO` of the same `pristine.db`
  (**both runs started at sha256 `c3b396a2…`**), every route module warmed first so no
  first-compile latency could move a timing-sensitive step. Everything volatile is masked
  identically in both transcripts (UUIDs, 32-hex ids, timestamps, scan codes), so a surviving
  difference is a real difference.
  - **VERDICT: PHASE 1 IS IDENTICAL, LINE FOR LINE.** 91 of 91 measured HTTP lines byte-identical;
    status histogram identical (`200 ×78 · 201 ×6 · 403 ×5 · 409 ×2`); **0** of the phase-1
    responses in the deny build carried `feedback_read_only`. And the database agrees: a normalised
    dump of **all 216 tables — 29,963 lines — is byte-identical**, `purchases 2165`,
    `raw_materials 952`, `integrity_check ok` on both.
  - **What "works" meant — real writes, not 404 probes** (74/74 steps identical, 0 changed):
    CAPTAIN opened a table, added three dishes, changed a quantity, removed a line, fired the KOT,
    completed and un-completed an item, recorded the guest and the party, asked for the bill twice
    (idempotent); KDS bumped new→preparing→ready→served, **undid inside the 10s window**, reprinted,
    resent, escalated and scanned an item out; CASHIER checked in on the floor, marked the request
    seen, printed the bill, printed it again past the 6s coalesce window, **settled it** and
    reprinted after settling; MANAGER voided a fired order, applied a 5% approver-verified discount,
    waived the service charge, **held** the bill and settled it from hold; ADMIN decided a discount
    request and settled a second bill as an override; a staff login with **no role** ran a whole
    table and a login whose `users.section` is `'GRE'` bumped a ticket and added an item (section is
    not the trigger — proved); FLOOR MANAGER settled and created/renamed/deleted tables; the **QR
    flow** placed an order, the captain modified, approved (fired to the KDS) and rejected another;
    a guest rang the service bell and the captain accepted it; **offline replay** reconstructed an
    order and de-duplicated the re-send.
  - **AND THEY STILL WORK AFTERWARDS.** A whole extra service (open → 2 items → fire → 3 bumps →
    request bill → print → settle) run in phase 2 **after the deny had already refused a GRE 21
    times**: 8 of 8 steps byte-identical, settle included.
  - **THE ONLY DIFFERENCES ARE THE GRE'S OWN WRITES.** Phase 2: 20 of 45 lines identical, 25 changed
    — **21 of them the GRE's forbidden writes** (403 `feedback_read_only` in the deny build against
    the handler's own answer without it: `POST /orders`, `PATCH` add_item, `PATCH` fire, print-bill,
    request-bill, void, settle, hold, discount, service-charge, guests, KDS bump/reprint/resend/
    escalate/scan-out, `orders/replay`, `customer-orders/[id]` approve, discount-requests, tables
    POST+DELETE). The remaining **4 are not behavioural**: H04/H07/H07b/H11 are the captain's own
    steps and a field-by-field diff shows the ONLY differing leaf is `kot_number` (14/15 vs 11/12) —
    the per-day KOT sequence, shifted by exactly the **3 KOTs the GRE itself fired** in the world
    where nothing stopped them. Same status, same items, same money.
  - **WHAT THE UNDENIED GRE ACTUALLY DID, from the database:** 3 orders with `server_name = 'QA Gre'`
    (one opened from the POS, one **replayed from the offline outbox**, one QR order they approved
    and thereby took ownership of), 3 KOTs `fired_by = 'QA Gre'`, an extra item + `bill_printed_at` +
    `bill_requested_by = 'QA Gre'` on the CAPTAIN'S live bill (subtotal 2187 vs 1458), plus 2
    `ct_guests`, 1 `order_guests` and 1 `kot_alerts` row. With the deny: **0 rows written by the
    GRE**, on every one of those tables. `/api/dine-in/service-requests` stayed answerable in both
    (G28/G29 identical) — the GRE's own job, deliberately outside the list.
  - **Two masks, both applied identically to both runs and both the app's own randomness, not the
    deny:** `restaurant_tables.qr_token` (db.ts:3900 back-fills a RANDOM token at boot for the one
    fixture row whose token is NULL — `gfqa-t12`), and `sales`' bare `HH:MM` column (the two runs
    necessarily ran in different minutes). Before masking they accounted for exactly 1 transcript
    line and 14 dump lines, all in those two fields.
  - Fixtures are all `capw-` prefixed and live ONLY in the scratchpad run copies (`capw-t1..t12`,
    `capw-u-cashier` on the existing `Cashier` role, 8 sessions, and a known bcrypt password on
    `gfqa-u-mgr` so the discount route's approver check could be exercised on its SUCCESS path).
    **The worktree database was never booted against.** Server on **3953 killed, port FREE**, no
    process left from this lane; the owner's preview on 3001 untouched. `npx tsc --noEmit` on the
    committed worktree → exit **0**, zero output. **No source file was changed by this lane.**

- **2026-09-23 — P2 ADVERSARIAL PROBE `floor-managers-and-null-role` (port 3955, no code changed).**
  Two claims, and the second one outranks the deny: **a Floor Manager must still work**, and **the
  deny must be INERT while `users.role_id` is NULL**. Method: an isolated run copy in the scratchpad
  (`rsync` of `src/` + `rsync -a --link-dest` for `node_modules` — same inode proved,
  `252312499` both sides — + `VACUUM INTO` for the DB), so the worktree database was only ever read
  (`?mode=ro`). Re-vacuumed at the end of the lane: **sha256 `755affd9…` before and after, byte
  identical, 0 `fmnr-` rows leaked into it**, `purchases 2165 · raw_materials 952 · 217 tables ·
  integrity_check ok`. Fixtures are all `fmnr-` prefixed and live ONLY in the run copy.

  - ✅ **(1) THE NULL-ROLE STATE — PROVED INERT, AND PROVED TO SWITCH ON.** The same login, the same
    27-step POS battery, three times, restoring the DB to one baseline (`65da4d42…`) between runs:

    | `users.role_id` | `roles.is_active` | battery result |
    |---|---|---|
    | **NULL** (unassigned) | — | **0 of 27** refused — every step got the handler's own answer |
    | **assigned `GRE`** | 1 | **26 of 27** refused with `feedback_read_only` |
    | **NULL again** | — | **0 of 27** refused — the login gets the POS rail straight back |
    | **assigned `GRE`** | **0 (deactivated)** | **26 of 27** — the escalation guard holds |

    The 27th step is `POST /api/dine-in/service-requests/[id]` (404 from the handler) — deliberately
    outside the list, because answering the table's bell is the GRE's own job. **The assigned run
    wrote NOTHING**: orders opened by that login 0, `fmnr-ov-6` still `open` with `voided_at` NULL,
    0 KOTs, 0 `order_guests`, 0 `discount_requests`, `recipe_deducted 0`. So the property the deny
    was designed around is real: **it refuses nobody until an administrator assigns the role, and it
    stops refusing the moment the role is taken away.** Un-assigning is the lever, not deactivating.

  - ✅ **(2) NOBODY WHO WORKS TODAY STOPS WORKING — 162 LINES AND 33,407 DUMP LINES, IDENTICAL.**
    The same six personas, the same battery, the same order, run TWICE from the SAME baseline: once
    with `src/proxy.ts` as committed (`refusePosWrite` ×3, byte-identical to HEAD `29dd05f`) and once
    with it reverted to `git show 96f3b66^:src/proxy.ts` (`refusePosWrite` ×0).
    · **Transcripts: 162 of 162 measured lines byte-identical**, status histogram identical in both
      (`200 ×93 · 201 ×9 · 400 ×3 · 403 ×33 · 404 ×21 · 409 ×3`), **0** carrying `feedback_read_only`.
    · **Database: a normalised `.dump` of all 217 tables — 33,407 lines — is byte-identical.** The
      only 28 lines that ever differed are `order_items.scan_code` and `restaurant_tables.qr_token`,
      both randomised by the app itself (the same `qr_token` mask the `captains-still-work` probe
      names); masked identically in both runs, the difference is **0**.
    · **The personas are the ones the claim is about:** `Floor Manager` (base_role manager),
      `Captain`, and the three null-role tiers that production still has 8 of —
      **null-role STAFF · null-role MANAGER · null-role ADMIN** — plus a GRE-shaped login whose role
      is not assigned.
    · **They did REAL WORK, not 404 probes.** Per persona, from the database: 1 order opened, items
      punched, a quantity changed, a line removed, a KOT fired and bumped `new→preparing→ready`,
      reprinted and escalated, a guest recorded, the bill requested and printed, held — and the three
      manager-tier logins **settled** it, **voided** a second order and **created, renamed and deleted
      tables**. The Floor Manager's 27 lines contain **20 successful POS writes and 0 refusals**.
    · **The Floor Manager's existing pages are untouched:** `/` · `/dine-in/floor` · `/dine-in/tables`
      · `/dine-in/kitchen` · `/captain` · `/reports` · `/dine-in/reservations` ·
      `/dine-in/reconciliation` all **200**.
    · **The deny never reaches outside `/api/dine-in/*`:** `POST` to `/api/vendors`,
      `/api/requisitions`, `/api/wastage`, `/api/tasks`, `/api/crm-calls/bookings/[id]/seat`,
      `/api/hr/attendance` and `/api/kitchen-production` answered identically for all five personas
      **and for an ASSIGNED GRE** — not one cell carried `feedback_read_only`.

  - 🛑 **(3) HIGH — A FLOOR MANAGER CANNOT OPEN ONE PAGE OF THIS MODULE, AND THE API DISAGREES WITH
    THE PAGE.** Re-measured and now quantified across the whole role table. `canAccessPage` runs the
    `greOnly` flag at line 991 — which a Floor Manager **passes**, being management — and then applies
    the role's own `page_access` list at lines 994-1004, which refuses:

    | persona | /feedback | /take | /take/&lt;id&gt; | /tracker | /analytics | `GET /api/feedback/floor` |
    |---|---|---|---|---|---|---|
    | no cookie at all | 307→login | 307 | 307 | 307 | 307 | `signed_out` |
    | junk session cookie | 403 | 403 | 403 | 403 | 403 | 401 |
    | **Floor Manager** | **403** | **403** | **403** | **403** | **403** | **200 `scope=management`** |
    | Captain | 403 | 403 | 403 | 403 | 403 | 403 `role_not_gre` |
    | null-role STAFF | 403 | 403 | 403 | 403 | 403 | 403 `no_role_assigned` |
    | null-role MANAGER | 200 | 200 | 200 | 200 | 200 | 200 `scope=management` |
    | null-role ADMIN | 200 | 200 | 200 | 200 | 200 | 200 `scope=admin` |
    | GRE login, role NULL | 403 | 403 | 403 | 403 | 403 | 403 `no_role_assigned` |
    | **GRE login, ASSIGNED** | **200** | **200** | **200** | **200** | **403** | 200 `scope=gre read_only=true` |
    | GRE, role DEACTIVATED | 403 | 403 | 403 | 403 | 403 | 403 `role_inactive` |

    The null-role MANAGER row is the diagnosis: it differs from the Floor Manager row **only** in
    having `page_access` NULL. **6 of the 10 roles in this snapshot carry an explicit list and would
    therefore 403 on all four pages** — `Floor Manager`, `Bar Manager`, `Head Chef`, `Store Manager`
    (all management tier, all of whom the module's own gate admits), plus `Captain`, `Cashier` and
    `Staff` (for whom the 403 is correct and intended anyway). Only `GRE` and `Manager` (NULL maps)
    and `Administrator` (line 966) get through.
    **CONTROL, measured:** add `/feedback` to the Floor Manager role's list and all four pages answer
    **200** immediately (the prefix grant carries `/take` and `/tracker`; `/analytics` opens on the
    manager tier). Reverted straight away — **production role config is the owner's, rule 5.**
    ⚠️ §2 does not record the PRODUCTION `GRE` role's `page_access` value, so whether the four real
    GREs can open the page is **still unverified in production**. This snapshot's GRE row is NULL,
    which is why it passes here.

  - ✅ **(4) PAGE-1 TRUTH — every line of the owner's rule, on real rows.** `GET /api/feedback/floor`
    as a Floor Manager, one board read:
    `3 items → not_ready` · `5 items → due (by items)` ·
    **`2 items + bill_requested_at → due` and `eligible_by.items=false`** — the trigger is genuinely
    independent of the count · `2 items + bill_printed_at → due` · settled 200 min ago → **off the
    board** · settled 5 min ago → on it (grace) · voided with 6 items AND a bill request → **off the
    board** · and the never-settled order has its exit. Threshold `4 (default)`, cutoff
    `04:00 source=default`, business date `2026-09-23`.
    **The stale exit is the DAY RULE, not ineligibility — proved by moving the boundary.** Two orders
    identical but for 60 minutes straddling the 04:00 IST rollover (22:30 UTC): `fmnr-o-stale`
    (03:30 IST) off the board, `fmnr-o-fresh` (04:30 IST) on it as `due`. Set `hr_day_cutoff='03:00'`
    and **the stale one returns as `due`** (`stale_open_order` 17→16, `all` 9→10); set `'09:00'` and
    it falls back to `04:00 source=default`, the night-window guard holding.

  - ✅ **(5) THE CLOCK IS RIGHT, against a known instant.** Order opened at raw column
    `2026-09-23 04:26:53`; SQL truth at read time **144 minutes**.
    · SERVER: API `opened_at` = `2026-09-23T04:26:53Z`, `epoch 1790137613000` — **identical** to
      reading the column as UTC; the same string parsed unrepaired on an IST box is **330 minutes**
      away. **21 of 21 timestamps** the board emitted carry an explicit zone; 0 un-zoned.
    · CLIENT: `zonedMs()` and `elapsed()` extracted **verbatim** from `src/app/feedback/ui.tsx`
      (byte-identity asserted as a substring; sha256 `756f99e0…` / `17f9bcdf…`) and run under
      `TZ=Asia/Kolkata`: **`"2h 24m"`** against a truth of 2h 24m. The OLD `Date.parse` reader on the
      same raw column gives **`"7h 54m"`** — the 5 h 30 m lie. The raw column through the NEW reader
      gives `"—"`. Case matrix 12/12 (note: a fractional-second stamp 10 min old correctly floors to
      `9m`, which is arithmetic, not a defect).

  - **GATES — clean.** Over the branch's whole diff vs `main` (merge-base `98e1be7`, 21 files):
    `lq_` 1 · `src/app/party-manager` 1 · `src/lib/pm/` 1 · `src/app/fssai` 1 · `src/lib/fssai` 1 ·
    `api/fssai` 1 · `bill-handover` 0 — and **every one of those six hits is the same two lines of
    §0 of THIS FILE, the sentence that names the gates.** Restricted to code files (no `.md`) all
    seven patterns are **0**, and bare-word `fssai` in code is **0** too. 0 gated module paths among
    the changed file names.
  - **HYGIENE.** `/Users/shashankreddy/Desktop/Claude/fnb-controller` untouched: HEAD `98e1be7` on
    `main`, its 86 dirty files are the other gated work and **0** of them mention feedback or `fmnr`.
    **Nothing was pushed** — `git ls-remote --heads origin guest-feedback` returns **0 rows** and the
    branch has no upstream. `npx tsc --noEmit` on the committed worktree → exit **0**, zero output.
    Worktree `git status` clean at `29dd05f` before this entry. Server on **3955 killed, 0 listeners,
    no process left from this lane**; the kill selector only ever matched `-p 3955` and my own
    `FMNR/wt` path, and both sibling lanes' servers (`BOHSEC`, `DOUBLE3963`) were verified alive
    afterwards. ⚠️ Observation, not an action of this lane: a sibling `next start -p 3965` that was
    listening at lane start had exited by the end; it was never a kill target here.
  - **NO SOURCE FILE WAS CHANGED BY THIS LANE.** Nothing was deployed; the build-only gate stands.

- **2026-09-23 — P4 LANE A (Page 3 Tracker · the placeholder · the door).** Port 3981, isolated run
  copy (`rsync` of `src/` + `rsync -a --link-dest` node_modules — same inode `252312499` proved —
  + `VACUUM INTO` of the DB). **The worktree database was never booted against: its mtime is still
  `Sep 22 18:41:50`.** New `src/app/api/feedback/tracker/{route.ts,query.ts}`; rewritten
  `src/app/feedback/tracker/page.tsx`; +68 lines in `src/lib/page-catalog.ts`; a comment in
  `src/components/Sidebar.tsx`. Fixtures are all `gftr-` and live ONLY in the run copy.

  - **THE ROUTE EXISTS NOW, AND IT IS A DIFFERENT UNIVERSE FROM PAGE 1 — deliberately.** Page 1
    answers "where do I walk now" (open + 30 min grace). Page 3 answers the Floor Manager's
    question, and **the tables a GRE MISSED are exactly the ones that have settled and left the
    board.** Measured on the same login, the same minute: the floor board carried 7 of the fixture
    orders and **not** `gftr-o11` (settled 3 h ago, never visited) nor `gftr-oy` (last night, still
    owed a revisit); the tracker carries both. Coverage off the live board would have read **4/6 =
    66.7 %**; the truth is **4/8 = 50 %**.
  - **THE DAY IS THE 04:00 IST BUSINESS DAY, anchored on `orders.created_at`** (Page 1 dates a row
    by LAST ACTIVITY because it asks whether the table is alive; a ledger must not move rows between
    days while you read it). Same `feedbackBoardCutoff()` + HRMS `businessDateOf()` as Page 1, same
    night-window guard, no new settings key. **Proved with a 60-minute pair straddling 22:30 UTC:**
    `gftr-ob-before` (03:30 IST) is absent from today and present under `?date=2026-09-22`;
    `gftr-ob-after` (04:30 IST) is on today's ledger as `due`. `?date=` is format- AND real-date-
    checked (`2026-02-31` → today + a note), refuses the future (`2030-01-01` → today + a note) and
    is parameterised (`' OR 1=1--` → today).
  - **EVERY FILTER IS SERVER-SIDE AND EVERY COUNT IS COMPUTED OVER THE ROWS THE LIST WILL DRAW.**
    `filter` 6-way: all 9 · pending 4 · completed 3 · negative 4 · follow_up 2 · resolved 1, and an
    unknown value falls back to `all` rather than blanking the page. `floor` (zone, `''` → `Floor`):
    Rooftop 5 · Ground Floor 3 · Floor 1 · `Atlantis` 0. `captain` (Suresh 4 · Anil 2). Header
    counts `active 8 · due 4 · taken 4 · issues 3 · follow_up 1`, coverage **50 %**.
  - 🐞 **DEFECT FOUND AND FIXED IN THIS LANE (1) — A PERSON FILTER INVENTED A 100 % COVERAGE.**
    First cut applied GRE/Manager to the whole page. Filtering by a person removes every UNVISITED
    table (nobody's name is on it), so `due` went to 0 and `?gre=TR Gre One` answered **`active 2,
    taken 2, coverage 100%`** on a floor whose real coverage was 50 % — an invented per-person score
    under that person's own name, which is exactly what the fairness ruling forbids. The scope is
    now TWO layers: Floor+Captain move every number; **GRE/Manager narrows the record list and its
    chip counts only**. Re-measured: `?gre=TR Gre One` → list 3, header still `active 8 … cov 50`.
    `meta.counts_scope` says so and the page prints it.
  - 🐞 **DEFECT FOUND AND FIXED IN THIS LANE (2) — THE CARRIED-OVER COMPLAINT VANISHED.** The SQL
    prefilter window is a day wider on each side (no index on `orders.created_at`, and a `T`-form
    stamp would sort above the space form at the boundary), so last night's order was inside it,
    was therefore already in `seen`, and its carried-over row was skipped — then the day filter
    dropped it for belonging to another day. An OPEN guest complaint disappeared from both paths at
    once. `seen` is now built from the rows that SURVIVED the day filter. Measured before → `carried
    _over_follow_up 0`; after → **1**, `gftr-oy` first in the list (follow-ups sort first).
    Carry-over is EARLIER services only (`bd < target`), so yesterday's page does not show tomorrow's
    complaint, and carried rows are deliberately OUT of `active/due/taken/coverage` — they belong to
    their own day's denominator — while the `follow_up` chip does include them (2 vs the header's 1).
  - **`taken ⊆ active` IS AN INVARIANT, not a kindness:** a visited table stays in the ledger even
    if it never met the trigger (the threshold is admin-tunable mid-service), otherwise coverage
    could read above 100 %.
  - **THE COVERAGE TABLE IS SEEDED FROM THE PEOPLE WHO HOLD THE ROLE, NOT FROM THE VISITS** — a GRE
    who recorded nothing is the single most important row on this page and a visit-driven query
    cannot produce it. Measured: `TR Gre One (gre, taken 2, tables 2, issues rec 1)` ·
    `QA Gre (gre, taken 1, follow-ups 1 opened / 1 open)` · `QA Manager (management, taken 1, 1
    closed)` · **`TR Gre Two (assigned, taken 0)`**. Eligible / Pending / Coverage % sit on the
    FLOOR TOTAL row only: nothing in this app assigns a table to a person, and an invented
    denominator in a performance table is worse than no number.
  - 🔒 **THE FAIRNESS RULING, checked against the payload:** the per-person row carries
    `tables_visited · taken · issues_recorded · follow_ups_opened/completed/open · share_pct` and
    **zero** keys matching rating/score/overall/negative; ordering is by activity, never sentiment.
    `issues_recorded` is the owner's own allowed "Issues Properly Recorded" and is labelled so more
    is better.
  - **READ-ONLY, PROVED THE SAME WAY PAGE 1 WAS:** the route file exports `GET` and nothing else;
    POST/PUT/PATCH/DELETE → **403** (CSRF, `/api/feedback` prefix armed) and **405** with a valid
    double-submit pair (8/8); GET/HEAD 200. `query.ts` contains no SQL write verb outside its own
    header comment. **40 authenticated reads left the census byte-identical** — `orders 68 ·
    items 174 · Σqty 220 · visits 10 · item_fb 5 · follow_ups 3 · settings 64 · purchases 2165 ·
    materials 952 · recipe_deducted 0 · integrity ok`.
  - **NO MONEY AND NO GUEST PII ON THE WIRE** (checked against the whole payload): no `unit_price`,
    `line_total`, `subtotal`, `total`, tax/cgst/sgst, `discount`, `payment_method`, `guest_name` or
    `guest_mobile`. **22 of 22 timestamps carry an explicit zone**, 0 un-zoned — raw
    `2026-09-23 11:21:46` leaves as `…T11:21:46Z`, and the same string read as IST is 330 minutes
    away.
  - **THE CACHE IS NEVER THE TRUTH, and it says when it lies.** `gf_visits.open_follow_ups` forced
    to 0 while a follow-up was open: the record still reported `open_follow_ups 1`, status
    `follow_up`, counts unchanged, and `meta.cache_mismatch` went **0 → 1 → 0** on restore.
  - ✅ **THE PLACEHOLDER IS GONE FROM PAGE 3** — `../placeholder` import removed, SSR HTML contains
    **0** occurrences of `Priya`, `Kiran`, `Meera`, `Prawn Tempura`, `Biryani remade` or the invented
    `83.3`. ⚠️ **The lane brief's item 3 was STALE: `src/app/feedback/take/page.tsx` was already
    fixed by P2 Lane B** (it reads `GET /api/feedback/floor`, `FLOOR_TABLES` occurrences 0, SSR
    contains 0 of the six invented table labels) — **left alone, not "re-fixed"**. The only files
    still importing `placeholder.ts` are `take/[orderId]` (P3's) and `analytics` (Lane B's), so the
    file must stay until those land.
  - 🔓 **THE DOOR — `page-catalog.ts` gained ONE line, and its rule is: for `/feedback*` the
    MODULE'S OWN GATE decides, and a role's `page_access` list can only NARROW that, never widen
    it.** The reason absence could not mean denial: **this module has never shipped, so no role's
    list could possibly mention it.** Measured over HTTP, 15 personas × 4 pages + the API, the SAME
    build with and without the line (control = the line commented out, everything else identical):

    | persona | /feedback /take /take/id /tracker /analytics — WITH | WITHOUT | API |
    |---|---|---|---|
    | Floor Manager · Bar Manager · Head Chef · Store Manager | **200 200 200 200 200** | 403 403 403 403 403 | 200 management |
    | GRE assigned (role map NULL) | 200 200 200 200 403 | 200 200 200 200 403 | 200 gre |
    | Manager (NULL map) · Administrator | 200 ×5 | 200 ×5 | 200 |
    | Captain · Cashier · Staff | 403 ×5 | 403 ×5 | 403 `role_not_gre` |
    | no role · section='GRE' no role | 403 ×5 | 403 ×5 | 403 `no_role_assigned` |
    | junk cookie / no cookie | 403 ×5 / 307 ×5 | same | 401 |

    Every row except the four management-with-an-explicit-list roles is **identical between the two
    runs**. And the production-relevant case, measured by giving the local GRE role an explicit list:
    **without the line an assigned GRE whose role carries a list gets 403 on all three of their
    pages** (`["/captain","/dine-in/floor"]` → 403 403 403 403); **with it, 200 200 200 403.** §2
    does not record the PRODUCTION `GRE` role's `page_access`, so this is the state the four real
    GREs may be in right now.
    **The lever, proved:** set the role's list to `["/feedback/tracker"]` → **403 403 200 403** (the
    owner's list governs the moment it mentions the module); `["/feedback"]` → 200 200 200 403 (the
    existing prefix grant); `["/feedback-notes"]` → 200 200 200 403 (anchored, not a substring).
    **It cannot widen:** a Captain role with `"/feedback"` AND `"/feedback/tracker"` in its list is
    still **403 on all four** — `greOnly` is the floor. All role-config edits were made in the RUN
    COPY ONLY and restored (`gre=NULL`, `captain=["/captain"]`, 7 roles with a map, verified).
    The same line is mirrored into `canAccessPageStrict()`, which is measured-but-not-wired, so
    wiring it up later cannot silently re-close the module.
  - **Sidebar needed no code change** — the four hrefs already twin the catalog's four paths, in the
    same order, and the Sidebar filters with the same `canAccessPage`; `/api/auth/me` hands it
    `role · role_name · is_head_chef · page_access` for the Floor Manager (verified live). A comment
    now records why the rows appear. ⚠️ Still open and NOT mine to fix: that client actor carries no
    `role_is_active`, so a DEACTIVATED GRE role still shows the nav rows, which then 403.
  - `npx tsc --noEmit` exit **0**, zero output (with a concurrent lane's in-flight analytics files
    present). Server on **3981 killed, port free**. ⚠️ A concurrent lane is editing this worktree
    (`analytics/page.tsx`, `api/feedback/analytics`, `api/feedback/reports`, `lib/feedback/
    reporting.ts`); **this commit adds only Lane A's five paths**.

- **2026-09-23 — P6 ADVERSARIAL PROBE `access-and-fairness` (port 3985, no source file changed).**
  Two claims: **the right people get in**, and **no metric rewards a GRE for staying silent.** The
  first holds everywhere I could push it. **The second is FALSE on Page 4 and in seven of the eight
  downloads, and it is falsified by construction, not by argument.** Isolated run copy in the
  scratchpad (`rsync` of `src/` + `rsync -a --link-dest` node_modules — same inode `252312499` —
  + `VACUUM INTO` of the DB); **the worktree database was never booted against** (mtime still
  `Sep 22 18:41:50`, 0 rows carrying my `p6-`/`p6a-` prefixes, `purchases 2165 · raw_materials 952 ·
  integrity ok`). Fixtures are all `p6-`/`p6a-` and live ONLY in the run copy.

  - 🔴 **CRITICAL — SELECTING A GRE IN THE PAGE 4 FILTER BUILDS THE SCORECARD THE FAIRNESS RULING
    FORBIDS, AND IT IMPROVES WHEN THE GRE RECORDS NOTHING.** `options.gres` populates a **GRE**
    `<Select>` (`analytics/page.tsx:352`); picking a name narrows the WHOLE dashboard — the rating
    split, the four `tone="bad"/"warn"` tiles, Most Complained, Service Recovery — to that person,
    and the only filter-aware copy on the page (line 389) talks about **coverage** and nothing else.
    **THE FLIP, one GRE, the same four tables, the same four visits, only what she wrote down
    changed** (`P6 Gre Two`, measured, then restored byte-identically):

    | filtered to `P6 Gre Two` | recorded HONESTLY | recorded "everything good" |
    |---|---|---|
    | Feedbacks taken | 4 | 4 |
    | Coverage | 33.3 % | 33.3 % |
    | Overall rating split | **Excellent 0 (0.0 %) · Average 4 (100.0 %)** | **Excellent 4 (100.0 %)** |
    | Negative item feedbacks (red tile) | **4** of 4 | **0** |
    | Returned/Remade/Replaced · Pending follow-ups | 4 · 2 | 0 · 0 |
    | Most complained | Chicken Tikka, negative 100 % | — |

    **It is not only on screen — it downloads.** `GET /api/feedback/reports?report=daily&format=xlsx
    &gre=P6%20Gre%20Two` produced two workbooks, both headed `GRE: P6 Gre Two`, both `Coverage 33.3%`
    and `Feedbacks taken 4`: the honest one reads `Excellent | 0 | 0.0%`, `Average | 4 | 100.0%`,
    `Negative item feedbacks | 4`; the silent one reads `Excellent | 4 | 100.0%`,
    `Negative item feedbacks | 0`. The PDF carries the same (`pdftotext`: `Excellent … 0 … 0.0%`,
    `Average … 4 … 100.0%`, footnote `• GRE: P6 Gre Two`). **7 of the 8 reports take `&gre=`**; only
    `gre-performance` is protected, and it says so in its own subtitle — *"Coverage and
    follow-through only. No rating the guests gave appears in this report."* That sentence is exactly
    right, and it is exactly what the other seven do not honour.
    **WHAT IS NOT WRONG, measured in the same breath, so the fix is surgical:** the unfiltered
    dashboard is venue-level; `gre_performance` carries `person · role · tables_visited ·
    issues_recorded · follow_ups_raised/completed/open · recovery_pct` and **zero sentiment keys**;
    Page 3's coverage table likewise (`tables_visited · taken · issues_recorded · follow_ups_* ·
    share_pct`). Under the flip **none of the allowed metrics moved**: `tables_visited 4 → 4`,
    `taken 4 → 4`, `share_pct 40 → 40`, venue `coverage_pct 83.3 → 83.3`. Recording a complaint costs
    a GRE nothing on any number the owner named — it is the *person filter over the sentiment
    sections* that reverses that, on screen and in a file that can be e-mailed.

  - ⚠️ **MEDIUM — THE OWNER'S NARROWING LEVER IS PAGE-ONLY; THE API IGNORES IT.** Set the GRE role's
    `page_access` to `["/feedback/take"]` (the lever P4 Lane A documents) and the pages answer
    `/feedback 403 · /take 200 · /tracker 403 · /analytics 403` — while **`GET /api/feedback/tracker`
    answers 200** with all 12 records and the per-person coverage table naming every GRE's activity
    (`['P6 Gre One','P6 Gre Two','P6 Gre Three','QA Gre']`), and `/api/feedback/floor` and
    `/order/<id>` answer 200 too. The routes gate on `feedbackAccess()`, which never reads
    `page_access`; so "he ticks one page and his list governs that role page by page" is true of the
    screen and false of the URL. No money or guest PII is in those payloads, and analytics stays 403.

  - ⚠️ **MEDIUM — ON PAGE 4 THE GRE WHO TOOK NO FEEDBACK AT ALL DOES NOT EXIST.** `grePerformance()`
    is built from visits, so a GRE with zero visits has **no row**: measured, `QA Gre` (assigned the
    GRE role, 0 visits tonight) appears on **Page 3** as `kind=assigned · tables_visited 0 · taken 0`
    and is **absent from Page 4's performance table and from the GRE/Manager Performance workbook**,
    where `P6 Gre Two` appears with `Open 2`. Total silence is the one behaviour the management page
    cannot see, while the honest recorder is the one carrying visible open work.

  - ⚠️ **LOW — the two numbers on the ALLOWED list that can still read worse for a recorder.**
    `recovery_pct = follow_ups_completed / follow_ups_raised`: `P6 Gre Three` (2 complaints recorded,
    neither revisited yet) prints **`0.0%`** in the workbook where `P6 Gre One` (nothing recorded)
    prints **`-`**; `Open` is 2 against 0. The denominator is "complaints you wrote down", so the
    only way to never show a low recovery rate is to never record one. Defensible — Guest Recovery
    Follow-Up is the owner's own metric and the remedy is to go back and close it — but it should be
    labelled as a work queue, not a score, and "-" must never sort above "0.0%".

  - ⚠️ **LOW — a venue number on a person's card.** Filtered to `P6 Gre One`, who raised **0**
    follow-ups, the Pending follow-ups tile reads `0` with the hint **"4 open now (all dates)"** —
    `open_follow_ups_now` is deliberately not range-bound and is also not person-bound, so a card
    headed with one name carries the venue's open count.

  - ✅ **ACCESS — THE RIGHT PEOPLE GET IN, PAGE *AND* API.** 13 personas × 5 pages × 5 API routes on
    the committed build: **GRE (assigned) 200 200 200 200 / analytics 403** — and 403 from
    `/api/feedback/analytics` AND all 16 `/api/feedback/reports?report=…&format=…` combinations
    (8 keys × xlsx|pdf), reason `management_only`; **Floor Manager · Bar Manager · Head Chef · Store
    Manager · Manager · Administrator 200 on all four pages**, 200 on every API; **Captain · Cashier
    · Staff · no-role · section='GRE' 403 everywhere** (`role_not_gre` / `no_role_assigned`);
    junk cookie → 403 pages / 401 API; no cookie → 307 → `/login` / 401 API.
    **THE CONTROL PROVES THE FIX:** the same run copy with the `page-catalog.ts` door line commented
    out in BOTH functions, server restarted, everything else identical — **Floor Manager, Bar
    Manager, Head Chef and Store Manager go 403 403 403 403 while the API still serves them 200**;
    every other row is unchanged (GRE 200 200 200 403, Captain 403, Admin/Manager 200). Restored,
    server restarted, re-measured: the matrix returns to the first reading. `src` trees byte-identical
    to the worktree afterwards (`diff -rq` clean, page-catalog sha256 `59bfb85a…` on both).
    **THE LEVERS, re-proved on role config edited in the RUN COPY ONLY and restored:** GRE role given
    a list that never mentions the module → still 200 200 200 403; `["/feedback/tracker"]` → 403 403
    200 403; a **Captain** role carrying `/feedback` AND `/feedback/analytics` → **still 403 on all
    four** (`greOnly` is the floor, the door cannot widen); GRE role `is_active=0` → 403 on all four
    pages and the API, and the POS deny still answers `feedback_read_only` (no escalation).
  - ✅ **EVERY ROUTE GATES ITSELF, AND NONE OF THEM ANSWERS A WRITE.** 20 of 20: POST/PUT/PATCH/DELETE
    on all five routes → **403** with no CSRF header and **405** with a valid double-submit pair,
    GET and HEAD 200. **12 evasion attempts as a GRE all refused:** trailing slash and `//` → 308 and
    **403 when followed**, `..`-segment 403, query string 403, `?item_key=` 403, upper-case and
    `%61nalytics` → 404 (no route), four spoofed headers (`x-user-role: admin`, `x-role-name`,
    `x-forwarded-user`, `x-fnb-scope`) → 403. Cookie stuffing only ever yields the LAST
    `fnb_session` value's own rights — not an escalation, since it needs a token you already hold.
    The GRE's 403 page is the access card: 0 occurrences of any fixture name, item or payload key.
  - ✅ **THE GRE READ-ONLY DENY (96f3b66) STILL HOLDS, on REAL rows.** 13 of 13 forbidden writes →
    **403 `feedback_read_only`** (place order · add_item · set_qty · remove_item · fire · replay ·
    settle · void · print-bill · request-bill · discount · KDS bump · create table) against open
    order `p6a-o1` and KOT `a1bd9e7c…` in state `new`; reads still 200. Census byte-identical across
    the battery (`orders 65 · items 164 · Σqty 270 · kots 17 · tables 27 · guests 0 ·
    recipe_deducted 0 · purchases 2165 · materials 952`), `p6a-o1` still `open` with every bill stamp
    NULL and the KOT still `new`. **CONTROL:** the *same* add_item body as a **Captain** returned
    **200 and wrote the row** (`order_items 164→165, Σqty 270→271`) — so the refusals are the deny,
    not malformed requests; the row was deleted and the census returned to `164 / 270`,
    `integrity_check ok`.
  - **GATES — clean.** Over the branch's CODE files vs `main` (merge-base `98e1be7`, 25 code files):
    `lq_` 0 · `src/app/party-manager` 0 · `src/lib/pm/` 0 · `src/app/fssai` 0 · `src/lib/fssai` 0 ·
    `api/fssai` 0 · bare `fssai` 0 · `bill-handover` 0 · `boh_` 0; 0 changed file names touch a gated
    path. `npx tsc --noEmit` on the worktree → exit **0**. `npm run build` on the byte-identical tree
    → **exit 0**, "Compiled successfully in 26.9s", all five `/api/feedback/*` routes and four pages
    in the manifest; the only 2 warnings are the pre-existing `next.config.ts`/`sheets-client.ts` NFT
    traces. Worktree clean at `7158feb`; `/Users/shashankreddy/Desktop/Claude/fnb-controller`
    untouched (81 dirty files, **0** mentioning feedback or my prefixes). Server on **3985 killed,
    0 listeners, no process of mine left**; the sibling fleet on 3997 was verified still alive.
    **NO SOURCE FILE WAS CHANGED BY THIS LANE.** Nothing was deployed; the build-only gate stands.

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
6. **May a GRE seat a reservation?** 🔴 *Raised by the `the-gre-is-denied` probe, 2026-09-22, and it
   is the one place the read-only rule is currently breached.* `POST /api/crm-calls/bookings/[id]/seat`
   opens an order on the table (or edits the one already there) and is open to any signed-in user —
   measured, as an assigned GRE. Seating is plausibly the GRE's own job, so the fix is his call, not
   ours: (a) leave it and state in the code that seating is exempt; (b) deny the single `…/seat`
   path to a GRE; (c) deny `/api/crm-calls/bookings` wholesale — which also takes away creating and
   editing reservations. **Do not patch this without his answer** (rule 5, and the no-undo rule).
7. **Does "HOD" outrank "GRE"?** Ticking Head Chef/HOD on a GRE login — or on the GRE role — turns
   the POS read-only deny OFF (measured: add-item, bump and settle all 200). Same for retiering the
   role to manager. Intended (management already holds those powers), but he should know that the
   HOD checkbox has this side effect, and say whether a GRE-titled login should stay read-only
   whatever its tier.
8. **Which roles get `/feedback` in their page list?** 🔴 *Re-raised and quantified by the
   `floor-managers-and-null-role` probe, 2026-09-23 — this is a CONFIG blocker on the module being
   usable at all, not a code defect.* `canAccessPage` runs the module's `greOnly`/`mgmtOnly` gates
   FIRST (a Floor Manager passes them) and then applies the role's own `page_access` list, which
   refuses. Measured on this snapshot: **6 of 10 roles carry an explicit list and get 403 on all four
   pages** — `Floor Manager`, `Bar Manager`, `Head Chef`, `Store Manager` (all management, all of
   whom the module intends to admit), plus `Captain`, `Cashier`, `Staff` (correctly refused anyway).
   Only `GRE` and `Manager` (NULL maps) and `Administrator` pass. A Floor Manager today gets
   **403 on the page and 200 from `GET /api/feedback/floor`**. Adding `/feedback` to the role's list
   opens all four immediately (measured, then reverted — rule 5).
   **He must, in Settings → Roles:** (a) add `/feedback` to the **GRE** role — §2 does not record
   that role's `page_access` in production, so the four real GREs are unverified; and (b) decide
   whether **Floor Manager** (and any other manager role he wants on this module) gets it too. The
   spec says "GRE **or Floor Manager**", and Floor Manager cannot open a single page as configured.
   ✅ **ANSWERED IN CODE BY P4 LANE A (2026-09-23), and it is no longer a blocker — but he still has
   the lever.** `canAccessPage` gained one anchored line: for `/feedback*` the module's own gate
   decides, and a role's `page_access` list can only NARROW that, never widen it. So a list written
   BEFORE this module existed (which is every list in the database) no longer reads as a refusal,
   and Floor Manager / Bar Manager / Head Chef / Store Manager — and an assigned GRE whose role
   carries a list — open the pages the gate admits. **Nothing was written to any role.** What is
   still HIS: if he wants a management role kept OFF part of this module, he ticks any one feedback
   page for that role in Settings → Roles, and from that moment his list governs that role page by
   page (measured: `["/feedback/tracker"]` → tracker 200, the other three 403). A Captain cannot be
   let in by adding `/feedback` to their list — `greOnly` refuses first (measured).

9. **Does the Tracker's coverage table belong in front of a GRE at all?** The owner's spec puts the
   GRE/Manager progress table on Page 3, which is a GRE-accessible page, so it ships there — but it
   names other people's activity, and `/feedback/analytics` is management-only for exactly that
   reason ("it ranks NAMED STAFF"). The table carries no rating, ratio or score, only activity, so
   it satisfies the fairness ruling as written. If he would rather a GRE saw only their own row,
   that is a one-line filter on `scope: 'gre'` — his call, not ours.

11. **Should Page 4's filters be allowed to build a per-person card?** 🔴 *Raised by the
    `access-and-fairness` probe, 2026-09-23, and it is the one place the fairness ruling is currently
    breached.* The owner's own spec lists **GRE** among Page 4's filters, and the module honours it —
    but picking a name narrows the RATING SPLIT and the four red/amber tiles too, so the same GRE on
    the same four tables reads `Excellent 4 (100%) · Negative 0` if she records nothing and
    `Excellent 0 · Average 4 (100%) · Negative 4` if she records what the guests said, at identical
    coverage (33.3%) and identical "Feedbacks taken" (4). Seven of the eight downloads accept the
    same `&gre=` and print it into an e-mailable file. Three ways out, all cheap: (a) the GRE /
    Manager filter narrows only the RECORD-level sections (comments, menu items, recovery) and never
    the rating split or the negative tiles — the shape Page 3 already uses; (b) it narrows
    everything, but the filtered state replaces the rating block with "records <name> took" and
    carries the fairness sentence into the header and into every export; (c) the filter is limited to
    management logins reviewing their own recovery queue. **Recommend (a)** — it is the same rule the
    Tracker already proved, and it keeps the filter the owner asked for. Until he answers, the safe
    reading is that Page 4 must not be used to appraise a GRE.

12. **Eligible / Pending / Coverage % are reported for the FLOOR, never per person**, because
    nothing in this app assigns a table to a GRE. If he wants per-person coverage, he has to tell us
    what makes a table "theirs" — a floor/zone assignment per shift is the only honest candidate,
    and `users.preferred_zones` already exists but is not maintained. Until then, the page shows
    each person's real activity plus their share of the tables that were covered, and says in as
    many words why the denominator is the room.

- **2026-09-24 — P5 LANE C (THE FAIRNESS CRITICAL · the owner's floor denominator · the coverage
  disagreement · the self-contradicting workbook · the PDF column).** Files: `src/lib/feedback/
  reporting.ts` · `src/lib/feedback/zones.ts` (NEW) · `src/lib/feedback/labels.ts` (NEW) ·
  `src/app/api/feedback/{reports,tracker/query,floor}` · `src/app/feedback/{page,tracker/page,
  analytics/page}.tsx`. `src/lib/captain-area.ts` was READ and **not modified** — it governs captains.

  - ⚠️ **HOW THIS LANE STARTED, because the log must not read as if I wrote all of it.** The worktree
    already held **1,270 uncommitted lines** from a P5 lane that died mid-write (7 files edited, 2 new).
    I did **not** discard them and did not redo them: I read them in full, **reproduced every briefed
    defect against `HEAD` (715f604)** to prove they were real, then verified the inherited fix and
    added six of my own. Mid-lane a CONCURRENT session committed the tree as **`f83b30b`** ("Checkpoint
    … inherited from the lane that died") — that commit contains the inherited work **plus my
    then-in-flight edits**, and its own message says the evidence would follow in the next commit.
    This entry is that evidence. Nothing was reverted (no-undo rule). A stray `tsconfig.rig.json` from
    another lane's scratch build is untracked and was deliberately left alone, not committed.

  - **METHOD, AND WHY NO SERVER WAS BOOTED.** Every number below comes from the SHIPPED code driven
    directly: `src/lib/{feedback/reporting,feedback/zones,feedback/labels,hr-attendance,kot-section}`,
    `src/lib/feedback/{read,access}` and `src/app/api/feedback/{tracker/query,reports/route,floor/
    route}.ts` copied into a scratch harness with only the `@/` alias rewritten, `@/lib/db`,
    `@/lib/auth` and the two session gates replaced by stubs, run under Node 25's type stripping. The
    REPORT ROUTE IS THE REAL ONE, so the xlsx and PDF bytes are the real ones (`XLSX.write`, `pdfkit`,
    `buildReportPdf`) — 16 files per run, all HTTP 200. **Port 3946 was never used: 0 listeners, no
    dev server, no `.next`.** The worktree DB was only ever read (`?mode=ro` + `VACUUM INTO`); its
    mtime is still `Sep 22 18:41:50` and `fnb-controller.db-wal` is 0 bytes. Fixtures are all `fair-`
    and live ONLY in the scratch copy: 12 tables across **3 floors / 7 sections mirroring the
    production shape** (FA FB FBR SA SB SO TC), 12 orders, 4 GREs — **Anita = First Floor, Bela =
    Second Floor, Chitra = UNASSIGNED, "Silent Gre" = Terrace and records nothing.**
    ⚠️ **AN ENVIRONMENT TRAP THAT COST THIS LANE A RUN:** the wall clock jumped ~11 h mid-session
    (machine sleep), so fixtures stamped `14:03 UTC` fell into the PREVIOUS 04:00-IST business day and
    every probe measured an EMPTY universe (`eligible 0`, `floors []`) while exiting 0. The fixture
    builder now re-stamps into the current business day on every invocation.

  - 🔴 **(1) THE FAIRNESS CRITICAL — REPRODUCED ON `HEAD`, THEN CLOSED.** The flip: ONE GRE, the SAME
    six visits, the SAME tables; only what she wrote down changed. `?gre=Anita Rao`:

    | | records HONESTLY | records "everything good" |
    |---|---|---|
    | **HEAD (715f604)** | Exc 0 · Avg **6 (100 %)** · NEG **6/6** · R/R/R 6 · pendFU 2 · complained `Chicken Tikka:6` | Exc **6 (100 %)** · NEG **0** · R/R/R 0 · pendFU 0 · complained — |
    | **now** | Exc 2 · Good 1 · Avg 6 · NEG 7/7 — **byte-identical to the UNFILTERED page** | Exc 8 · Good 1 · NEG 1/1 — **byte-identical to the UNFILTERED page** |

    Coverage read 45.5 % in BOTH HEAD columns, so the incentive was purely in the sentiment sections:
    the honest GRE looked worse under her own name. **The structural proof, a deep diff of the whole
    payload, filtered vs unfiltered:** HEAD moved **13 paths** (`summary.feedback_taken`,
    `coverage_pct`, `excellent`, `good`, `everything_good`, `negative_item_feedbacks`,
    `item_feedbacks`, `menu_items`, `common_problems`, `most_complained`, `recovery`,
    `gre_performance`, `daily`); now it moves **4** — `filters.gre`, `person`, `meta.counts_scope`,
    `meta.person_filter_active` — and only `person` carries data. Under the flip the person block
    moves in **exactly three fields, all credits**: `issues_recorded` 6→0, `follow_ups_raised` 2→0,
    `follow_ups_open` 2→0. `tables_visited 5`, `taken 6`, `feedbacks_recorded 7`,
    `area_coverage_pct 80 %`, `off_area_visits 1` are **identical in both worlds**, and the block
    carries **zero** keys matching rating/excellent/good/average/poor/negative/happy/score/unrated.
  - **AND IT NO LONGER LEAVES THE BUILDING.** Same flip, through the REAL route, `daily.xlsx` headed
    `GRE: Anita Rao`: HEAD printed `Excellent 0 / Average 6 (100.0%)` honest against
    `Excellent 6 (100.0%)` silent. Now the **Rating split sheet is byte-identical to the unfiltered
    workbook's** in both worlds (sha `8baf057a…` / `f590f9cb…`, filtered == unfiltered both times),
    a **"What Anita Rao did" sheet is present on 8 of 8 reports** carrying only the owner's five
    metrics, and every export now states in words *"it fills in the 'What <name> did' sheet and
    changes NOTHING else in this file … Do not read this file as an appraisal of them."*

  - 🔒 **(2) THE OWNER'S FLOOR RULING — A DEFAULT, NOT A RESTRICTION. `src/lib/feedback/zones.ts`,
    SELECT-only, and `captain-area.ts` untouched.** Why it is not reused: `captainAreaFilter()` is
    gated on `captain_area_lock`, which has **0 rows** (re-measured on the worktree DB), so it returns
    `null` for everybody; switching it on would start restricting CAPTAINS mid-service. `zones.ts`
    reads the same two columns and copies the same conventions (`''` ⇄ `'Floor'`, unassigned = all).
    · **NOBODY IS RESTRICTED, measured:** `GET /api/feedback/floor` for 7 viewers (each GRE, a Floor
      Manager, a manager assigned to the Terrace, and a viewer whose `preferred_zones` is malformed)
      returns the **SAME 13 rows across all 3 floors** — `DISTINCT BOARDS ACROSS ALL VIEWERS: 1`. Only
      `my_floors` / `area_label` / `area_note` differ.
    · **PAGE 1 OPENS ON HER FLOOR, ONCE.** The default block and the `floorOptions` memo were
      extracted **verbatim** from `src/app/feedback/page.tsx` (byte-identity asserted) and run: first
      board → `First Floor`; nine more 10-second refreshes → still `First Floor`; **she switches to
      Second Floor and the refresh does NOT drag her home**; unassigned → `all`; TWO assigned floors →
      `all` (picking one would hide the other); a payload with no `viewer` block → `all`, no crash.
      Every floor stays in the selector (`['all','First Floor','Second Floor']`), her own is marked
      `(yours)`, and an assigned floor with nothing open is still offered as `(yours) (none open)`.
    · **COVERAGE IS MEASURED AGAINST HER FLOOR, and both pages agree:** Anita `4/5 = 80 %` with
      `1 off-floor`; Bela `2/4 = 50 %`; **Chitra (unassigned) `—`, measured venue-wide exactly as
      before**; **"Silent Gre" (assigned Terrace, recorded nothing) `0/2 = 0 %`** — the row the page
      exists to show.
    · **WHERE THE OFF-FLOOR VISIT WENT (the brief asks this explicitly):** it counts three times and
      vanishes nowhere — inside her `tables_visited`/`taken`, inside the ROOM's coverage numerator,
      and named separately as `off_area_visits` so the help is visible. It is deliberately NOT in her
      floor denominator, so helping upstairs can never read as a shortfall.
    · **13 zone cases asserted**, including all three malformed `preferred_zones` forms (`not json`,
      an object, a number) degrading to **unassigned = measured against everything** — over-measure,
      never under-measure, because the other direction prints a fake 100 %.
    · 🐞 **A COMMENT THAT PROMISED WHAT THE CODE DID NOT.** `zones.ts` claimed "a management user comes
      back as AREA_UNASSIGNED"; nothing in it tests a tier. The comment now states the truth (the area
      is the PERSON's own assignment, whoever they are; 0 users of any tier hold `preferred_zones`
      today, so management comes back unassigned in fact) and says why a tier test was not added.

  - 🐞 **(3) HIGH — THE COVERAGE DISAGREEMENT, REPRODUCED AND CLOSED.** Same service, no filters, same
    database: **HEAD → Page 3 `13 eligible / 10 taken / 76.9 %` vs Page 4 `12 / 9 / 75.0 %`.**
    **Now → `12 / 9 / 75.0 %` on both.** **PAGE 4's DEFINITION WAS THE RIGHT ONE** and Page 3 adopts
    it: the denominator is the tables that were OWED a visit and the numerator the visits ON those
    tables. Page 3 had padded BOTH sides with a visit to a table nobody was owed, so its ratio drifted
    toward 100 % as a GRE visited more tables nobody asked for. Nothing disappeared — the extra visit
    is still a row, still in the chips, and is now counted by name (`extra_visits 1`,
    `feedbacks_recorded 10`) on BOTH pages.
    · 🐞 **AND THE SAME DISEASE ONE LEVEL DOWN, found by this lane:** Page 3's progress table has
      carried "Tables" (DISTINCT tables) and "Taken" (eligible visits) since 7158feb; Page 4 had one
      field computed as Page 3's *Taken* and labelled *Tables visited*. Proved with **one table
      seating two parties in one service**: HEAD → Page 3 `Tables 6 / Taken 7` vs Page 4 `Tables 6`
      with no Taken and `share undefined`, **5 of 5 rows disagreeing**; now → `Tables 5 / Taken 6`
      on both, **0 rows disagreeing**, and `share_pct` uses Page 3's rule on both.

  - 🐞 **(4) HIGH — THE WORKBOOK CONTRADICTED ITSELF; NOW IT RECONCILES ON ITS OWN FACE.**
    HEAD, one `daily.xlsx`: Summary **"Feedbacks taken 8"** beside a Rating split accounting for
    **9** (weekly/monthly 12 vs 13; and 5 vs 6 under `&gre=`). Now: `Feedbacks recorded 10` = Rating
    split `10` = a printed **"Total feedbacks recorded"** row, the Share column **sums to 100.0 %**
    (HEAD divided the four ratings by "rated only" and Not-rated by "rated + unrated"), and
    `meta.reconciles` carries the three invariants **all true on all 8 reports** — rating split,
    coverage split, `covered <= eligible`. Two named numbers replace one overloaded one:
    `feedbacks_recorded` (every visit) vs `eligible_tables_covered` (the coverage numerator).

  - 🐞 **(5) HIGH — TWO DIFFERENT DISHES PRINTED AS THE SAME PDF ROW.** Measured over the **628 real
    menu items** with the renderer's OWN `doc.widthOfString` at its own geometry (A4, margin 40,
    PAD 4, Helvetica 8) and its own `fit()`:

    | | Item column | printed in full | identical printed rows |
    |---|---|---|---|
    | HEAD widths + hard truncate | 103.2 pt | 477/628 | **28 rows swallowing 58 names** |
    | widened columns ALONE | 127.1 pt | 562/628 | **11 rows — not enough** |
    | widened + `fitPrint` (shipped) | 127.1 pt | 562/628 | **0 — 628 of 628 distinct** |

    **END TO END in a rendered PDF**, the pair the brief names: HEAD printed `AG FORTYSEVEN CHAR…`
    **twice** (a bottle of wine and a glass of it as one row) and `GODAWAN 01 RICH AND…` twice; now
    `AG FORTYSEVEN …NAY BOTTLE` vs `AG FORTYSEVEN…NNAY GLASS` and `GODAWAN 01 RIC…ED - BOTTLE` vs
    `…UNDED 30ML`. **The xlsx keeps the FULL string — 0 ellipses anywhere in the workbook** — because
    people sort and VLOOKUP on it.
    · 🐞 **THE UNIQUENESS PROMISE WAS PROBABLE, NOT TRUE.** One `#tag` pass sufficed for 628 items but
      two names sharing a 3-char FNV tag AND an elided form would collide again. `printableLabels()`
      now re-tests and widens until unique. Stressed: 40 names differing only in the middle are unique
      at 90 pt, at 40 pt and at 12 pt (where nothing fits); and a **REAL** tag collision hunted out of
      400,000 candidates (`COLLIDE 138 …` / `COLLIDE 466 …`, both `54c`) resolves to `#wy4` / `#y18`.
    · **EVERY column, not just the one in the brief:** all 8 reports × filtered and unfiltered ×
      1-floor and 3-floor GRE → **16 fitPrint columns, 0 failures, and 0 truncated cells or headings
      anywhere.** Getting there cost three rounds of measurement (my own longer help strings
      truncated the person sheet's Measure/Value/Basis columns, and a 3-floor `area_label` overflowed
      at 123.0 pt into 115.9 pt — it is now summarised as `First Floor +2 more`).

  - 🐞 **(6) MEDIUM/LOW CLOSED BY THIS LANE.**
    1. **The GRE who recorded NOTHING now exists on Page 4.** `grePerformance()` is seeded from the
       people who HOLD the role (active role, active user), not from visits — the same thing Page 3
       does and for the same reason. Measured: `Silent Gre` and `QA Gre` both appear with
       `kind: 'assigned'`, 0 everywhere, and the workbook note says that row is the point of the table.
    2. 🔒 **GUEST RECOVERY WAS STILL READABLE BACKWARDS, and it is one of the owner's five metrics.**
       A GRE with two complaints not yet revisited printed `0.0%`; a GRE who recorded none printed
       `-` in the same column — the honest one looked worse, and `-` **sorts above** `0.0%`. It now
       prints as a QUEUE that carries its own denominator: `0/2 · 0.0%` in tables, `0.0% - 0 of 2
       closed` on the person sheet, and **`none raised` in words** where there is nothing to close,
       with `RECOVERY_IS_A_QUEUE` on screen and in every export saying *"Never read 'none raised' as
       better than an open queue — it is the OPPOSITE way round."*
    3. **The Tracker's floor-total row printed under the wrong headings** — `N pending` sat in the
       "Issues rec." column, so the venue looked as though it had recorded that many complaints. Every
       cell now sits under its own heading, and the total row carries real totals.
    4. **`COVERAGE_PER_GRE_UNAVAILABLE` had become false.** It said flatly that coverage per person
       has no honest denominator; that is now true only of an UNASSIGNED person, and the sentence says
       so.
    5. **The screen says which layer each number belongs to.** `meta.counts_scope` prints above the
       Dashboard whenever a name is selected, and the Dashboard's own hint reads *"the whole selected
       floor / captain / period — NOT the person above"*.

  - **DELIBERATELY LEFT OPEN, with reasons.** ⚠️ The brief asked for "the 12 MEDIUMs recorded in the
    state file". **There are not 12 — this file records 2 MEDIUMs and 2 LOWs from the P6 probe plus 4
    MEDIUMs P2 Lane B left open, and I am not inventing eight more.** Of the eight real ones, five are
    closed above and three are left, all outside this lane's authority:
    · **`page_access` narrows PAGES, not API routes** (P6's MEDIUM). The routes gate on
      `feedbackAccess()`, which never reads `page_access`. Mirroring page lists into API gates is an
      app-wide policy change affecting every module, not a feedback fix — rule 5, and it needs the
      owner. Mitigating facts re-checked: no money and no guest PII on any of those payloads, and
      `/api/feedback/analytics` + all 16 report combinations still 403 a GRE.
    · **The Sidebar's actor carries no `role_is_active`**, so a DEACTIVATED GRE role still shows the
      three nav rows, which then 403. The fix is in `/api/auth/me` + `Sidebar.tsx` — not my files.
    · **The HOD checkbox switches the POS read-only deny off** (open decision 7) — owner's call.
    · Also unchanged on purpose: `readOrderForFeedback()` is still not board-scoped (P3 needs older
      orders and it returns no money), and `FloorRow.in_grace` is still derived from
      `order_status === 'settled'` (correct because the SQL already bounds settled rows).
    · ⚠️ **ONE THING THE OWNER MAY WANT TO RULE ON, found while measuring and NOT patched.** A
      person's floor coverage counts the visits **they** made. When a colleague covers a table on
      their floor, the room's coverage rises but that person's own figure does not (Bela reads
      `2/4 = 50 %` on a floor where 3 of her 4 tables were in fact visited, one of them by Anita).
      That does not breach the ruling — nothing improves by recording less — but it is a judgement
      about whether "her floor's coverage" means *she* covered it or *it got covered*. `off_area_visits`
      already shows the helper's side. Left as measured, not guessed at.

  - **NO REGRESSION, and the read rail is still a read rail.** 37 reads through every entry point
    (7 filter combinations × analytics + item-comments + tracker, then all 16 downloads) left the
    database **byte-identical** (sha before == after), census `orders 66 · items 170 · Σqty 216 ·
    visits 14 · item_fb 11 · follow_ups 2 · tables 27 · users 19 · purchases 2165 · raw_materials
    952`, `integrity_check ok`. All five `/api/feedback/*` route files export **`GET` and nothing
    else**; zero SQL write verbs outside comments in any of my six files. `npx tsc --noEmit` exit
    **0**, zero output. Gate patterns over every changed file: `lq_` 0 · `party-manager` 0 ·
    `lib/pm/` 0 · `fssai` 0 · `bill-handover` 0 · `boh_` 0. **Nothing was pushed and nothing
    deployed — the build-only gate stands.**

- **2026-09-24 — P5 LANE B (the export/PDF half: independent verification, and the four things the
  PDF was still getting wrong AT PRODUCTION SCALE).** Files: `src/lib/feedback/reporting.ts` only —
  the sheet-building and PDF-layout functions. **NO SERVER WAS BOOTED** (load average was 79 at lane
  start). Method: `VACUUM INTO` snapshot, the real `reporting.ts` / `tracker/query.ts` / `labels.ts` /
  `report-pdf.ts` compiled to CommonJS with `tsc` and called directly, and **real PDFs rendered
  through the exact `pdfFor()` pipeline from `reports/route.ts`** then read back with `pdftotext`.
  Ran CONCURRENTLY with Lane C; where we overlap this entry is an INDEPENDENT second measurement
  with different fixtures, and it agrees with theirs.

  - ✅ **THE THREE BRIEFED HIGHs — VERIFIED FIXED, EACH WITH A CONTROL.**
    1. **The coverage disagreement.** Fixtures built to the brief's own shape (7 eligible tables, 5
       covered, 1 visited-but-never-eligible): Page 3 and Page 4 now both read **7 eligible / 5 taken
       / 71.4 %**, and agree on `feedbacks_recorded 6` and `extra_visits 1`. **CONTROL** — the same
       fixture, same database, with only the numerator/denominator reverted to `today.length`:
       **Page 3 reads `8 eligible / 75.0 %` against Page 4's `7 / 71.4 %`**, which is the brief's
       measured pair exactly. **PAGE 4's DEFINITION IS THE RIGHT ONE** and Page 3 now uses it: the
       denominator is the tables that were OWED a visit and the numerator is the visits on those
       tables. The old version put a visited-but-not-owed table into BOTH sides, so coverage drifted
       toward 100 % as a GRE visited tables nobody was owed — a coverage figure that improves without
       covering anything, which is the fairness ruling breached from the other direction.
       They also agree **per floor**, i.e. about the new floor-scoped denominator: First Floor
       `3/3/100 %`, Second Floor `3/2/66.7 %`, Terrace `1/0/0 %`, P3 == P4 on every one.
    2. **The self-contradicting workbook.** **184 assertions across all 8 reports × 4 filter states,
       0 failures**: Summary "Feedbacks recorded" == the Rating split Total row, the rating rows sum
       to that total, the shares sum to 100 %, `By day` Σeligible/Σtaken == the summary, and the
       three `meta.reconciles` invariants hold. Re-run after my own edits: **32/32 combinations
       internally consistent.**
    3. **The PDF menu column.** Over the **628 real menu names**, measured with the renderer's own
       `doc.widthOfString` at Helvetica 8: BEFORE **151 truncated and 58 names collapsed into 28
       identical strings**; WIDENING ALONE still left **22 names in 11 identical strings** (so the
       widening was NOT sufficient on its own and the `labels.ts` pass is load-bearing); SHIPPED
       **628 of 628 distinct, 562 printed in full, 0 over the column**. Confirmed in a REAL rendered
       PDF: 671 menu rows parsed out of `pdftotext`, **0 printed names appearing twice**, and the
       distinguishing tail survives (`AG FORTYSEVEN …NAY BOTTLE` vs `AG FORTYSEVEN…NNAY GLASS`).
       `printableLabels()` was also stressed adversarially: a **forced 20-way `nameTag` collision**,
       5,000 shared-head names, unicode/emoji, duplicate and empty inputs, and order-shuffling —
       **uniqueness held in every case** (the tag loop is genuinely a guarantee, not a probability).

  - 🐞 **AND THEN THE ONE NOBODY HAD MEASURED: A TRUNCATED PERCENTAGE INVERTS ITS OWN MEANING.**
    The briefed PDF defect was about menu names. The same renderer was doing something worse to the
    **GRE / Manager Performance** report, and it only appears at the owner's REAL scale — the local
    snapshot has 3 tables, production has **292 across 3 floors (First Floor 188, Second Floor 100,
    Terrace 4)**. `report-pdf.ts` tail-chops every cell, and `Their floor` had 45.0pt of usable width
    against a 58.3pt cell, so **in a real rendered PDF**:

    | | as committed at `f83b30b` | fixed |
    |---|---|---|
    | Bharath, covered **every** table on his floor | `188/188 1…` | `188/188 100.0%` |
    | Nisha Sharma, 25 of 100 | `25/100 25…` | `25/100 25.0%` |

    **A GRE who covered 188 of 188 tables printed a coverage of "1…", which a manager reads as 1 %.**
    The best possible row printed as the worst possible number, in a file that gets e-mailed — the
    fairness ruling breached by the RENDERER rather than by the query. Both PDFs above were rendered
    from the same payload differing only in the width integers.
    **Root cause, worth naming:** the widths had been sized to the HEADING ("measured minimums … with
    the remainder to Person"), which is the wrong bound for a right-aligned number column — the
    heading is short and the cell is long. Every width in that table is now
    `max(heading @ Helvetica-Bold 8, CEILING CELL @ Helvetica 8) + 2*PAD`, and the ceilings are
    **provable, not guessed**: 292 tables is the whole venue, so `"292/292 100.0%"` is the widest
    `Their floor` cell that can ever exist. `Recovery` 62 → 72 for the same reason (`100/100 · 10…`).

  - 🐞 **A KPI `sub` IS ONE HARD-TRUNCATED LINE, AND FOUR OF THEM WERE BEING CUT MID-WORD.**
    `report-pdf.ts:224` renders each tile's sub with `fit(doc, k.sub, cellW - 12)` at Helvetica 7.5 —
    153.09pt, no wrapping. Measured at production scale, the two that mattered:
    · `"threshold 4 items (default), or bill asked / printed"` (159.8pt) printed as
      `"… or bill asked / pri…"` — **losing the word PRINTED, one of the owner's three eligibility
      triggers**, on the tile that explains the denominator;
    · `"213 on eligible tables + 79 on tables that never met the trigger"` (205pt) printed as
      `"… + 79 on tables that n…"` — and **that sentence is the one that reconciles the Summary
      against the Rating split**, i.e. the fix for HIGH #2 was itself unreadable in the PDF.
    Both are now measured against 153.09pt at four-digit worst-case numbers.

  - 🐞 **A VENUE NUMBER ON A PERSON'S CARD (§6 2026-09-23 LOW) — CLOSED.** Measured: with three
    complaints open venue-wide, `GET …&gre=<name>` produced a workbook headed with that person's name
    whose "Follow-ups open now (all dates)" tile read **3 with an EMPTY sub** — for a GRE who had
    raised **none**. It diverges from the person's own figure by construction (venue 3; the three
    GREs' own counts 2, 1 and 0). The tile now says `Whole venue, all dates - NOT this person's.`
    and — because a NAME cannot be fitted into 153pt (`"not Nisha Sha…"`) — the naming sentence goes
    into `footnotes`, which DO wrap: *"…is the WHOLE VENUE's open queue, not Pushpa's: 0 of those are
    theirs."* Verified in the rendered PDF. The `guest-recovery` sheet gained the matching second row.

  - ✅ **THE EXHAUSTIVE AUDIT, which is the real generalisation of HIGH #3.** Every heading, every
    cell and every KPI label/value/sub, across **8 reports × 5 filter states at production scale
    (292 tables, 628 menu items): 36,365 rendered strings — 0 over their column, 0 over the tile,
    0 pairs of distinct values printing the same string.**
    **CONTROL at `f83b30b`, same harness, same fixtures: 73 cell overflows + 15 KPI overflows = 88.**
    Attribution, so this log does not overclaim: **24 of the 88 are mine** (`By person/Their floor` 9,
    KPI subs 15); the other 64 (`What <name> did` Basis/Value) were closed CONCURRENTLY by Lane C's
    copy edits, which is why the combined tree measures 0.

  - ⚠️ **MEDIUM LEFT OPEN, DELIBERATELY, WITH THE MEASUREMENT.** The `Floor` column (58.04pt usable)
    fits every SINGLE-floor value — `First Floor` 36.0 · `Second Floor` 47.6 · `Terrace` 26.5 · `all`
    8.0 — and elides the **multi-floor** ones (`First Floor / Second Floor` is 90.2pt). 4 of the 8
    possible values on 3 floors therefore print elided, e.g. `First Floor / S…`. It is NOT ambiguous
    (the column is `fitPrint`, so the audit above proves 0 collisions) and the single-floor case is
    the norm the owner's ruling describes. Widening it enough for the 3-floor case needs 128 of the
    table's 515 points, which would re-truncate the numbers. The honest alternatives are a deliberate
    abbreviation (`First / Second`, since the column is already headed "Floor") or printing `2 floors`
    — **both change the xlsx too**, so this is a wording call rather than a bug fix, and it is left
    for the owner rather than guessed at.

  - ⚠️ **THE BRIEF'S "12 MEDIUMs in the state file" DO NOT EXIST — reported rather than invented.**
    §6/§7 record **3 MEDIUMs and 2 LOWs**, not 12. Of the ones that fall in this half, measured
    against the shipped code: **§6:1047 (the GRE who recorded nothing has no row) is FIXED** —
    `Pushpa`, holding the GRE role with 0 visits, prints in the rendered PDF as
    `Pushpa · Terrace · 0 · 0/4 0.0%`, and `Swetha` with no floor assignment prints `-` rather than
    an invented denominator; **§6:1054 (recovery reads worse for a recorder) is MITIGATED and left** —
    `recoveryCell()` prints `0/2 · 0.0%` beside `none raised`, carries its denominator, the ordering
    is by activity and never by the ratio, and the sheet note says in as many words that *"none
    raised" must never be read as better than an open queue*; removing it would delete one of the
    five metrics the owner NAMED; **§6:1062 is CLOSED above**.

  - **NO REGRESSION, AND THE WORKTREE DATABASE WAS NEVER WRITTEN.** Its mtime is still
    `Sep 22 18:41:50`; read-only census `purchases 2165 · raw_materials 952 · orders 53 · gf_visits 4
    · menu_items 628`, `integrity_check ok`, and **0 rows** carrying this lane's `lnb-` / `pw-`
    prefixes — every fixture lived only in scratchpad copies made with `VACUUM INTO`.
    `npx tsc --noEmit` exit **0**, zero output. Gate patterns over the branch's whole code diff vs
    `main`: `lq_` 0 · `src/app/party-manager` 0 · `src/lib/pm/` 0 · `src/app/fssai` 0 ·
    `src/lib/fssai` 0 · `api/fssai` 0 · `bill-handover` 0 · `boh_` 0; 0 changed file names touch a
    gated path. **No server was booted, no port was opened, nothing was pushed and nothing was
    deployed — the build-only gate stands.**
