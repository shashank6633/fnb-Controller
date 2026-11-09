# Valet Parking — design and decisions

Companion to `docs/valet/SPEC.md` (the owner's words, unchanged). This file is the
plan and the rulebook: where it and the code disagree, the code is wrong.

## 1. What the app already gives us (inspected 2026-11-09, origin/main 5837f5d)

| Need | Existing piece reused | Note |
|---|---|---|
| Staff login / sessions | `getCurrentUser()` (`src/lib/auth.ts`), `fnb_session` cookie | No second auth system. |
| Roles | `roles` table + role-only capability columns (finance, HR) | Valet adds 3 role-only columns, default OFF. |
| Page gating | `src/lib/page-catalog.ts` + `src/proxy.ts` + `Sidebar.tsx` | New `valetCap` row flag, same shape as `financeCap`. |
| CSRF | proxy double-submit + `src/lib/api.ts` | `/api/valet/` prefix added. |
| Outlets | `outlets`, `users.current_outlet_id` | No user→outlet map exists; valet adds `valet_staff_outlets`. |
| Real-time | `kds-bus.ts` SSE pattern | Valet gets its own bus + polling fallback (pm2 workers do not share an in-process bus). |
| Background jobs | `scheduler.ts` (5-min tick, prod-only), armed in `instrumentation.ts` | Too coarse for minute-level releases → queue eligibility is computed at READ time, plus a 20-second valet worker for notifications/escalations. |
| Media | BLOB-in-SQLite stores (`hr-files.ts`, `task-files.ts`) | `valet_media`, private, size-capped, served only through an authorised route. |
| WhatsApp | `src/lib/whatsapp.ts` (Meta Cloud / Interakt, template sends) | Valet adapter wraps it; simulator when unconfigured. |
| Consent | `wa-consent.ts` (STOP keywords, phone-keyed) | Valet consent is per pass + channel, recorded separately. |
| Tables / visits / bills | `restaurant_tables`, `orders` (open order = dining visit), `ct_bookings`, `customers` by phone | Optional links only (increment 2). |
| Public guest pages | `/menu` route handler serving self-contained HTML | Same approach: no React shell, no staff pollers, `noindex`. |
| Localisation | **none in the app** | Assumption A1: a module-scoped en/hi string table (`src/lib/valet/i18n.ts`) a future app-wide system can absorb. |

## 2. Access model

Three role-only capability columns on `roles` (DEFAULT 0, no backfill — the owner ticks them
in Settings → Roles): `valet_head`, `valet_attendant`, `valet_host`. Resolved only from an
**assigned, active** role, fail-closed, in a separate query (a missing column = no capability,
never an app-wide failure). An Admin holds all three implicitly.

| Who | Capability | Can |
|---|---|---|
| Owner/Admin | `role='admin'` | Everything; enable valet per outlet; config, retention, staff↔outlet, integrations, multi-outlet reports. |
| Valet Head | `valet_head` | Board for ASSIGNED outlets; dispatch, reassign, priority/ETA with reason, zones, tags, incidents, shifts, voids, recovery handover, reports. |
| Valet Attendant | `valet_attendant` | Check-in, condition photos, park, take next car, own task, mark ready, verified handover, report problem. No guest mobile, no history, no reports. |
| Host/Cashier/Floor | `valet_host` | Look up by tag/plate, see status, request pickup on a guest's confirmed behalf, link a dining visit. |
| Guest | device cookie | Only passes granted to that browser. |

Pages (catalog section "Valet Parking", flag `valetCap`): `/valet` (head), `/valet/attendant`
(attendant or head), `/valet/desk` (host or head), `/valet/reports` (head), `/valet/settings`
(head; admin-only sections enforced by the API). Like finance/HR capabilities the flag is
**necessary, not sufficient** — the role's page list must also tick the page.

Outlet scope: every staff API resolves the outlet from the request, then requires
`admin` OR a `valet_staff_outlets` row for (user, outlet), AND the outlet enabled (except
admin settings). No assignment ⇒ refusal with a plain-language reason.

Guest pages `/valet-pass`, `/valet-checkin` and the guest APIs (an **exact list** of static
paths under `/api/valet-guest/`, no dynamic segments — see proxy.ts's %2F note) are public and
self-authenticate with an httpOnly `fnb_vp` device cookie (SameSite=Lax). Guest writes also
require a custom header + same-origin `Origin` check (CSRF), and every guest endpoint is
rate-limited in the database (works across pm2 workers).

## 3. State model

### Vehicle (`valet_vehicle_sessions.state`)

| From → To | Actor | Guard | Timestamps |
|---|---|---|---|
| (new) → `CHECKED_IN` | attendant/head | outlet enabled; required fields; tag free; duplicate plate acknowledged | `checked_in_at`, `checked_in_by` |
| `CHECKED_IN` → `PARKING` | attendant | not already busy (task limit) | `parking_started_at`, `parking_by` |
| `CHECKED_IN`/`PARKING` → `PARKED` | attendant/head | zone given; key location given; photo policy met or exception recorded | `parked_at`, `parked_by` |
| `PARKED` → `PARKING` | head/attendant | relocation within lot (reason) | movement row |
| `PARKED`/`HOLDING_NEAR_GATE` → `RETRIEVING` | attendant holding the ASSIGNED pickup | pickup ASSIGNED→IN_PROGRESS in the same transaction | `retrieving_started_at` |
| `RETRIEVING` → `READY_AT_GATE` | that attendant (or head) | gate zone; gate capacity warning (staff may override with reason) | `ready_at`, dwell deadline |
| `READY_AT_GATE` → `HANDED_OVER` | authenticated staff | tag matches + single-use guest credential (rotating code / claim code) **or** head recovery with reason+method; consumed in the same transaction | `handed_over_at`, `handed_over_by`, `handover_method` |
| `READY_AT_GATE` → `RELOCATING` | staff | dwell expired, guest back inside, or gate full | `relocating_at` |
| `RELOCATING` → `HOLDING_NEAR_GATE` | staff | holding zone + spot recorded (never by timer) | `holding_at`; open pickup → `NO_SHOW` |
| `HOLDING_NEAR_GATE`/`RETRIEVING`/`READY_AT_GATE` → `PARKING` | staff | re-park after acknowledged cancellation | movement row |
| any non-final → `VOIDED` | head | reason; for test/duplicate records only; history kept | `voided_at`, `void_reason` |

Final states: `HANDED_OVER`, `VOIDED`. A cancellation **never** closes a vehicle session.

### Pickup (`valet_pickups.state`) — one active per vehicle (partial unique index)

| From → To | Actor | Guard |
|---|---|---|
| (new) → `SCHEDULED` / `QUEUED` | guest (own pass) / host / head | idempotent: an active pickup is returned, never duplicated |
| `SCHEDULED` → `QUEUED` | system (worker or any read) | `now ≥ release_at` |
| `SCHEDULED`/`QUEUED` → `CANCELLED` or rescheduled | guest / staff | not yet claimed |
| `QUEUED` → `ASSIGNED` | attendant (Take next car) / head (assign) | atomic CAS inside `BEGIN IMMEDIATE`; attendant on shift, not on break, under task limit |
| `ASSIGNED` → `QUEUED` | head (reason) / the attendant before starting | — |
| `ASSIGNED` → `IN_PROGRESS` | assigned attendant | handoff acknowledged if reassigned |
| `ASSIGNED`/`IN_PROGRESS` reassigned | head (reason) | new attendant must acknowledge the handoff; custody row written |
| `IN_PROGRESS` → `READY` | assigned attendant / head | vehicle → `READY_AT_GATE` |
| `READY` → `COMPLETED` | staff (verified handover) | vehicle → `HANDED_OVER` |
| `READY` → `NO_SHOW` | staff | vehicle reached `HOLDING_NEAR_GATE` |
| `ASSIGNED`/`IN_PROGRESS`/`READY` → `CANCELLED` | staff acknowledging a guest change request | never silently by the guest |

A lost connection never re-dispatches: work held by an attendant whose device has gone quiet
is flagged **uncertain** on the board; only the head (reason) or an acknowledged handoff moves it.

## 4. Queue rule (the eligibility and fairness contract)

* `lead(zone)` = median start→ready minutes for that zone over the last 14 days when ≥ 5
  samples exist, else the zone's configured minutes, else the outlet default (8).
* A pickup with target time `T` is **eligible** when `now ≥ T − lead(zone)`. Request-now:
  `T = requested_at`. Its `queued_at` is set to `max(requested_at, T − lead)` — its turn
  starts when it was **due**, not when it was booked, so a far-future booking never blocks.
* Order among eligible: `priority DESC, queued_at ASC, seq ASC` (stable). Overdue work is not
  re-sorted (FIFO already puts it first); it is flagged on the board and escalated.
* A head priority change needs a reason and is audited.
* Eligibility is computed in SQL at read time and promoted by the worker — a dead worker
  cannot strand a due request.

ETA: position `k` in the eligible queue, `A` attendants on shift and not on break,
`d50`/`d90` recent durations for the car's zone. Range =
`now + ceil(k/A−1)·d50 + d50 … now + ceil(k/A)·d90`, rounded to whole minutes. No staff on
shift ⇒ no number ("Waiting for an attendant"). Too little data ⇒ the configured estimate,
labelled as an estimate. Head override (with reason) wins.

## 5. Credentials

| Credential | Shape | Stored | Lifetime |
|---|---|---|---|
| Guest device cookie `fnb_vp` | 32 random bytes | SHA-256 | until revoked; grants revoked when a session closes |
| Activation link (staff-shown QR) | 24 random bytes | SHA-256 | 15 min, single use |
| Pairing code (guest-led check-in) | 6 digits, unique among pending per outlet | plain (staff-only lookup, rate-limited) | 15 min |
| Rotating handover code | 6 digits | SHA-256 | 90 s; single use; consumed with the handover |
| Printed claim code (phone-less) | 8 chars Crockford | SHA-256 | until handover/revoke; single use |
| Venue entry token (QR/NFC card) | 16 random chars, rotatable | plain (public by design) | until rotated |

Tag numbers and plates are identifiers, never credentials. Failed verifications are counted;
5 failures on a session lock code verification until the head runs recovery.

## 6. Increments

1. **Core** — schema, roles/catalog/proxy, outlet enable + zones + staff + tags, staff and
   guest-led check-in, parking + custody, guest pass (now/5/10/later), queue + Take next car,
   ready/dwell/holding, verified handover + claim receipt + head recovery, Head Dashboard, team
   + shifts, SSE + polling, tests.
2. Scheduling across midnight/service hours/capacity, photos, reports + CSV, paper ticket
   books, FNB links + host/cashier actions, notification outbox + WhatsApp adapter/simulator +
   consent + webhook dedupe, escalations, closing rush, retention.
3. NFC provisioning (NDEF URLs, Web NFC capability detection), RFID adapter + simulator.

## 7. Assumptions (A#) — change any by telling the build

* A1 — no app localisation system exists; en/hi strings live in `src/lib/valet/i18n.ts`.
* A2 — times stored as ISO-8601 UTC strings written by one helper; shown in IST.
* A3 — Admin implicitly holds every valet capability. Manager tier does **not** (owner ticks).
* A4 — a valet user with no outlet assignment can open the page but every API refuses with
  the reason; nothing falls back to "all outlets".
* A5 — the guest pass lives in a browser cookie; a different browser on the same phone (e.g.
  WhatsApp's in-app browser) needs a restore link or desk recovery.
* A6 — SSE reaches clients on the same server process only; every live screen also polls
  (board 10 s, guest 5 s) so a multi-worker deploy stays correct.
