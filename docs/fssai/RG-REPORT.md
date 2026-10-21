# FSSAI COMPLIANCE — REVIEW GATE REPORT

**For:** the owner · **Date:** 2026-09-21 · **Branch:** `fssai-compliance` (worktree
`/Users/shashankreddy/Desktop/Claude/fnb-fssai`) · **Head:** `6aee190`
**Nothing is deployed. Nothing is merged. Nothing is pushed.** The gate from §0 holds:
*"After i say Deploy FSSAI then only Deploy this module."*

---

## 1. THE HONEST HEADLINE — read this before you open anything

**P2b and P3 are `PARTIAL`, not `DONE`, and there is one known HIGH defect still open.** Two things
you must know before you spend your own evening on this:

1. **The signature is still not the deliberate act it is supposed to be.** Submitting a check writes
   a signature in your name **whether or not anybody asked for one**, and a signature you *did*
   deliberately give is recorded as the weaker, un-asked-for kind. Details and the one-line fix in
   §6, defect **H-1**. Everything else about the attestation — who, when, a SHA-256 over the answers
   and photographs, an audit row — is real and was measured. It is the *ceremony* that is loose, not
   the evidence.
2. **Nobody has ever seen these screens.** Not one pixel was rendered, not one button pressed, by
   any of the four build lanes. Each hit the same wall (no headless browser available, the live
   Browser pane forbidden for that fleet) and each said so plainly. Everything in this report about
   the **server** — the engine, the rules, the refusals, the photograph, the digest, the verification
   queue — was measured over HTTP against a real database. Everything about the **feel of the screen**
   is code-read, not clicked. *Your first tap is genuinely the first tap.* That is uncomfortable, and
   it is also exactly why this gate exists.

**And one practical thing that will otherwise waste your first ten minutes:** the database in this
worktree contains **no checklist you can run**. It holds one leftover test row
(`ZZ-P2B-COLDROOM`, status *draft*, zero questions). §3 gives you a three-minute authoring script to
create a real one first.

**What I am asking you to judge:** does the phone runner feel right in your hand? Everything in
P4–P11 renders through it. If it is wrong, it is cheap to change today and expensive after eight
more modules sit on top.

---

## 2. HOW TO OPEN IT ON A PHONE

The module is not deployed, so "on a phone" means your phone on the same Wi‑Fi as this Mac,
pointed at a server running in this worktree.

### 2.1 Start it (on the Mac)

```bash
cd /Users/shashankreddy/Desktop/Claude/fnb-fssai
npx next build                          # already done for you today — exit 0, 30.9s
npx next start -H 0.0.0.0 -p 3000
```

Port **3000 is free** (checked). Use `npx next start`, **not** `npm run dev` — npm runs `predev`
first, which is `rm -rf .next` and throws away the whole build cache for no gain here.

> ⚠️ **Run it in this worktree and nowhere else.** `DB_PATH` is `process.cwd()/fnb-controller.db`,
> so a server started in `~/Desktop/Claude/fnb-controller` would write your **live** checkout's
> database. Started here it writes *this* worktree's copy — which is a snapshot of your real data
> (purchases 2165, your 9 users, your 29 departments), so everything looks familiar, and **nothing
> you do in this review touches production.**

### 2.2 Open it (on the phone)

| | |
|---|---|
| **Sign in** | `http://192.168.1.12:3000/login` |
| **The module** | `http://192.168.1.12:3000/fssai` |
| **Straight to the runner** | `http://192.168.1.12:3000/fssai/checklists/run` |

`192.168.1.12` is this Mac's address on your network right now (`ipconfig getifaddr en0`). If the
Wi‑Fi changes, re-read it and substitute.

**Plain `http://` is fine and logging in will work** — the session and CSRF cookies are set with
`secure: false`, commented in the code as *"local dev / LAN access over HTTP"*
(`src/app/api/auth/login/route.ts:32`). The camera also works over plain http, because the photo
button is a native `<input type="file" accept="image/*" capture="environment">`
(`run/[id]/page.tsx:1350`) and not `getUserMedia`, which would have demanded HTTPS.

### 2.3 Which login tier reaches what

Gating is by longest-prefix match over `src/lib/page-catalog.ts` (verified:
`pathname === p.path || pathname.startsWith(p.path + '/')`, `page-catalog.ts:658`).

