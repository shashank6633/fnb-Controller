# HRMS Module — Architecture Contract & Implementation Plan

Status: **PHASE 0 COMPLETE (recon + plan). NO CODE WRITTEN. NOTHING DEPLOYED.**
Rule of record: **do not deploy until the owner says exactly `DEPLOY HRMS`.**
Build branch: `hrms` — never merged, never deployed, until that phrase.

This document is the module contract in the style of `docs/CRM_DECISIONS.md`. Every
build agent gets pointed here. It was produced by a 10-agent read-only inspection of
the live codebase (2026-08-16); every claim below is grounded in a file the fleet
actually read.

---

## 0. Stack facts (verified, do not re-derive)

- Next.js 16 App Router, React 19, better-sqlite3 (SYNCHRONOUS — blocks the single
  Node thread), Tailwind v4 CSS-first (**no tailwind.config file** — theme is
  `@theme inline` in `globals.css`, and those tokens are DEAD; the app is hardcoded
  hex).
- 142 of 144 pages are `'use client'` components fetching their own JSON. No RSC
  data fetching, no Server Actions. HR pages are client components, full stop.
- One shell: `AppShell` renders Sidebar + main for every route. HR pages write **no
  layout code**.
- DB: single file `process.cwd()/fnb-controller.db`, WAL mode, `foreign_keys = ON`.
  No migration framework — schema lives in `initializeSchema()` in `src/lib/db.ts`
  (6,837 lines), one labelled `try/catch` block per module, every statement
  `IF NOT EXISTS` / PRAGMA-guarded. **Schema errors are swallowed silently** — after
  adding tables, verify they exist; a booted app proves nothing.
- Ids: `generateId()` (= crypto.randomUUID) from `src/lib/db.ts`. Never AUTOINCREMENT,
  never nanoid.
- Timestamps: `datetime('now')` = **UTC, space-separated, no Z**. Render only through
  `src/lib/format-date.ts` (`fmtIST*`, `todayIST`). `date-fns` is installed and
  imported NOWHERE — do not be the first.
- Deploy: `gh workflow run deploy.yml` → AWS Lightsail 1 GB RAM / 2 vCPU / 40 GB SSD.
  Every deploy restarts Node ⇒ `initializeSchema` reruns.
- `npm test` runs 4 static guards incl. `scripts/check-boot-migrations.js`, which
  FAILS the build on any unguarded boot write to users/roles/page_access/etc.
- `next.config.ts` sets `ignoreBuildErrors: true` — **`npx tsc --noEmit` is the real
  type gate**, run it explicitly.

## 1. The four decisive architecture decisions

### D1 — Employee identity: `hr_employees` stands alone, nullable FK to `users`

