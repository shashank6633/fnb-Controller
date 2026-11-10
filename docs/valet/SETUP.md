# Valet — setup (after the owner says "Deploy")

Nothing below happens by itself. After deploy, valet is **invisible and off** for everybody until
the owner switches it on.

## 1. Owner / admin — one-time

1. **Settings → Roles**: on the roles that should use valet, tick **Valet Head**, **Valet
   Attendant** or **Valet Desk/host** (all start unticked — no existing role changes). Add the valet
   pages to those roles' page lists as usual. A Valet Desk tick also shows the valet box on the
   Cashier bill screen.
2. **Valet Settings** (`/valet/settings`), per outlet:
   * **Switch ON**.
   * **Zones**: parking zones (with capacity and "minutes to fetch" if known), the pickup gate, a
     holding bay.
   * **Key tags**: add your tag numbers (e.g. 1–60).
   * **Rules**: hours, gate wait, pickup options, required fields, photos, retention months, paper
     tickets, closing-time questions, RFID mode (keep **Off**).
   * **Staff for this outlet**: tick who works valet here.
   * Print the **guest check-in QR** for the standee.
3. WhatsApp (optional): follow docs/valet/NOTIFICATIONS.md. Leave "Send REAL WhatsApp messages"
   unticked until the templates are approved and a test on the simulator looks right.

## 2. Database ("migrations")

There is no separate migration step. On every start the app runs `applyValetSchema`
(src/lib/valet/schema.ts) inside its normal schema set-up:

* creates 27 new tables, all named `valet_…` (if missing);
* adds `valet_head`, `valet_attendant`, `valet_host` to `roles` — `INTEGER DEFAULT 0`, **no
  backfill**, so no existing role gains anything;
* adds later columns to valet's own tables if an older valet build created them;
* creates indexes. Every statement is "IF NOT EXISTS"/column-probe, logged by name if it fails,
  and never stops the rest of the app from starting.

Nothing existing is altered, renamed or deleted. Rolling back the code leaves these tables unused.

## 3. Environment

See docs/valet/env.example. Production needs nothing new.

## 4. Sample data and tests (developer, never on live)

* `npx tsx scripts/valet-demo-seed.ts <dir with a COPY of fnb-controller.db>` — fictional cars and
  demo staff (head, two attendants, desk, a no-valet cashier) with sign-in tokens written to
  `<dir>/demo-sessions.json`. Refuses to run unless the folder is under a `harness/` directory.
* `npx tsx scripts/valet-tests.ts <dir with a COPY>` — the valet suite (sections A–Z). Network is
  disabled inside it and WhatsApp credentials in the copy are overwritten with fakes.

## 5. Files this module touches outside its own folders

Additive edits only: `src/lib/db.ts` (calls the valet schema), `src/lib/auth.ts` (reads the three
role ticks, fail-closed), `src/proxy.ts` (exact public paths: `/valet-pass`,
`/api/valet-guest/{state,entry,act}`, `/api/valet-rfid/ingest`; CSRF for `/api/valet/`),
`src/lib/page-catalog.ts` + `src/components/Sidebar.tsx` (Valet Parking section),
`src/app/api/auth/roles/route.ts` + `src/app/settings/roles/page.tsx` (the three ticks),
`src/app/api/whatsapp/webhook/route.ts` (valet events only when the signature is enforced),
`src/instrumentation.ts` (starts the valet worker), `src/components/BatchTagScanner.tsx` (optional
labels; kitchen text unchanged), `src/app/cashier/page.tsx` (one line: the valet box, invisible
without a valet tick).