| Screen | Path | Who reaches it |
|---|---|---|
| Dashboard | `/fssai` | **any signed-in user** |
| Checklist library | `/fssai/checklists` | **any signed-in user** |
| **The phone runner** | `/fssai/checklists/run` and `/run/[id]` | **any signed-in user** (inherits `/fssai/checklists`) |
| Verify records | `/fssai/verification` | **management** (`mgmtOnly`) |
| Reports · Documents · Inspections · Inspection Mode | `/fssai/reports` etc. | **management** (still placeholders) |
| **Settings + the checklist builder** | `/fssai/settings`, `/fssai/settings/checklists/[id]` | **admin only** (`adminOnly`) |

Your own account `shashank@akanhyd.com` is **admin**, so it reaches everything. To feel what a
porter feels, sign in as `btl-staff@test` (**staff**) — the runner works, Settings redirects away.

**Nav parity is clean** (the old drift trap): 21 rows in `page-catalog.ts`, 21 links in
`Sidebar.tsx`, and a diff of the two lists returns **IDENTICAL — no drift**.

---

## 3. A CHECK YOU CAN ACTUALLY RUN, END TO END

### Step 0 — make something to run (≈3 minutes, admin, easier on a laptop)

Today the library is empty. On the Mac browser (or the phone, it works either way):

1. `/fssai/settings` → **Checklists** → **New checklist**.
2. Name it *"Closing round — kitchen"*. Set:
   - **Frequency:** Per shift
   - **Run against:** **Nothing in particular** ← *important, see the warning below*
   - **Department:** Kitchen · **Pass mark:** 100%
3. **Add a section** — *"Before the round"*.
4. **Add three questions**, enough to exercise the parts that matter:
   | # | Type | Settings |
   |---|---|---|
   | 1 | **Yes/No** | *"Are all surfaces clear and wiped?"* — pass = **Yes** |
   | 2 | **Temperature** | *"Freezer core temperature"* — min **−18**, max **−15**, **Photo: Always** |
   | 3 | **Text** | *"Anything the next shift should know?"* — optional |
5. **Publish.**
6. **Schedule it** → assign to yourself (or to the Kitchen department) for the **closing** shift.

> ⚠️ **Choose "Nothing in particular" (or "A person") as the target.** If you pick **equipment**,
> **area**, **GRN** or **batch**, the runner will correctly refuse to start, because the equipment
> and area registers are P4 work and do not exist yet — *"the list to pick from arrives with the
> equipment register… Typing it by hand would let two spellings become two separate records of one
> round."* (It can still be run if you type the unit's name onto the **schedule**, which does accept
> free text.)

> The screen will also show you a **configuration warning** on a per-shift checklist run against
> nothing in particular: *"…ONE person files it for the whole restaurant each time it is due…"*
> That is deliberate (§7 Q16) and is exactly right for a closing round.

### Step 1–6 — the round itself, on the phone

| | What you do | What should happen |
|---|---|---|
| 1 | `/fssai` → big **"Run a check"** button at the top | The picker opens: *Due to you* / *Carry on where you left off* |
| 2 | Tap the checklist → **Start this check** | A round opens. Tap Start again from anywhere → it **resumes the same round**, never a second one |
| 3 | Answer Q1 **Yes** | Card turns complete. Answer it *wrong* (pass = Yes, answer No) and it says *"Recorded as a fail"* |
| 4 | Answer Q2 **−12.4** | *"Above the acceptable maximum of −15"* — a real failure, in words. Correct it to **−16.5** |
| 5 | Q2 still says **"This answer still needs a photograph."** Tap the camera | Native camera. The photo is shrunk on the phone (1200 px, quality ladder) to ≈165 KB before it is sent — **measured with a real 14.18 MB, 12 MP photograph**. The answer is then re-judged complete |
| 6 | Try **Submit** with Q2's photo missing | Refused, and it **names what it is waiting for**: *"2 questions still need an answer"* + the list, each row tappable |
| 7 | **Sign and submit** | The attestation statement is shown, then the record is filed: outcome, pass %, who, when, a SHA-256 over every answer and photograph |
| 8 | Sign in as a **manager** → `/fssai/verification` | The record is in the queue. You **cannot verify your own** (403 *"You recorded this check yourself"*). Verifying **cannot change a single answer** — proved by a tampering POST that left the fingerprint byte-identical |

**Things worth deliberately trying, because they are the rules that matter:**