`users` rows are **login accounts, not people**: `email` NOT NULL UNIQUE,
`password_hash` NOT NULL, and production has shared station logins ("Continental
CDP", "bakery cdp"). A kitchen helper who never logs in cannot be a `users` row
without fabricating a live credential. Therefore:

```sql
hr_employees (
  id TEXT PRIMARY KEY,            -- generateId()
  employee_code TEXT UNIQUE,      -- HR-issued, human-facing
  full_name TEXT NOT NULL,
  phone10 TEXT,                   -- PhoneField contract: +91 = bare 10 digits (norm10)
  department_id TEXT,             -- departments.id (the REAL org tree, 3 mains + 16 subs)
  designation_id TEXT,            -- hr_designations.id
  user_id TEXT REFERENCES users(id),  -- NULLABLE; the only declared FK
  home_outlet_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  ...
);
CREATE UNIQUE INDEX idx_hr_emp_user ON hr_employees(user_id) WHERE user_id IS NOT NULL;
```

Hard consequences, all non-negotiable:
- **Never** ALTER users/roles/sessions DDL. Never write `users.page_access`,
  `role_id`, `is_head_chef`, `is_store_manager`, `can_approve_requisitions`.
- **Never** gate login/getCurrentUser/proxy on an hr_employees row existing
  (`admin@local` has no person behind it; failing closed locks the venue out).
- `users.is_active` stays the ONLY login kill switch. HR "termination" PROPOSES
  deactivation via the existing admin `PUT /api/auth/users` — never writes it from
  a cron or migration. (Password change does NOT revoke sessions; deactivation does.)
- Child hr_ tables reference `hr_employees.id` as plain TEXT + index, **no FK**
  (the task_*/ct_* house style; FKs are enforced at runtime and a DEFAULT '' insert
  against an FK column throws).

### D2 — Org backbone: reuse, never duplicate

- **departments**: reuse the existing table (19 rows, parent_id tree). NO
  `hr_departments`. There are already two department vocabularies (`departments`,
  `task_departments`) — do not create a third. HR references `departments.id`.
- **designations**: new `hr_designations` master (name, dept hint, grade, active).
  `users.position` (free text, POSITION_TEMPLATES) is left UNTOUCHED — additive rule
  wins; the duality is accepted and documented here rather than migrating /users.
- **outlets**: reuse. `outlet_id TEXT` on EVERY hr_ table, stamped from
  `getCurrentOutletId()`. But `users.current_outlet_id` is a *view preference* any
  user can switch — the employment assignment is `hr_employees.home_outlet_id` +
  `hr_employee_outlets` (join table) for multi-outlet staff.
- **working calendar**: attendance/leave read `tm_working_hours` / `tm_holidays`
  from settings (the Task module's keys) — a second business calendar would make
  payroll and task escalation disagree about what a working day is.
- **company identity for letters/payslips**: printing today reads global
  `business_name`/`gstin` settings keys; `outlets.gstin` is written and read by
  nothing. HR documents must read the global keys (and this is flagged as a known
  wrinkle for multi-outlet letterheads).

### D3 — Attendance engine: append-only events, computed day summary, provider-agnostic

- `hr_attendance_events` — append-only timeline. Columns include `source`
  (`gps|biometric|manual|import`), event_type (`check_in|check_out|break_start|
  break_end|outside_detected|outside_confirmed|returned`), UTC timestamp, lat, lng,
  accuracy_m, geofence_id, geofence_status, reason, device_info, created_by.
  **Historical events are never updated or deleted.**
- `hr_attendance` — ONE row per employee per IST day: the summary
  (status ∈ NOT_CHECKED_IN…OVERTIME, first_in, last_out, break_minutes,
  outside_minutes, worked_minutes, overtime_minutes, shift_id, correction state).
  Carries `date TEXT` = **IST day** computed via `todayIST()` at write time and
  indexed directly — the house `date(col,'+330 minutes')` idiom defeats indexes and
  will not survive thousands of rows.
- **Provider abstraction** = the `source` column + one intake chokepoint
  (`src/lib/hr-attendance.ts: recordAttendanceEvent()`). GPS is just the first
  caller. Biometric later = a new caller (webhook/CSV/SDK) that maps
  `hr_biometric_map (employee_id, biometric_employee_id, device_id, outlet_id)` and
  calls the same function. No manufacturer assumptions anywhere.
- Geofences: `hr_geofences` (outlet_id, name, lat, lng, radius_m, accuracy_threshold_m,
  grace_seconds, active). Haversine in `src/lib/hr-geo.ts` (pure, no DB). Radius is
  data, not code.
- Corrections: `hr_attendance_corrections` follows the `variance_approvals` pattern
  verbatim — frozen original + requested + approved values, partial UNIQUE over
  pending, decision fns refuse non-pending. Original attendance is NEVER silently
  overwritten.

### D4 — Documents & photos: BLOBs in SQLite, task-files shape, HR-only gate

- Copy the `/api/tasks/files` route shape (multipart+dataURI decode, mime allowlist,
  SVG reject, octet-stream coercion, nosniff, sanitized Content-Disposition) into
  `/api/hr/documents` — but with (a) a per-employee + HR-role gate, (b)
  `Cache-Control: private, no-store` (task_files uses 1-year immutable — a revoked
  contract would live in an ex-employee's browser cache for a year), (c) its own
  `hr_documents` table. **Do NOT reuse the task_files table** — its read gate is
  "any signed-in user".
- **5 MB hard cap** client and server: Next 16 with a proxy buffers request bodies
  and SILENTLY TRUNCATES over 10 MB (`experimental.proxyClientMaxBodySize` unset);
  nginx allows 25 MB, so nginx will not save us. Content-Length pre-check before
  buffering (copy from `/api/error-report`).
- Employee photos: client-side canvas compression via the existing `ImageUpload`
  component (~250 KB base64), stored as TEXT.
- Capacity flags for the 1 GB/40 GB box (revisit at Phase 4, before the vault gets
  real usage): synchronous BLOB reads stall POS; `auto_vacuum` is OFF; and the
  nightly backup is `.dump | gzip` which hex-doubles BLOBs — **backup-db.sh must
  change in the same commit that makes the vault live**.

## 2. Security contract (every agent memorises this)

1. **The proxy protects pages, not APIs.** `canAccessPage` runs only inside
   `if (!isApi)`; API GETs get cookie-PRESENCE only. ⇒ **Every** `/api/hr/*`
   handler, GET included, opens with `getCurrentUser()` + its own predicate. A
   forged cookie reaching a salary GET is the threat model, and it has happened to
   this app before.
2. **Catalog tier flags are the only gate that holds against legacy users.**
   `page_access` fails OPEN four ways (NULL / `[]` / bad JSON / non-array), and 8 of
   9 local users have NULL. Every salary/payroll/bank/disciplinary/document page
   carries `adminOnly` or `mgmtOnly` — AND the API re-checks. The flag alone is
   never the boundary.
3. **Prefix-grant leak is real**: a `/hr` catalog entry grants every `/hr/*` child.
   Mitigation chosen: accept the leak for benign pages; every sensitive page carries
   a tier flag (tier checks run BEFORE grants and cannot be overridden). Employee
   self-service lives under **`/my-hr`** — a separate root — so granting staff
   self-service can never prefix-grant the admin module.
4. **CSRF is opt-in**: add `'/api/hr'` to `CSRF_REQUIRED_PREFIXES` in `src/proxy.ts`
   (one line) — and then every HR client mutation MUST use `api()`/`apiJson()` from
   `src/lib/api.ts` or it 403s. The two changes land together.
5. **Path bans** (proxy `isPublic()` is substring/extension based):
   - never the substring `print` in any HR path — it becomes PUBLIC, unauthenticated;
   - never end an HR URL in `.jpg/.png/.json/...` — the asset regex makes it public.
   Payslips are therefore a **pdfkit endpoint** (`/api/hr/payslips/[id]/pdf`,
   authenticated, attachment) — the same approach as the cashier digital bill. No
   print pages in HR at all.
6. **New predicates** live in `src/lib/hr.ts` (PURE module — no DB import, importable
   by client components, modelled on `src/lib/tasks.ts`): `canManageHr`,
   `canApproveLeave`, `canViewSalary` (admin-only to start), `canViewHrDocs`
   (admin ∥ HR role ∥ the employee themself). Do not overload `isManagement` —
   it includes every HOD. HR personas ("HR Admin", "Payroll") are **rows in the
   existing `roles` table created by the owner in Settings → Roles**, never seeded
   by migration (the boot-migration lock bans it, and it once silently re-granted
   revoked pages on every deploy).
7. **Sensitive config NEVER goes in the shared `settings` table** — GET
   /api/settings returns all keys to every signed-in user, and managers can write
   any unlisted key. Benign HR scalars use `hr_*` keys registered in
   KEY_POLICY/OWNED_PREFIXES with owner `/api/hr/settings`; salary bands, statutory
   rates etc. live in hr_ tables behind gated routes.
8. **Never extend SessionUser with HR fields** — `/api/auth/me` is public-path and
   hands the whole object to every page.
9. **Admin surfaces leak**: `/admin/database` masks by SECRET_KEY_RE which does NOT
   match salary/aadhaar/pan/bank columns → extend `src/lib/secret-keys.ts`
   (committed file, needs owner approval). Client error messages on HR pages must
   never contain PII (POST /api/error-report is public and stored).
10. **Actor identity is `me.email`** everywhere in this app (audit, tasks,
    approvals). hr_ tables store `*_email` for actors, `employee_id` for subjects.

## 3. Committed files HR must touch (OWNER APPROVAL REQUIRED, foundation pass only)

Everything else in the module is a NEW file. These are edited once, in one
foundation commit, before any parallel build:

| # | File | Change |
|---|------|--------|
| 1 | `src/lib/db.ts` | ONE appended `try/catch` block (hr_ tables + indexes) at the end of `initializeSchema` (~line 6112), following the task-module block shape. No writes to shared masters. |
| 2 | `src/lib/page-catalog.ts` | ONE appended PageSection 'HR' (+ '/my-hr' entries), near the end of the array (declaration order is behaviour — firstAllowedPath walks it). Tier flags per §2.2. |
| 3 | `src/components/Sidebar.tsx` | Matching navTree section(s) — the catalog-only page is gated-but-INVISIBLE (three in-code warnings; live today for 3 paths). |
| 4 | `src/proxy.ts` | One line: `'/api/hr',` in CSRF_REQUIRED_PREFIXES. |
| 5 | `src/lib/secret-keys.ts` | Extend mask regex for salary/aadhaar/pan/bank/ifsc/uan/esic. |
| 6 | `src/app/api/notifications/inbox/route.ts` | (Phase 7) HR bell buckets, each in own try/catch + dynamic import — un-isolated code here kills every user's bell. |
| 7 | `src/app/api/settings/route.ts` | Register `hr_` prefix in KEY_POLICY/OWNED_PREFIXES. |

## 4. Module layout (all new files)

```
src/lib/hr.ts                    pure: vocabularies + badge colors + predicates + row types
src/lib/hr-server.ts             server helpers (DB); never imported by client code
src/lib/hr-attendance.ts         recordAttendanceEvent() chokepoint + day-summary computation
src/lib/hr-geo.ts                pure haversine + geofence eval
src/lib/hr-files.ts              BLOB store (clone of task-files.ts, HR gate)
src/lib/reports/hr-*.ts          one file per report: COLUMNS + run(db, outletId, from, to)
src/app/hr/<page>/page.tsx       admin/mgmt pages (~21)
src/app/hr/_components/*         module-local components
src/app/my-hr/page.tsx           employee self-service (mobile-first: CHECK IN button)
src/app/my-hr/<page>/page.tsx    attendance history, leave, payslips, sops...
src/app/api/hr/**/route.ts       all APIs (self-service under /api/hr/me/*)
docs/HRMS_DECISIONS.md           this file
```

UI: copy exact class strings, not abstractions — root `min-h-screen bg-[#FFF8F0]
text-[#2D1B0E]` → `max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5`; cards
`bg-white border border-[#E8D5C4] rounded-xl shadow` (the literal string —
globals.css keys the hover-lift on it); h1 `text-2xl sm:text-3xl font-bold
text-[#af4408]` + lucide icon; tables ALWAYS in `overflow-x-auto` (the missing
wrapper is a documented P0 on phones); modals = the house safe-modal shell
(`fixed inset-0 z-50 bg-black/40`, inner card `calc(100vh - 1.5rem)`); dropdowns in
modals/tables use Combobox/portal (absolute dropdowns get clipped); `Toggle` for
every switch; `PhoneField` for phones; recharts + the tasks-page KpiCard/ChartCard
pattern for the dashboard; `vendors/page.tsx` is the canonical CRUD page template;
`tasks/` is the canonical module shape.

Lists: server-side pagination ONLY (`page/pageSize` + `COUNT(*)`, parseInt-guarded
— a float in LIMIT throws), copy `/api/crm-calls/calls`. CSV = same endpoint
`?format=csv`, UTF-8 BOM, formula-injection guard (`/^[=+\-@\t\r]/`), truncation
warning inside the file. Money/number formatting per existing pages; never
toLocaleString inside an export.

Notifications: bell buckets (live COUNTs, one row per queue — the badge SUMS
counts, so never one row per employee); durable per-user rows copy the
task_notifications shape as `hr_notifications`; push via `sendPushToUser` after
commit; WhatsApp via `notifyEvent` with all three parallel maps updated together.
Audit: `logAuditEvent` for STATE CHANGES (salary, status, bank, approvals) —
NOT per-punch (attendance events are their own log; audit_events has no retention
and unbounded HR writes would slow the shared /audit page).

## 5. Schema inventory (~34 tables, all `hr_` prefixed)

Phase 1: hr_employees, hr_designations, hr_employee_outlets
Phase 2: hr_geofences, hr_attendance_events, hr_attendance, hr_attendance_corrections,
         hr_biometric_map
Phase 3: hr_shifts, hr_rosters, hr_shift_requests, hr_leave_types, hr_leave_balances,
         hr_leave_requests
Phase 4: hr_salary_structures (effective_from/to, NEVER overwritten),
         hr_salary_components, hr_statutory_configs (company/state/category/effective-dated),
         hr_bank_accounts (masked read: XXXX…4587 unless canViewSalary),
         hr_documents (BLOB), hr_advances, hr_advance_installments,
         hr_payroll_runs, hr_payroll_items
Phase 5: hr_sops, hr_sop_versions, hr_sop_assignments (viewed/completed/acknowledged),
         hr_trainings, hr_training_assignments, hr_tests, hr_test_questions,
         hr_test_attempts
Phase 6: hr_kpis, hr_performance_reviews, hr_assets, hr_asset_history,
         hr_candidates, hr_onboarding_items, hr_disciplinary_records,
         hr_resignations, hr_exit_clearance
Phase 7: hr_notifications

(Existing `training_sessions`, `knowledge_tests`, `staff_meals`, the seeded "HR
Manager Daily Checklist" task, and `cashier_presence` are ADJACENT, not reusable:
cashier_presence overwrites by design and cannot be an attendance log; the task
checklist overlap is surfaced to the owner as a Phase 6 decision, not silently
resolved.)

## 6. Phase order (= the spec's §50, mapped to this codebase)

1. **Foundation + Employee Master** — the 7 committed-file edits (§3), hr.ts,
   employees CRUD + profile tabs, designations, employee↔user link UI.
2. **GPS attendance** — geofences admin, /my-hr check-in (browser geolocation),
   events, corrections, outside-geofence flow.
3. **Shifts, roster, leave** (overnight shifts: end < start = +1 day, tested).
4. **Salary structure, bank, documents, payroll architecture, advances.**
5. **SOP library + versions, training, knowledge tests.**
6. **Performance, assets, recruitment, onboarding, probation, disciplinary, exit.**
7. **Reports, HR dashboard, bell buckets, audit surfacing.**
8. **Biometric abstraction hardening** (mapping UI + import provider; no vendor code).

Each phase: build on `hrms` branch → `tsc` 0 → `npm test` green (all 4 static
guards) → adversarial verify (≤10 agents) → on-screen check on :3001 → commit on
`hrms`. **No deploy. No merge. Production never sees this until `DEPLOY HRMS`.**

## 7. Standing constraints carried from the owner

- Fleet size ≤ 10 agents per pass.
- Committed-file edits only with explicit approval (§3 list is the ask).
- Never modify the material-movement flow (Central → requisition → Dept → recipe
  consumption at KOT complete). HR touches none of it.
- Party Manager code stays out of every commit (leak-check each commit).
- Parked working-tree changes (10 modified + 4 untracked files from the purchasing
  work) belong to ANOTHER task — HR commits must never include them; stage
  explicitly, never `git add -A`.
- Never say "Done" — report the verification checklist.
