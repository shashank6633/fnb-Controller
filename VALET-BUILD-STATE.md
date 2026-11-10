# VALET PARKING — DURABLE BUILD STATE

> **Single source of truth for the Valet build.** On ANY restart (crash, network loss, new
> context): read this file and `git log --oneline -15` FIRST, then continue from "Next steps".
> Never redo work listed under "Done and verified". Update this file at every save
> (every 30–60 minutes, the owner's instruction).

## 0. The gate

**NEVER deploy. NEVER push. NEVER merge into main.** The owner deploys only on his explicit
word "Deploy". Commits go to the LOCAL branch `valet-parking-1109` only, message
`WIP valet: <what>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
The branch's upstream was UNSET on purpose (it auto-tracked origin/main) — keep it unset.

| | |
|---|---|
| Worktree | `/Users/shashankreddy/Desktop/Claude/fnb-valet` |
| Branch | `valet-parking-1109` (from origin/main `5837f5d`) |
| Live repo (never touch) | `/Users/shashankreddy/Desktop/Claude/fnb-controller` (local main is STALE 62aa895; dev server :3001 is not ours) |
| Other sessions' worktrees (never touch) | `fnb-purchgt`, `fnb-reqrecon`, `fnb-approvallabels` (and every other `fnb-*`) |
| Ports | 3900–3949 only. One dev server per agent, one `next build` at a time. Kill what you start. |
| Spec | `docs/valet/SPEC.md` (verbatim) · Design/rulebook: `docs/valet/DESIGN.md` |
| Memory note | `~/.claude/projects/-Users-shashankreddy-Desktop-Claude/memory/project_fnb_valet.md` |

Owner rules that bind every step: no `rm`/`rm -rf` (make new uniquely-named folders instead);
never change production roles/depts/mappings — new capabilities default OFF; edit BOTH
`page-catalog.ts` and `Sidebar.tsx`; resolve roles in BOTH `getCurrentUser` and `proxy.ts`;
guest routes self-authenticate; never handle credentials (simulator + setup docs instead);
plain-language checklists, never "Done".

## 1. Increment plan (spec §13 order)

| # | Scope | Status |
|---|---|---|
| 1 | Core: schema, access, outlet enable, zones, staff↔outlet, tags, staff + guest-led check-in, parking + custody, guest pass, queue + Take next car, ready/dwell/holding, verified handover + claim receipt + recovery, Head Dashboard, team/shifts, SSE + polling, tests | **VERIFIED (local)** |
| 2 | Scheduling across midnight/hours/capacity, photos, reports+CSV, paper ticket books, FNB links, notification outbox + WhatsApp adapter/simulator, consent, escalations, closing rush, retention | **VERIFIED (local, browser 10 Nov)** |
| 3 | NFC provisioning, RFID adapter + simulator, docs, final checklist | **VERIFIED (local, browser 10 Nov; no physical device)** |

## 2. Done and verified

- **Engine + access + APIs (increment 1 backend)** — commits dcbb6ca, 0b2687c, + test commit.
  Proof: `npx tsc --noEmit` clean; `npx tsx scripts/valet-tests.ts <harness copy>` → **229 passed, 0 failed**
  (sections A–P: schema/constraints, access incl. proxy + catalog + command table, check-in, parking,
  pickups/idempotency/scheduling, FIFO fairness, take-next, **5-process simultaneous claim race → exactly
  2 of 5 got cars, no double claim**, gate/dwell/holding/no-show, change requests, reassignment handoff,
  verified handover + replay + lockout + recovery, guest layer/CSRF/enumeration/tag reuse, midnight
  business date, shift custody, void/desk masking/ETA honesty/cross-outlet).
- Files: `src/lib/valet/*` (schema, states, config, caps, credentials, core, bus, queue, ops-arrival,
  ops-pickup, ops-admin, commands, board, guest, guest-page, i18n, http), routes `src/app/valet-pass`,
  `src/app/api/valet/{command,board,attendant,desk,session,context,settings,stream}`,
  `src/app/api/valet-guest/{state,entry,act}`. Shared files touched: db.ts (1 import + 1 call), auth.ts,
  page-catalog.ts, proxy.ts, Sidebar.tsx, api/auth/roles/route.ts, settings/roles/page.tsx.

- **Increment 1 browser-verified (2026-11-09 evening)** on a harness copy (`harness/valet/browser-214625/app`,
  `next dev` port 3900 bound to 127.0.0.1, scheduler OFF), identities separated by origin (head=localhost,
  attendant=127.0.0.1, guest=guest.localhost, desk=desk.localhost). Scenarios run and checked in the DB:
  1. Guest QR check-in → pairing code → attendant confirms with tag → guest phone becomes the pass → park
     (zone/spot/rack, 3 custody rows) → guest "Now" (ETA range + "1 car ahead") → head assigns → fetch →
     ready (3-min gate timer + rotating 6-digit code on the guest phone) → verified handover by guest code →
     "Handed over" on the guest phone; DB: code consumed once, grants revoked, tag freed, pickup COMPLETED.
  2. Phone-less guest: claim receipt (code shown once) → wrong tag refused + logged → handover by claim code.
  3. Scheduled pickup: booked request released by the queue rule and dispatched FIFO.
  4. No-show: ready → guest went inside → move to holding (reason) → confirm holding spot → pickup NO_SHOW →
     guest returned → new pickup queued (both attempts + 15-event timeline kept).
  5. Head intervention: assign from the drawer, priority with an on-screen-enforced reason (shown on card).
  6. Two simultaneous staff clients: head board updated via SSE ("Live") when the attendant claimed a car.
  7. Desk (host): lookup "4" → tag 04 (masked plate) → request only after ticking guest confirmation.
  8. Hindi on the guest page. 375px attendant + guest; desktop head board.
- Bugs found in the browser and FIXED: guest page redraw wiped a half-typed form; false "booked pickup late"
  on request-now cars; "keys with someone quiet" noise for locked phones (now off-shift only); 12 cramped
  tiles; scanner showed kitchen "batch" wording (optional props added, kitchen unchanged); scanner close
  wiped the car dialog; tag "2" ≠ "02" (numeric tags now ignore leading zeros); desk needed 2 chars; native
  prompt()/confirm() replaced by an in-app reason dialog; at-gate duplicate; phone title squeeze.
- Commits: … f8c207e, 2bbc122. tsc clean (`--incremental false`). valet-tests 232/0. Gate earlier: suites
  identical to origin/main baseline; next build OK. origin/main merged in at ee4d521 (59d764e, clean).

## 3. Increment 2 (done)

DONE in increment 2 (tests 316/0, tsc clean; commits ba1cab6 … a26dfe5):
- worker.ts (20 s tick, armed in instrumentation.ts; prod or ENABLE_SCHEDULER=1 only) → promote due, expire,
  escalations.ts (unclaimed/long fetch/outside/dwell/no staff; deduped; auto-resolved; shown inside the
  matching board exception with a separate "Seen" acknowledgement), notify.ts outbox, closing.ts, retention.ts.
- notify.ts: verified identity = guest sends "VALET <code>" from their phone (pass button → wa.me link);
  consent recorded; STOP opt-out; NOW → pickup only when exactly one car matches (else staff alert);
  honest statuses (sent ≠ delivered; delivered/read/failed only from the SIGNED webhook; no backwards moves;
  stale replays ignored; provider events deduped); bounded retries 1/5/15 min → failed on the board;
  obsolete messages cancelled; SIMULATOR whenever the outlet's real-send switch is off, WhatsApp/template
  is missing, or the process is not production (VALET_ALLOW_DEV_SEND=1 overrides for a developer only).
  ⚠ The prod DB copy carries LIVE WhatsApp creds (Interakt key + token): tests disable fetch + overwrite
  creds on the copy; browser harness must keep outlet real-send OFF (default) — dev never sends anyway.
- Webhook hook in src/app/api/whatsapp/webhook/route.ts: valet ingest only when auth.enforced (signature
  checked with a configured app secret). Prod has NO app secret today → valet ignores WhatsApp events until
  the owner pastes it (noted for the owner).
- Simulator route /api/valet/simulator (admin; refused when live) + message log /api/valet/messages + Settings UI.
- Photos (media.ts, /api/valet/media): byte-sniffed JPEG/PNG/WebP, 2 MB, 6/car, private no-store route,
  attendant/head only, progress + retry upload, head drawer strip; counts toward the photo policy.
- Reports (reports.ts, /api/valet/reports, /valet/reports page + catalog/sidebar rows): definitions,
  denominators, immediate vs booked kept apart, shift-hours filter, outlet scoping, formula-safe CSV.
- Paper tickets (17bb4d2, ops-paper.ts): ticket books, validation, guest entry = pending claim/verification
  only, stub-checked confirmation. A ticket number alone grants nothing.
- Dining links (894e3ee, ops-dining.ts, tests 361/0): link is to the ORDER (table transfer keeps it; table
  read live); by-table resolves the ONE open bill — 2+ open bills on a table (real data has one with 4) →
  refused 'ambiguous_table'; bill with no outlet → refused; merged bill shows "merged — re-link".
  /cashier gets <ValetOrderChip> (one insertion above the actions row): route /api/valet/dining answers
  {show:false} (200) to anyone without a valet cap / not assigned / valet off — checked BEFORE the order
  lookup; request button only for host cap (mirrors pickup.request) and only after "Guest asked" tick.
  Head drawer: Dining line + Link to table / Re-link / Unlink; board MiniCard shows "Table X · bill #N".
- Test fix: section K "quiet device" leaked the REAL clock from section H's process race (a5's shift
  last_seen_at = wall time) → passed only before ~midnight IST or when a5 lost the race. K now sets a5's
  heartbeat explicitly. Product logic unchanged.
- PART 2 BROWSER PASS DONE (2026-11-10 03:25–04:55, harness copy, WA creds blanked, simulator only):
  ordinary cashier sees NO chip + quiet 200; desk links by tag → request only after "Guest asked" tick →
  head board shows "Table 3 · bill #…" live; re-link to a 4-open-bill table refused in plain words; unlink;
  desk search by table; photo upload (2400px → 33 KB stored, note + who), fake JPEG → 415, signed-out → 401;
  guest QR check-in → pairing → WhatsApp code → simulator "VALET <code>" linked → "NOW" → pickup queued
  (source guest/WhatsApp) → ready → "ready" message SIMULATED, guest pass flips to ready + handover code;
  reports + CSV; settings (templates, paper, books); paper: ticket-only check-in, unknown ticket refused,
  table claim needs stub tick, verification path; head "Needs attention" escalations with Seen.
  Fixes from the pass (all committed, tests 365/0): desk card shows the linked table; chip spacing; guest
  later-times only bookable ones (none after closing, not the closing minute — 2 tests); pairing code
  submits on Enter/Go; attendant check-in PAPER TICKET field (was missing!); verification shows the ticket;
  pass says TICKET; ticket-book form clears; demo seed adds a no-valet cashier.
- Browser-harness lessons: cookies are per HOST not port — other sessions' servers on localhost:38xx share
  `fnb_session` → use own hosts (valet-att/valet-admin/valet-desk/guest/guest2 .localhost). Turbopack in
  the harness MISSES rsync'd server-lib changes → restart the server after syncing src/lib. Demo admin
  user added to the harness copy only (token in session scratchpad, never in chat).

## 3b. Increment 3 (2026-11-10, commits d97e2c4 … 456c1c6+)

- NFC (ops-nfc.ts, /api/valet/nfc): key-tag link = /valet/attendant?nfc=<12-char opaque ref>; staff of
  that outlet only (others/dead links get the SAME 404 'nfc_unknown'; signed out → 401 → login);
  re-issue kills old sticker; chip-serial copy check → 'nfc_copy' alert; lost/retired tags refused.
  Attendant: ?nfc= arrival opens the car (fetches the other outlet's view if needed) + Web NFC "Tap key
  tag" (useWebNfc capability hook). Settings NFC panel: venue/table/key links, copy, write (Web NFC
  only), New link / Remove, CSV, EPC per tag.
- RFID (ops-rfid.ts, POST /api/valet-rfid/ingest = public EXACT path, Bearer token, SHA-256 stored):
  config rfid.mode off|simulator|live (default off, admin-only via Rules); verdicts accepted / replay /
  duplicate / stale / future / unknown_tag / invalid; batch ≤ 200; rate limit; health never/ok/quiet/
  disabled; simulator (admin, simulator mode only); drawer shows "keys seen near …, unconfirmed".
  Observations never change car/pickup/custody. Schema: valet_rfid_readers, valet_rfid_events, tag
  columns nfc_issued_at / nfc_chip_serial / rfid_epc via ADDED_COLUMNS (runs before indexes).
- Tests Y (NFC) + Z (RFID) → suite 423/0. Lint: no new findings; learned that the React Compiler lint
  reports ONE finding per component and SKIPS a component containing try…finally or a render-time
  setState — removing eslint-disable lines and `finally` restored analysis.
- Docs: SETUP, NOTIFICATIONS, OPERATIONS, HARDWARE, DEPLOY, env.example, CHECKLIST (final owner list).
- Gate: part-2 gate PASSED (efc8198 == origin/main 1b8b290 on every suite; valet 365/0; build ok).
  FINAL GATE PASSED on af7b7f1 (== origin/main 1b8b290 on every suite; valet 423/0; build ok) — CHECKLIST §6.

- OWNER 2026-11-10 "For Valet Role Only Valet Related Pages should be Seen": verified (page list =
  valet pages → only valet pages, lands on them). Trap closed: roles API refuses a valet tick with NO
  page list (= every page) unless admin tier; Roles screen "Valet pages only (n)" button + warning.
  No live role has a valet tick (guard is a no-op for all existing roles). Test section AA → 438/0.

## 3c. DEPLOYED — 2026-11-10 12:06 IST (owner said "Deploy" in this session)

- Pushed af05b8f to origin/main (fast-forward from a18108c) → GitHub Action run 42769296777 success →
  https://fnb.akanhyd.com/api/build-info = af05b8f.
- Before push: full gate on 3bbb338 == live main on every suite (valet 438/0, build ok); main then moved
  to a18108c (db-explorer.ts only, no overlap) → merged (af05b8f) → tsc, check-rate-basis, check-db-explorer
  identical to live main, next build ok. Bundle proof: 0 liquor / party-manager / fssai / feedback paths,
  0 lq_/fssai_ lines, preview.html untracked; only boot write = ALTER roles ADD 3 valet columns DEFAULT 0.
- Post-deploy (public): /login 200; /valet-pass bad link 200 + noindex; guest entry {ok:false}; valet board,
  dining, RFID intake → 401 signed out; /valet → 307 login.
- Rollback: Valet Settings Switch OFF / untick roles (soft); code: on box `sudo mv .next .next.broken &&
  sudo mv .next.bak .next && sudo pm2 restart fnb-controller` (previous build a18108c kept as .next.bak).
- The local main checkout (~/Desktop/Claude/fnb-controller) is STALE as always — not touched.

## 3d. After deploy — tap-to-pair attendant cards (2026-11-10 evening, NOT deployed yet)

- Owner asked: "valet person has the RFID or NFC to scan their mobile so the details are updated to
  them". Explained phones can't be scanned/act as tags from a web app; owner chose (AskUserQuestion)
  "Tap-to-pair NFC card". Built: ops-handoff.ts, tables valet_handoff_cards / valet_handoff_taps,
  guest cmd 'tap' (/valet-pass?h=<ref>), attendant pop-up + page panel "A guest tapped your card — NN",
  commands handoff.card_issue/card_clear (head) + handoff.confirm/reject (attendant), Settings → NFC
  panel → Attendant tap cards. Tests AB → 463/0. Browser: both flows (page panel; pop-up over the
  "give the pass" dialog right after check-in) → guest pass appears by itself.
- Staff guide artifact https://claude.ai/artifact/Pmdd2wH31SxkCtVQZEB5Mm has the tap step.
- NEEDS the owner's word "Deploy" (per-action) → fetch/merge origin/main, gate, push, Action.

## 4. Exact next steps

1. Tap-to-pair awaiting "Deploy". Deployed base: owner setup next (docs/valet/SETUP.md): role ticks + "Valet pages only", outlet ON, zones,
   tags, staff, QR standee; WhatsApp templates + Meta app secret later.
2. If the owner asks for changes: they go on this branch as new WIP commits, gate again.

## 4b. Follow-ups noticed (not valet scope — for the owner)

- App-wide sidebar highlights parent + child links at once (isActive = startsWith), e.g. /feedback vs
  /feedback/take, /boh vs /boh/dashboard, /valet vs /valet/settings.
- The floating captain-alerts bell shows for every signed-in user (existing behaviour, already noted in memory).
- /cashier lists a table once PER open order: the measured data has table "1" with 4 open (empty, test-
  looking) orders → React "two children with the same key" console error + 4 tiles for one table. Existing
  cashier behaviour + data; valet only refuses to guess on such a table.

## 5. Decisions and assumptions

See `docs/valet/DESIGN.md` §7 (A1–A6). Additions go there and are summarised here.

## 6. Test commands

```bash
cd ~/Desktop/Claude/fnb-valet
npx tsc --noEmit -p .
# valet suite (harness copy only — never the worktree DB):
H=~/.claude/projects/-Users-shashankreddy-Desktop-Claude-fnb-controller/d4c3df78-586f-426c-bdcf-8e2000a14e0e/harness/valet/run-$(date +%H%M%S); mkdir -p $H; cp fnb-controller.db $H/
npx tsx scripts/valet-tests.ts $H
# regression gate: copy of brewery gate.sh pointed at this worktree (see harness/valet/gate.sh)
```

Known baseline on origin/main (from the brewery gate, 2026-11-07): run-tests 74/2,
report-builder 'total' crash, every other suite passes; routed 74/0; desk passes.

## 7. Open questions for the owner

- (none blocking yet)
