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
| P0 | Recon | owner's "inspect before coding" requirement | IN PROGRESS | fleet `wlc4zdmjh` / run `wf_b7840bea-8d6`, started 2026-09-16 |
| P1 | Foundation — schema + nav + RBAC + shells | §20, §24 | PENDING | |
| P2 | Checklist engine — templates/sections/questions | §15 | PENDING | |
| P3 | Mobile runner — run, evidence, signature, submit | §22 | PENDING | |
| **RG** | **🛑 REVIEW GATE — STOP. Owner reviews P0–P3.** | — | **BLOCKING** | not approved |
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

**RULE: when P0, P1, P2 and P3 are all `DONE`, the build STOPS.** Do not start P4. Do not "just make
a start" on anything behind the gate. Put the module in a state he can open and try, then report and
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
3. **CHECK THE REVIEW GATE FIRST.** If P0–P3 are all `DONE` and the **RG** row does not say
   `APPROVED`, **STOP IMMEDIATELY**. Run no fleet. Start no phase. End your turn by reporting that
   the build is complete through P3 and waiting on the owner's review, and restate what he needs to
   look at. A phase started behind a blocking gate is the single worst failure this build can have —
   it spends hours on foundations he may want changed.
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

