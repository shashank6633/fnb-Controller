# CRM — Call-to-Table (ct) · Architecture Decisions & Build Contract

Module namespace: **`ct_`** (tables) · **`/crm-calls/*`** (pages) · **`/api/crm-calls/*` + `/api/telecmi/*`** (APIs).
The existing "AKAN CRM" module (`crm_*` tables, `/crm/*` pages) is a DIFFERENT feature and is untouched.

## Stack facts (actual, override the master prompt where they differ)
- Next.js 16 App Router + React 19 + **better-sqlite3** (single file DB `fnb-controller.db`), Tailwind v4.
- NO Postgres, NO jsonb → JSON stored as TEXT; arrays as JSON text. Timestamps: TEXT ISO-8601 **UTC** (`new Date().toISOString()`), displayed IST via `toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })`.
- Auth: cookie sessions. Server: `getCurrentUser()` from `@/lib/auth` (null = 401), `requireRole('admin')` for admin-only. NO 'gre' role exists — GRE = any signed-in user granted the CRM pages via page-access/roles; admin-only: settings, backfill. Recording playback: any signed-in user (page access gates the UI).
- Client fetch: `api(url, { method, body })` from `@/lib/api` (handles CSRF; plain `fetch` is fine for GETs).
- Real-time: SSE, mirroring KDS — bus `src/lib/kds-bus.ts` pattern (globalThis EventEmitter), stream route pattern `src/app/api/dine-in/kds/stream/route.ts` (heartbeat 25s, abort cleanup, `export const dynamic = 'force-dynamic'`).
- Migrations: additive-only, isolated `try/catch` blocks at the END of `initializeSchema()` in `src/lib/db.ts`. NEVER write to users/roles/departments/raw_materials from a migration.
- UI style: warm palette (`#FFF8F0` bg, `#af4408` accent, `#E8D5C4` borders, text `#2D1B0E`/`#8B7355`), `lucide-react` icons, cards `bg-white border border-[#E8D5C4] rounded-xl`. Pages are `'use client'` components fetching their own data. Mobile-responsive (stack/cards under `md:`).

## Files & ownership (each fleet agent owns ONLY its listed files — never edit shared files)
Shared files (already done, DO NOT TOUCH): `src/lib/db.ts` (ct_ schema), `src/lib/ct/bus.ts`, `src/lib/ct/phone.ts`, `src/lib/ct/settings.ts`, `src/components/Sidebar.tsx`, `src/lib/page-catalog.ts`, `package.json`, `src/app/api/notifications/inbox/route.ts`.

