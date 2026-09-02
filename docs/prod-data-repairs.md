# Production data repairs — 3 jobs, each: BACKUP → VERIFY → REPAIR → CONFIRM

**Written 2026-09-02 against local HEAD 34f1825. Nothing was changed anywhere — this
document is the only new file.**

**What "proven" means here.** Everything below was tested against a **copy of the local
database** (`fnb-controller.db`, file dated 2026-08-31). That local file is a **stale
snapshot** — it is NOT production. Concretely, in the snapshot:

- requisitions numbered `REQ-2026-*` stop at **REQ-2026-0006** (2026-08-05). **REQ-2026-0620
  does not exist in it** — so nothing about the "200" value is proven; only the queries and
  the shape of the fix are.
- `ct_bookings` has only 40 rows (2026-06-20 → 2026-07-24) and the band calendar
  (`ct_entertainment` type `band`) is **empty** — so the band relink is proven to *execute*,
  not proven to produce links.
- `purchase_orders` has 24 rows; the PO repair script found and fixed exactly 1 on the copy.

Anything that could only be checked on the Lightsail box (the deployed code version, file
ownership, whether `sqlite3` is installed) is marked **UNPROVEN — check on the box**.

---

## 0. Shared setup on the production box (do this once per session)

The app lives at **`/var/www/fnb-controller`** and the database is
**`/var/www/fnb-controller/fnb-controller.db`** (the app opens
`process.cwd()/fnb-controller.db` — `src/lib/db.ts:11`; the deploy workflow's `cd` at
`.github/workflows/deploy.yml:84` fixes the cwd). pm2 runs the app as **root**, so the DB
files may be root-owned — if any command below says "permission denied" or
"SQLITE_CANTOPEN", put `sudo` in front of it.

```bash
ssh <your-lightsail-login>
cd /var/www/fnb-controller

# sqlite3 CLI — UNPROVEN whether it's installed; this line settles it:
command -v sqlite3 || sudo apt-get install -y sqlite3
```

### The BACKUP step (identical for all three jobs — never skip it)

```bash
cd /var/www/fnb-controller
STAMP=$(date +%F-%H%M)
sudo cp fnb-controller.db      fnb-controller.db.bak-$STAMP
sudo cp fnb-controller.db-wal  fnb-controller.db.bak-$STAMP-wal 2>/dev/null || true
sudo cp fnb-controller.db-shm  fnb-controller.db.bak-$STAMP-shm 2>/dev/null || true
ls -la fnb-controller.db.bak-$STAMP*
```

(You can additionally run `npm run backup` — the nightly VACUUM-INTO snapshot — but the
raw `cp` trio above is the restore-in-30-seconds one: to roll back, stop pm2, copy the
three `.bak` files back over the live names, start pm2.)

You do **not** need to stop the app for any of these repairs — SQLite WAL handles a second
writer, and every write below is a short transaction. Do them at a quiet hour anyway.

---

## 1. REQ-2026-0620 — the "200 eggs" line

### What I could and could not prove

- **The real columns** (from `initializeSchema()` in `src/lib/db.ts` — requisitions at
  :1507, items at :1557, plus later ALTERs at :2470-2526): a requisition line is
  `requisition_items(id, req_id, material_id, quantity_requested, chef_approved_qty,
  quantity_issued, quantity_to_purchase, unit, is_rejected, issued_at, notes, ...)`.
  The header is `requisitions(req_number, date, status, department_id, ...)`.
- **The row itself is NOT in the local snapshot** (it stops at REQ-2026-0006), so whether
  200 is requested/approved/issued, and by whom, is **UNPROVEN** until you run the VERIFY
  query on the box.

### Is 200 a unit mix-up, a typo, or real?

- **It cannot be a pack-size mix-up.** In the snapshot, the material **EGGS**
  (`raw_materials` id `4f4b75e3-4013-47b5-a65d-4afc37703cd5`) is `unit=pcs`,
  `purchase_unit=pcs`, `pack_size=1.0` — recipe unit and purchase unit are the same thing,
  so there is no ×pack conversion that could turn a sane number into 200. (The pack
  convention — purchase rows in purchase units, `current_stock` in recipe units ×pack —
  only bites when `pack_size ≠ 1`.) The VERIFY query below re-checks `pack_size` on
  production in case the master row changed after the snapshot.
- **200 pieces in one day is inside this building's real range.** Historical daily egg
  issues in the snapshot: mostly 30–120 pcs/day, but 180 on 2026-05-03 and **360 on
  2026-04-29**. So 200 is unusual-but-plausible (a party/banquet day), and it is equally
  plausible as a typo for 20 or 100. **The snapshot cannot decide this — the VERIFY query
  on production decides it.**

### VERIFY (read-only — run on the box, paste-ready)

