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
| P3 | Mobile runner — run, evidence, signature, submit | §22 | **PARTIAL** | **BUILT — Lane A `9c453bb`·`efd6103`·`acd6766` (picker 849 + runner 1,683 + `RunnerUI.tsx`); Lane B `4a70cff`·`ecf1948`·`3ffac34`·`d1e6590`·`5d5f459`·`6aee190` (evidence + sign + approvals routes, `/fssai/verification` 952).** **NO SCHEMA CHANGE.** HARD RULE 14 SETTLED: photos stay in-row as TEXT data URIs, 250 KB client target / **400 KB server ceiling** / 1200 px / 4 per answer / 24 per run — proved with a real 14.18 MB 12 MP photograph shrinking to 165 KB ≈ 22% of production's ~1 MB nginx limit. The evidence route makes "Photo: Always" satisfiable at last (P2a could only insert the row by hand). Signing became an ACT with a SHA-256 over every answer + photograph; verifying **cannot change a record** (proved by a tampering POST — fingerprint byte-identical either side). **PARTIAL for two reasons: (1) an OPEN HIGH — `FSSAI_REQUIRE_EXPLICIT_SIGNATURE = false` (`src/lib/fssai.ts:1392`) still lets submit write a signature nobody asked for, and its stated precondition has EXPIRED (the runner now does send `sign:true`, `run/[id]/page.tsx:585`); `signMode` is hardcoded `'on_submit'` (`runs/route.ts:749`) so a deliberate signature is recorded as the un-asked kind. Two-line fix, deliberately not applied — it is an attestation policy (RG-REPORT §7 Q17). (2) no browser ever rendered the runner: the 390px fit is a static audit, and the offline queue's retry loop is unexercised.** Also not built: corrective action on failure (`raise_ca_on_fail` stored, **0** readers in the engine; `fssai_corrective_actions` written by no route), the equipment/area registers (`fssai_equipment` 0 rows), any due/overdue reminder. Gates: identical to P2b's row above, run on the same commit |
| **RG** | **🛑 REVIEW GATE — STOP. Owner reviews P0–P3.** | — | **BLOCKING — report delivered, awaiting his word** | **`docs/fssai/RG-REPORT.md`** (2026-09-21). Carries all five things §4 requires: the phone URL + tier table, a runnable end-to-end script (incl. the fact that the DB holds NO runnable checklist — one draft test row `ZZ-P2B-COLDROOM`, 0 questions — so step 0 authors one), the three real gate numbers, what the runner does NOT do, and 20 open decisions each with options + trade-offs + a recommendation. **Not approved.** P4–P11 stay `HELD` |
| P4 | Receiving QC · Temperature Logs · Cold Room | §2, §4, §5 | HELD | behind RG |
| P5 | FIFO/FEFO & Expiry · Oil Quality · Water & Ice | §3, §12, §13 | HELD | behind RG |
| P6 | Pest Control · Documents & Certificates | §7, §17 | HELD | behind RG |
| P7 | Corrective Actions + Task/Maintenance + alerts | §14, §21, §23 | HELD | behind RG |
| P8 | Seeded checklist templates (the twelve) | §6, §8, §9, §10, §11 | HELD | behind RG |
| P9 | Dashboard · Inspection Mode · Reports | §1, §16, §18 | HELD | behind RG |
| P10 | Audit trail hardening — void, never delete | §19 | HELD | behind RG |
| P11 | Full adversarial verification + carve | all | HELD | behind RG |

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
3. **CHECK THE REVIEW GATE FIRST.** If P0–P3 are all `DONE` **or `PARTIAL`** and the **RG** row does
   not say `APPROVED`, **STOP IMMEDIATELY**. Run no fleet. Start no phase. End your turn by reporting
   that the build is through P3 and waiting on the owner's review, and restate what he needs to look
   at — point him at `docs/fssai/RG-REPORT.md`. A phase started behind a blocking gate is the single
   worst failure this build can have: it spends hours on foundations he may want changed.
   > ⚠️ **`PARTIAL` DOES NOT MEAN "GO AND FINISH IT" (added 2026-09-21).** P2b and P3 are `PARTIAL`
   > because the only thing that can close them is the owner opening the module on his phone — no
   > agent in this environment can render a screen, which is exactly what those rows are missing.
   > There is no `PENDING` row left. **Rebuilding a `PARTIAL` phase is forbidden while RG is
   > blocking**: two lanes already discovered their own work was built before they started and
   > rightly switched to verifying instead of rebuilding. The one item a run MAY act on is the open
   > HIGH in §7 Q17 — **and only if the owner has answered it.**