## Schema (already migrated — use as-is)
```
ct_guests(id PK, outlet_id TEXT DEFAULT '', phone_e164 TEXT NOT NULL UNIQUE, name TEXT DEFAULT '',
  alt_phone TEXT DEFAULT '', email TEXT DEFAULT '', tags TEXT DEFAULT '[]', source TEXT DEFAULT 'call',
  notes TEXT DEFAULT '', dob TEXT DEFAULT '', anniversary TEXT DEFAULT '', preferences TEXT DEFAULT '{}',
  created_at, updated_at)

ct_calls(id PK, telecmi_call_id TEXT UNIQUE, guest_id TEXT, phone_e164 TEXT NOT NULL,
  direction TEXT DEFAULT 'inbound',            -- inbound|outbound
  status TEXT DEFAULT 'ringing',               -- ringing|answered|missed|abandoned|voicemail
  agent_user TEXT DEFAULT '', queue TEXT DEFAULT '',
  started_at TEXT, answered_at TEXT, ended_at TEXT, duration_sec INTEGER DEFAULT 0,
  recording_url TEXT DEFAULT '', raw_payload TEXT DEFAULT '{}',
  disposition TEXT DEFAULT '',                 -- booking_made|enquiry|event_enquiry|complaint|wrong_number|follow_up_needed|no_action
  disposition_note TEXT DEFAULT '', created_at)

ct_bookings(id PK, guest_id TEXT NOT NULL, source_call_id TEXT, booking_date TEXT, slot_time TEXT,
  party_size INTEGER DEFAULT 2, occasion TEXT DEFAULT '', section_pref TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',               -- pending|confirmed|seated|completed|no_show|cancelled
  created_by TEXT DEFAULT '', channel TEXT DEFAULT 'call', advance_amount REAL DEFAULT 0,
  notes TEXT DEFAULT '', created_at, updated_at)

ct_follow_ups(id PK, guest_id TEXT NOT NULL, call_id TEXT, due_at TEXT, assigned_to TEXT DEFAULT '',
  status TEXT DEFAULT 'open',                  -- open|done|skipped
  note TEXT DEFAULT '', created_at)

ct_recoveries(id PK, call_id TEXT NOT NULL UNIQUE, guest_id TEXT, phone_e164 TEXT NOT NULL,
  missed_at TEXT NOT NULL, detected_via TEXT DEFAULT 'cdr',   -- cdr|live_event|backfill
  sla_due_at TEXT NOT NULL,
  status TEXT DEFAULT 'pending',               -- pending|attempting|recovered|unreachable|expired|auto_resolved
  assigned_to TEXT DEFAULT '', attempts TEXT DEFAULT '[]',    -- [{at,by,method:'callback'|'whatsapp'|'sms',outcome}]
  first_attempt_at TEXT, recovered_at TEXT, recovery_call_id TEXT, recovery_booking_id TEXT,
  escalated INTEGER DEFAULT 0, escalated_at TEXT, resolution_note TEXT DEFAULT '', created_at, updated_at)

ct_webhook_log(id PK, kind TEXT,               -- live|cdr
  telecmi_call_id TEXT DEFAULT '', phone_e164 TEXT DEFAULT '', event TEXT DEFAULT '',
  received_at TEXT, payload TEXT DEFAULT '{}', processed INTEGER DEFAULT 0, error TEXT DEFAULT '')

ct_settings(key TEXT PRIMARY KEY, value TEXT)  -- JSON values; defaults seeded
```
`generateId()` from `@/lib/db` for all ids. EXPIRED is a terminal *flag* state but a breached-pending recovery can still be worked (attempt allowed on expired; recovery then proceeds normally).

## Core lib contracts (fleet-built; exact signatures)
- `src/lib/ct/telecmi-mapper.ts` — `mapLivePayload(raw: any): { telecmiCallId: string; phone: string; direction: 'inbound'|'outbound'; event: 'ring'|'answer'|'hangup'; agent: string; queue: string; at: string } | null` and `mapCdrPayload(raw: any): { telecmiCallId: string; phone: string; direction; status: 'answered'|'missed'|'abandoned'|'voicemail'; agent; queue; startedAt; answeredAt: string|null; endedAt; durationSec: number; recordingUrl: string } | null`. Tolerant fallbacks across TeleCMI field variants (id/callid/uuid; from/caller/customer_number; missed/noanswer/no-answer/cancel/abandoned/voicemail/busy→missed-family; log unknown shapes via console.warn). Returns null only when no phone AND no call id.
- `src/lib/ct/ingest.ts` — THE core. Exports:
  - `ingestCdr(raw: any): { callId: string|null; created: boolean }` — map → normalize phone (`normalizePhone`) → upsert ct_calls on telecmi_call_id (idempotent; update fills nulls, never duplicates) → link/create nothing for unknown guests (guest_id stays null until a guest exists with that phone; if one exists, link) → if missed-family status: create ct_recoveries (INSERT OR IGNORE on call_id) with SLA via `slaDueAt(missedAt)` → if answered inbound: auto-resolve any pending/attempting recovery for same phone (`status='auto_resolved'`, resolution_note) → if answered outbound: try match to an open recovery for that phone (status pending/attempting, missed within last 7d) → set `status='attempting'` if no disposition yet, append attempt `{method:'callback', outcome:'answered'}`, set first_attempt_at → store raw payload → emit bus events (`call_ended`).
  - `ingestLive(raw: any): void` — log to ct_webhook_log; on `ring` inbound: upsert a ringing ct_calls row + emit `incoming_call` with guest snapshot (join ct_guests by phone); on `hangup`: emit `call_ended`.
  - `reconcileLiveEvents(): number` — ct_webhook_log ring events >5min old with no ct_calls CDR (status still 'ringing' & no ended_at) → mark those calls missed + create recoveries (`detected_via='live_event'`).
  - `expireOverdueRecoveries(): number` — pending past sla_due_at → `escalated=1, escalated_at` and status stays 'pending' until 2× SLA → then `status='expired'`. Simplification documented: EXPIRED at 2× SLA without attempts.
  - `sweep(): void` — calls both; safe/cheap; invoked from recovery/dashboard/inbox GETs.
  - `attributeBooking(bookingId: string): void` — if booking has no source_call_id, find latest answered inbound call for same guest within attribution window → set source_call_id; if source call maps to an open recovery → set recovery_booking_id + status 'recovered'.
