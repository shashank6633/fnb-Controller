# FSSAI COMPLIANCE — DURABLE BUILD STATE

> **This file is the single source of truth for the FSSAI build.** A scheduled task re-reads it
> every 30 minutes with NO memory of the conversation that started this. Everything needed to
> resume is written here. Keep it current: a phase is not finished until its row says `DONE`
> and its evidence line is filled in.

---

## 0. THE GATE — READ THIS FIRST, EVERY TIME

**The owner's words, verbatim (2026-09-16):**
> *"After i say Deploy FSSAI then only Deploy this module Just Build and develop."*

**NEVER deploy this module. NEVER merge this branch to `main`. NEVER run `gh workflow run deploy.yml`.**
Build only. The owner deploys, and only after he types **Deploy FSSAI**.

This is the third standing gate in this project, alongside:
- **Liquor Reconciliation** — held until he says *"Deploy Liqour Reconcilation"*
- **Akan Party Manager** — held until he informs

Every deploy bundle carved from the main repo must prove, with a command and its real output,
**three zero-counts**: zero `lq_`/liquor paths, zero `party-manager`/`src/lib/pm/` paths, and zero
`fssai` paths. Never assert a count. Show the `0`.

> **⚠️ GREP THE SIGNATURE, NOT THE WORD (measured 2026-09-17).** A bare `grep -ri fssai src/` in the
> live repo returns **11**, and always has. Those are the **FSSAI licence number printed on a
> customer bill** — `src/lib/bill-pdf.ts`, `src/lib/offline-print/print.ts`,
> `src/app/settings/print-design/page.tsx` — committed at live HEAD since 2026-07-16 and legally
> required on an Indian restaurant bill. They are **not** this module. A carve check that greps the
> bare word will fail forever on a clean repo, and the next person will either "fix" innocent
> billing code or learn to ignore the gate. Check these four instead; all are `0` in the live repo
> today:
> ```
> grep -r 'fssai_' src/                                   # the table prefix
> grep -r "'/fssai" src/                                  # the twenty nav paths
> ls -d src/app/fssai src/app/api/fssai 2>/dev/null       # the module's directories
> ls src/lib/fssai.ts 2>/dev/null                         # its vocabulary module
> ```

**Structural protection:** this module lives in an isolated git worktree on branch
`fssai-compliance`, never on `main`. That is deliberate — the code physically cannot enter a
deploy bundle by accident.

| | |
|---|---|
| Worktree | `/Users/shashankreddy/Desktop/Claude/fnb-fssai` |
| Branch | `fssai-compliance` (forked from `main` @ `4125237`) |
| Live repo (DO NOT BUILD HERE) | `/Users/shashankreddy/Desktop/Claude/fnb-controller` |

---

## 1. HARD RULES — these bind every agent, every phase

1. **NO DEPLOY, NO MERGE, NO PUSH.** See §0. You may commit *to the `fssai-compliance` branch
   inside this worktree only* — that is how work survives a crash. Never `git checkout` / `restore`
   / `reset` / `clean` in the LIVE repo at `fnb-controller`: it holds ~62 files of uncommitted work
   across three other lanes, including ~506 lines of gated liquor work in `src/lib/db.ts`.
2. **NEVER TOUCH THE LIVE REPO.** All work happens in this worktree. Three other fleets are live in
   `fnb-controller` (WhatsApp W3, Stock Movements, Party Requisitions). Their uncommitted churn is
   theirs, not a defect of yours.
3. **DO NOT REDESIGN THE APP.** The owner: *"Do not redesign the complete application. The new FSSAI
   Compliance module must look and behave like a native part of the existing F&B Controller."*
   Reuse existing components, APIs and conventions. Match the surrounding code's idiom.
4. **DO NOT CHANGE PRODUCTION MAPPINGS.** Station→department, departments and roles are the owner's
   to set in the app. Read them; never write them.
5. **DO NOT CHANGE THE MATERIAL-MOVEMENT FLOW.** Frozen by the owner, verbatim: *"Central Store
   --issue via requisition--> Department Stock --recipe consumption at KOT complete--> consumed"*.
   FSSAI observes and records. It never moves stock.
6. **DB SAFETY.** `fnb-controller.db` is real data in WAL mode. Never open the live one read-write.
   Snapshot only with `sqlite3 "file:<path>?mode=ro" "VACUUM INTO '<dest>'"` — a plain `cp` loses the
   WAL. Verify `purchases = 2165`. `better-sqlite3` is **SYNCHRONOUS** — never `await` its calls.
   `DB_PATH = path.join(process.cwd(), 'fnb-controller.db')`, so a server started in this worktree
   writes THIS worktree's DB. Never start one in the live repo.
7. **SCHEMA HAS NO MIGRATION FRAMEWORK.** All schema lives in `initializeSchema()` in
   `src/lib/db.ts`, and **it swallows schema errors silently** — a migration that never ran looks
   identical to one that worked. Always prove columns exist afterwards, on a fresh empty DB *and* on
   a real snapshot.
8. **THE SIDEBAR/CATALOG DRIFT TRAP.** `src/components/Sidebar.tsx` keeps its OWN nav tree;
   `src/lib/page-catalog.ts` gates pages. A page in only the catalog is gated and **invisible**
   (this once hid 8 pages including `/variance-approvals` and looked like a stock bug). A page in
   only the sidebar is visible and **ungated**. Always edit BOTH.
9. **`tsc` IS THE ONLY TYPE GATE.** `next.config.ts` sets `typescript: { ignoreBuildErrors: true }`,
   so `next build` passing proves **nothing** about types. Always run `npx tsc --noEmit`.
10. **AUTH REALITY.** `src/proxy.ts` (the renamed middleware) guards **PAGES, NOT APIs**, and
    `canAccessPage` **fails OPEN in four ways**. Every API route must gate itself. Tier flags
    (`adminOnly` / `mgmtOnly` / `hodOnly`) are the real gate. `hodOnly` = HODs (`is_head_chef`) +
    admins, **excluding managers**. State-changing calls need the `fnb_csrf` cookie + `x-csrf-token`
    header.
11. **PURCHASE UNIT LEADS.** Owner rule: every Purchase and Inventory screen leads with the
    **purchase unit**, recipe unit secondary. Stock is stored in recipe units; `pack_size` converts.
    Use the existing DualQty layer — 293 sites were converted to this law.
12. **EVIDENCE, NOT ASSERTION.** Every claim carries the command that produced it and that command's
    real output. "Verified" with no transcript is a defect. If you could not prove something, say so
    — that is a valid and valued answer.
13. **NEVER SAY "DONE" WITHOUT THE CHECKLIST.** Verify end-to-end: UI, UX, DB, API, security, PWA,
    calculation, regression. Never ship partial work silently.
14. **`nginx client_max_body_size` IS 1 MB** in production — photo evidence uploads must either stay
    under it or be chunked/compressed client-side. A larger upload returns 413. Decide this
    deliberately in P3 and write the decision down.

---

## 2. THE ARCHITECTURE DECISION (settled — do not relitigate)

The owner's §24 requires: *"Design the backend so that checklists are dynamic and configurable
rather than creating a separate database table for every checklist."*

**Therefore twelve of the twenty sub-modules are SEEDED CONFIGURATION, not code.** Food Quality (§6),
Cleaning & Sanitation (§8), Personal Hygiene (§9), Food Storage (§10), Kitchen Safety (§11) and the
daily FIFO checklist (§3) are all the same object — a template with sections, typed questions, a
frequency, a department, a responsible role and pass/fail conditions. They ship as **rows**, so the
owner edits them in Settings when regulations change instead of waiting for a developer.

**Only records with a genuinely different SHAPE get their own tables:** Receiving QC (per-line
accept/reject against a GRN), Temperature & Cold Room logs (a reading against a configured range),
FIFO/FEFO (batch + expiry), Pest Control (vendor service + separate sightings), Oil, Water,
Documents & Certificates, Corrective Actions.

This is the difference between ~10 tables and ~45.

**Table prefix: `fssai_`** — every table this module adds. That prefix is also what the deploy gate
greps for, so it is not merely a convention.

---

## 3. INTEGRATION CONTRACT — reuse, never duplicate (owner's §21)

| FSSAI needs | Existing source — READ, never duplicate |
|---|---|
| Items | `raw_materials` (Item Master) |
| Suppliers | `vendors.id`. ⚠️ **`store_vendors` is NOT a table** — it is a JSON key computed in `api/stores/[id]/stock/route.ts:158` |
| Receiving | `purchases`, `goods_receipt_notes`, `purchase_orders` |
| Batches / FIFO | Kitchen Production batches + barcode (`production_batches`, `PROD######`) |
| Departments | existing departments table — **read only** (HARD RULE 4) |
| Employees | HRMS people tables |
| Equipment / cold rooms | ⚠️ **There is no equipment master.** `hr_assets` is a staff-issued-item register (uniform/ID card). Cold units exist only as free text in `production_batches.storage_location` — live values: `Cold Room 1/2/3`, `walkin chiller 1`. So `fssai_equipment` is NOT duplication; seed `location_label` from those exact strings so existing batches join |
| Maintenance tasks | existing Maintenance module |
| Corrective-action tasks | existing Task Manager |
| Stores | `store_locations`, `store-engine.ts` |
| Roles / permissions | `roles` + `users.role_id`. ⚠️ `roles` has **`base_role`, not `tier`** (`db.ts:2803`). And gating is **inert in production**: `role_id` set on 0 of 9 users, `page_access` NULL on 8 (NULL = all pages). Only tier flags + each route's own check actually hold |

**A new item master, vendor master or employee master is an automatic CRITICAL defect.**

⚠️ **`hr_employees` is EMPTY (0 rows).** Owner §21 says employee names come from HR — they cannot today.
Use `users.email` as the actor reference until he populates HR. Raise it at the review gate.