```bash
cd /var/www/fnb-controller
sudo sqlite3 -header -column fnb-controller.db "
SELECT r.req_number, r.date, r.status, r.department_id,
       ri.id AS line_id, m.name, ri.unit AS line_unit,
       ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued,
       ri.quantity_to_purchase, ri.is_rejected, ri.issued_at,
       m.unit AS recipe_unit, m.purchase_unit, m.pack_size, m.current_stock
  FROM requisitions r
  JOIN requisition_items ri ON ri.req_id = r.id
  JOIN raw_materials m      ON m.id = ri.material_id
 WHERE r.req_number = 'REQ-2026-0620'
   AND LOWER(m.name) LIKE '%egg%';"

# Did stock actually MOVE for this line? (empty result = nothing moved yet)
sudo sqlite3 -header -column fnb-controller.db "
SELECT l.req_item_id, l.reason, l.delta_line_qty, l.line_unit, l.pack_factor,
       l.delta_recipe_qty, l.stock_applied, l.created_at
  FROM requisition_issue_ledger l
  JOIN requisitions r ON r.id = l.req_id
 WHERE r.req_number = 'REQ-2026-0620';"

# Context: what this kitchen normally draws (compare 200 against these)
sudo sqlite3 -header -column fnb-controller.db "
SELECT r.date, SUM(ri.quantity_issued) AS eggs_issued_that_day
  FROM requisitions r
  JOIN requisition_items ri ON ri.req_id = r.id
  JOIN raw_materials m ON m.id = ri.material_id
 WHERE m.name = 'EGGS'
 GROUP BY r.date ORDER BY r.date DESC LIMIT 30;"
```

**How to read it:**
- If `pack_size` is `1.0` and `line_unit`/`recipe_unit`/`purchase_unit` are all `pcs` →
  a unit mix-up is ruled out; 200 is either a typo or a real big day.
- If `quantity_issued = 0` and the ledger query returns **nothing** → the 200 has not
  moved any stock yet. This is the easy case (Repair A).
- If `quantity_issued > 0` or the ledger shows rows with `stock_applied = 1` → the eggs
  have already left the central store into the department ledger. **Do not hand-edit
  numbers in this case** (Repair B).
- Compare 200 against the 30-day history column. If the date was a party night (check
  Party Bookings for that date), 200 may simply be correct — in which case **change
  nothing**.

### REPAIR

**Repair A — wrong number, nothing issued yet** (only if VERIFY showed
`quantity_issued = 0` and an empty ledger). Replace `<LINE_ID>` with the `line_id` from
VERIFY and `<RIGHT_QTY>` with the corrected quantity (e.g. `20`):

```bash
sudo sqlite3 fnb-controller.db "
UPDATE requisition_items
   SET quantity_requested = <RIGHT_QTY>,
       chef_approved_qty  = CASE WHEN chef_approved_qty IS NOT NULL
                                 THEN <RIGHT_QTY> ELSE NULL END
 WHERE id = '<LINE_ID>'
   AND quantity_issued = 0;
SELECT changes();"
```

Expected output: `1`. If it prints `0`, the guard refused — either the id is wrong or the
line got issued between VERIFY and now; re-run VERIFY.

**Repair B — the 200 was already issued.** The issue touched four places at once
(`requisition_items.quantity_issued`, `requisition_issue_ledger`,
`raw_materials.current_stock`, `department_material_transactions`) — the cutover rule is
"every gram leaves central exactly once, at the issue"
(`docs/requisition-deduct-at-issue-cutover.md`). A hand-written UPDATE that fixes one of
the four creates the exact double-count this app spent months killing. **Use the app
instead:** on the requisition, undo / store-reject the issued egg line (the app writes the
`issue_reversal` and credits central back), then re-issue the correct quantity. If the
app won't let you (requisition fulfilled/locked), that's a developer task, not a
paste-in query — say the word and it gets built as a proper script with its own dry run.

### CONFIRM

Re-run the first VERIFY query. Expected: `quantity_requested` (and `chef_approved_qty` if
it was set) now read `<RIGHT_QTY>`; `quantity_issued` unchanged from what VERIFY showed.

---

## 2. Band attribution — `relinkBands()`

### What it is and what it repairs