- `src/lib/ct/metrics.ts` — `guestMetrics(db, guestId)` → `{ total_calls, calls_30d, missed_calls, last_call_at, total_bookings, completed_visits, no_shows, last_visit_at, conversion_rate, badge }`; badge: NEW CALLER (calls≤1, no bookings) / ENQUIRED–NOT CONVERTED (calls>0, no seated/completed) / CONVERTED (≥1 seated|completed) / REPEAT GUEST (≥2 completed) / LAPSED (converted but no visit 45d+). Also `dashboardStats(db, {from,to})` for the dashboard route (call counts by day/hour, funnel Calls→Answered→Booked→Seated, recovery funnel Missed→Attempted→Recovered→Booked, per-agent leaderboard, avg time-to-first-callback, lapsed list).
- `src/lib/ct/bus.ts` (DONE) — `emitCt(evt: CtEvent)`, `subscribeCt(fn): () => void`; `CtEvent = { type: 'incoming_call'|'call_ended'|'recovery_update'; callId?; phone?; guest?; recoveryCount?; at }`.
- `src/lib/ct/phone.ts` (DONE) — `normalizePhone(raw): string` → E.164 `+91XXXXXXXXXX` best-effort (10-digit → +91; keeps other country codes; strips separators; returns '' if <8 digits).
- `src/lib/ct/settings.ts` (DONE) — `ctSetting(db, key)`, `ctSettings(db)`, `setCtSetting(db, key, value)`, `slaDueAt(missedAtIso, db?): string` (business-hours aware: if missed after close, due = next open + SLA), `webhookToken(db): string` (env `TELECMI_WEBHOOK_SECRET` else persisted random token), `isTelecmiConfigured()`. Keys: `sla_minutes`(30), `attribution_hours`(48), `business_open`('12:00' IST), `business_close`('23:30' IST), `auto_assign`('round_robin'|'off'), `escalation_note`, `after_hours_whatsapp`('0'), `after_hours_template`, `agent_map`(JSON), plus non-secret telecmi base url.