4. Otherwise, find the first phase in §4 whose status is `PENDING`. A phase marked `HELD` is behind
   the review gate and is not available to you, whatever its position in the table.
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
  6. **STILL NOT BUILT, and the report says so plainly:** corrective action on a failed answer
     (`raise_ca_on_fail` is stored and read by **nothing** in the engine — measured 0 hits in
     `runs/route.ts`; `fssai_corrective_actions` is written by no route), the equipment/area
     registers (`fssai_equipment` 0 rows, so an equipment-targeted checklist can only run if an admin
     types the unit onto the schedule), any due/overdue reminder, and **offline**: `public/sw.js`
     deliberately intercepts nothing — *"Let the network handle everything"* — so a round already
     open survives a signal drop via the `localStorage` queue, but a reload with no signal loads
     nothing at all (RECON §10 R8 — do NOT re-enable caching to "fix" this; it resurrects the
     stale-chunk bug the disabler exists to prevent).
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
| **Q14** | **A check FAILED, the problem was fixed, and the same shift needs re-checking.** The slot is locked by the failed record, so the only path today is a manager VOIDING a true observation and filing a fresh one — and the file then reads "voided fail + fresh pass" instead of "failed, corrected, re-checked". Raised by the P2 probes; it must be settled **before P8 seeds the temperature checklists**. | Four options in §7 detail below. **Recommend (c): the fix is a CORRECTIVE ACTION against the failed record (P7), verified there — no second record of the same round** — with (b)'s linked re-check where a physical re-measurement is genuinely needed. Today's behaviour (a) is unchanged and the refusal now says the record FAILED and that a manager may void it if it was a mistake. | — |
| **Q15** | **Should a record freeze the checklist's TITLE in a column?** The fix round froze the title, the code, both versions and the whole question set into a `fssai_audit_log` row (`action='snapshot'`) at submit — deliberately, because the alternative is a migration on a table that will hold audit history. | **Recommend (a): keep the snapshot** until P9 measures a real report; then consider (c) — columns for the two hot fields, snapshot for the sheet. Options in detail below. | — |
| **Q16** | **A checklist that is run "against nothing in particular", every shift, means ONE person files it for the whole restaurant** — whoever starts it first. Correct for one round per restaurant, wrong for "everyone does this". | **Recommend (a): warn, do not refuse** — built: `config_warnings` is returned on create, edit and publish and must be shown on the builder screen. Options in detail below. | — |
| **Q17** | **🔴 Should an UNSIGNED check be refused? (the open HIGH, defect H-1.)** `FSSAI_REQUIRE_EXPLICIT_SIGNATURE = false` (`src/lib/fssai.ts:1392`) so submit still signs when nobody asked, and `signMode` is hardcoded `'on_submit'` (`runs/route.ts:749`) so a deliberate signature is labelled as the unasked kind. The flag's stated precondition — *"the runner does not send sign:true yet"* — **expired** at `9c453bb`. | (a) flip the flag on **and** fix the mode label · (b) fix the **mode label now**, flip the refusal after he has run one check on the phone · (c) leave both (every record keeps a signature nobody gave) · (d) go further — a separate Sign screen before submit. **Recommend (b) now, (a) the moment the runner has been used once**: the evidence is already strong (who, when, a digest that breaks on any later edit); it is the ceremony that is loose, and tightening a path nobody has pressed is the only reason to wait. | — |
| **Q18** | **A person-targeted round is filed against the user's EMAIL**, because `hr_employees` is empty (0 rows) and email is the only stable staff key this app has (§3). | (a) keep email · (b) switch to `users.id` now · (c) wait for HR to be populated, then key on the employee record. **Recommend (a) now, (c) when HR is populated** — the two keys would not collide and existing rounds keep theirs. Flagged so it is a decision, not a discovery. | — |
| **Q19** | **A leftover test checklist sits in his data** — `ZZ-P2B-COLDROOM`, *"Cold room temperature — closing round"*, **draft**, 0 questions. It is the only row in `fssai_templates`. | (a) delete it (`DELETE FROM fssai_templates WHERE code='ZZ-P2B-COLDROOM';`) · (b) leave it, a harmless draft · (c) finish it into the demo checklist. **Recommend (a) or (c).** Left in place by the gate lane so nothing in his data changed without his say-so. | — |
| **Q20** | **What may the runner promise about a lost signal?** `public/sw.js` deliberately intercepts nothing app-wide. A round already on screen survives (answers queue in `localStorage`, submit refuses while anything is unsent); a reload with no signal loads nothing. | (a) say "needs a connection", keep the in-page queue (today) · (b) re-enable caching for FSSAI routes only · (c) a proper offline shell for the runner · (d) accept it — the venue's Wi-Fi is the answer. **Recommend (a).** (b)/(c) resurrect the stale-chunk bug the disabler exists to prevent (RECON §10 R8) and are far bigger than they look — worth it only if checks are really run where there is no signal. | — |

### Q14 — a failed check, a repair, and the re-check that has nowhere to go

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