`relinkBands(db, {from, to})` — `src/lib/reservego-import.ts:1728`. For every booking in
the date range it re-resolves **`ct_bookings.live_band` and `live_band_id`** ("who played
the night this guest dined") from the entertainment calendar
(`ct_entertainment` rows with type `band`, names resolved against the `ct_bands` master).
Two things to know before running it:

1. **It clears as well as sets** (by design — a cancelled act must take its bookings'
   credits with it, `reservego-import.ts:1715`). If the calendar for the range you give it
   is **empty**, it will blank every existing link in that range. So always check the
   calendar first (VERIFY below) and keep the range tight.
2. It writes **only** those two columns on `ct_bookings` (single UPDATE at :1759, one
   transaction), leaves `updated_at` alone, and never inserts into `ct_bands`. Its
   `ensureSchema()` may also ADD a few missing columns (PRAGMA-guarded, additive-only,
   no-ops when they already exist — :295-323).

### Is anything exposing it? (the honest answer)

**There is no "repair everything" button.** The only callers in the whole repo are the
entertainment-calendar routes:

- `POST /api/crm-calls/entertainment` (`route.ts:148`) — after creating a calendar entry,
  relinks **that one date**. Management-only.
- `PUT/DELETE /api/crm-calls/entertainment/[id]` (`[id]/route.ts:97,117`) — relinks the
  old and new dates. Management-only.

Nothing else — not the bands API, not the reservation-import routes — calls it, and there
is no script for it in `scripts/`.

**UNPROVEN — check the box first:** whether the *deployed* build even contains the helper
(the route resolves it dynamically and silently skips the relink on older builds):

```bash
grep -c "export function relinkBands" /var/www/fnb-controller/src/lib/reservego-import.ts
# "1" → the deployed code has it.  "0" / file missing → deploy current main first.
```

### Steps to run it on production

**BACKUP** — section 0.

**VERIFY (read-only)** — see what the relink would work from, for your range:

```bash
sudo sqlite3 -header -column /var/www/fnb-controller/fnb-controller.db "
SELECT event_date, name, start_time FROM ct_entertainment
 WHERE LOWER(TRIM(type))='band' AND event_date BETWEEN '<FROM>' AND '<TO>'
 ORDER BY event_date;"

sudo sqlite3 /var/www/fnb-controller/fnb-controller.db "
SELECT COUNT(*) AS bookings_in_range,
       SUM(CASE WHEN COALESCE(live_band,'')<>'' THEN 1 ELSE 0 END) AS already_linked
  FROM ct_bookings
 WHERE COALESCE(NULLIF(reserved_date,''), booking_date) BETWEEN '<FROM>' AND '<TO>';"
```

If the first query returns **no rows**, stop — running the relink over that range would
only clear links, never add them.

**REPAIR — Option A (no code, one night at a time).** If only a night or two need fixing:
log in as a manager/admin, open the entertainment calendar (What's On), and **re-save the
band entry for that night** (open it, Save — you don't have to change anything). The save
triggers the relink for exactly that date. Adding a missing band to the calendar, or to
the `ct_bands` master and then re-saving the night, does the same.

**REPAIR — Option B (a date range).** There is no built trigger for this — the honest
statement is: *a proper admin button needs to be built if you want this repeatable.* Until
then, this one-off runner is the way. It was **executed against the local DB copy in this
investigation** (output below), so the mechanism is proven; the production result depends
on production's calendar. On the box:

```bash
cd /var/www/fnb-controller
cat > relink-bands-once.ts <<'EOF'
// One-off: re-resolve band attribution for a date range.
//   sudo npx --yes tsx relink-bands-once.ts <from YYYY-MM-DD> <to YYYY-MM-DD>
import Database from 'better-sqlite3';
import { relinkBands } from './src/lib/reservego-import';
const [, , from, to] = process.argv;
if (!from || !to) { console.error('usage: tsx relink-bands-once.ts <from> <to>'); process.exit(1); }
const db = new Database('./fnb-controller.db');
console.log(JSON.stringify(relinkBands(db as any, { from, to }), null, 2));
EOF

sudo npx --yes tsx relink-bands-once.ts 2026-08-01 2026-08-31   # your range here
rm relink-bands-once.ts
```

(`tsx` is not installed on the box — `npx --yes` fetches it, the same way the repo's own
`npm run test:ct` does. Run it from `/var/www/fnb-controller` so the `@/lib/*` imports
inside the engine resolve via the repo's tsconfig — that resolution is what was proven
locally.)

Proof-of-execution on the local copy (range = the snapshot's whole booking window; the
snapshot's calendar is empty, hence 0 changed — that is the stale-snapshot limit, not a
bug):

```json
{ "from": "2026-06-20", "to": "2026-07-24", "dates": 0, "scanned": 40,
  "changed": 0, "linked": 0, "cleared": 0, "unresolved": [] }
```

**CONFIRM.** The runner's own JSON is the report: `scanned` (bookings in range), `linked`
(got a band), `cleared` (band removed because the calendar says nobody played),
`unresolved` (names on the calendar with **no `ct_bands` master row** — add those bands to
the master and run again, that is the designed loop). Then re-run the second VERIFY query:
`already_linked` should now match what the calendar says the range deserves.

---

## 3. PO header vendor repair — `scripts/repair-po-header-vendor.ts`

### What the script actually does (read end-to-end)

- **Dry-run by default.** It writes **nothing** unless you pass `--apply`
  (line 52: `const APPLY = process.argv.includes('--apply')`; the only write, line 76/107,
  runs inside `if (APPLY)`).
- **The only write is** `UPDATE purchase_orders SET vendor = ?, vendor_id = ? WHERE id = ?`.
  No other table, no other column. The derivation it uses, `headerVendorFromLines()`
  (`src/lib/vendor-mapping.ts:380`), is read-only (SELECTs against `vendors` only), and
  the script's import of the app db module is type-only — **no boot migrations run**, the
  schema is untouched.
- One honest nuance: it examines **every** PO, not only frozen ones — a *draft* whose
  stored header disagrees with the rule would also be rewritten. That is harmless (the app
  itself re-derives a draft's header on its next save with the same function), but if you
  want surgical, use `--po <number> --apply` per PO instead of a blanket `--apply`.
- `--db <path>` points it at another file; without it, it uses `./fnb-controller.db` of
  the directory you run it from.
- POs where **no line carries a vendor at all** are skipped on purpose (line 87) — the
  script will never blank a header the app deliberately leaves alone.

### Proven on the local DB copy (full transcript)

Dry run (`npx tsx scripts/repair-po-header-vendor.ts --db <copy>`):

```
PO-2026-0008  [pending_reapproval]  4 line(s), 2 vendor identities
   stored : vendor="LOCAL PURCHASE" vendor_id="05695ec4b6eed2b30fbd0432df8c8713"
   derived: vendor="Mixed (2 vendors)" vendor_id=null
     line vendor "LOCAL PURCHASE" (len 14, id="05695ec4b6eed2b30fbd0432df8c8713") x3
     line vendor "HYPERPURE" (len 9, id="0061835fdbf06a869b85b87d05f9a27c") x1

24 PO(s) examined · 1 disagree with the current rule · 0 written (dry run — pass --apply to repair).
```

Apply run on the copy: same listing, then
`24 PO(s) examined · 1 disagree with the current rule · 1 REWRITTEN.`
Post-check on the copy:
`PO-2026-0008 | pending_reapproval | Mixed (2 vendors) | (empty vendor_id)` — and a second
dry run reported `0 disagree with the current rule`. Exactly one row, exactly two columns.

(The copy is the stale snapshot — production's list of disagreeing POs **will differ**;
that is what the production dry run is for.)

### Production run (Lightsail box)

The box builds nothing itself, but the full repo source is checked out at
`/var/www/fnb-controller` at the deployed commit and `node_modules` (incl. native
`better-sqlite3`) is box-built (`.github/workflows/deploy.yml:84-104`). `tsx` is **not** a
dependency — `npx --yes tsx` downloads it on first use, same as `npm run simulate:call`
does. First confirm the script has actually been deployed:

```bash
cd /var/www/fnb-controller
test -f scripts/repair-po-header-vendor.ts && echo OK || echo "NOT DEPLOYED YET — push+deploy main first"
```

**BACKUP** — section 0. The script rewrites rows in place; the `cp` trio is your rollback.

**VERIFY (dry run — writes nothing):**

```bash
cd /var/www/fnb-controller
sudo npx --yes tsx scripts/repair-po-header-vendor.ts
# want a close look at one PO from the listing first?
sudo npx --yes tsx scripts/repair-po-header-vendor.ts --po PO-2026-0079
```

Read the listing. Each block shows the stored header vs what the rule derives, and the
distinct line spellings with their **lengths** — a `(len 15)` next to a `(len 14)` of the
same-looking name is the trailing-space bug the fix exists for. Any `NOTE: line vendor(s)
not in the Vendor master` line means a spelling worth fixing in the Vendor master itself.

**REPAIR:**

```bash
# surgical (recommended if only a few POs are listed):
sudo npx --yes tsx scripts/repair-po-header-vendor.ts --po PO-2026-0079 --apply

# or everything the dry run listed:
sudo npx --yes tsx scripts/repair-po-header-vendor.ts --apply
```

**CONFIRM:**

```bash
# 1. the script's own re-check — expected: "... 0 disagree with the current rule · 0 written"
sudo npx --yes tsx scripts/repair-po-header-vendor.ts

# 2. eyeball the repaired header(s):
sudo sqlite3 -header -column fnb-controller.db "
SELECT po_number, status, vendor, vendor_id
  FROM purchase_orders
 WHERE po_number IN ('PO-2026-0079');"   -- list the PO numbers the dry run showed
```

Expected: each repaired PO shows the `derived:` value from the dry-run listing — either
the master-row spelling with its id, or `Mixed (N vendors)` with an empty id. Then open
one of them in the app (`/purchase-orders`): the read path serves the stored column
verbatim, so the screen should now match.