## API routes (fleet-built)
- `POST /api/telecmi/webhook/live/[token]` + `POST /api/telecmi/webhook/cdr/[token]` — validate token vs `webhookToken(db)` (403 otherwise), always ack `{ok:true}` fast; wrap ingest in try/catch (log to ct_webhook_log.error; still 200). No session auth.
- `POST /api/telecmi/click-to-call` `{guest_id?|phone, recovery_id?}` — authed; if env TELECMI creds present call TeleCMI originate REST (fetch, 5s timeout) else mock `{mocked:true}`; log an attempt on the recovery if recovery_id given (method 'callback', outcome 'initiated').
- `GET /api/telecmi/recording/[callId]` — authed; look up ct_calls.recording_url; if absent 404; stream/redirect via server fetch proxy (never expose the TeleCMI URL to the client).
- `POST /api/telecmi/backfill` — admin-only; body `{days?}`; if creds absent → `{mocked:true}`; else pull CDRs page-wise and run each through `ingestCdr`.
- `/api/crm-calls/guests` GET (list w/ search+filters+metrics+CSV via `?format=csv`), POST (create; normalize phone; 409 on duplicate phone). `/api/crm-calls/guests/[id]` GET (profile + metrics + unified timeline: calls/bookings/follow-ups/notes reverse-chron), PUT (edit incl tags/preferences), plus follow-up create/done via PUT actions.
- `/api/crm-calls/calls` GET (filters: direction/status/agent/date/phone/guest_id, paged). `/api/crm-calls/calls/[id]` PUT `{disposition, disposition_note}` — if disposition 'booking_made' the client then POSTs a booking with source_call_id.
- `/api/crm-calls/bookings` GET/POST; POST runs `attributeBooking`; `[id]` PUT status transitions (seated/completed/no_show/cancelled/confirmed).
- `/api/crm-calls/recoveries` GET (queue: default status pending/attempting sorted by sla_due_at asc; `?count=1` fast count; calls `sweep()` first), `[id]` PUT actions `{action: 'attempt'|'unreachable'|'note'|'assign'|'match_call'|'resolve'}` per lifecycle.
- `/api/crm-calls/dashboard` GET — `dashboardStats` (+ sweep()).
- `/api/crm-calls/events` GET — SSE stream of bus events (KDS stream pattern). `/api/crm-calls/live` GET — poll fallback (active ringing calls + latest events since ?after=).
- `/api/crm-calls/settings` GET/PUT — admin-only; exposes webhook URLs (`/api/telecmi/webhook/{live|cdr}/<token>`) for copy-paste; secrets NEVER returned (env only; report configured: true/false).
- `/api/crm-calls/seed` POST — admin-only, dev convenience: 25 guests / 120 calls / 40 bookings / recoveries in mixed states; idempotent (`ct_seed_done` setting) with `{force:true}` override.

## AI call enhancement (scorecard) — reuses the existing production engine
Wires TeleCMI recordings into the EXISTING `src/lib/crm-audio.ts analyzeCallRecording()` (Gemini transcribes audio; Claude/Gemini produces the CallPilot-style scorecard) — NO new AI. Rendered by the existing `@/app/crm/assistant/CallAnalysisCard` (8-axis radar + coaching + transcript).
- `src/lib/ct/recording-fetch.ts` — shared SSRF-safe recording fetch (allowlist + manual redirect) used by the recording proxy AND analyze.
- `src/lib/ct/analyze.ts` — `analyzeCtCall(callId,{actor,force,language})`, `analyzePendingBatch(limit)`, `storedAnalysis(db,callId)`. Persists on ct_calls: analysis_json, analysis_score, analysis_outcome, analysis_summary, analysis_status (''/pending/done/error/skipped), analysis_error, analyzed_at, analyzed_by.
- Trigger: on-demand "✨ Enhance" button per call (Call Log + Guest 360) AND opt-in `auto_analyze` setting ('0'/'1', default off) → fire-and-forget after CDR ingest + a manual "analyze recent" batch endpoint.
- APIs: `/api/crm-calls/calls/[id]/analyze` (GET stored / POST run), `/api/crm-calls/calls/analyze-batch` (POST admin).
- Provider/keys reuse the AKAN CRM settings (crm_llm_provider, crm_gemini_keys). 14MB inline-audio cap.
- RETENTION: ct_setting `analysis_retention` ('permanent' default | 'ephemeral'). Ephemeral = compute-and-show only: `analyzeCtCall` wraps EVERY ct_calls write in `persist()` (no-op when ephemeral), skips the cache-return + pending claim, `analyzePendingBatch` early-returns, and the ingest auto-hook is gated on retention!=='ephemeral'. The Enhance POST still returns the scorecard in its body; Call Log + Guest 360 display it from a session cache of the POST response (GET returns empty in ephemeral). Settings "Scorecard storage" selector disables the auto-score toggle + batch button when ephemeral.
- LANGUAGE: CT analysis passes `outputLanguage:'english'` to analyzeCallRecording — Gemini AUTO-DETECTS the spoken language (English/Telugu/Hindi/mix), reports it in the scorecard `language` field, but returns the transcript + coaching + summary TRANSLATED INTO ENGLISH. New opt-in param on analyzeCallRecording (default 'auto' = original-language, so AKAN CRM analyze-recording is unchanged). Impl: TRANSCRIBE_PROMPT_EN + ENGLISH_OUTPUT_OVERRIDE in crm-audio.ts.

