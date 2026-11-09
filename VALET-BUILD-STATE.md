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
| 2 | Scheduling across midnight/hours/capacity, photos, reports+CSV, paper ticket books, FNB links, notification outbox + WhatsApp adapter/simulator, consent, escalations, closing rush, retention | **NEXT** |
| 3 | NFC provisioning, RFID adapter + simulator | not started |

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

## 3. In progress

- Nothing half-done. Next = increment 2.

## 4. Exact next steps (increment 2)

1. Valet worker (`src/lib/valet/worker.ts`, 20 s tick, armed in instrumentation.ts next to the scheduler,
   same prod-only/ENABLE_SCHEDULER rule): promote due pickups, expire pending, escalations (unclaimed 5 min,
   long fetch, outside waiting, dwell overrun, no staff) as deduped valet_alerts that auto-resolve.
2. Notification outbox `valet_notifications` + adapters: in-app (always), WhatsApp via src/lib/whatsapp.ts
   template sends ONLY when configured + consent + verified identity; otherwise a clearly labelled SIMULATOR.
   Webhook ingest: delivery statuses + button replies (dedupe provider event ids, reject replay, verify
   signature with the existing app-secret logic). Failed-delivery view on the board.
3. Photos: `valet_media` BLOB store (≤6, ≤1.5 MB after client resize, magic-byte check), upload with
   progress/retry from the attendant, authorised short-lived view route, damage annotation.
4. Reports `/valet/reports` + CSV (safe CSV: formula-injection guard), definitions + denominators.
5. Paper ticket books + bill-folder/table QR entry (pending verification; stub confirmation before dispatch).
6. FNB links: table/order/booking/customer on a session; cashier/host buttons (guest-confirmed request);
   bill print/settle offers a prompt only. Must not change existing POS flows (impact-check first).
7. Closing-rush mode; retention job (redact valet-only PII + photos after N months, incident holds).
8. Re-run gate vs origin/main; browser scenarios for each; owner note.

## 4b. Follow-ups noticed (not valet scope — for the owner)

- App-wide sidebar highlights parent + child links at once (isActive = startsWith), e.g. /feedback vs
  /feedback/take, /boh vs /boh/dashboard, /valet vs /valet/settings.
- The floating captain-alerts bell shows for every signed-in user (existing behaviour, already noted in memory).

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
