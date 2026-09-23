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
| P2 | Page 1 Floor Feedback + the READ-ONLY guarantee, proved server-side | **DONE (A + B)** | §6 2026-09-22: GET-only routes (405 with CSRF, 403 without), 40 reads → census identical, 6-persona gate, all 5 statuses live, `tunable()` zero-default bug fixed, tsc 0. **Part (B) IS NOW APPLIED** — one prefix deny at ONE boundary (`src/lib/feedback/pos-readonly.ts` + `src/proxy.ts`), zero POS route handlers edited, 23/23 forbidden writes refused for an assigned GRE, 115/115 non-GRE writes untouched. **Lane B (read/board/catalog) closed its three HIGHs + 7 MEDIUMs** — elapsed proved against a known instant, a business-day exit for the never-settled order, tier flags proved per persona; 120 reads → census identical. **Probe `the-gre-is-denied` (2026-09-22, port 3954, no code changed): 87/87 state-changing POS requests refused against REAL rows with zero writes, the same requests measured WRITING for six other personas — but the claim is falsified once, by `POST /api/crm-calls/bookings/[id]/seat`, which opens/edits an order for any signed-in user (§6, §7 items 6-7).** |
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