- **Answer "maybe" to a Yes/No** → refused *by name*: *"'maybe' is not an answer to this question."*
- **Leave the freezer reading blank** → *"No reading recorded."* A blank is **not** zero.
- **Try to record yesterday's round** → refused unless you give a reason; two days back is refused
  outright (1-day limit); tomorrow is refused always.
- **Open the same slot twice** → refused, and if the first record **failed**, the refusal says so:
  *"A second record would hide that."*
- **Have someone else open it, then take it over as a manager** → you must say why.

---

## 4. THE REAL NUMBERS — all three measured by me today, on this commit

| Gate | Command | Result |
|---|---|---|
| **Types** | `npx tsc --noEmit` | **exit 0**, zero output |
| **Build** | `npx next build` | **exit 0** · *"✓ Compiled successfully in 30.9s"* · 289/289 static pages · **34 FSSAI entries** (10 API routes + 24 pages) · **1 warning** = the pre-existing `next.config.ts` NFT trace, present at `main` |
| **Tests** | `npm test` | **exit 1** with **74 passed · 2 failed** — the exact recorded baseline. The two are the `kitchen`/`liquor` **station sentinels mapped in your production data**; HARD RULE 4 forbids touching them, so they fail at baseline and still do |

*(My first build attempt returned exit 1 with "Another next build process is already running" — a
concurrent agent held the lock. I waited rather than killing it and re-ran; the 30.9s exit-0 above
is my own.)*

**What is actually on disk**

| | |
|---|---|
| FSSAI API routes | 10 (`templates`, `templates/[id]`, `sections`, `questions`, `assignments`, `runs`, `masters`, `evidence`, `sign`, `approvals`) — 4,036 lines |
| Shared logic | `src/lib/fssai.ts` 1,470 lines · `src/lib/fssai-server.ts` 778 lines |
| Real screens | 6 — dashboard (199), library (1,671), **run picker (849)**, **runner (1,683)**, **builder (3,518)**, verification (952) |
| Still P1 placeholders | **18 of 24** — by design; they are P4–P11, behind this gate |
| Database (this worktree) | purchases **2165**, 216 tables, users 9, departments 29, roles 9 — untouched. `fssai_templates` 1 (the draft test row), everything else **0** |

**Rules held, checked on the tree, not asserted:** no schema change since P1 · **0** new paths
containing `print` (the rule that would make a record world-readable) · catalog/sidebar identical ·
no production mapping written.

---

## 5. WHAT THE MOBILE RUNNER DOES **NOT** DO YET

Stated plainly, so you find none of it by surprise.

1. **It has never been rendered.** No hydration, no modal opening, no sticky bar on a real viewport,
   no keyboard behaviour, no Escape key. The 390 px fit is a *static* audit (widest fixed element
   80 px, no horizontal scroll container, 20 touch targets at 44–56 px) plus a build that compiles.
   It is not a screenshot.
2. **It does not work offline in the way people assume.** The app's service worker
   (`public/sw.js`) **deliberately does not intercept any request** — *"Let the network handle
   everything"* — because caching once shipped a stale-chunk bug. So: a round already open on screen
   survives a signal drop (each answer is queued in `localStorage` and retried, and submit refuses
   while anything is still only on the phone, naming the count) — but **reload or open the app with
   no signal and nothing loads at all.** The queue's retry loop was never exercised in a real
   browser; it is the highest-risk untested path in the build.
3. **A failed answer raises nothing.** `raise_ca_on_fail` is stored on every question and **nothing
   in the engine reads it** (confirmed: 0 references in `runs/route.ts`, and
   `fssai_corrective_actions` is written by no route at all). The fix-and-re-check story is P7 and
   §7 Q14 below.
4. **There is no equipment or area register**, so a checklist targeted at a cold room can only be run
   if an administrator types the unit onto the schedule. `fssai_equipment` has **0 rows**.
5. **There is no reminder.** Nothing tells anyone a check is due. "Due to you" is computed when the
   screen is opened. A fixed-time morning nudge needs §7 Q7 settled.
6. **The signature is one tap, not a separate step** — the statement is shown and the button reads
   *"Sign and submit"*. A two-step endpoint exists (`POST /api/fssai/sign`) and is wired for errors,
   but the phone path is the single tap. See H-1 and §7 Q6/Q17.
