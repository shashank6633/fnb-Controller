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
| P2 | Page 1 Floor Feedback + the READ-ONLY guarantee, proved server-side | **DONE (A + B)** | §6 2026-09-22: GET-only routes (405 with CSRF, 403 without), 40 reads → census identical, 6-persona gate, all 5 statuses live, `tunable()` zero-default bug fixed, tsc 0. **Part (B) IS NOW APPLIED** — one prefix deny at ONE boundary (`src/lib/feedback/pos-readonly.ts` + `src/proxy.ts`), zero POS route handlers edited, 23/23 forbidden writes refused for an assigned GRE, 115/115 non-GRE writes untouched. |
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
