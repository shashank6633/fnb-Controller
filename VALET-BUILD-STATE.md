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
| 1 | Core: schema, access, outlet enable, zones, staff↔outlet, tags, staff + guest-led check-in, parking + custody, guest pass, queue + Take next car, ready/dwell/holding, verified handover + claim receipt + recovery, Head Dashboard, team/shifts, SSE + polling, tests | **IN PROGRESS** |
| 2 | Scheduling across midnight/hours/capacity, photos, reports+CSV, paper ticket books, FNB links, notification outbox + WhatsApp adapter/simulator, consent, escalations, closing rush, retention | not started |
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

## 3. In progress

- Increment 1 SCREENS written + committed (f1ac194): `/valet` Head Dashboard, `/valet/attendant`,
  `/valet/desk`, `/valet/settings`, shared kit `src/app/valet/ui.tsx`, dialogs `src/app/valet/modals.tsx`.
  tsc clean (use `--incremental false`: a stale tsconfig.tsbuildinfo once reported a phantom TS6200; the stale
  file was MOVED to scratchpad/stale-tsbuildinfo-*). Lint: 9 remaining = setState-in-effect pattern the app
  uses everywhere (33 such in feedback/captain/cashier) — accepted, not a gate.
- Regression gate running: `harness/valet/gate.sh base origin/main` then `gate.sh valet valet-parking-1109 build`
  (same snapshot.db for both). Outputs: harness/valet/gate-base.out, gate-valet.out.
- Demo seed: `npx tsx scripts/valet-demo-seed.ts <harness dir>` (fictional cars/staff, harness-only guard).

## 4. Exact next steps

1. Read gate-base.out vs gate-valet.out → must be equal except valet-tests; next build exit 0.
2. Browser tree = `git archive HEAD` into harness/valet/browser-run-*, + node_modules clone + seeded DB
   (browser-* dir from the seed) + harness-only `allowedDevOrigins: ['127.0.0.1','*.localhost']` in its
   next.config.ts. `next dev` ONLY (NEVER next start on a prod-DB copy: the scheduler would run and could
   send real WhatsApp). Port 3900. Head on localhost, attendant on 127.0.0.1, guest on guest.localhost
   (separate cookie jars); sign in by setting fnb_session from demo-sessions.json via the browser.
3. Scenarios: guest QR check-in → pairing → attendant confirm → pass → request → take next → fetch → ready →
   handover with rotating code; scheduled pickup; phone-less (claim receipt); no-show → holding → returned;
   head intervention (reassign, priority, ETA, void); two staff clients updating live. 375px + desktop.
4. Fix what the browser finds; re-run valet-tests; commit; owner progress note.
5. Then increment 2 (see §1).

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