7. **Never exercised at all:** editing a checklist *while* a round is open; retiring a question
   mid-round from the runner's side; more than 4 photographs on one answer; the library's search at
   real row counts; the duplicate/clone button.
8. **18 of the 24 screens are still placeholders** — receiving, temperature, cold rooms, FIFO, pest,
   oil, water, storage, hygiene, documents, reports, inspection mode. That is the plan, not a defect:
   every one of them is behind this gate.

---

## 6. DEFECTS — what was found, what was fixed, what is still open

Across the four lanes, **19 defects** were found by actually exercising the engine. **12 were fixed
and re-proved.** These **7 are open**:

### 🔴 H-1 (HIGH, open) — submit signs when nobody asked, and mislabels a signature that was asked for

`src/lib/fssai.ts:1392` — `FSSAI_REQUIRE_EXPLICIT_SIGNATURE = false`.
`src/app/api/fssai/runs/route.ts:748` — `signNow = askedToSign || !FSSAI_REQUIRE_EXPLICIT_SIGNATURE`.

**Measured:** a fully answered check submitted with **no** `sign` flag and no prior signing call
returns 200, writes `signed_by = <you>`, `signed_at`, and a `sign` row in the audit log. The strict
gate that would refuse with `signature_required` is skipped. The stale-signature guard
(`signature_stale`) is skipped the same way.

**Why it is still here, and why that reason has expired.** The flag was set `false` deliberately, and
the code comment still says why: *"the runner does not send sign:true yet"* — so that your first tap
at this gate would not meet an error about the button you had just pressed. **That is no longer
true.** The runner sends it (`run/[id]/page.tsx:585`,
`sign: needsSignature ? true : undefined`) and renders both refusals with a retry. The precondition
is satisfied; the flag was never flipped because it is another lane's file and it is *your*
attestation policy, not an engineering detail.

**Second half of the same defect:** `runs/route.ts:749` hardcodes
`const signMode: 'explicit' | 'on_submit' = 'on_submit'` while `askedToSign` is computed on the line
above and then ignored. So a signature you gave **deliberately**, having read the statement, is
recorded and shown to an inspector as the kind the server wrote **without being asked**.

**The fix is two lines** (`= true`, and `askedToSign ? 'explicit' : 'on_submit'`), and both paths
were proved working in an isolated copy. **I have not applied it** — see §7 Q17; it changes what
happens on the very build you are about to judge, and it is a compliance-ceremony decision.

### The other six, all lower

| | File | What |
|---|---|---|
| **M-1** | `api/fssai/runs/route.ts:749` | (the mode half of H-1, above) |
| **M-2** | `api/fssai/assignments/route.ts` | `POST` returns the created row **without** the department/role/person name joins that `GET` supplies. Harmless today (the modal re-reads after saving); it becomes a blank owner the moment a screen renders the create response optimistically |
| **L-1** | `api/fssai/evidence/route.ts:221` | Attaching a photo to a **voided** round says *"already been submitted"*. A voided record never happened — the opposite of submitted |
| **L-2** | `settings/checklists/[id]/page.tsx:3122` | In the builder's **preview**, the +/− stepper on a blank temperature starts from **0**, so the first tap on a −18…−15 freezer question gives 0.5. Preview only; the real runner is correct |
| **L-3** | `settings/checklists/[id]/page.tsx:2091` | The "Critical" chip on a question **row** explains its consequence in a hover `title` — and a phone has no hover. The full sentence is on screen in the editor, so nothing is hidden, only hover-only in that one place |
| **L-4** | `api/fssai/runs/route.ts` | The `signature_stale` refusal reports answer/photo **counts**, which are identical when a *value* changed — correct, and useless for saying what moved |

**The two HIGH defects that were found and fixed** are worth knowing about, because they are the
shape of thing this module must never do:

- **The builder painted the failing answer green.** A Yes/No authored with **"no"** as the pass — the
  shape of *"Any pest sighting during the round?"*, i.e. the most important FSSAI questions — showed
  Yes in green directly above the engine's own red *"Recorded as a FAIL."* Colour followed button
  position, not the rule. Fixed: the preview now asks the engine which answer passes, so the two
  cannot drift.
- **Switching a section off promised its questions went with it. They did not** — the run engine
  builds the sheet from the *question's* on/off switch and never looks at the section's, so a
  **critical** question inside a section you believed you had retired could still fail a whole round.
  Fixed: the dialog now names the count and says they are still asked.