The full, measured contract with the trap for every master is `docs/fssai/RECON.md` §5. Where this
table and RECON.md disagree, **RECON.md wins** — it was measured against the live database.

---

## 4. PHASES — the resume order

Work the FIRST row whose status is `PENDING`. One phase per scheduled run. Mark it `DONE` only when
its evidence line is filled in with real command output.

| # | Phase | Covers | Status | Evidence |
|---|---|---|---|---|
| P0 | Recon | owner's "inspect before coding" requirement | **DONE** | 7 agents, 0 died. `docs/fssai/RECON.md` = 4,607 lines (contract 1-961, raw lanes 962+). Read-only: worktree `git diff --stat` empty, live DB mtime unchanged. Corrected this file (no `unbuilt` flag) + 3 integration rows. 10 owner questions in §7 |
| P1 | Foundation — schema + nav + RBAC + shells | §20, §24 | **DONE** | 11 agents (1 errored). 11 `fssai_` tables + 34 indexes + the app's FIRST boot assertion. 20 nav rows in BOTH files, 20 page.tsx. `npx tsc --noEmit` exit 0, zero output. Real snapshot: 205→216 tables, 0 removed, purchases still 2165, 215 columns match their CREATE text exactly. db.ts 9,561→10,625. Commits 0e7b9ec·b93ee61·5268b36·21aa4c2 |
| P2a | Checklist engine — the API: templates/sections/questions/assignments + the run engine | §15 | **DONE** | 2 lanes + 4 adversarial probes + 1 fix round. 11 files, ~4,500 lines, commits `9a10dfd`·`5373289`·`39c9e12`·`4a6f593`·`515bda9`. **NO SCHEMA CHANGE** (`git diff c6c3f1a..HEAD` does not contain `db.ts`; zero `ALTER/CREATE TABLE/CREATE INDEX` in the diff). `npx tsc --noEmit` exit 0, zero output. `npm run build` exit 0, "✓ Compiled successfully in 33.5s", 27 FSSAI entries (7 API + 20 pages), 1 warning = the pre-existing `next.config.ts` NFT trace (present at `main`). `npm test` exit 1 at `run-tests.js` with **74 passed · 2 failed** — the identical recorded baseline; both survivors are the `kitchen`/`liquor` station sentinels, mapped in the owner's production data (HARD RULE 4 forbids changing them). The five scripts the `&&` chain never reaches all pass alone: 94 · 104 · 161 · 198 · 380 = 937. Fix round closed 6 measured defects incl. two HIGH (a recorded FAILURE erased from the verdict by a mid-run retire; a Yes/No answered with the word "yes" frozen as a failure) — 34 pure assertions + 5 HTTP repro scripts, 0 regressions, record drifted after **0 of 10** template edits. DB restored: purchases 2165, all `fssai_` tables back to their pre-run counts |
| P2b | Checklist engine — the SCREENS: settings hub, checklist library, the builder (sections · questions · the eight types · reorder · preview) | §15 | **PARTIAL** | **BUILT — commits `4148cb1` (library) · `6b406f0` (hub) · `7808b43` (builder) · `0e61b6f`·`ad003b6`·`fb42540` (fix rounds).** Measured 2026-09-21 by the gate lane, not taken on trust: `settings/page.tsx` 616 · `checklists/page.tsx` 1,671 · `settings/checklists/[id]/page.tsx` **3,518** (the row above said it "does not exist") · `grep -rln "api/fssai" src/app/fssai` → **7**, not one. 18 of 24 pages remain P1 placeholders — that is P4–P11, behind RG. Catalog/sidebar diff → **IDENTICAL, no drift** (21/21). **PARTIAL, not DONE, for one reason: no browser ever rendered these screens.** Both lanes hit the same wall and said so; every UI claim is code-read + API-replay. Two HIGH defects were found by exercising the engine and FIXED (the preview painted the FAILING answer green whenever pass="no" — the shape of every pest question; retiring a section did NOT retire its questions, so a critical question inside a "switched-off" section still failed the round). Open: **L-2** preview stepper starts at 0 not target, **L-3** the Critical chip's consequence is hover-only on a phone. Gates on this commit: `npx tsc --noEmit` exit 0 zero output · `npx next build` exit 0, "✓ Compiled successfully in 30.9s", 289/289 static pages, 34 FSSAI entries · `npm test` exit 1 **74 passed · 2 failed** (baseline; the 2 are the kitchen/liquor station sentinels in production data, HARD RULE 4) |
| P3 | Mobile runner — run, evidence, signature, submit | §22 | **PARTIAL** | **BUILT — Lane A `9c453bb`·`efd6103`·`acd6766` (picker 849 + runner 1,683 + `RunnerUI.tsx`); Lane B `4a70cff`·`ecf1948`·`3ffac34`·`d1e6590`·`5d5f459`·`6aee190` (evidence + sign + approvals routes, `/fssai/verification` 952).** **NO SCHEMA CHANGE.** HARD RULE 14 SETTLED: photos stay in-row as TEXT data URIs, 250 KB client target / **400 KB server ceiling** / 1200 px / 4 per answer / 24 per run — proved with a real 14.18 MB 12 MP photograph shrinking to 165 KB ≈ 22% of production's ~1 MB nginx limit. The evidence route makes "Photo: Always" satisfiable at last (P2a could only insert the row by hand). Signing became an ACT with a SHA-256 over every answer + photograph; verifying **cannot change a record** (proved by a tampering POST — fingerprint byte-identical either side). **PARTIAL for ONE reason now: no browser has ever rendered the runner — the 390px fit is a static audit and the offline queue's retry loop is unexercised. (The label half of the old reason (1) is CLOSED, `905ef52`.) OWNER RULED Q17 2026-09-25: "Fix the mode label NOW; strict refusal AFTER one real run on the phone." `FSSAI_REQUIRE_EXPLICIT_SIGNATURE = false` therefore STAYS false by decision, not by drift, and the reason is written into the constant: the signature path has never been through a real browser and a hydration bug there would block every submit mid-service. ⚠️ CORRECTION TO THE OLD TEXT AND TO RG-REPORT §6/§7, which had the defect BACKWARDS: it was never "a deliberate signature recorded as the un-asked kind". The one-tap and two-step paths were both labelled correctly; the UN-ASKED case (client sends no `sign` flag, the flag is off, the server attests anyway) was the one printing "signed by pressing “Sign and submit”" about a button nobody pressed. The report's proposed `askedToSign ? 'explicit' : 'on_submit'` would have broken the two correct cases and left the wrong one wrong. Fixed instead by giving the enum its missing THIRD value, `'not_asked'` — and by widening `readFssaiSignature`, which collapsed every unrecognised value to `'explicit'`, the strongest claim.** Also not built from P3's neighbours: the equipment/area registers (`fssai_equipment` 0 rows), any due/overdue reminder. **Corrective action on failure is now BUILT — see P7 below.** Gates: identical to P2b's row above, run on the same commit |
| **RG** | **REVIEW GATE — P0–P3 put in front of the owner.** | — | **NO LONGER BLOCKING — the owner instructed the build to carry on (2026-10-06). The DEPLOY gate in §0 is UNTOUCHED.** | **`docs/fssai/RG-REPORT.md`** (2026-09-21). Carries all five things §4 requires: the phone URL + tier table, a runnable end-to-end script (incl. the fact that the DB holds NO runnable checklist — one draft test row `ZZ-P2B-COLDROOM`, 0 questions — so step 0 authors one), the three real gate numbers, what the runner does NOT do, and 20 open decisions each with options + trade-offs + a recommendation. **He never ticked the row, and on 2026-10-06 he asked for FSSAI to be completed with a thirty-agent fleet instead** — an instruction to proceed, which is what the gate was waiting for. The twenty decisions are therefore still OPEN and NONE of them is settled by this: every phase that depends on one builds the safest reversible default and records the assumption here (§7), exactly as §7's own rule says. ⚠️ **THIS CHANGES NOTHING ABOUT DEPLOYING.** §0 stands word for word: no deploy, no merge to `main`, no push, no `gh workflow run`, until he types **Deploy FSSAI**. |
| **W1** | **Shared foundations for the record modules — schema · nav · RBAC · vocabulary** | §2, §5, §17, §19, §24 | **DONE** | **2026-10-06. The ONLY agent allowed to edit `db.ts`, `page-catalog.ts`, `Sidebar.tsx`, `fssai.ts` in this run.** **19 new `fssai_` tables (11 → 30) and 65 new indexes (34 → 99)**, all in `initializeSchema` via `applyFssaiSchema`, all matching the existing 11 column for column (`id` TEXT PK · `outlet_id` · `created_at`/`updated_at` · FK columns `TEXT NOT NULL` never `DEFAULT ''` · no CHECK · void trio on every record table). **ASSERTED, NOT ASSUMED** — a throwaway probe reads the two DDL arrays out of `db.ts` and runs them exactly as the boot does: `declared 30 tables / 99 indexes · DDL that threw: 0 table, 0 index · MISSING TABLES: none · MISSING INDEXES: none · DUPLICATE NAMES: none`, then inserts one minimum row into each of the 19 in FK order (20/20 OK), then EXERCISES the uniqueness rules — a second seed marker, a second shelf life for one item, a duplicate standard code, a duplicate inspection number and an orphan received line are all REFUSED by name, while two standards with `code=''` are correctly ALLOWED (the partial UNIQUE is partial). **A second probe runs the SHAPE GUARD for real** — all 30 CREATEs into `temp.zz_*` and a column-by-column `pragma_table_xinfo` diff: `30/30 OK, 0 drift`, so no FK inside a temp table makes the guard say "probe failed" on every cold start; and an upgrade from a database ONE DEPLOY BEHIND (11 old tables, two live rows) reaches `tables 11 → 30, indexes 99, 0 statements threw, fssai_templates=1 fssai_runs=1 untouched`. **Nav:** 21 → **23** FSSAI rows, `/fssai/audit-log` (mgmtOnly) + `/fssai/settings/equipment` (adminOnly), in `page-catalog.ts` AND `Sidebar.tsx` AND `modules.ts`, each with a real `page.tsx` — a measured drift check says catalog 23 · sidebar 23 · **catalog-only none, sidebar-only none, order IDENTICAL, 0 label mismatches**. **RBAC EXERCISED, not read:** `page-catalog.ts` compiled standalone and the real `canAccessPage`/`isAdminOnlyPath` called — `/fssai/audit-log` admin✓ manager✓ HOD✓ staff✗; `/fssai/settings/equipment` admin✓ manager✗ HOD✗ staff✗ (longest-prefix `bestEntry` resolves the two-segment path correctly); `/fssai/settings`, `/fssai/settings/checklists/abc` and `/fssai/temperature` unchanged; `homePathFor` unchanged for all five tiers. The file's own stale prefix-grant figure re-measured: **12 parents / 92 grants** (was written 11 / 88). **Vocabulary:** `src/lib/fssai.ts` §14, 1,875 → 2,728 lines — record lifecycle, the three-way tick-box, `fssaiRangeCheck`, the receiving checkpoints, the nine temperature kinds, expiry/oil/water/pest/document/inspection vocabularies, `fssaiVoidRefusal`, `FSSAI_ATTACHMENT_ENTITIES`, the seed log. **Gates:** `npx tsc --noEmit` **exit 0, zero output**; `node scripts/check-boot-migrations.js` **exit 0, "✓ CLEAN — every boot-time write to admin-owned state is one-shot"**. **The worktree DB was opened READ-ONLY only** — `purchases 2165`, `216 tables`, `fssai tables 11` and mtime unchanged (the 19 appear on the next cold start). NO SEED WRITTEN. NOT deployed, NOT pushed, NOT merged. |
| P4 | Receiving QC · Temperature Logs · Cold Room | §2, §4, §5 | **SCHEMA READY** | **W1 (2026-10-06) built the tables, indexes, nav and vocabulary; the screens and routes are the feature lane's.** Tables: `fssai_receiving_checks` · `fssai_receiving_lines` · `fssai_temperature_logs` · `fssai_temp_standards` · `fssai_equipment_events`. New nav: `/fssai/settings/equipment` (adminOnly, in BOTH files + a shell). Evidence on the W1 row below |
| P5 | FIFO/FEFO & Expiry · Oil Quality · Water & Ice | §3, §12, §13 | **SCHEMA READY** | **W1.** Tables: `fssai_item_shelf_life` · `fssai_expiry_items` · `fssai_oil_checks` · `fssai_oil_disposals` · `fssai_water_tests`. Evidence on the W1 row below |
| P6 | Pest Control · Documents & Certificates | §7, §17 | **SCHEMA READY** | **W1.** Tables: `fssai_pest_services` · `fssai_pest_sightings` · `fssai_pest_devices` · `fssai_documents` (+ the shared `fssai_attachments`). Evidence on the W1 row below |
| P7 | Corrective Actions + Task/Maintenance + alerts | §14, §21, §23 | **PARTIAL** | **THE CORRECTIVE-ACTION SPINE IS BUILT AND LIVE IN CODE — `a7e5714` (engine + route) · `d1ea748` (screens) · `2f7628c` (self-review fixes). Brought forward out of P7 because the owner RULED §7 Q14 on 2026-09-25: "Corrective action against the failed record. The failure STANDS. The fix and its verification hang off it via `fssai_corrective_actions`. NO change to the slot rule, no 'rejected' status, no voiding a true observation." NO SCHEMA CHANGE — the P1 spine took it as declared. What closed: `raise_ca_on_fail` had **0** readers in the engine and `fssai_corrective_actions` was written by **no route at all** (measured: 0 rows, 0 questions with the flag ever switched on — the inert-guard shape exactly). Now a failed answer on a flagged question raises `CA-yyyy-####` inside the submit transaction, from the SAME judged list the verdict is built from, reading `is_fail` off the frozen response; idempotent on (run_id, response_id); best-effort so a follow-up row that will not insert can never cost a chef his submitted round. `/api/fssai/corrective-actions` does assign/start/complete/verify/reopen/cancel, every UPDATE status-guarded and in one transaction with its audit row, no DELETE, no create-by-hand. `complete` REFUSES without the fix in words; `verify` refuses the fixer, refuses whoever recorded the failed check, and refuses anyone outside management. It CANNOT un-fail anything: no write against `fssai_runs` or `fssai_responses` exists in either file. `/fssai/corrective-actions` replaces its PhaseShell; the failed record shows its actions on `/fssai/verification` and on `GET /api/fssai/runs?id=`. **STILL NOT BUILT, and the screen says so:** the fix does not become a row in the Task Manager (`created_task_id` deliberately left `''`, never a fabricated task id), and there are no escalations or due/overdue reminders — §21/§23 are untouched. Gates: `npx tsc --noEmit` 0, `npx next build` 0; proof harness 33/33 + 9/9 against a COPY of the db (production db still 0 actions). NOT deployed, NOT pushed — the FSSAI gate holds.** |
| P8 | Seeded checklist templates (the twelve) | §6, §8, §9, §10, §11 | **BUILT — not browser-verified** | **2026-10-06, Wave 2. NO SCHEMA CHANGE, NO SHARED-FILE CHANGE** (`db.ts`, `page-catalog.ts`, `Sidebar.tsx`, `fssai.ts` all untouched; the only shared edit is `built: true` on P8's OWN five rows in `modules.ts`). **The twelve exist as DATA**: `src/lib/fssai-checklist-pack.ts` — **12 checklists · 37 sections · 151 questions · 66 critical**, across all five areas (food-quality 2, cleaning 3, hygiene 2, storage 3, kitchen-safety 2). Applier `src/lib/fssai-seed-server.ts`, route `src/app/api/fssai/seed/route.ts` (GET state + POST apply; **no PUT, no DELETE** — asserted), admin screen `/fssai/settings/ready-made`, and the five module screens are real at last via `src/app/fssai/_components/SeededModuleScreen.tsx`. **IT IS NOT A BOOT SEED** — an administrator presses a button, the marker row goes in FIRST inside the transaction and `uq_fssai_seed_item` is the gate, so a restart can never bring back a checklist he retired. **PROBE (the real code, real `initializeSchema`, a `VACUUM INTO` copy of the worktree DB): `/tmp/claude-501/p8probe/probe.cjs` → exit 0, 67 passed / 0 failed.** Measured: boot creates 30 fssai tables incl. `fssai_seed_log` + `uq_fssai_seed_item`; the pack passes `normalizeFssaiQuestion` with **0 problems**; **a good answer passes all 151 questions** and a reading 20 °C below a minimum fails and raises a CA (the R1 renderer test); apply → `templates +12 · sections +37 · questions +151 · seed_log +13 · audit_log +12 · fssai_runs UNCHANGED · purchases 2165`; 0 orphan questions, 0 invented roles, 0 invented departments; **a second apply is refused `already_applied` and writes nothing, and still refuses after an admin RETIRES one of the twelve — the retired row is NOT resurrected**; a new pack version skips the 11 codes already in use and overwrites none; an unknown department id is refused by name with no marker row written; a real department id is stamped BY ID; `publish:true` publishes and records `published_by`; CSRF refused with no pair and with a mismatched pair, passes with a matching pair. **Gates: `npx tsc --noEmit` exit 2, 4 src errors — ZERO in any P8 file; all four are sibling lanes' in-flight files (`_p9/reports.ts`, `inspections/route.ts`, `corrective-actions/page.tsx`).** `next build` deliberately NOT run (the verify wave builds once for everybody). **NOT browser-verified** — no agent in this environment can render a screen, the same wall P2b and P3 hit. **Assumptions recorded in §7: seeded as DRAFT; no rota; no department; `target_kind` only 'none'/'person'; 10 of 12 carry the Q16 warning and the screen shows it.** NOT deployed, NOT pushed, NOT merged — §0 holds |
| P9 | Dashboard · Inspection Mode · Reports | §1, §16, §18 | **SCHEMA READY** | **W1.** Mostly reads, as planned; the two shapes a read cannot invent are `fssai_inspections` + `fssai_inspection_findings` (somebody ELSE's findings against clauses we did not write — not a checklist run). Evidence on the W1 row below |
| P10 | Audit trail hardening — void, never delete | §19 | **SCHEMA READY** | **W1.** `fssai_audit_log` already existed and is already being written; W1 added the void trio to all 19 new tables, the shared `fssaiVoidRefusal()` guard, the `FSSAI_RECORD_TABLES` allowlist, `fssai_retention_runs` (an unattended job that deletes image data must prove what it did), and the missing SCREEN: `/fssai/audit-log` (mgmtOnly, BOTH files + a shell). Evidence on the W1 row below |
| P11 | Full adversarial verification + carve | all | PENDING | after the feature lanes. The carve still proves the FOUR signature checks of §0, never the bare word `fssai` |

### 🛑 THE REVIEW GATE (RG) — the owner's decision, 2026-09-16

The owner chose **option 1 + option 4**: the scheduler runs phases unattended, **and the build stops
after P3** so he can judge the mobile checklist experience on his own phone before committing to the
eight record modules.

**RULE: when P0, P1, P2a, P2b and P3 are all `DONE`, the build STOPS.** Do not start P4. Do not "just
make a start" on anything behind the gate. Put the module in a state he can open and try, then report and
wait.

**To pass the gate the owner must say so explicitly.** Only he can change the RG row to `APPROVED`.
Until that word exists in this file, P4–P11 stay `HELD`.

**What the RG report must contain** (this is what he is deciding on, so it must be real, not a
summary of intentions):
- How to open the module on a phone — the exact URL and which login tier reaches it.
- A checklist he can actually run end to end: pick one, answer it, attach a photo, sign, submit.
- The real numbers: `npx tsc --noEmit` exit, `npm run build` exit, test pass counts.
- What the mobile runner does NOT yet do, stated plainly.
- The open decisions from §7, each with 3–4 options, trade-offs and a recommendation.

**Why this gate is where it is:** every one of P4–P11 renders through the checklist engine and the
mobile runner. If the runner feels wrong on a phone, fixing it after eight more phases are built on
top costs far more than fixing it now. He is reviewing the foundation, not the features.

### Phase detail

- **P0 Recon** — READ ONLY. Produce `docs/fssai/RECON.md`: the exact conventions this module must
  match (page shell, table/card components, form patterns, API response shape, CSV/PDF export
  helpers, toast/error handling), the RBAC wiring (`getCurrentUser`, `isManagement`,
  `canAccessPage`, tier flags, CSRF), the real column names of every integration table in §3, and
  the existing photo/attachment upload path (HRMS documents vault stores BLOBs — reuse or not, and
  why). **No code.**
- **P1 Foundation** — `fssai_` schema for the checklist engine (templates, sections, questions,
  assignments, runs, responses, evidence, approvals, corrective_actions, audit_log) in
  `initializeSchema()`; all 20 nav entries in BOTH `Sidebar.tsx` and `page-catalog.ts`; RBAC per §20;
  page shells that render.

  > ⚠️ **CORRECTION, 2026-09-16 (P0 recon).** An earlier draft of this file told P1 to use an
  > existing `unbuilt: true` flag. **There is no such flag on this branch.** `grep -rn "unbuilt" src/`
  > returns nothing, and `PageEntry` (`src/lib/page-catalog.ts:19-35`) has exactly `path`, `label`,
  > `hodOnly?`, `mgmtOnly?`, `adminOnly?`. The flag exists only in *uncommitted* liquor work in the
  > live repo, which this branch forked away from. **Do not reference it.** Either register a nav
  > entry only once its page exists, or add the flag deliberately as new work — and if you add it,
  > it must also keep the path out of `homePathFor` / `firstAllowedPath`, or a user whose map
  > contains only unbuilt paths gets redirected onto a 404 with no click. See RECON.md §4.5.
- **P2 Checklist engine** — admin CRUD for templates/sections/questions. Eight question types:
  Yes/No, Pass/Fail, Numeric, Temperature, Text, Photo, Multiple Choice, Signature. Frequency,
  department, responsible role, required evidence, pass/fail conditions.
- **P3 Mobile runner** — the §22 flow: Select Checklist → Select Area/Equipment → Questions →
  Readings → Photo → Remarks → Sign → Submit. Large buttons, dropdowns, toggles, numeric inputs,
  minimal typing. Settle the 1 MB upload limit (HARD RULE 14) here and record the decision.
- **P4** — dedicated tables. Temperature standards **configurable from Settings, never hard-coded**
  (§5). Out-of-range automatically raises a corrective action (§4).
- **P5** — FIFO/FEFO reads existing batch/barcode data (§3); no duplicate item master.
- **P6** — pest services + sightings tracked separately; certificate expiry reminders (§17).
- **P7** — any failed check can raise a corrective action; integrates Task Manager + Maintenance;
  configurable escalation rules (§23).
- **P8** — seed the twelve checklists as template rows. No bespoke tables.
- **P9** — dashboard (§1), Inspection Mode (§16), 19 reports with date/department/location/status
  filters and PDF/Excel/Print (§18). Reads everything, so it comes last.
- **P10** — created/modified by + timestamps, original vs changed value, reason for change; sensitive
  records are **voided with a mandatory reason, never deleted** (§19).
- **P11** — adversarial verification fleet, `npx tsc --noEmit`, `npm run build`, full test chain,
  boot and render every screen, and prove the three zero-counts from §0.

---

## 5. HOW TO RESUME (the scheduled task's own instructions)

1. `cd /Users/shashankreddy/Desktop/Claude/fnb-fssai` — **never** the live repo.
2. Read this file top to bottom. §0 and §1 bind you.
3. **THE REVIEW GATE IS NO LONGER BLOCKING — and the DEPLOY gate still is.** Read both sentences.
   On **2026-10-06** the owner asked for FSSAI to be completed with a thirty-agent fleet. That is the
   instruction the RG row was waiting for, so P4–P11 are available and a run must NOT stop at the
   gate any more. ⚠️ **§0 IS UNCHANGED AND IS A DIFFERENT GATE.** Nothing is deployed, merged to
   `main`, pushed, or run through `gh workflow` until he types **Deploy FSSAI**. Confusing the two
   is the worst mistake available here: one was about whether to keep BUILDING, the other is about
   putting food-safety screens in front of real staff.
   > The original rule, kept so nobody thinks it was lost: *"If P0–P3 are all `DONE` or `PARTIAL`
   > and the RG row does not say `APPROVED`, STOP IMMEDIATELY… point him at
   > `docs/fssai/RG-REPORT.md`."* It held from 2026-09-16 to 2026-10-06 and it was right to.
   **The twenty open decisions in §7 are STILL OPEN.** Proceeding is not approval of any of them: a
   phase that needs one builds the safest reversible default, makes it configurable where that is
   cheap, writes the assumption into the code AND into §7, and never cites an earlier phase's
   default as precedent.
   > ⚠️ **`PARTIAL` STILL DOES NOT MEAN "GO AND REBUILD IT" (added 2026-09-21, kept 2026-10-06).**
   > P2b and P3 are `PARTIAL` because the only thing that can close them is the owner opening the
   > module on his phone — no agent in this environment can render a screen, which is exactly what
   > those rows are missing. **Rebuilding a `PARTIAL` phase is still forbidden**: two lanes already
   > discovered their own work was built before they started and rightly switched to verifying
   > instead of rebuilding. That reason never depended on the review gate, so the gate no longer
   > blocking does not change it. A lane whose brief lands on P2b or P3 VERIFIES; it does not start
   > again.
4. Otherwise, find the first phase in §4 that is not finished. `SCHEMA READY` means Wave 1 has built
   that phase's tables, indexes, nav rows and vocabulary and the screens and routes are still to
   build — read the W1 row for exactly which names you may use, and **do not edit `src/lib/db.ts`,
   `src/lib/page-catalog.ts`, `src/components/Sidebar.tsx` or `src/lib/fssai.ts`**; if something is
   missing there, say so in your report rather than adding a second convention beside the first.
   There is no `HELD` row left (the gate in §5.3 stopped blocking on 2026-10-06); `PENDING` means
   nothing has been built for it at all.
5. If a phase is `IN PROGRESS`, check whether its workflow is still running before starting another —
   look for a run id on its row. Do not run two phases at once.
6. Run that phase as an agent fleet: map → build → adversarial verify → fix. Every agent gets §0–§3
   of this file verbatim in its brief.
7. When it finishes, commit to `fssai-compliance` **in this worktree only**, update the phase row to
   `DONE`, and fill in its evidence line with real command output (tsc exit, build exit, test counts).
8. Record anything needing the owner's ruling in §7, with 3–4 options, trade-offs and a
   recommendation. Do not guess his preferences and do not silently pick one.
9. If the phase failed, set the row back to `PENDING`, and append what failed and why to §6 so the
   next run does not repeat the mistake.
10. **Never deploy. Never merge to `main`. Never push.**

---

## 6. LOG — what happened, newest last

- **2026-09-16** — Worktree created at `4125237` on branch `fssai-compliance`. `node_modules`
  hardlinked via `rsync -a --link-dest` (Turbopack rejects a symlinked `node_modules` —
  *"points out of the filesystem root"*). Gate recorded in memory. Phases defined. P0 queued.
- **2026-09-17** — **P1's work was destroyed once and recovered.** All three build lanes left it
  uncommitted; at 10:07:59 a concurrent agent's `git checkout -- .` reverted all four tracked files
  to HEAD, losing 665 lines of schema, 78 of catalog and 54 of sidebar. Only the untracked pages
  survived. It was recovered from the Turbopack source-map cache — which `npm run predev`
  (`rm -rf .next`) would have deleted — and committed as `b93ee61`.
  **RULE, ADDED TO §1.1 IN PRACTICE: commit at the END OF EVERY LANE, not at the end of the phase.**
  This worktree is shared with other agents that run destructive git commands. Uncommitted is the
  only place git cannot protect.
- **2026-09-18** — **P2 fix round. Six measured defects closed, two of them HIGH, all on the run
  engine; each one's own repro was re-run and the output pasted into the lane report.** Commit
  `515bda9`, no schema change, `tsc` exit 0, `npm run build` exit 0, `npm test` unchanged at
  74 · 2, 0 regressions across 60+ re-checks.
  1. **A recorded FAILURE was erased from the verdict by a mid-run retire** — submit judged
     `is_active = 1` only, while the record printed every response row. Measured before: staff answer
     "Floor condition = Soiled" (frozen `is_fail=1`), an admin presses the ordinary delete on that
     question, staff submit → `{fail_count:0, pass_pct:100, outcome:'pass'}` on a sheet that still
     prints the failing line. After: `{fail_count:1, pass_pct:66.7, outcome:'fail'}`, and a retired
     **critical** failure still fails the whole run. Submit now judges the live sheet PLUS every
     question this round already answered, and says so (`counted_retired_questions`). Staff may
     CORRECT such an answer; a NEW answer to a switched-off question is still refused (409).
  2. **A Yes/No answered with the WORD "yes" was frozen as a compliance failure** (only `value_bool`
     was read; an absent boolean means "not answered", which for a required question means a fail).
     The words now live in the shared predicate: `'yes'` → `value_bool=1, is_fail=0`, and `"maybe"`
     is refused **by name** (400) rather than silently counted as a fail.
  3. **`photo_rule` / `note_rule` — the admin's "required evidence" — were never evaluated.** A
     question demanding a photo AND a note answered, submitted and PASSED with neither. They are now
     evaluated: such an answer is INCOMPLETE (never silently turned into a fail), and the submit
     refusal names what it is waiting for. NOTE for P3: "Photo: Always" can only be satisfied once
     P3 ships the evidence-write route — proved here by inserting the `fssai_evidence` row directly,
     after which submit succeeded.
  4. **The checklist NAME and CODE on a finished record were read live**, so renaming a checklist
     re-labelled every record ever taken under it — and a rename does not bump the version, so
     nothing said so. The sheet as it was asked (title, code, versions, and EVERY question including
     the ones left blank) is now frozen into `fssai_audit_log` at submit, `action='snapshot'`, and
     the record renders from it. **No schema change** — see §7 Q15 for the columns this would
     otherwise have needed.
  5. **A round answered across several versions claimed one version.** The record now carries
     `template_version_at_open` and `template_version_at_submit`.
  6. **Two disagreeing definitions of "answered"** (the route's own vs the evaluator's) — one
     type-aware predicate now, `fssaiResponseAnswered`, used by the answer count and the submit gate.
  Also landed: CSRF re-checked inside the one FSSAI route with a caller-controlled path segment
  (`POST /api/fssai/templates/print-abc` reached the handler with no token, because `proxy.ts:135`
  treats any `/print` path as public before routing — the fix is in FSSAI's own file and changes
  nothing shared); a restaurant-wide record no longer refuses a colleague with "belongs to another
  department" (a run with no department is readable by any signed-in user; a run that DOES belong to
  another department is still 403); a recorded FAILURE is refused in its own words; option lists
  reject anything that is not text (`[object Object]` can no longer become a choosable answer);
  `config_warnings` say out loud when a setup means ONE person files for the whole restaurant.
  **THE CONTRACT FOR P2b/P3, in one place:** every FSSAI mutation must go through `api()`/`apiJson()`
  (CSRF). `GET /api/fssai/masters` feeds every dropdown. A finished run returns
  `template` (as recorded) + `template_now` + `template_renamed_since` + `sheet_as_asked` +
  `template_version_at_open`/`_at_submit`; a history list returns `template_name_at_record` (lead
  with it, never with `template_name`). An answer returns `verdict.needs_photo` / `needs_note` and
  `display_value` (`decimals` is display only — rounding before the range test would let 5.4 °C pass
  a 0–5 rule). A 409 on open carries `code`, `run_id` and `can_view` — do not offer "View" when
  `can_view` is false.
- **2026-09-20** — **P3 Lane B: evidence, signature, verification queue.** Commits `4a70cff`
  (protective rescue of the previous run's uncommitted work) · `ecf1948` (the API) · `3ffac34` (the
  screen) · `d1e6590` (the oversized-photograph fix). **NO SCHEMA CHANGE** — `signed_by`/`signed_at`
  and `fssai_approvals` already existed; the digest and the statement go into one `fssai_audit_log`
  row (`action='sign'`), the pattern P2a's snapshot already uses. `npx tsc --noEmit` exit 0 zero
  output; `npm test` **74 passed · 2 failed** (the baseline; the two are the kitchen/liquor station
  sentinels in the owner's production data, HARD RULE 4).
  1. **THE SERVER WAS INVENTING THE SIGNATURE.** P2a's submit wrote `signed_by = me.email` as a side
     effect whenever `requires_signature` was set — and it **DEFAULTS TO 1**, so that was every
     record. Nobody was ever asked. An inspector reading "signed by chef@akan" would reasonably
     believe a person attested; the server typed it when the last box was ticked. Signing is now an
     act (`POST /api/fssai/sign`) recording who (session cookie), when (server clock), a SHA-256 of
     every answer and photograph as they then stood, and the statement in words. Change an answer
     afterwards and the digest no longer matches — measured: `884cadf4…` → `98b648c3…`.
  2. **THE EVIDENCE WRITE ROUTE EXISTS, so "Photo: Always" is satisfiable at last.** Measured: submit
     refused with *"Photograph of the thermometer display → No photograph attached"*; after the
     upload the answer was re-judged `is_fail 1 → 0` and submit passed. P2a had to insert the row by
     hand; nothing has to now.
  3. **THE 1 MB CEILING IS SETTLED (HARD RULE 14 — the decision this phase owed).** Photographs stay
     in-row as TEXT data URIs via the Task module's `ImageUpload` (RECON §6: there is no upload
     service in this app, and the BLOB route's caps all exceed production's real limit). Budget:
     250 KB client target, **400 KB server ceiling**, 1200 px, 4 per answer, 24 per run. Proved with a
     real 12 MP photograph (4032×3024, 14.18 MB): ImageUpload's own ladder gives 474→358→252→**165 KB**
     at 1200×900, a 226,599-char body ≈ 22% of the real ceiling. A retention window is still
     undecided (§7 Q13).
  4. **VERIFYING CANNOT CHANGE A RECORD, proved by request and not by the absence of a button.** A
     verify POST stuffed with `value_text:'TAMPERED'`, `is_fail`, `pass_pct`, `signed_by`, `remarks`
     and a `responses[]` array left the SHA-256 over every answer, verdict and photograph
     **identical** (`a1355e25…` before and after); only `status` moved. §7 Q3 holds: the recorder is
     refused on their own record (403 `own_record`), a non-manager is refused, a rejection demands a
     reason, and a second decision is refused 409.
  5. **⚠️ THE ROWS ABOVE THIS ENTRY ARE STALE — the orchestrator owns the phase table (§5.7), so I did
     not edit it.** For the next run: P2b **is** built (hub `6b406f0`, library `4148cb1`, builder
     `7808b43`, fix rounds `0e61b6f`·`ad003b6`·`fb42540`), and P3 Lane A's phone runner landed today
     (`9c453bb`·`efd6103`·`acd6766`). So "19 of the 20 pages are still placeholders" and
     "`settings/checklists/[id]/page.tsx` does not exist" are both **false**, and
     `grep -rln "api/fssai" src/app/fssai` now returns **7**, not one.
  6. **ONE DECISION A LATER RUN MAY WANT TO REVERSE, stated plainly.** The strict gate that REFUSES an
     unsigned submit is built and **off**, behind `FSSAI_REQUIRE_EXPLICIT_SIGNATURE` in
     `src/lib/fssai.ts`. Lane A's runner posts `{action:'submit'}` without a `sign` flag, so with the
     gate on every check the owner tried to file at the review gate would meet an error about the
     button he had just pressed. Instead the act is performed and its **kind** recorded
     (`mode:'explicit'` vs `mode:'on_submit'`), and every screen says which. Proved both ways by
     turning it on in an isolated copy: `signature_required` and `signature_stale` both fire, and
     `{sign:true}` submits in one tap. To tighten: add `sign: true` to the runner's submit body, then
     flip the constant.
- **2026-09-21** — **THE REVIEW GATE REPORT IS WRITTEN, AND THE PHASE TABLE ABOVE IS NOW TRUE.**
  `docs/fssai/RG-REPORT.md`. Four lanes had each declined to edit the phase table (§5.7 makes it the
  orchestrator's, and they were committing into the same worktree concurrently), so P2b said "NOT
  BUILT" and P3 said "Not started" for three days while both were in fact built. **Both rows are now
  `PARTIAL`** — not `DONE`, and deliberately so.
  1. **WHY NOT `DONE`.** DONE requires evidence that was measured. It was not, for the one thing this
     gate exists to judge: **no browser has ever rendered a single FSSAI screen.** All four lanes hit
     the same wall (no puppeteer/playwright/jsdom in `node_modules`; installing one would write
     through the HARDLINKED `node_modules` into the owner's tree; the Browser pane was forbidden for
     that fleet) and all four said so honestly in their reports. Every server-side claim was
     executed over HTTP; every screen claim is code-read. And P3 carries an **open HIGH**.
  2. **THE OPEN HIGH, NAMED SO NOBODY INHERITS IT AS SETTLED.**
     `FSSAI_REQUIRE_EXPLICIT_SIGNATURE = false` (`src/lib/fssai.ts:1392`) — submit still writes a
     signature nobody asked for, and `signMode` is hardcoded `'on_submit'` (`runs/route.ts:749`) so a
     signature the person deliberately gave is recorded as the kind the server wrote unasked. **The
     flag's own comment still says "because the runner does not send sign:true yet" — that is FALSE
     as of `9c453bb`** (`run/[id]/page.tsx:585` sends it). Two-line fix, both paths already proved.
     NOT applied here: it changes behaviour on the exact build the owner is about to judge, and it is
     an attestation policy, not an engineering detail. RG-REPORT §7 Q17.
  3. **GATES RE-RUN FIRST-HAND ON `6aee190`, not copied from a lane report:** `npx tsc --noEmit`
     exit 0 zero output · `npx next build` exit 0 "✓ Compiled successfully in 30.9s", 289/289 static
     pages, 34 FSSAI entries, 1 warning (the pre-existing `next.config.ts` NFT trace) · `npm test`
     exit 1 **74 passed · 2 failed** (the baseline sentinels). Catalog/sidebar `diff` →
     **IDENTICAL**, 21/21. **0** FSSAI paths contain `print`. The DB was opened **read-only only**:
     purchases 2165, 216 tables, users 9 — untouched.
     ⚠️ My first `next build` returned exit 1 — *"Another next build process is already running"*. A
     concurrent lane held the lock. I waited for it rather than killing it; the exit-0 above is my
     own re-run. **A build exit 1 in this worktree is more likely a lock than a break — check
     `pgrep -f "next build"` before believing it.**
  4. **THE THING THAT WOULD HAVE WASTED HIS FIRST TEN MINUTES.** The worktree DB contains **no
     runnable checklist**: `fssai_templates` = 1 and it is the leftover test row `ZZ-P2B-COLDROOM`,
     status *draft*, **0 questions**, 0 sections, 0 assignments, 0 runs. The lanes correctly cleaned
     up after themselves and the result is an empty module. The report opens with this and gives a
     3-minute authoring script. **I did not seed one** — a sibling lane was live in this worktree at
     the time (its own `next dev` on 3976) and two agents seeding the same demo would have produced
     duplicates in his data.
  5. **FOUR NEW OPEN DECISIONS ADDED TO §7** (Q17 signature ceremony · Q18 person-target keyed on
     email · Q19 the leftover test row · Q20 what the runner may promise about a lost signal). Also
     noted: **§7 has two different questions both numbered Q11** (the `getDb()` rewrite and the
     "screens print measured gaps" question). The report disambiguates them as **Q11-A** and
     **Q11-B**; the numbering here is left alone so no scheduled run is confused by a renumber.
  6. **STILL NOT BUILT, and the report says so plainly:** ~~corrective action on a failed answer
     (`raise_ca_on_fail` is stored and read by **nothing** in the engine — measured 0 hits in
     `runs/route.ts`; `fssai_corrective_actions` is written by no route)~~ — **CLOSED 2026-09-25
     by the owner's Q14 ruling; see the P7 row above (`a7e5714`·`d1ea748`·`2f7628c`).** The
     Task-Manager link and the escalations are still not built. The equipment/area
     registers (`fssai_equipment` 0 rows, so an equipment-targeted checklist can only run if an admin
     types the unit onto the schedule), any due/overdue reminder, and **offline**: `public/sw.js`
     deliberately intercepts nothing — *"Let the network handle everything"* — so a round already
     open survives a signal drop via the `localStorage` queue, but a reload with no signal loads
     nothing at all (RECON §10 R8 — do NOT re-enable caching to "fix" this; it resurrects the
     stale-chunk bug the disabler exists to prevent).
- **2026-10-06** — **WAVE 1: THE SHARED FOUNDATIONS FOR P4–P10. One agent, four shared files,
  nothing else touched.** The owner asked for FSSAI to be completed with a thirty-agent fleet, so the
  review gate stopped blocking (§5.3 rewritten, the old rule quoted in place so it is not lost) and
  the **deploy** gate did not move an inch.
  1. **19 new `fssai_` tables, 11 → 30, and 65 new indexes, 34 → 99**, all inside
     `FSSAI_TABLE_DDL` / `FSSAI_INDEX_DDL`, so the existing per-statement try/catch, the shape guard
     and the boot assertion cover them with no new machinery. The §2 architecture decision was
     honoured, not quietly widened: the twelve checklist sub-modules are still ROWS. Every table here
     earns its place by SHAPE — a per-line accept/reject against a delivery, a number against a
     configured range, a batch with a date, a contractor's visit, a certificate with an expiry.
  2. **THE ONE THING I WOULD OTHERWISE HAVE SHIPPED BLIND.** The shape guard re-runs every CREATE
     into `temp.zz_<name>` and diffs `pragma_table_xinfo`. If a FOREIGN KEY inside a TEMP table had
     thrown there, the guard would have pushed `"<name> probe failed"` on every cold start and the
     boot assertion would have printed **FSSAI SCHEMA NOT OK for ever, over a perfectly good
     schema** — the inert-guard shape inverted. So I ran the guard's own three steps for real:
     **30/30 tables, 0 column differences, 0 probe failures.** Then the case that actually matters
     for testing and production, a database ONE DEPLOY BEHIND: 11 old tables with a published
     template and a submitted run in them → **tables 11 → 30, indexes 99, 0 statements threw, both
     rows untouched.**
  3. **A TICK-BOX IS TEXT, NOT AN INTEGER, and this is the measurement that decided it.**
     `goods_receipt_notes` carries six INTEGER `qc_` tick-boxes and on the live snapshot there are
     **29 GRNs with all six columns summing to 0 on every one of them**. That 0 cannot distinguish
     *"checked and wrong"* from *"nobody ticked it"*, which are opposite statements about a delivery,
     so a report over it either over-counts failures or silently treats an un-done check as a pass.
     Every checkpoint column in the new tables is therefore `TEXT` with `''|ok|not_ok|na`
     (`FssaiCheckResult`), `''` is the default and means NOT ASSESSED, and only `not_ok` is a failure.
  4. **`fssai_evidence` COULD NOT BE REUSED, and that is not a defect to fix.** Its `run_id` is
     `TEXT NOT NULL` with an FK to `fssai_runs`, so a photograph of a rejected delivery or a rat
     sighting cannot go there — and widening it would be worse than useless, because
     `computeFssaiSheetDigest` hashes a run's evidence into the SHA-256 the signature covers, so
     run-less rows would sit inside a signed set. New table `fssai_attachments`, same photo budget,
     same 12-month retention columns, same "the image ages out, the row never does" rule, plus an
     `entity_table` allowlist so a caller-supplied table name can never reach SQL.
     **⚠️ THE RETENTION SWEEP MUST NOW WALK BOTH TABLES** — one that clears only `fssai_evidence`
     keeps every record-module photograph for ever. `fssai_retention_runs` exists so an unattended
     job that deletes image data from a compliance file can prove what it did.
  5. **THE SEED'S MEMORY, which P8 cannot be correct without.** The HRMS block in `db.ts` states the
     trap in its own words: a boot seed RESURRECTS ROWS AN ADMIN DELETED. `INSERT OR IGNORE` keyed on
     `code` cannot tell "never seeded" from "seeded and then deliberately retired" — both look like an
     absent row. `fssai_seed_log` + the full UNIQUE `uq_fssai_seed_item` make a pack's marker row
     insertable exactly once, and the refusal was exercised, not assumed.
  6. **NAV: 21 → 23 rows, in all three files.** `/fssai/audit-log` (mgmtOnly — §19 had a trail being
     written and no screen to read it on) and `/fssai/settings/equipment` (adminOnly — `fssai_equipment`
     holds **0 rows**, so a cold room cannot even be the target of a check). Both have a real
     `page.tsx`, because a catalogued path with no page is a 404. Drift measured, not trusted:
     catalog 23 · sidebar 23 · catalog-only **none** · sidebar-only **none** · order IDENTICAL ·
     **0** label mismatches across catalog/sidebar/modules. The RBAC was EXERCISED by compiling
     `page-catalog.ts` and calling the real `canAccessPage` — `/fssai/settings/equipment` resolves
     adminOnly through `bestEntry`'s longest-prefix rule at two segments deep, and no tier's
     `homePathFor` moved.
     ⚠️ **`/fssai/verification` is in the catalog and the sidebar but has NO `modules.ts` row** —
     pre-existing, harmless today because that page is fully built and does not use `PhaseShell`, but
     it is the one place the three lists disagree. Do not "fix" it by deleting the catalog row.
  7. **The file's own stale number, re-measured as it demands.** The prefix-grant comment said
     "11 parents carry 88 such grants" for a "20-row" FSSAI section that was already 21 rows. It is
     **12 parents / 92 grants**, and `/fssai/settings` is a new KIND of entry: a catalog parent that
     is itself the child of another one.
  8. **An honest change to screen copy, flagged because it is a judgement and not a fact.** Eighteen
     shells printed *"That work is deliberately on hold… the build stops once a checklist runs on a
     phone"*. True in September, false the moment the owner commissioned the fleet. The sentence is
     not deleted — it is behind `FSSAI_BUILD_HELD_AT_REVIEW_GATE = false` in `modules.ts`, one line
     from coming back, with the reason written beside it. `PhaseShell` also stops printing it on any
     screen that passes its own `notice`, which is the Inspection Mode case the prop was written for.
  9. **Gates:** `npx tsc --noEmit` **exit 0, zero output** · `node scripts/check-boot-migrations.js`
     **exit 0, "✓ CLEAN"**. The worktree DB was opened **read-only only** — `purchases 2165`,
     216 tables, `fssai` tables still **11**, mtime unchanged; the 19 appear on the next cold start.
     **No seed row was written anywhere.** `npm run build` and `npm test` were NOT run by this lane:
     a concurrent lane holds the `next build` lock in this worktree and a build exit 1 here is more
     often a lock than a break (§6, 2026-09-21 note 3). The feature lanes own those two numbers.
 10. **WHAT THE EIGHT FEATURE LANES MUST NOT DO.** They may not edit `src/lib/db.ts`,
     `src/lib/page-catalog.ts`, `src/components/Sidebar.tsx` or `src/lib/fssai.ts` — if a column or a
     vocabulary value is missing, SAY SO in the report rather than adding a second convention beside
     the first. A lane MAY set `built: true` on its OWN row in `modules.ts` and nobody else's. The
     one table nobody may add a UNIQUE to casually is `fssai_temperature_logs`: the obvious
     double-submit index over (equipment, date, time, person) would refuse a second UNDATED reading,
     because `reading_at` defaults to `''` and `''` compares equal in a UNIQUE index. Double submits
     belong to the route.
- **2026-09-17** — P1 fix round. `npm test` went `71 passed · 3 failed` → `74 passed · 2 failed`; the
  two survivors are **not code and not FSSAI's** — they assert that the `kitchen` and `liquor`
  station sentinels resolve to NO department, and both are mapped in the owner's production data
  (`station_departments`). Changing that is forbidden by HARD RULE 4. Also closed: a pre-existing
  privilege escalation in `/api/auth/roles` (an all-unknown page list was stored as `NULL` = every
  page — it now 400s), and the screen copy lost "Phase N" and the inspector framing (§7 Q11).

---

## 7. OPEN DECISIONS FOR THE OWNER

P0 recon raised ten. Full argument and evidence for each in `docs/fssai/RECON.md` §9.

**HOW THESE ARE HANDLED WHILE HE IS AWAY.** The owner chose an unattended, scheduler-paced build,
so a phase must not sit and wait. Each question therefore has a **provisional default** — the P0
recommendation — which a phase MAY build on, provided it:
  1. writes the assumption into the code as a comment naming this section,
  2. keeps the decision reversible (a column that can be ignored beats one that must be added later),
  3. lists it in the review-gate report so he can overturn it before P4.
**A provisional default is NOT an answer.** Never present one to him as settled, and never let a
later phase cite an earlier phase's default as precedent.

| # | Question | Provisional default (P0 recommendation) | Owner's answer |
|---|---|---|---|
| Q1 | Per-outlet FSSAI records? (2 outlets exist) | Add `outlet_id TEXT NOT NULL DEFAULT ''` now, defer filtering | — |
| Q2 | Existing checklist/hygiene/maintenance overlap FSSAI | Pest + Water stay in Maintenance, FSSAI *reads* them; hide the dead `/tasks/checklists` + `/tasks/hygiene` nav once the runner ships, keep data; do NOT migrate the 56 manager items | — |
| Q3 | Who verifies a check? | Any management may verify, but **never the person who recorded it** | — |
| Q4 | Save a record if its audit row fails? | Yes, but raise an admin alert — never lose a check staff really did | — |
| Q5 | FIFO/FEFO has no data (952/952 items blank) | Produced batches only for now; a data-entry phase next; capture at goods receipt only if an inspector demands lot traceability | — |
| Q6 | What counts as a signature? | Authenticated user + timestamp. No drawing | — |
| Q7 | Who wakes the system to say a check is due? | In-process scheduler for detection; tell him plainly a fixed-time reminder needs an external cron on the box | — |
| Q8 | Three roles in §20 do not exist (no Maintenance, Supervisor, F&B Controller) | Staff / Manager / Admin for v1. **FSSAI must never create roles** — that is his production config | — |
| Q9 | May a check be backdated? | Yes, within 1 day, mandatory reason, row flagged | — |
| Q10 | Who may see compliance reports? | Staff see their own department; cross-department and inspection packs are management | — |
| **Q11** | **A fix agent rewrote `getDb()` — OUTSIDE the FSSAI footprint.** It found a real app-wide hazard: if `initializeSchema` throws (read-only file, or an older DB missing `sales.bill_type`), the handle cache is already populated, so every later call returns a half-built handle **forever, silently** — no `schema_version`, no health endpoint, nothing printed. The fix moves boot into `bootDb()`, shouts on failure, and makes the next `getDb()` **re-open the file** (SQLite latches read-only at open, so reusing the handle can never recover). Measured across 901 call sites. | **Do not decide this inside FSSAI.** It fixes a whole-app hazard and arguably deserves to ship BEFORE FSSAI, as its own small change. Options: (a) carve it out to `main` separately, (b) keep it on this branch and ship with FSSAI, (c) revert it and lose a real fix. **Recommend (a).** | — |
| **Q12** | `uq_fssai_runs_open` ends in `recorded_by`, so the schema allows **two staff to open the same checklist slot at once**, and nothing caps how many submitted runs one slot accumulates (proved: 3 submitted runs on one slot). The foundation cannot fix this — it needs a route-level rule in P2/P3. | Add the one-run-per-slot rule in P2. Flagging it now so no later phase inherits the wrong belief. | — |
| **Q13** | `fssai_evidence.data_uri` stores photos **in-row as TEXT**. At the ~250 KB cap and 4 photos/day that is roughly **365 MB/year** inside a database file that is 34 MB today. Matches every existing image store in the app, so it is consistent — but nothing enforces a retention window because none has been decided. | Decide in P3: in-row with a retention window, or a separate BLOB table. | — |
| Q11 | The shells print gaps measured in your OWN records. Should they, and who should see them? | Keep the facts, drop the inspector framing (**done** — see below); gate the "Worth knowing now" panel to management in P2 | — |
| **Q14** | **A check FAILED, the problem was fixed, and the same shift needs re-checking.** The slot is locked by the failed record, so the only path today is a manager VOIDING a true observation and filing a fresh one — and the file then reads "voided fail + fresh pass" instead of "failed, corrected, re-checked". Raised by the P2 probes; it must be settled **before P8 seeds the temperature checklists**. | Four options in §7 detail below. **Recommend (c): the fix is a CORRECTIVE ACTION against the failed record (P7), verified there — no second record of the same round** — with (b)'s linked re-check where a physical re-measurement is genuinely needed. Today's behaviour (a) is unchanged and the refusal now says the record FAILED and that a manager may void it if it was a mistake. | **RULED 2026-09-25 — option (c), BUILT.** "Corrective action against the failed record. The failure STANDS. The fix and its verification hang off it via `fssai_corrective_actions`. NO change to the slot rule, no 'rejected' status, no voiding a true observation." The linked re-check of option (b) was NOT taken and is not built. See the P7 row. |
| **Q15** | **Should a record freeze the checklist's TITLE in a column?** The fix round froze the title, the code, both versions and the whole question set into a `fssai_audit_log` row (`action='snapshot'`) at submit — deliberately, because the alternative is a migration on a table that will hold audit history. | **Recommend (a): keep the snapshot** until P9 measures a real report; then consider (c) — columns for the two hot fields, snapshot for the sheet. Options in detail below. | — |
| **Q16** | **A checklist that is run "against nothing in particular", every shift, means ONE person files it for the whole restaurant** — whoever starts it first. Correct for one round per restaurant, wrong for "everyone does this". | **Recommend (a): warn, do not refuse** — built: `config_warnings` is returned on create, edit and publish and must be shown on the builder screen. Options in detail below. | — |
| **Q17** | **🔴 Should an UNSIGNED check be refused? (the open HIGH, defect H-1.)** `FSSAI_REQUIRE_EXPLICIT_SIGNATURE = false` (`src/lib/fssai.ts:1392`) so submit still signs when nobody asked, and `signMode` is hardcoded `'on_submit'` (`runs/route.ts:749`) so a deliberate signature is labelled as the unasked kind. The flag's stated precondition — *"the runner does not send sign:true yet"* — **expired** at `9c453bb`. | (a) flip the flag on **and** fix the mode label · (b) fix the **mode label now**, flip the refusal after he has run one check on the phone · (c) leave both (every record keeps a signature nobody gave) · (d) go further — a separate Sign screen before submit. **Recommend (b) now, (a) the moment the runner has been used once**: the evidence is already strong (who, when, a digest that breaks on any later edit); it is the ceremony that is loose, and tightening a path nobody has pressed is the only reason to wait. | — |
| **Q18** | **A person-targeted round is filed against the user's EMAIL**, because `hr_employees` is empty (0 rows) and email is the only stable staff key this app has (§3). | (a) keep email · (b) switch to `users.id` now · (c) wait for HR to be populated, then key on the employee record. **Recommend (a) now, (c) when HR is populated** — the two keys would not collide and existing rounds keep theirs. Flagged so it is a decision, not a discovery. | — |
| **Q19** | **A leftover test checklist sits in his data** — `ZZ-P2B-COLDROOM`, *"Cold room temperature — closing round"*, **draft**, 0 questions. It is the only row in `fssai_templates`. | (a) delete it (`DELETE FROM fssai_templates WHERE code='ZZ-P2B-COLDROOM';`) · (b) leave it, a harmless draft · (c) finish it into the demo checklist. **Recommend (a) or (c).** Left in place by the gate lane so nothing in his data changed without his say-so. | — |
| **Q21** | **A three-way tick-box, decided by W1 and worth overturning if you disagree.** Your GRN screen's six quality boxes are integers, and on your own data all 29 GRNs have all six reading 0 — which can mean "checked and wrong" or "nobody ticked it". The new delivery, oil and water records store `''` (not checked) · `ok` · `not_ok` · `na` instead, and only `not_ok` counts as a failure. | (a) keep the four-way box · (b) go back to a tick/no-tick integer to match the GRN screen · (c) four-way here AND widen the GRN's six to match. **Recommend (a) now, (c) when the receiving screen is built** — (c) is the only one that makes the two screens tell the same story, but it edits committed purchasing code, which this module does not do without your word. | — |
| **Q22** | **Where a photograph of a delivery or a pest sighting is stored.** A checklist round's photographs live in `fssai_evidence` and are inside the SHA-256 that the signature covers. A delivery or a sighting has no round, so W1 added `fssai_attachments` beside it — same 250 KB / 400 KB budget, same 12-month window you ruled on, same "the image ages out, the row stays". The cost is that the retention sweep now has two tables to walk. | (a) two stores, as built · (b) one store, by letting evidence rows exist with no round — which would put unsigned photographs inside a signed set · (c) no photographs on the record modules at all. **Recommend (a).** (b) is the one option that quietly weakens a signature. | — |
| **Q23** | **Who may cancel a compliance record.** W1 made it one shared rule for every register: a manager, a head of department or an admin, never the person who wrote the record, and always with a reason in words. | (a) as built · (b) admin only — safest, and it means a Saturday night reading entered on the wrong fridge waits for you · (c) let the person who wrote it cancel their own within the shift. **Recommend (a).** (c) is the one that lets a bad number disappear. | — |
| **Q24** | **The build-order sentence on the screens.** Eighteen screens said the work was "deliberately on hold" for your review. You have since asked for the module to be completed, so W1 stopped asserting it (one constant, `FSSAI_BUILD_HELD_AT_REVIEW_GATE`, reversible in a line). | (a) leave it off · (b) put it back · (c) replace it with a plain "being built" note. **Recommend (a).** This says nothing about deploying — §0 stands. | — |
| **Q25** | **Shelf life lives in a new FSSAI table, not in your Item Master.** All 952 items have a blank shelf life, so FEFO has nothing to sort on. W1 did NOT write the missing days into `raw_materials`: that is your Item Master, and `api/import-materials` would wipe it on the next import anyway. `fssai_item_shelf_life` holds one row per item you configure, as a join and never a copy. | (a) keep it in FSSAI · (b) fill in `raw_materials.shelf_life` instead and accept the import risk · (c) both, with FSSAI winning. **Recommend (a).** | — |
| **Q20** | **What may the runner promise about a lost signal?** `public/sw.js` deliberately intercepts nothing app-wide. A round already on screen survives (answers queue in `localStorage`, submit refuses while anything is unsent); a reload with no signal loads nothing. | (a) say "needs a connection", keep the in-page queue (today) · (b) re-enable caching for FSSAI routes only · (c) a proper offline shell for the runner · (d) accept it — the venue's Wi-Fi is the answer. **Recommend (a).** (b)/(c) resurrect the stale-chunk bug the disabler exists to prevent (RECON §10 R8) and are far bigger than they look — worth it only if checks are really run where there is no signal. | — |

### Q14 — a failed check, a repair, and the re-check that has nowhere to go

> **SETTLED 2026-09-25: option 3, and it is built** (`a7e5714`·`d1ea748`·`2f7628c`). The analysis
> below is kept as the record of how the question was put, not as an open question. Option 2's
> linked re-check was NOT adopted: nothing creates a second record of the same round, and the
> slot rule is untouched.

**What happens today, measured.** A slot (checklist · date · target · shift) is closed once it holds
a submitted or verified record. So: the cold room reads 9 °C at closing → the record is submitted and
FAILS → the engineer fixes it → the 11 pm re-check is refused, `409 slot_already_recorded`, for
everyone including a manager. The only exit is `void` with a reason, which reopens the slot.

**Why that is not good enough.** Voiding is for a record entered by mistake. Using it to make room
for a better number is exactly the habit a compliance file must not teach, and the file ends up
showing a voided failure beside a fresh pass rather than the true story: *failed, corrected,
re-checked*. The design anticipated a `rejected` status that reopens the slot, but nothing sets it
(the verification queue is P3/P7's), so `void` is the only reopening path in the build today.

1. **Leave it as it is.** No work. The refusal now at least says the record FAILED and that a manager
   may void it if it was entered by mistake. The file stays misleading in the one case that matters.
2. **A linked RE-CHECK run.** A second run in the same slot, marked as a re-check of the first, both
   records standing. Honest and simple to read. Needs a link between the two runs — a column, or the
   audit row — and a rule about which one the dashboard counts.
3. **A CORRECTIVE ACTION against the failed record (P7), verified there.** No second record of the
   same round: the failure stands, the fix and its verification hang off it. This is how an FSSAI
   audit trail normally reads, it is what `fssai_corrective_actions` was created for, and it needs no
   change to the slot rule.
4. **Build the `rejected` status.** A manager sends a record back and the slot reopens for a redo.
   Right for "this record is wrong", not for "the fridge was mended".

**Recommendation: 3, with 2 where a physical re-measurement is genuinely needed.** Whichever you
choose, it must be settled before P8 seeds the temperature checklists — that is the module where a
failed reading followed by a repair is an everyday event.

### Q15 — where a record's own title should live

The fix round froze the sheet as it was asked — title, code, `version_at_open`,
`version_at_submit`, pass mark, and every question including the ones left blank — into one
`fssai_audit_log` row per record (`action='snapshot'`, `field='record'`), written inside the submit
transaction. The read path renders a finished record from it.

1. **Keep the snapshot.** No migration, one row per record, and a record whose snapshot is missing or
   unreadable still renders (it falls back to the live name and says `template_name_source:'live'`).
   Reads cost one extra row; a history list reads the title with `json_extract`.
2. **Add frozen `template_name` / `template_code` columns to `fssai_runs`** (and a per-response
   `template_version`). Cheaper, more obvious reads — at the cost of a migration on a table that will
   hold audit history, in a codebase whose `initializeSchema()` swallows errors (HARD RULE 7).
3. **Both:** columns for the two fields every screen shows, the snapshot for the full question set.

**Recommendation: 1 now; revisit at P9** when a real report says whether the extra row hurts.

### Q16 — "against nothing in particular", every shift

`target_kind='none'` puts nothing in the slot key, so a per-shift checklist configured that way is
filed ONCE per shift for the whole restaurant, by whoever starts it first. For a single closing round
that is exactly right. For personal hygiene (one record per person) or cold rooms (one per unit) it
is wrong, and nothing in the authoring API used to say so.

1. **Warn, do not refuse — BUILT.** `config_warnings` is returned on create, edit and publish, in
   words: *"…ONE person files it for the whole restaurant each time it is due…"*. The builder screen
   (P2b) must render it. Nothing is decided behind his back.
2. **Refuse to publish** a `per_shift`/`daily` checklist with `target_kind='none'`. Safe, and wrong
   the moment he genuinely wants one restaurant-wide round.
3. **Auto-scope to the person** (one record each). Convenient, and a silent change of meaning.
4. **Auto-scope to the department.**

**Recommendation: 1.** Revisit only if a seeded checklist in P8 trips over it.

> ⚠️ **IT DID, AND BY DESIGN — measured 2026-10-06 (P8).** **10 of the twelve ready-made checklists
> carry this warning**, because ten of them genuinely are one round for the whole restaurant: the
> daily kitchen clean, the washroom round, the storage walks, the opening safety check. The two that
> are one-per-person (`CHK-HYG-SHIFT`, `CHK-HYG-HEALTH-MONTHLY`) use `target_kind='person'` and do not
> warn. So the recommendation stands and nothing was changed — but the warning is no longer only in a
> JSON field: `/fssai/settings/ready-made` prints it next to the checklist it belongs to BEFORE the
> admin presses the button, so he reads the sentence on the screen and not on a Friday night. **No
> seeded checklist targets equipment, an area, a GRN or a batch**, deliberately: the runner refuses a
> non-'none' target with no `target_id` (`runs/route.ts:381`) and `fssai_equipment` holds 0 rows, so a
> per-cold-room seeded checklist would be impossible to start. He changes one in the builder the day
> the equipment register has rows.

### Q20 — P8's own five assumptions, none of them hidden (2026-10-06)

None of these is a ruling. Each is the safest reversible default, each is reversible in the builder
in one click, and each is written on the screen that applies the pack.

1. **The twelve arrive as DRAFTS, not published.** A draft is invisible to staff
   (`templates/route.ts` shows a non-admin only published, active checklists), so the owner reads
   each one, changes the questions and the ranges to match this kitchen, and publishes it himself.
   Publishing twelve is twelve clicks; un-publishing twelve that staff have already filed in is not.
   **Configurable**: the apply screen offers "Published straight away", and the route takes
   `{publish: true}`.
2. **The pack sets NO rota.** `fssai_assignments` needs a person or a role, roles are the owner's
   (HARD RULE 4), and a seeded rota would start marking staff late for checks nobody rostered them
   for. **Nothing becomes "due" until he adds it to the schedule.**
3. **No department, unless he picks one.** Live names carry double spaces ("Akan  Indian") and
   matching on a name is forbidden (RECON §5 row 5), so the pack leaves `department_id` blank and the
   screen offers an optional per-checklist picker that sends an **id**. An id that does not exist is
   refused by name and nothing is written.
4. **`responsible_role_id` is always ''.** FSSAI never creates a role, and guessing which of his
   roles owns a checklist is a production-mapping change (HARD RULE 4).
5. **It cannot be un-seeded.** There is no DELETE on `/api/fssai/seed`. Once the twelve exist they
   are ordinary checklists, retired in the builder like any other — because a seed able to remove
   what it created would be able to remove his edits with them.

**He may want to overrule 1 (publish straight away) and 2 (seed a rota too).** Both are one change.

### Q11 — the module tells the truth about the restaurant, inside the restaurant's app

**What is on screen today.** Four shells state a gap measured in the live database, and all four
statements are true — each was re-verified against the data before it was written:

| Screen | What it says | Measured |
|---|---|---|
| Receiving | the six quality tick-boxes are unticked on every delivery so far | 29 GRNs, all six `qc_` columns sum to 0 |
| FIFO & Expiry | the shelf-life field on all 952 items is empty | 952 items, 0 with a shelf life |
| Temperature Logs | there is no temperature record in the app at all today | no such column anywhere; GRN stores pass/fail only |
| Cold Room | your cold units are not a list in this app yet | 4 free-text strings on `production_batches` |

**The tension.** They are exactly what the owner needs while he judges the foundation. They also
render inside the app he intends to hand to an inspector, on screens any signed-in staff member can
open — and a sentence written *for* him, read *over his shoulder*, is a different thing entirely.

**Already done, and not up for debate** (it needed no ruling, because it removed no fact):
- The shared line *"…so there is nothing here to show an inspector"* is gone from all 19 shells. It
  carried no information the rest of the sentence did not, and it was the one line that read as a
  statement about the restaurant rather than about the software.
- `/fssai/inspection-mode` — the one screen designed to be handed over — now passes its own notice
  and can never inherit the default. **Rule for P9: nothing on Inspection Mode may describe what the
  restaurant lacks.**

**The options on the four measured facts:**

1. **Leave them visible to everyone.** Most honest, no work. But every member of staff, and anyone
   holding the tablet, can read the restaurant's weak points off a food-safety screen.
2. **Keep them, show them to management only** — put the "Worth knowing now" panel behind
   `isManagement`. The people who can act still see them; a porter's phone shows only what the screen
   will do. Costs one conditional and an `/api/auth/me` call on pages that today fetch nothing.
3. **Take them out of the app** — move them into the review-gate report and this document. Nothing
   measured about the restaurant ever renders. You lose them at the moment you are actually looking
   at the screen they concern.
4. **Keep them until the review gate, delete them at P4** — treat them as scaffolding notes that die
   when the real screens arrive.

**Recommendation: 2 now, 4 in the end.** They earn their place while you are judging the foundation,
but they belong to the person who can act on them. Once the real screens exist, an empty temperature
register says the same thing better than a sentence about an empty temperature register.