## Device-dialed callbacks (no TeleCMI outbound package)
For plans WITHOUT outbound: `src/components/ct/CallbackButton.tsx` opens the native dialer (`tel:`), times the away duration (visibilitychange), shows a log sheet (duration + outcome), POSTs `/api/crm-calls/calls/log-callback` → synthesizes an OUTBOUND ct_calls row (agent_user = the GRE's email, duration_sec, disposition) + appends the recovery attempt + advances the recovery (reached+dispositioned → recovered). Wired into Recovery Queue + Guest 360 (replacing the click-to-call that needs outbound). Web CANNOT read the device call log — duration is a confirmed time-away estimate; exact call-log capture is a planned Android-app follow-up (Option A). Manual-log affordance covers desktop.

## Live feed "answered by"
ingest emits carry `agentName` (resolveAgentLabel) on 'answered'+'call_ended'; the Live wallboard feed shows "answered by <name>".

## Agent Mapping (who answered the call)
`src/lib/ct/agents.ts` — getAgentMap (ct_settings 'agent_map' JSON {rawTelecmiAgentId: userEmail}), getUserNamesByEmail, resolveAgentLabel (raw→staff NAME, falls back to raw id if unmapped), distinctCallAgents. Read APIs (calls, guests/[id] timeline, dashboard leaderboard) add `agent_display` = resolved staff name; pages render `agent_display || agent_user`. Editor: CRM Settings "Agent Mapping" section (agents_seen + staff list from settings GET) → PUT { agent_map }. Same map feeds round-robin `nextAssignee`.

## Ringing display limits (raised 2026-07-18)
Screen-pop MAX_CARDS=5 (CTScreenPop.tsx); Live wallboard client slice(0,12) + server /api/crm-calls/live LIMIT 10. Total calls captured/logged is unlimited — these only bound the at-a-glance "ringing now"/pop views.

## Live Calls wallboard (foundation-built — already exists, do not recreate)
`src/app/crm-calls/live/page.tsx` — real-time receiving-calls wallboard (ringing-now cards with second counters, today counters, live feed, by-hour bars). Consumes `/api/crm-calls/events` (SSE), `/api/crm-calls/live` (poll: `{seq, events, ringing}`), `/api/crm-calls/dashboard?days=1` (`{today, byHour}`). Sidebar + page-catalog entries exist (`/crm-calls/live`).

## Pages (fleet-built, under `src/app/crm-calls/`)
`layout.tsx` (mounts `<CTScreenPop/>` + nothing else) · `page.tsx` Dashboard · `recovery/page.tsx` Recovery Queue (SLA countdown chips 🟢/🟠/🔴, actions) · `guests/page.tsx` list · `guests/[id]/page.tsx` Guest 360 · `log/page.tsx` Call Log · `settings/page.tsx` admin Settings.
Components in `src/components/ct/`: `CTScreenPop.tsx` (SSE + poll fallback; known/unknown caller; persists after hangup; disposition chips post-call), `QuickBookingModal.tsx` (shared by pop, guest 360, recovery).

## Simulator & tests (fleet-built)
- `scripts/simulate-call.ts` (npm run simulate:call) — flags: `--phone`, `--kind ring|answered|missed|outbound-answered`, posts realistic TeleCMI-ish payloads to local webhook URLs (reads token via better-sqlite3 or env).
- `scripts/ct-tests.ts` (npm run test:ct) — self-contained: temp DB copy; asserts idempotent CDR ingest, phone normalization, attribution, recovery lifecycle (missed→attempt→recovered), auto-resolve, expiry. Exit non-zero on failure.

## Non-goals Phase 1 (documented deviations)
WhatsApp/SMS sends stubbed (config-gated off; log only). Daily digest = dashboard "Yesterday" section (no email). Browser dialer not built. Phase 2/3 not built. Sidebar badge = floating-bell inbox integration (+ in-section count chip).