---

## 7. THE OPEN DECISIONS — yours to settle

Everything below is a **provisional default** the build leaned on so it could keep moving while you
were away. **None of them is an answer**, none was presented anywhere as settled, and every one is
still cheap to reverse today.

### The four that block the next phase

---

#### **Q17 (new) — Should an unsigned check be REFUSED? (defect H-1)**

1. **Flip the flag on.** An unsigned submit is refused; the phone shows the statement and the button
   says *"Sign and submit"*. Also fix the mode label. Strongest file, one extra beat before every
   submit. *Risk: everything about it is built and measured, but it has never been through a real
   browser — if there is a hydration bug in the signature path, it would block every submit.*
2. **Flip it, but only the mode label now** and the strict refusal after you have used the runner
   once. Keeps this review frictionless, makes the record honest about what kind of attestation it
   was, and leaves the real gate as a five-second change afterwards.
3. **Leave both as they are.** No work. Every record keeps carrying a signature nobody was asked for,
   which is the one thing an inspector reading your file should never find.
4. **Go further — a separate Sign screen** (§22's literal order): review the sheet, then sign, then
   submit. Two taps, the strongest ceremony, and the endpoint already exists.

**Recommendation: (2) now, (1) the moment you have run one check on the phone and it felt right.**
The evidence is already strong — who, when, and a SHA-256 that breaks if an answer changes
afterwards. It is the *ceremony* that needs tightening, and tightening it on a path you have not
pressed yet is the only reason to wait a day.

---

#### **Q14 — A check FAILED, the fault was fixed, and the re-check has nowhere to go**

The cold room reads 9 °C at closing → the record is submitted and **fails** → the engineer fixes it →
the 11 p.m. re-check is **refused**, because the slot is closed. The only way out today is a manager
**voiding** a true observation.

1. **Leave it.** No work. The refusal at least says the record failed and that a manager may void it
   if it was a mistake. The file keeps reading "voided fail + fresh pass" instead of the truth.
2. **A linked RE-CHECK round.** A second record in the same slot, marked as a re-check of the first,
   both standing. Honest and easy to read; needs a link between the two and a rule about which one
   the dashboard counts.
3. **A corrective action against the failed record** (P7), verified there. The failure stands; the
   fix and its verification hang off it. This is how an FSSAI file normally reads, it is what
   `fssai_corrective_actions` was created for, and it needs no change to the slot rule.
4. **Build the `rejected` status** — a manager sends a record back and the slot reopens. Right for
   *"this record is wrong"*, wrong for *"the fridge was mended"*.

**Recommendation: (3), with (2) where a physical re-measurement is genuinely needed.**
**This must be settled before P8 seeds the temperature checklists** — that is the module where a
failed reading followed by a repair is an everyday event.

---

#### **Q13 — How long do photographs live?** *(the one decision P3 owed and did not finish)*

Photographs are stored **in-row as TEXT data URIs**, matching every other image store in this app.
The size budget **is** settled and proved with a real 12 MP photo: 250 KB client target, **400 KB
server ceiling**, 1200 px, 4 per answer, 24 per run — about 22 % of production's real ~1 MB nginx
limit. What is **not** settled is how long they are kept: at 4 photos a day that is roughly
**365 MB a year** inside a database file that is 34 MB today.

1. **Keep everything forever.** Simplest, and the database grows without bound.
2. **Keep in-row with a retention window** — e.g. full-size for 12 months (longer than any inspection
   cycle), then drop the image and keep the record, the fact a photo existed, and its digest.
3. **Move photographs to a separate table** so the main tables stay small, and back it up separately.
   More moving parts; the digest still proves nothing was swapped.
4. **Write them to disk** with a path in the row. Smallest database, and the one option that breaks
   your current single-file backup habit.

**Recommendation: (2), window = 12 months.** It keeps the one-file backup that already works, bounds
the growth, and never deletes the *record* — only the picture attached to a record older than any
inspector will ask about.

---

#### **Q11-A — A whole-app database fix is sitting on this branch** *(not FSSAI's to decide)*

A fix agent found and fixed a real app-wide hazard **outside the FSSAI footprint**: if
`initializeSchema` throws (read-only file, or an older DB missing a column), the handle cache is
already populated, so every later call returns a half-built handle **forever, silently**. The fix
moves boot into `bootDb()`, shouts on failure, and re-opens the file on the next call. Measured
across 901 call sites.

1. **Carve it out to `main` as its own small change**, before FSSAI. It protects the live app today.
2. **Keep it on this branch** and let it ship whenever FSSAI ships — i.e. possibly never.
3. **Revert it** and lose a real fix.
4. Carve it out **and** keep the copy here, so the branch does not drift.

**Recommendation: (1).** It is not an FSSAI feature; it is a bug in the app you are running right
now, and holding it hostage to this gate protects nobody.

---

### The rest — settled provisionally, still yours to overturn

| # | The question | Options | Recommendation |
|---|---|---|---|
| **Q1** | **Per-outlet records?** (2 outlets exist) | (a) `outlet_id` everywhere, filtered · (b) no column, one compliance file · (c) column present, filtering deferred | **(c)** — built. Adding the column later to tables holding audit history is painful; the switcher can wait until a second kitchen is really inspected |
| **Q2** | **The old checklist/hygiene screens overlap FSSAI** (`/tasks/checklists` 5 templates / 56 items / 0 records; `/tasks/hygiene` 0 records; pest + water already live as maintenance schedules) | (a) leave both, accept two places · (b) hide the dead nav, keep the data · (c) migrate the 56 items into FSSAI · (d) pest + water stay in Maintenance, FSSAI *reads* them | **(d) + (b)** — pest control genuinely *is* a maintenance schedule. Do not migrate the 56 items; they are manager checklists ("Washrooms"), not FSSAI records |
| **Q3** | **Who verifies a check?** | (a) any management, **never the recorder** · (b) manager tier and above only · (c) admin only · (d) per-template verifying role | **(a)** — built and proved (403 `own_record`). It is the narrowest rule that works on a nine-person roster, and "you cannot sign your own check" is the part an inspector cares about. (d) stays available later |
| **Q4** | **Save a record if its audit row fails?** | (a) yes, record wins · (b) no, roll the whole thing back · (c) yes, but raise an admin alert | **(c)** — never lose a check staff really performed, never let the trail rot silently. *The alert half is not built yet* |
| **Q5** | **FIFO/FEFO has no data** — shelf life empty on all 952 items | (a) produced batches only · (b) capture batch + expiry at goods receipt · (c) a data-entry phase for the perishable subset · (d) all, phased | **(a) now, (c) next, (b) only if an inspector demands lot traceability** — (b) adds a step to every delivery and will be skipped in practice unless it is genuinely required |
| **Q6** | **What counts as a signature?** | (a) authenticated user + timestamp · (b) a drawn signature · (c) typed name + timestamp · (d) a 4-digit PIN re-entered at submit | **(a)** — built. Stronger than a drawing anyone can scribble, and it matches how the rest of the app records an actor. (d) only if an inspector asks for a distinct act |
| **Q7** | **Who says a check is due?** The in-process scheduler is production-only and lazy-armed | (a) register FSSAI's sweep in the existing scheduler · (b) external cron on the box at fixed hours · (c) compute on page load, no alerts in v1 · (d) (a) now, (b) later | **(d)** — but plainly: **a fixed-time 8 a.m. WhatsApp reminder needs (b) configured on the server.** Today the build is at (c): nothing reminds anybody |
| **Q8** | **Three roles in §20 do not exist** (no Maintenance, no Supervisor, no F&B Controller) | (a) map them onto existing roles · (b) create them in `/settings/roles` · (c) Staff / Manager / Admin only for v1 | **(c) for v1, (b) when you want the finer split.** **FSSAI must never create a role** — roles are your production config |
| **Q9** | **May a check be backdated?** | (a) never · (b) within N days, mandatory reason, flagged · (c) management only, any date, flagged | **(b) with N = 1** — built and proved all four ways. A restaurant that lost power at 11 p.m. records the closing check next morning; forbidding it just moves the lie into a live entry |
| **Q10** | **Who sees compliance reports?** | (a) management only · (b) staff see their own department, management sees all · (c) admin only | **(b)** — built at the API (another department's staff gets 403). The cross-department and inspection-pack views stay `mgmtOnly` |
| **Q11-B** | **The placeholder screens print gaps measured in your own records** ("the six quality tick-boxes are unticked on every delivery", "the shelf-life field on all 952 items is empty") — true, useful to you, and readable by anyone holding the tablet | (a) leave visible to everyone · (b) keep them, **management only** · (c) move them out of the app into this report · (d) keep until the review gate, delete at P4 | **(b) now, (d) in the end.** They earn their place while you judge the foundation, but they belong to the person who can act. *Not yet built — the panels are still visible to any signed-in user* |
| **Q12** | **Two people could open the same slot at once** — the schema allows it | Fix at the route (built: one open round per slot, resume never duplicates) · or accept · or a DB constraint | **Route rule — done.** Proved: pressing Start twice resumes the same round; a second person gets *"… already has this check open"* with a takeover path |
| **Q15** | **Where should a record's own title live?** The sheet as it was asked is frozen into an audit row at submit | (a) keep the snapshot · (b) add frozen columns to `fssai_runs` · (c) both — columns for the two hot fields, snapshot for the sheet | **(a) now, revisit at P9** when a real report says whether the extra row hurts. (b) means a migration on a table holding audit history, in a codebase that swallows schema errors |
| **Q16** | **"Against nothing in particular", every shift** = one person files for the whole restaurant | (a) **warn, do not refuse** · (b) refuse to publish · (c) auto-scope to the person · (d) auto-scope to the department | **(a)** — built; the warning is returned on create, edit and publish, in words, and the builder shows it. Revisit only if a seeded checklist in P8 trips over it |
| **Q18** *(new)* | **A person-targeted round is filed against the user's EMAIL**, because `hr_employees` is empty (0 rows) and email is the only stable staff key | (a) keep email · (b) switch to `users.id` now · (c) wait for HR to be populated, then key on the employee record | **(a) now, (c) when you populate HR** — the two would not collide; existing rounds keep their email key. Flagged so it is a decision and not a discovery |
| **Q19** *(new)* | **A leftover test checklist is sitting in the database** — `ZZ-P2B-COLDROOM`, *"Cold room temperature — closing round"*, draft, 0 questions | (a) delete it · (b) leave it, it is a harmless draft · (c) finish it into the demo checklist from §3 | **(a) or (c).** It is one row; `DELETE FROM fssai_templates WHERE code='ZZ-P2B-COLDROOM';` removes it. I left it alone so nothing in your data changed without your say-so |
| **Q20** *(new)* | **What should the runner promise about a lost signal?** The app's service worker is deliberately inert app-wide | (a) say "needs a connection" and keep the in-page queue (today) · (b) re-enable caching for the FSSAI routes only · (c) a proper offline shell for the runner · (d) accept it: the venue's Wi-Fi is the answer | **(a) now.** (b)/(c) would resurrect the stale-chunk bug the disabler exists to prevent, and it is a much bigger piece of work than it looks — worth doing only if checks are really being run in a cold room with no signal |

---

## 8. WHAT I WOULD DO NEXT, IF YOU ASKED ME

1. **Run one check on your phone** (§3). Ten minutes. That is the whole point of this gate.
2. **Answer Q17, Q14, Q13** — they are the three that block P4/P7/P8.
3. **Let the two-line H-1 fix land** once the runner has felt right once.
4. Only then release P4.

If the runner feels wrong — too many taps, the wrong things large, the wrong things buried — say so
now. Everything in P4–P11 renders through it.

---

## 9. PROVENANCE — what is measured and what is not

**Measured, first-hand, on this commit, by the agent writing this report:**
`tsc` exit 0 · `next build` exit 0 in 30.9s with the route table · `npm test` 74 · 2 · the
catalog/sidebar diff · the file inventory · the database counts · every line number and quoted
sentence in §5 and §6.

**Measured by the build lanes, over HTTP against a running server, with transcripts:** the whole
engine — the eight question types, the refusals in their real words, the photograph with a real
14.18 MB camera file, the SHA-256 digest breaking when an answer changes, the tamper-proof verify,
the slot rule, takeover, void, backdating, CSRF, and cross-department 403s. P3 Lane A's proofs ran
against **this worktree's own database**, then deleted their own rows — the counts in §4 match that
lane's recorded baseline exactly.

**NOT measured by anybody: the screens.** No browser ever rendered them. Every statement in this
report about what a screen *looks like* is read from its source; every statement about what the
server *does* was executed. Where those two disagree, believe the server half.

---

*Written at the review gate, 2026-09-21. Nothing here is deployed, merged or pushed. P4–P11 remain
`HELD` until you say so.*
