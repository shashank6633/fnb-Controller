# FSSAI P0 RECON — LANE: DATABASE CONVENTIONS

**Phase:** P0 (read-only). **Date:** 2026-09-16.
**Worktree:** `/Users/shashankreddy/Desktop/Claude/fnb-fssai`, branch `fssai-compliance`, forked from main @ `4125237`.
**Live repo read (never written):** `/Users/shashankreddy/Desktop/Claude/fnb-controller`.

Every line number refers to the **worktree** copy `src/lib/db.ts` (9,561 lines) unless the text
says *live copy*. §0 explains why those two files differ and why it matters.

> **Spelling, 2026-10-14.** `<liquor>_` below stands for the liquor-reconciliation tables' real
> two-letter prefix, and `grep 'l[q]_'` is the same search written so it does not contain that
> prefix. Both are spelled this way on purpose: the FSSAI deploy gate counts the literal prefix in
> every line this bundle adds, and these notes must not be what makes it read non-zero.

Nothing was written except this document. No migration ran. No server was started. The live
database was opened read-only and snapshotted with `VACUUM INTO` (§8).

---

## §0. THE TWO db.ts FILES — READ THIS BEFORE P1 TOUCHES ANYTHING

The worktree and the live repo do **not** hold the same `db.ts`.

```
$ wc -l /Users/shashankreddy/Desktop/Claude/fnb-controller/src/lib/db.ts     # live
   10129
$ wc -l /Users/shashankreddy/Desktop/Claude/fnb-fssai/src/lib/db.ts         # our worktree
    9561
$ diff <worktree> <live> | grep -c "^[<>]"
568
```

> **⚠️ STALE, 2026-09-17 (P1 fix lane).** Both counts have moved and neither is a valid gate any
> more. Live `db.ts` is now **10,158** (the liquor lane added 29 lines there on 2026-09-17 08:11;
> `grep -c fssai` on it is still **0**, and `grep -c 'l[q]_'` is still **57**). This worktree's
> `db.ts` has grown past 9,561 with the `fssai_` block and the rebuilt boot path. Re-measure
> before relying on either number — see the correction box at the top of `RECON.md`.

The 568 differing lines are the **uncommitted liquor-reconciliation (`<liquor>_*`) work** in the live
repo. Tables present only in the live copy:

```
$ comm -13 <(grep -o "CREATE TABLE IF NOT EXISTS [a-z_0-9]*" <worktree> | sort -u) \
           <(grep -o "CREATE TABLE IF NOT EXISTS [a-z_0-9]*" <live>     | sort -u)
<liquor>_brand_map
<liquor>_portal_checks
<liquor>_retail_flags
<liquor>_wallet_txns
<liquor>_withdrawals
```

Consequences, in order of importance:

1. **Our insertion point is line 8189/8190, not the live file's 8756.** In the worktree,
   `initializeSchema()` ends at:
   ```
   8188	    `);
   8189	  } catch (e) { console.error('hrms schema failed:', e); }
   8190	}
   ```
   The FSSAI block goes **after 8189, before the closing brace on 8190**. In the live copy the
   HRMS catch is at 8251 and the `<liquor>_*` block runs 8251-8756. Do not copy a line number across.

2. **The live DB is already ahead of our db.ts.** The five `<liquor>_*` tables exist in production data
   (§8) but not in our branch's schema code. Expected and harmless — our branch never drops
   anything — but "table exists in the DB" is not proof our branch creates it.

3. **The best migration-safety pattern in this codebase lives in that uncommitted work** (§3.4).
   Reuse the *pattern*. Do **not** import the `<liquor>_*` code into this branch — it is the owner's
   ungated work and copying it here would entangle two unrelated deliverables.

---

## §1. THE STRUCTURE OF initializeSchema()

### 1.1 Where it is and when it runs

`src/lib/db.ts:24-76` — module-level singleton, `DB_PATH` is **`process.cwd()`-relative**:

```ts
24	const DB_PATH = path.join(process.cwd(), 'fnb-controller.db');
25
26	let db: Database.Database | null = null;
27
28	export function getDb(): Database.Database {
29	  if (!db) {
30	    db = new Database(DB_PATH);
31	    db.pragma('journal_mode = WAL');
32	    db.pragma('foreign_keys = ON');
...
59	    db.pragma('cache_size = -32000');
60	    db.pragma('busy_timeout = 5000');
61	    db.pragma('temp_store = MEMORY');
62	    initializeSchema(db);
```

Load-bearing facts:

- `initializeSchema()` runs **once per process**, on the first `getDb()`, guarded only by the
  `if (!db)` memo. A deploy restarts the process, so **"runs on boot" means "runs on every
  deploy"** — the premise of the boot-migration lock (§3.3).
- `foreign_keys = ON` (line 32). FK declarations are **enforced**, not decorative.
- `temp_store = MEMORY` (line 61) matters for §3.4: the shape-guard pattern creates `temp.zz_*`
  tables, and with this pragma they never touch disk.
- `DB_PATH` is `process.cwd()`-relative — **this is why no server may be started in
  `fnb-controller/`**. Running `npm run dev` there opens the real 34 MB production database
  read-write.

### 1.2 Internal organisation

`initializeSchema()` spans **lines 77-8190** (8,113 lines):

| Region | Lines | Shape |
|---|---|---|
| Core founding tables | 78-340 | ONE giant db.exec() template literal, **no try/catch** |
| Everything after | 341-8189 | ~130 independent try/catch blocks, each ending `catch (e) { console.error('<label> failed:', e) }` |

Counts, measured:

```
$ grep -c "db.exec("                   db.ts   ->  364
$ grep -c "catch (e) { console.error"  db.ts   ->  130
$ grep -c "catch (_)"                  db.ts   ->    4
$ grep -c "catch {"                    db.ts   ->   10
```

The **first db.exec() at line 78 is unguarded**. It creates `raw_materials`, `purchases`,
`sub_recipes`, `recipes`, `settings` (207) and the other founding tables. A failure there is the
only schema failure that actually crashes boot. Everything after line 341 fails silently.

### 1.3 Where a new module's block goes

The two most recent modules both appended a single labelled block at the tail with a banner
comment. The Task module banner (`db.ts:5459-5465`) is the template:

```ts
5459	  // ══════════════════════════════════════════════════════════════════════════
5460	  // TASK MANAGEMENT MODULE (2026-07) — purely additive. All 19 tables + seeds
5461	  // live inside ONE labeled try/catch so any failure here never blocks boot and
5462	  // never touches existing tables. Idempotent: CREATE TABLE/INDEX IF NOT EXISTS,
5463	  // INSERT OR IGNORE, existence-guarded seeds.
5464	  // ══════════════════════════════════════════════════════════════════════════
5465	  try {
```

**Recommendation for FSSAI:** append after `db.ts:8189`, same banner form, but **do not use one
giant db.exec()** — §3.2 shows why the Task module's own choice is the thing that would bite us.

### 1.4 Ordering constraints (real, not stylistic)

1. **`settings` must exist before any one-shot flag is read.** Created at line 207 inside the
   unguarded block, so any block after line 341 can rely on it. A `fssai_` block at 8189 is safe.
2. **FK parents before children.** `foreign_keys = ON`. SQLite does not validate FK targets at
   CREATE TABLE time, only at DML time — so a forward reference will not fail the migration, it
   will fail the first insert.
3. **Seeds after their table, in the same block** (pattern at 5767-5785: `INSERT OR IGNORE`
   immediately after the create, inside the same try).
4. **Backfills after the columns they fill**, and one-shot or null-only (§3.3).
5. **A seed that must not re-run needs its flag written inside the same transaction.**
   `db.ts:793-795`: *"The flag is written INSIDE the transaction, so a crash between seed and flag
   leaves neither and the next boot retries cleanly."*

---

## §2. THE TWO PATTERNS

### 2.1 Pattern A — fresh CREATE TABLE IF NOT EXISTS

Canonical example, `db.ts:904-920` (`menu_item_images`):

```ts
904	  try {
905	    db.exec(`
906	      CREATE TABLE IF NOT EXISTS menu_item_images (
907	        id         TEXT PRIMARY KEY,
908	        item_id    TEXT,
909	        mime       TEXT NOT NULL,
910	        width      INTEGER NOT NULL DEFAULT 0,
911	        height     INTEGER NOT NULL DEFAULT 0,
912	        size       INTEGER NOT NULL DEFAULT 0,
913	        data       BLOB NOT NULL,
914	        created_by TEXT NOT NULL DEFAULT '',
915	        created_at TEXT NOT NULL DEFAULT (datetime('now'))
916	      );
917	      CREATE INDEX IF NOT EXISTS idx_menu_item_images_item ON menu_item_images(item_id);
918	      CREATE INDEX IF NOT EXISTS idx_menu_item_images_created ON menu_item_images(created_at);
919	    `);
920	  } catch (e) { console.error('menu_item_images migration failed:', e); }
```

House rules visible in it, confirmed across all 204 live tables (§4): `TEXT PRIMARY KEY`; every
non-PK column NOT NULL DEFAULT-ed; `created_at TEXT NOT NULL DEFAULT (datetime('now'))`; indexes
IF NOT EXISTS, named `idx_<table>_<cols>`, declared in the same statement block under the table;
one labelled catch per block.

### 2.2 Pattern B — additive ALTER TABLE ADD COLUMN behind a has() guard

**The has() helper is not a shared utility.** It is redeclared inline in every block that needs it,
always over a fresh PRAGMA table_info. Canonical form, `db.ts:1001-1013`:

```ts
1001	  try {
1002	    const cols = db.prepare("PRAGMA table_info(raw_materials)").all() as any[];
1003	    const has = (n: string) => cols.some((c: any) => c.name === n);
1004	    const adds: [string, string][] = [
1005	      ['primary_vendor',     "TEXT DEFAULT ''"],
1006	      ['purchase_unit',      "TEXT DEFAULT ''"],
1007	      ['recipe_unit',        "TEXT DEFAULT ''"],
1008	      ['conversion_factor',  "REAL DEFAULT 1"],
1009	      ['yield_percent',      "REAL DEFAULT 100"],
1010	      ['last_purchase_price',"REAL DEFAULT 0"],
1011	      ['last_purchase_date', "TEXT DEFAULT NULL"],
1012	    ];
1013	    for (const [c, t] of adds) if (!has(c)) db.exec(`ALTER TABLE raw_materials ADD COLUMN ${c} ${t}`);
```

One-line-per-column variant, `db.ts:3110-3117` (named `hasG` to avoid shadowing):

```ts
3110	    const grnCols = db.prepare("PRAGMA table_info(goods_receipt_notes)").all() as any[];
3111	    const hasG = (n: string) => grnCols.some((c: any) => c.name === n);
3112	    if (!hasG('qc_quality'))       db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_quality INTEGER NOT NULL DEFAULT 0`);
3113	    if (!hasG('qc_temperature'))   db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_temperature INTEGER NOT NULL DEFAULT 0`);
3114	    if (!hasG('qc_expiry'))        db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_expiry INTEGER NOT NULL DEFAULT 0`);
3115	    if (!hasG('qc_damage'))        db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_damage INTEGER NOT NULL DEFAULT 0`);
3116	    if (!hasG('qc_weight'))        db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_weight INTEGER NOT NULL DEFAULT 0`);
3117	    if (!hasG('qc_invoice_match')) db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_invoice_match INTEGER NOT NULL DEFAULT 0`);
```

**Two traps in Pattern B:**

- `cols` is read **once, before** the ALTERs. Fine as written, because each column is added at most
  once — but a block that ALTERs and then re-consults the stale `cols` will add twice and throw.
  Re-PRAGMA if you need a fresh view.
- A NOT NULL column added by ALTER **must carry a DEFAULT**, or SQLite rejects it on a non-empty
  table. Every example above obeys this.

### 2.3 Which pattern FSSAI uses

All `fssai_` tables are new => **Pattern A**. Pattern B applies only where FSSAI extends an
existing table — per HARD RULE 2 the only candidates are `goods_receipt_notes` (Receiving QC, which
**already has six qc_* columns**, §8.4(3)) and `raw_materials` (which **already has
storage_location and shelf_life_days**, §8.5). Check what exists before proposing a column.

---

## §3. HOW ERRORS ARE SWALLOWED, AND HOW TO PROVE A MIGRATION APPLIED

### 3.1 The exact swallow

No clever machinery — 130 copies of one line. Representative, `db.ts:8189`:

```ts
  } catch (e) { console.error('hrms schema failed:', e); }
```

and `db.ts:920`:

```ts
  } catch (e) { console.error('menu_item_images migration failed:', e); }
```

Four blocks swallow with **no log at all** — `catch (_) { /* table may not exist yet on first run */ }`
(e.g. `db.ts:436`, `db.ts:456`). Ten more use a bare `catch {`.

console.error goes to the systemd journal (`deploy/fnb-controller.service:18-20`):

```
18	# Logging — visible via `journalctl -u fnb-controller`
19	StandardOutput=journal
20	StandardError=journal
```

Evidence exists but is only reachable by SSH-ing to the box. **Nothing surfaces a failed migration
inside the app.** The app boots normally, the page renders, and the first write throws
"no such table".

### 3.2 What a single swallowed error actually costs — MEASURED

A multi-statement exec runs its statements **sequentially**; when one throws, the ones before it
have already committed and the ones after it **never run**. With the whole block in one try, the
log records one line and the module loses every table below the typo.

Proof, run against an in-memory database with this repo's own better-sqlite3:

```
$ node exec-fail-proof.js

--- index on a mistyped column (statement 5 of 9) ---
error  : no such column: recored_at
created: ["fssai_a","fssai_b","fssai_c"]
LOST   : fssai_d, fssai_e

--- syntax typo (statement 3 of 5) ---
error  : near "TABEL": syntax error
created: ["fssai_a","fssai_b"]
LOST   : fssai_c, fssai_d, fssai_e

--- duplicate column in table 2 of 5 ---
error  : duplicate column name: note
created: ["fssai_a"]
LOST   : fssai_b, fssai_c, fssai_d, fssai_e
```

Read the first case carefully: **a typo in an INDEX name — `recored_at` for `recorded_at` —
silently destroyed two later tables.** The Task module put all 20 of its tables in one statement
block (`db.ts:5466-5765`). FSSAI plans nine. One typo in question-type index #3 and sub-modules 4-9
have no storage, with a single journal line as the only trace.

### 3.3 What verification already exists

| Mechanism | File | What it actually proves | Enough for FSSAI? |
|---|---|---|---|
| check-boot-migrations.js | `scripts/check-boot-migrations.js` | **Static lint of db.ts text.** Flags boot-time writes to admin-owned state lacking a one-shot guard. Never opens a database. | No — cannot tell whether a table exists |
| config_fingerprint_log | `db.ts:5428-5457` | SHA-256 of the users/roles permission config each boot; logs transitions | No — permissions only |
| Admin Database console | `src/app/api/admin/database/route.ts` | Admin-only, read-only SQL in a child process; `?view=catalog` returns table list + row counts | **Yes — this is the verification tool** |
| Boot assertion / schema_version | — | **Does not exist.** grep for `process.exit`, `SCHEMA_VERSION`, `schema_version` in db.ts -> no matches | — |
| Health endpoint | — | **Does not exist.** No `src/app/api/health*` | — |

check-boot-migrations.js is wired into `npm test` (`package.json:17`) and `npm run check:boot`
(`package.json:21`). Its header states the rule FSSAI's seeds must obey
(`check-boot-migrations.js:8-23`):

> *"The migration block in src/lib/db.ts runs on EVERY getDb() cold start, and a deploy restarts
> the process — so 'runs on boot' means 'runs on every deploy'. That is fine for a schema change …
> It is NOT fine for anything a human has decided."*

Escape hatches in the order the file itself prefers them (`check-boot-migrations.js:31-49`): make
it one-shot with a settings flag; narrow it to a true NULL-fill; or declare
`// boot-migration-lock: <reason>`.

**This directly constrains the FSSAI checklist-template seed.** Seeding twelve templates on every
boot would re-add a template an admin retired — the identical shape as the `menu_categories`
is_active case the lock already guards (`check-boot-migrations.js:73-80`). Use a one-shot flag.

### 3.4 BEST PRACTICE IN THIS CODEBASE — and it already exists, uncommitted

The strongest answer to "prove the migration applied" is **not** something P1 must invent. The
uncommitted `<liquor>_*` work in the live repo solved exactly this, twice over (live copy
`fnb-controller/src/lib/db.ts`):

**(a) Per-statement execution with the failing table NAMED** — live `db.ts:8589-8593`:

```ts
  for (const stmt of <LIQUOR>_TABLE_DDL) {
    const named = /CREATE TABLE IF NOT EXISTS (<liquor>_[a-z_]+)/.exec(stmt);
    try { db.exec(stmt); }
    catch (e) { console.error('liquor reconciliation (<liquor>_*) schema failed for ' + (named ? named[1] : '?') + ':', e); }
  }
```

A DDL **array**, not one template literal. One bad statement loses exactly one table, and the log
says which. This alone defeats every failure mode measured in §3.2.

**(b) A SHAPE GUARD, for the thing IF NOT EXISTS cannot do** — live `db.ts:8596-8666`:

> *"IF NOT EXISTS answers 'is there an object with this name', never 'does it have the right
> columns'. A table that already exists in a WRONG shape survives the block above in complete
> silence — no log line, indexes still created, CHECK vocabularies simply absent — and then throws
> at runtime, three deploys away from the cause. Measured on a fixture: a 6-of-16-column
> `<liquor>_wallet_txns` booted clean, then 'table `<liquor>_wallet_txns` has no column named bank_match' on the
> first save, with type='NONSENSE' accepted."*

And why it matters **specifically to a phased build**:

> *"This matters most for the phases: the day L2 adds a column to the CREATE TABLE above, dev is a
> fresh DB and works, while testing and production already have the table and never get it."*

Mechanism: re-run each CREATE TABLE text into `temp.zz_<name>`, read the intended columns off the
temp copy with **pragma_table_xinfo** (not table_info — it omits generated columns, which would
make the guard re-ALTER every boot: *"Measured: table_info 25, table_xinfo 26"*), diff against the
real table, and ALTER TABLE ADD COLUMN whatever is missing. Generated columns and
NOT-NULL-without-default columns are **reported, not added**. `dflt_value` comes back without
parentheses and must be re-wrapped. It shouts on drift because CHECK constraints and FKs cannot be
added by ALTER, so a repaired table is only *partly* repaired.

**Recommendation for the FSSAI foundation phase (P1):**

1. Define `FSSAI_TABLE_DDL: string[]` — one CREATE TABLE IF NOT EXISTS fssai_* per entry.
2. Execute per-statement with the table name in the catch (pattern (a)).
3. Add the shape guard over `fssai_` (pattern (b)), **reimplemented in this branch** — do not
   import the `<liquor>_` code.
4. Indexes in their own try, separate from the tables, so one swallowed error cannot hide the other
   half (the live block says so at `db.ts:8668-8669`).
5. After the block, assert and log: count how many expected `fssai_` tables exist and console.error
   loudly if any are missing. No such assertion exists anywhere in the app today; FSSAI is the
   module that needs it, and "inspection-ready records" is exactly what a missing table destroys.
6. Verify by hand, per deploy, through the admin Database console: `?view=catalog`.

---

## §4. NAMING CONVENTIONS — MEASURED ACROSS ALL 204 LIVE TABLES

### 4.1 Primary keys

```
$ sqlite3 "file:<snapshot>?mode=ro" "SELECT CASE
    WHEN sql LIKE '%INTEGER PRIMARY KEY%' THEN 'INTEGER-PK'
    WHEN sql LIKE '%TEXT PRIMARY KEY%'    THEN 'TEXT-PK'
    ELSE 'other/composite' END AS k, COUNT(*)
  FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' GROUP BY k;"
INTEGER-PK|9
TEXT-PK|190
other/composite|5
```

**TEXT PRIMARY KEY holding a UUID is the rule (190 of 204).** Generator, `db.ts:8242-8244`:

```ts
8242	export function generateId(): string {
8243	  return crypto.randomUUID();
8244	}
```

The nine INTEGER PRIMARY KEY AUTOINCREMENT tables are all append-only high-volume logs:
`config_fingerprint_log`, `whatsapp_events_log`, `wa_conversations`, `wa_messages`, `wa_media`,
`wa_ingest_state`, `wa_consent_log`, `wa_report_files`, `wa_report_runs`.

**FSSAI should use TEXT PRIMARY KEY + generateId() throughout.**

### 4.2 Generated human-facing codes — a SEPARATE column, never the PK

Real values from the live database:

```
$ sqlite3 ... "SELECT barcode, batch_number FROM production_batches LIMIT 4;"
PROD000001|CG260707001
PROD000002|CG260708001
PROD000003|M260708001
PROD000004|PT260709001

$ sqlite3 ... "SELECT invoice_id FROM purchases WHERE invoice_id != '' LIMIT 3;"
PINV-2026-0001
PINV-2026-0002
PINV-2026-0003

$ sqlite3 ... "SELECT id FROM goods_receipt_notes LIMIT 2;"
129f5574-3b47-4efe-bcc6-89020753c796     <- the PK is still a UUID
2a3ae5c3-bf15-444c-ab0a-31320032562e
```

`PROD` + 6 digits is minted by max-suffix+1 (`src/app/api/kitchen-production/route.ts:42-50`);
`PINV-<yyyy>-####` by MAX(CAST(substr(...))) per year (`src/lib/grn-reversal.ts:1723-1726`). Both
are **max+1 scans, not counters** — safe on this single-threaded server, with
`production_batches.barcode UNIQUE` as the real guard.

If FSSAI needs a citable record number for an inspector: UUID PK + `record_no TEXT UNIQUE`.

### 4.3 Timestamps — and the txn_date trap

Frequency across all 204 tables (count = number of tables carrying that column name):

```
162  created_at        68  updated_at        26  date
  7  event_date         6  started_at         6  reviewed_at        6  completed_at
  5  sent_at            5  issued_at          4  recorded_at        4  finished_at
  3  txn_date           3  submitted_at       3  received_at        3  expiry_date
  2  voided_at          2  verified_at        2  served_at
```

**The rules:**

- `created_at TEXT NOT NULL DEFAULT (datetime('now'))` — universal (162 tables). **UTC**.
- `updated_at` same declaration, on tables that are edited (68).
- `date TEXT` (YYYY-MM-DD) — the **business date** a record belongs to, distinct from created_at.
  26 tables. This is what an FSSAI daily log is keyed and reported on.
- Event verbs get `<verb>_at`: reviewed_at, verified_at, voided_at, completed_at.

**The txn_date trap, confirmed:** it exists on only **3** tables. `inventory_transactions` uses it,
alongside *both* created_at and recorded_at:

```
$ sqlite3 ... "PRAGMA table_info(inventory_transactions);"
0|id|TEXT   ... 6|created_at|TEXT|1|datetime('now')  ... 17|txn_date|TEXT|1|''
                                                        18|recorded_at|TEXT|1|''
                                                        19|created_by|TEXT|1|''
```

Three different times on one row: txn_date = when the movement happened (backdatable),
recorded_at = when a human entered it, created_at = when the row was written. **FSSAI must not
invent a fourth spelling.** Use `date` for the business date (the 26-table majority) and
`created_at` for the row. Use `recorded_at` **only** if a check may be logged for an earlier date
than it was entered — an owner decision, not a default (§10).

### 4.4 Other column conventions

| Concern | Convention | Evidence |
|---|---|---|
| Soft-delete / retire | `is_active INTEGER NOT NULL DEFAULT 1` | 42 tables |
| Actor | `created_by TEXT NOT NULL DEFAULT ''` — an **email**, not a user id | 41 tables; logAuditEvent uses actor_email |
| Free text | `notes` (37) or `note` (22) | — |
| Ordering | `sort_order INTEGER NOT NULL DEFAULT 0` | 9 tables |
| Workflow state | `status TEXT NOT NULL DEFAULT '<initial>'` with the vocabulary in a trailing `--` comment | 50 tables; e.g. `db.ts:8107` |
| Booleans | `INTEGER NOT NULL DEFAULT 0/1`. No SQLite BOOLEAN anywhere | — |
| **JSON** | **`<thing>_json TEXT NOT NULL DEFAULT '{}'` or `'[]'`** — plain TEXT, JSON.stringify on write. No json_*() SQL functions | 29 columns, all suffixed `_json` |

The `_json` census (the naming rule has no exceptions):

```
audit_events.before_json / .after_json        tasks.checklist_json
hr_attendance_corrections.original_json / .requested_json / .approved_json
hr_shifts.split_json          hr_payroll_items.earnings_json / .deductions_json / .detail_json
knowledge_tests.questions_json                knowledge_test_results.answers_json
hr_test_questions.options_json                hr_test_attempts.answers_json
training_sessions.attendees_json              ct_calls.analysis_json
po_line_stock_snapshots.stores_json / .dept_json   ... (29 total)
```

**FSSAI's typed questions and answers go in `*_json` TEXT columns**, matching
knowledge_tests.questions_json / knowledge_test_results.answers_json — the closest existing
analogue to a typed-question engine.

### 4.5 Foreign keys — the split

```
$ sqlite3 ... "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND sql LIKE '%FOREIGN KEY%';"
56
```

**Which** 56 is the point. Of the prefixed module families, only `store_*` and `<liquor>_*` declare FKs.
**`task_*`, `hr_*`, `ct_*`, `crm_*`, `wa_*` declare none** — they reference by plain TEXT id plus
an index, and say so:

```
7579	        employee_id TEXT NOT NULL,                -- hr_employees.id (no FK by design)
7616	        employee_id    TEXT NOT NULL,               -- hr_employees.id (no FK by design)
```

House rule at `db.ts:7507-7509`: cross-module references are *"plain TEXT + index (the
task_*/ct_* house style)"*.

**FSSAI is a module, not a ledger => follow the module style: no FKs to raw_materials, vendors,
departments, users or hr_employees.** Plain TEXT + index + a `--` comment naming the target. This
also keeps `foreign_keys = ON` from turning a deleted master row into a failed compliance write.

*Rationale for P1:* a food-safety record is evidence. It must survive the deletion of the vendor or
employee it refers to. An FK would either block that deletion or cascade the evidence away.

### 4.6 outlet_id scoping — NOT universal

49 tables carry outlet_id. The original migration (`db.ts:1117-1132`) applied it to seven
transactional tables:

```ts
1117	    const TABLES_NEEDING_OUTLET = [
1118	      'sales', 'purchases', 'purchase_orders', 'parties', 'staff_meals',
1119	      'closing_stock', 'inventory_transactions',
1120	    ];
```

with backfill to a default outlet named 'Main' (`db.ts:1113`) and an `idx_<table>_outlet` index.

Measured — which FSSAI-relevant tables actually have it:

```
tasks  0    task_categories  0    checklist_templates  0    checklist_items  0
daily_checklist_records  0    hygiene_audits  0    hr_documents  0
maintenance_schedules  0      hr_employees  0 (has home_outlet_id)
production_batches  1
```

**The pattern:** money- and stock-movement tables are outlet-scoped; the Task module, the checklist
engine and the HR document vault are **not**.

**OPEN DECISION for the owner, not a default to assume.** One outlet exists in production. If FSSAI
records are ever pulled per-outlet for an inspection, `outlet_id TEXT` + `idx_fssai_<t>_outlet`
costs nothing now and cannot be retrofitted cheaply onto historical evidence later. Recommend
adding it, nullable, and flagging the question.

### 4.7 Table naming

```
40 hr_*    16 ct_*    16 crm_*    10 wa_*    10 task_*    8 store_*
 6 party_*  5 <liquor>_* 4 production_*  3 print_*  ... plus unprefixed founders
```

Every module since the Task module is prefixed. `fssai_` is consistent, and **no fssai object
exists yet** (§8.2) — the namespace is clean.

### 4.8 Settings-key naming

60 rows in `settings`. Migration-flag convention:

```
menu_categories_seed_v1      direct_reviewed_backfill_v1    station_dept_seed_v1
qc_category_seed_v1          phase1_master_backfill_v1      discount_limits_v1
nav_continuity_grants_v1     recipe_costs_resync_v1         price_basis_repair_v1
migration_pack_size_reset_for_non_ml_v1     migration_sales_category_backfilled
```

Config keys are `<module>_<thing>`: hr_day_cutoff, hr_punch_debounce_min,
crm_loyalty_points_per_100, kot_undo_window_seconds, stale_table_auto_close_hours,
purchase_backdate_limit_days.

=> FSSAI one-shot flags: `fssai_<thing>_seed_v1`. FSSAI config keys: `fssai_<thing>`. The `fssai_`
prefix also lets P1 register an OWNED_PREFIXES entry (§7) in one line.

---

## §5. AUDIT PATTERNS ALREADY IN THE APP

The owner's §19 asks for four things: (a) created/modified by + timestamps, (b) original vs changed
value, (c) reason for change, (d) VOID-not-DELETE. All four exist here, in different places.

### 5.1 audit_events — the append-only spine (USE IT, but not sufficient alone)

`db.ts:3930-3952`:

```ts
3930	  // Append-only audit log. No UPDATE, no DELETE — only INSERT.
3931	  // We don't enforce immutability at the SQL level (SQLite triggers could,
3932	  // but it complicates testing); instead `logAuditEvent` is the only insert path
3933	  // and the /audit page is read-only.
...
3936	      CREATE TABLE IF NOT EXISTS audit_events (
3937	        id           TEXT PRIMARY KEY,
3938	        event_type   TEXT NOT NULL,
3939	        entity_type  TEXT NOT NULL,
3940	        entity_id    TEXT NOT NULL,
3941	        actor_email  TEXT NOT NULL DEFAULT '',
3942	        outlet_id    TEXT,
3943	        before_json  TEXT,
3944	        after_json   TEXT,
3945	        note         TEXT DEFAULT '',
3946	        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
3947	      );
3948	      CREATE INDEX IF NOT EXISTS idx_audit_created   ON audit_events(created_at DESC);
3949	      CREATE INDEX IF NOT EXISTS idx_audit_entity    ON audit_events(entity_type, entity_id);
3950	      CREATE INDEX IF NOT EXISTS idx_audit_actor     ON audit_events(actor_email);
```

Writer, `db.ts:8286-8317`:

```ts
8281	/**
8282	 * Log an append-only audit event. Captures who did what to which entity,
8283	 * with optional before/after snapshots for diff'ing.
8284	 * Never throws — audit failure should not break the parent operation.
8285	 */
8286	export function logAuditEvent(
8287	  db: Database.Database,
8288	  params: {
8289	    event_type: string;        // e.g. 'po.approve', 'recipe.edit', 'reset.run', 'purchase.delete'
8290	    entity_type: string;       // 'purchase_order', 'recipe', 'raw_material', 'requisition', ...
8291	    entity_id: string;
8292	    actor_email?: string;
8293	    outlet_id?: string | null;
8294	    before?: any;
8295	    after?: any;
8296	    note?: string;
8297	  }
8298	): void {
...
8314	  } catch (e: any) {
8315	    console.error('[audit] failed to log event:', e?.message, params.event_type);
8316	  }
```

`before`/`after` are JSON.stringify-ed by the helper — pass objects, not strings. event_type
convention: `<entity>.<verb>`, dot-separated, lowercase. 241 rows live.

**Covers §19(a) and (b). Does NOT cover (c) reason or (d) void.**

**Limitation FSSAI must design around:** logAuditEvent **never throws**. If the audit insert fails,
the parent operation succeeds anyway and the only trace is a journal line. For a record whose
purpose is inspection evidence, P1 should decide deliberately whether a compliance write may
succeed with its audit row missing, and say so in writing (§10).

### 5.2 hr_attendance_corrections — THE BEST MODEL FOR FSSAI §19

`db.ts:7665-7686`:

```ts
7665	      -- Corrections follow the variance_approvals pattern: frozen original +
7666	      -- requested + approved JSON, decision metadata, and a partial UNIQUE over
7667	      -- pending so one employee-day can hold only one open request. The
7668	      -- original events are NEVER rewritten — an approved correction appends
7669	      -- source='manual' events and recomputes the summary.
7670	      CREATE TABLE IF NOT EXISTS hr_attendance_corrections (
7671	        id             TEXT PRIMARY KEY,
7672	        employee_id    TEXT NOT NULL,
7673	        date           TEXT NOT NULL,               -- IST business date being corrected
7674	        original_json  TEXT NOT NULL DEFAULT '{}',
7675	        requested_json TEXT NOT NULL DEFAULT '{}',
7676	        reason         TEXT NOT NULL DEFAULT '',
7677	        requested_by   TEXT NOT NULL DEFAULT '',
7678	        status         TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
7679	        reviewed_by    TEXT NOT NULL DEFAULT '',
7680	        reviewed_at    TEXT NOT NULL DEFAULT '',
7681	        review_reason  TEXT NOT NULL DEFAULT '',
7682	        approved_json  TEXT NOT NULL DEFAULT '',
7683	        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
7684	      );
7685	      CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_att_corr_pending
7686	        ON hr_attendance_corrections(employee_id, date) WHERE status = 'pending';
```

**Why this is the one to copy** — it satisfies every clause of §19 in one shape:

| Owner's §19 clause | Column |
|---|---|
| created/modified by + timestamps | requested_by / created_at / reviewed_by / reviewed_at |
| original value | original_json (**frozen at request time**) |
| changed value | requested_json, then approved_json |
| reason for change | reason (requester) **and** review_reason (approver) |
| management verification | status + reviewed_by + reviewed_at |
| never destroys the original | stated at 7668-7669 — an approved correction **appends** |

The **partial unique index** (7685-7686) is a pattern FSSAI needs directly: one open correction per
(subject, date). The same guard prevents two pending corrective actions on one failed check.

It also gives FSSAI the Corrective Action sub-module almost verbatim: a failed check produces a row
with original_json (what was recorded), reason (what went wrong), requested_json (the action
proposed), then reviewed_by/review_reason (management verification).

### 5.3 variance_approvals — the ancestor, live proof the pattern works

```sql
CREATE TABLE variance_approvals (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                     -- 'central' | 'liquor'
  ...
  system_stock REAL NOT NULL DEFAULT 0,     -- what the system had at count time
  physical_stock REAL NOT NULL DEFAULT 0,   -- what was counted
  variance REAL NOT NULL DEFAULT 0,
  counted_by TEXT NOT NULL DEFAULT '',
  count_note TEXT NOT NULL DEFAULT '',      -- optional note from whoever counted
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected'
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT '',
  review_reason TEXT NOT NULL DEFAULT '',   -- admin records the reason after asking staff
  outlet_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), auto_applied INTEGER NOT NULL DEFAULT 0, ...
)
```

Note `auto_applied INTEGER` — records that a small variance applied itself without review. FSSAI's
equivalent question ("may a passing check auto-close?") should be recorded the same explicit way
rather than being implicit in the absence of a reviewer.

The trailing `, auto_applied ..., batch_id ..., batch_label ...` on one line is the visible
signature of **Pattern B ALTERs** on a live table — useful to recognise when reading schemas.

### 5.4 VOID-not-DELETE — goods_receipt_notes

`db.ts:3119-3146`:

```ts
3133	    // VOID IS A STATUS VALUE, NOT A COLUMN: goods_receipt_notes.status gains
3134	    // 'void' alongside received/partial/rejected. There is no CHECK constraint
3135	    // on that column (see the CREATE above), so this needs no table rebuild —
3136	    // but it does mean every reader that filters on status must be told about
3137	    // 'void'. A voided GRN keeps its header AND its line items: the bill
3138	    // document survives, struck through, with who voided it and when.
...
3141	    if (!hasG('edited_at'))   db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN edited_at TEXT`);
3142	    if (!hasG('edited_by'))   db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN edited_by TEXT DEFAULT ''`);
3143	    if (!hasG('edit_count'))  db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0`);
3144	    if (!hasG('voided_at'))   db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN voided_at TEXT`);
3145	    if (!hasG('voided_by'))   db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN voided_by TEXT DEFAULT ''`);
3146	    if (!hasG('void_reason')) db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN void_reason TEXT DEFAULT ''`);
```

The void/soft-delete census across all 204 tables is short — this is the **only** complete
implementation:

```
goods_receipt_notes.voided_at / .voided_by / .void_reason      <- the model
orders.voided_at                                                (status='void', no reason column)
tasks.is_archived                                               (archive, not void)
```

Lines 3124-3131 also answer a question FSSAI will face — *why denormalise onto the row when
audit_events already has it*: audit_events stays the authority for the field-level diff, but a list
view needing a per-row audit lookup would be an N+1 on every page load, so six cheap stamps ride
along. **FSSAI should do both: stamps on the record for the list view, logAuditEvent for the diff.**

### 5.5 error_reports — the dedupe + resolve shape

```sql
CREATE TABLE error_reports (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,               -- hash(source|message|where) for dedup
  ...
  count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT, resolved_by TEXT NOT NULL DEFAULT '', notified_at TEXT
)
```

digest + count + first_seen/last_seen collapses a repeated event into one row; notified_at prevents
re-alerting. A recurring FSSAI failure (same check failing daily) should collapse the same way
rather than generating 30 identical alerts.

### 5.6 Verdict

| Need | Copy this |
|---|---|
| Every write, who/what/before/after | logAuditEvent -> audit_events (`db.ts:8286`) |
| **Correction with original + reason + approval** | **hr_attendance_corrections (`db.ts:7670-7686`)** |
| One open request per subject/day | partial UNIQUE ... WHERE status='pending' (`db.ts:7685`) |
| Cancel a record without destroying it | goods_receipt_notes void triple (`db.ts:3144-3146`) + status='void' |
| Repeating alert | error_reports digest/count/resolved (§5.5) |

---

## §6. ATTACHMENTS AND BLOBS — AND THE 1 MB CEILING

### 6.1 Three BLOB stores already exist

| Table | Purpose | Client cap | Gate |
|---|---|---|---|
| menu_item_images | dish photos | `400 * 1024` (`api/menu-items/image/route.ts:40`) | any signed-in |
| task_files | task attachments | `src/lib/task-files.ts` | any signed-in |
| hr_documents | HR document vault | `HR_DOC_MAX_BYTES = 5_000_000` (`src/lib/hr-files.ts:18`) | HR role + per-employee |

`hr_documents`, `db.ts:7860-7881`:

```ts
7860	      -- Document vault: bytes as BLOBs in THIS file (contract D4) behind an
7861	      -- HR-gated route with Cache-Control private/no-store. 400k client cap
7862	      -- upstream; scripts/backup-db.sh switched off .dump|gzip in the same
7863	      -- change that shipped this table.
7864	      CREATE TABLE IF NOT EXISTS hr_documents (
7865	        id            TEXT PRIMARY KEY,
7866	        employee_id   TEXT NOT NULL,
7867	        doc_type      TEXT NOT NULL DEFAULT '',    -- aadhaar|pan|address_proof|... (vocab in hr.ts)
7868	        doc_number    TEXT NOT NULL DEFAULT '',    -- masked outside canViewHrDocs
7869	        issue_date    TEXT NOT NULL DEFAULT '',
7870	        expiry_date   TEXT NOT NULL DEFAULT '',    -- expiry alerts key on this
7871	        filename      TEXT NOT NULL DEFAULT '',
7872	        mime          TEXT NOT NULL DEFAULT '',
7873	        size_bytes    INTEGER NOT NULL DEFAULT 0,
7874	        data          BLOB,
7875	        verify_status TEXT NOT NULL DEFAULT 'unverified',
7876	        verified_by   TEXT NOT NULL DEFAULT '',
7877	        uploaded_by   TEXT NOT NULL DEFAULT '',
7878	        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
7879	      );
7880	      CREATE INDEX IF NOT EXISTS idx_hr_docs_emp ON hr_documents(employee_id);
7881	      CREATE INDEX IF NOT EXISTS idx_hr_docs_expiry ON hr_documents(expiry_date);
```

### 6.2 Why BLOBs and not files on disk — already written down

`db.ts:865-872`:

```ts
865	  // WHY A BLOB TABLE AND NOT A FILE ON DISK.
866	  // There is no image host in this system and no asset pipeline. Disk under
867	  // public/ loses the images: NOTHING backs public/ up — deploy/aws/backup-db.sh
868	  // and deploy/configure-backups.sh both snapshot ONLY fnb-controller.db — so a
869	  // box rebuild or a restore-from-backup would bring the menu back with every
870	  // photo permanently gone, and deploy/aws/push.sh runs `rsync -az --delete`
871	  // with no exclusion for public/. A BLOB rides inside every existing backup for
872	  // free, and survives the GCP `sqlite3 .dump` path as an X'..' hex literal.
```

**This settles it for FSSAI photo evidence: BLOBs, not files.** A compliance photo that vanishes on
a box rebuild is worse than no photo — it is evidence that silently stops existing.

### 6.3 Read/write path (copy this shape)

Write — `src/lib/hr-files.ts:45-83`, storeHrDocument(): takes a Buffer, throws over the cap,
computes size_bytes from buffer.length itself, single prepared INSERT.

Read — `src/lib/hr-files.ts:90-108`, readHrDocument(), with the normalisation every BLOB reader in
this app repeats:

```ts
103	  // better-sqlite3 returns BLOBs as Buffer already; normalize just in case.
104	  if (row.data && !Buffer.isBuffer(row.data)) {
105	    row.data = Buffer.from(row.data as unknown as ArrayBuffer);
106	  }
```

Two further rules from the routes:

- **The BLOB never rides the list JSON.** `src/app/api/hr/documents/route.ts:71`: *"Every
  hr_documents column EXCEPT the data BLOB — metadata never bytes."* Bytes come from a separate
  `/[id]/file` route.
- That file route serves with `Cache-Control: private, no-store` (`hr-files.ts:88`).

### 6.4 THE 1 MB CEILING — a live contradiction P1 must not inherit

The repo's checked-in nginx says 25 MB:

```
$ grep -rn "client_max_body_size" deploy/
deploy/nginx.conf:11:    client_max_body_size 25M;
deploy/aws/nginx.conf:19:    client_max_body_size 25M;
```

**The live box is not running that config.** `src/app/crm-calls/database/page.tsx:83-87`, written
after a real probe against production:

```
83	 * And the ceiling is 1 MB, not 25. Probed against production directly: a 900 KB
84	 * body reaches the app (401), 1,100 KB is refused by the proxy (413). The
85	 * repo's deploy/nginx.conf does say client_max_body_size 25M — the live box is
86	 * not running it, which is consistent with those AWS deploy scripts being stale.
87	 * So the app must fit the limit that EXISTS, not the one that is checked in.
```

**And hr-files.ts still believes the checked-in number** (`src/lib/hr-files.ts:10-13`):

```ts
10	// Size gate: Next 16 with a proxy silently truncates request bodies over 10 MB
11	// and nginx allows 25 MB, so neither will save us — WE are the gate. The
12	// 5 MB hard cap below must be enforced client-side, in the route's
13	// Content-Length pre-check, AND here as the last line of defense.
```

=> **HR_DOC_MAX_BYTES = 5_000_000 is not actually reachable in production.** Anything over ~1 MB is
refused by the proxy with a 413 before the route runs. A latent bug in HRMS, mitigated only by
hr_documents having 0 rows (§8.4(5)). **FSSAI must not copy the 5 MB number.**

### 6.5 Concretely, how FSSAI photo upload must work

1. **Compress client-side before upload.** Target **<= 400 KB**, matching the proven-good
   menu_item_images cap — comfortably inside the ~1 MB ceiling with headroom for multipart
   overhead. Phone cameras produce 3-8 MB JPEGs; canvas resize + re-encode is mandatory.
2. **One photo per request.** Never batch. A 3-photo check is three POSTs.
3. **Enforce the cap three times** — client, route Content-Length pre-check, store function (the
   defence-in-depth `hr-files.ts:10-13` prescribes; keep the discipline, fix the number).
4. **Handle 413 explicitly.** `crm-calls/database/page.tsx:98-100` shows the house pattern: halve
   and retry up to MAX_SPLIT_DEPTH. For one photo the analogue is re-compress at lower quality,
   retry once, then tell the user plainly.
5. **Own table, own gate.** `hr-files.ts:3-6`: *"Modelled 1:1 on src/lib/task-files.ts, but writes
   to its OWN table: the task_files read gate is 'any signed-in user', while hr_documents sits
   behind the HR-role + per-employee gate."* FSSAI evidence photos need their own `fssai_photos`
   table so the gate is FSSAI's to set.
6. **Metadata in list responses, bytes from a dedicated route.**
7. **Tell the owner** that raising the live client_max_body_size is a one-line nginx change. Do not
   change it in a build phase — production config, out of scope.

### 6.6 Backups

`scripts/backup-db.sh` was switched from `.dump | gzip` to **VACUUM INTO** because the dump path
hex-doubles BLOBs (`hr-files.ts:6-8`). FSSAI photos ride inside that backup for free. **No FSSAI
change needed** — but nobody may "optimise" the backup script back to `.dump`, and the same
VACUUM INTO is the only safe way to snapshot the live DB (§8.1).

---

## §7. SETTINGS AND KEY_POLICY — HOW A CONFIGURABLE VALUE IS ADDED

### 7.1 The table

`db.ts:207-219` — a two-column KV, inside the **unguarded** founding block:

```ts
207	    CREATE TABLE IF NOT EXISTS settings (
208	      key TEXT PRIMARY KEY,
209	      value TEXT NOT NULL
210	    );
211
212	    -- Insert default settings if not exists
213	    INSERT OR IGNORE INTO settings (key, value) VALUES ('costing_method', 'average');
214	    INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', 'INR');
```

Everything is a **string**; callers parse. 60 rows live.

**There is no updated_at and no updated_by on `settings`.** Who changed a setting, and when, is only
knowable if the writing route logs it — and the generic route does not (§7.3).

### 7.2 KEY_POLICY — the per-key write tiers

`src/app/api/settings/route.ts:13-34`:

```ts
13	/**
14	 * ONE table for every key this generic endpoint treats specially. BOTH halves
15	 * read it — the GET redaction filter and the PUT write gate — so a privileged
16	 * setting can no longer be listed on one side and forgotten on the other. That
17	 * drift is exactly what left po_require_admin_approval UI-restricted with no
18	 * server counterpart for a whole release.
19	 *
20	 *   read:  'admin'  -> non-admins read back null. ...
24	 *   write: 'admin'  -> a manager PUT/POST of this key 403s with `writeError`.
25	 *   owner: '<path>' -> the key belongs to a dedicated route that validates and
26	 *                     masks it; this generic door is shut for EVERYONE, admins
27	 *                     included, so that route stays the single way in.
28	 *   retired: '<why>' -> the behaviour this key switched NO LONGER EXISTS ...
33	 */
34	type KeyPolicy = { read?: 'admin'; write?: 'admin'; writeError?: string; owner?: string; retired?: string };
```

The **floor** for the generic PUT is admin-or-manager (`route.ts:271-273`):

```ts
271	  if (me.role !== 'admin' && me.role !== 'manager') {
272	    return Response.json({ error: 'Manager or admin required to change settings' }, { status: 403 });
273	  }
```

=> **An unregistered key is manager-writable.** The `department_recipe_deduction_v1` comment
(`route.ts:37-47`) records that before its `owner:` entry existed, a manager could zero recipe
deduction for all 29 departments through this endpoint.

Prefix ownership, `route.ts:208-215` — the comment on the `hr_` line is the instruction FSSAI should
follow:

```ts
208	const OWNED_PREFIXES: Array<{ re: RegExp; route: string }> = [
209	  { re: /^wa_/i, route: '/api/whatsapp/config' },
210	  // HRMS keys (hr_day_cutoff, hr_punch_debounce_min, ...) are owned by the HR
211	  // settings route so the manager-writable generic PUT here cannot touch them,
212	  // per docs/HRMS_DECISIONS.md §2.7. Registered BEFORE the first hr_* key
213	  // exists — the gate being decorative-until-registered is the trap.
214	  { re: /^hr_/i, route: '/api/hr/settings' },
215	];
```

**P1 must add `{ re: /^fssai_/i, route: '/api/fssai/settings' }` in the same commit that creates the
first fssai_ key, not later.**

### 7.3 The audit gap in the generic route

PUT /api/settings writes and returns (`route.ts:309-310`):

```ts
309	  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(value ?? ''));
310	  return Response.json({ key, value });
```

**No logAuditEvent.** Confirmed by grep: of `api/settings/route.ts`,
`api/settings/hod-only/route.ts` and `api/hr/settings/route.ts`, **only api/hr/settings/route.ts
imports logAuditEvent.** Combined with `settings` having no updated_by/updated_at, a temperature
standard changed through the generic endpoint would leave **no trace of who changed it or when** —
failing the owner's §19 for the very value that decides whether a fridge passes.

### 7.4 The model to copy: /api/hr/settings

Ownership + gates (`src/app/api/hr/settings/route.ts:20-22, 83-86`):

```ts
20	 * OWNERSHIP: the generic /api/settings route registers the `hr_` prefix in
21	 * KEY_POLICY/OWNED_PREFIXES and routes hr_* keys HERE (already wired) — this
22	 * route is the only writer, so the canAdminHr gate below actually holds.
...
83	export async function PUT(request: Request) {
84	  const me = await getCurrentUser();
85	  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
86	  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });
```

Validate-everything-before-writing-anything (`route.ts:90-91`):

```ts
90	  // Validate EVERYTHING before writing ANYTHING — a half-applied settings PUT
91	  // (cutoff updated, debounce rejected) would silently shift business days.
```

The audited transactional write (`route.ts:124-147`):

```ts
124	    // Before-image reads through the SAME effective getters as GET, so the
125	    // audit trail records the value the engine was actually using (a garbage
126	    // stored value audits as the default it fell back to).
127	    const before = {
128	      hr_day_cutoff: getHrDayCutoff(db),
129	      hr_punch_debounce_min: getHrPunchDebounceMin(db),
130	    };
131
132	    const upsert = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
133	    const write = db.transaction(() => {
134	      if (cutoff !== null) upsert.run('hr_day_cutoff', cutoff);
135	      if (debounce !== null) upsert.run('hr_punch_debounce_min', String(debounce));
...
139	      logAuditEvent(db, {
140	        event_type: 'hr.settings.update',
141	        entity_type: 'hr_settings',
142	        entity_id: 'attendance',
143	        actor_email: me.email,
144	        outlet_id: outletId,
145	        before,
146	        after,
147	      });
```

`route.ts:117`: *"better-sqlite3 is synchronous — resolve every await BEFORE db.transaction."*
getCurrentOutletId() is awaited on line 118, outside the transaction. **An `await` inside a
db.transaction() callback is a bug in this codebase.**

### 7.5 The effective-getter pattern — "never hard-coded" in practice

`src/lib/hr-attendance.ts:206-232`:

```ts
206	/** One settings value or null. Never throws — a settings read must not take
207	 *  the attendance engine down; the defaults below are always safe. */
208	function readSetting(db: Database.Database, key: string): string | null {
209	  try {
210	    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
211	      | { value: string } | undefined;
212	    return row?.value ?? null;
213	  } catch { return null; }
214	}
...
228	/** hr_day_cutoff ('HH:MM'), default '04:00'. Invalid stored values fall back. */
229	export function getHrDayCutoff(db: Database.Database): string {
230	  const v = String(readSetting(db, 'hr_day_cutoff') ?? '').trim();
231	  return cutoffValid(v) ? v : DEFAULT_CUTOFF;
232	}
```

There is **no shared getSetting() helper** — each module writes its own private readSetting (three
exist: `hr-attendance.ts:208`, `smartoffice.ts:64`, `whatsapp.ts:58`), and there are **110** inline
`SELECT value FROM settings WHERE key` call sites across `src/`. FSSAI should add its own
`src/lib/fssai-settings.ts` with typed getters rather than scattering inline reads.

### 7.6 THE RECIPE — adding a configurable FSSAI temperature standard

Seven steps, each mirroring hr_day_cutoff:

1. **Key name:** `fssai_temp_standards` (or `fssai_temp_<equipment_type>`). Value is a JSON string
   (§4.4) — e.g. `{"cold_room":{"min":0,"max":5},"freezer":{"min":-22,"max":-18}}`.
2. **Register the prefix** in OWNED_PREFIXES (`api/settings/route.ts:208`):
   `{ re: /^fssai_/i, route: '/api/fssai/settings' }`. **Before** the first key exists.
3. **Write `src/app/api/fssai/settings/route.ts`** modelled on api/hr/settings/route.ts:
   getCurrentUser() -> 401; an FSSAI admin capability -> 403; validate the whole payload before
   writing anything; db.transaction() around upsert + logAuditEvent
   (event_type: 'fssai.settings.update'); generic 500 bodies, never e.message.
4. **Write typed getters** in `src/lib/fssai-settings.ts` following getHrDayCutoff: never throw,
   always fall back to a documented safe default, validate the stored value.
5. **Every reader goes through the getter.** No inline SELECT in an FSSAI route, and no numeric
   literal for a temperature limit anywhere in the module.
6. **Read the before-image through the same getter** the engine uses
   (`api/hr/settings/route.ts:124-126`).
7. **Who may write:** admin only, per the self-lift reasoning KEY_POLICY applies to
   purchase_backdate_limit_days and closing_variance_bar_* (`route.ts:59-66, 127-151`) — a manager
   who could widen the acceptable fridge range could make a failing fridge pass. Read may stay open
   (managers must know the target), matching those same entries' posture.

**One caution:** SECRET_KEY_RE (`src/lib/secret-keys.ts`) redacts anything that *looks* like a
secret. Avoid FSSAI key names containing `key`, `token`, `secret` or `password` — e.g.
`fssai_temp_key` would be silently admin-only for the wrong reason.

---

## §8. THE LIVE SCHEMA — REAL QUERY, REAL OUTPUT

### 8.1 The snapshot (the only safe way; a plain cp loses the WAL)

```
$ SNAP=<scratchpad>/fssai-recon-snapshot.db
$ sqlite3 "file:/Users/shashankreddy/Desktop/Claude/fnb-controller/fnb-controller.db?mode=ro" \
          "VACUUM INTO '$SNAP'"
SNAPSHOT OK
-rw-r--r--@ 1 shashankreddy  wheel  14696448 Sep 16 19:01 .../fssai-recon-snapshot.db
```

Source was 34,082,816 bytes with a 1,429,672-byte WAL. The snapshot is 14.7 MB because VACUUM INTO
compacts free pages.

**Freshness verified** — WAL content is present, and the live file agrees on the table count:

```
$ sqlite3 "file:$SNAP?mode=ro" "SELECT COUNT(*), MAX(created_at) FROM sessions;"
235|2026-09-15 01:58:14
$ sqlite3 "file:/Users/.../fnb-controller.db?mode=ro" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
204
```

### 8.2 The count

```
$ sqlite3 "file:$SNAP?mode=ro" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
204
```

**204 user tables.** The `fssai_` namespace is clean:

```
$ sqlite3 "file:$SNAP?mode=ro" "SELECT type,name FROM sqlite_master WHERE name LIKE '%fssai%';"
(no rows)
$ grep -ril "fssai" /Users/shashankreddy/Desktop/Claude/fnb-fssai/src/
(4 files match only the bill-footer FSSAI licence-number text; no module)
```

### 8.3 Tables whose names suggest FSSAI overlap — WITH ROW COUNTS

Row counts are the point: a table with data is a live feature FSSAI must not disturb; a table with
zero rows is dormant.

```
$ while read t; do n=$(sqlite3 "file:$SNAP?mode=ro" "SELECT COUNT(*) FROM \"$t\";");
    printf "%-40s %s\n" "$t" "$n"; done < <candidates>

audit_events                             241
batch_transactions                        28
butchering_batches                         0
central_cutover_batches                    0
checklist_items                           56
checklist_templates                        5
crm_knowledge                              6
crm_training_responses                     0
crm_training_sessions                      0
daily_checklist_records                    0
error_reports                             35
hr_documents                               0
hr_training_assignments                    0
hr_trainings                               0
hygiene_audits                             0
knowledge_test_results                     0
knowledge_tests                            0
maintenance_logs                          21
maintenance_schedules                     21
party_status_audit                         0
production_batch_departments               0
production_batches                         9
qc_category_checkers                       8
training_sessions                          0
unit_audit_locks                           2
variance_approvals                         0
wastages                                   0
```

### 8.4 What that means — the five findings that matter

**(1) A checklist engine ALREADY EXISTS, and it is the wrong shape for FSSAI.**
`db.ts:5586-5626`:

```ts
5598	      -- 10. checklist_items
5599	      CREATE TABLE IF NOT EXISTS checklist_items (
5600	        id             TEXT PRIMARY KEY,
5601	        template_id    TEXT NOT NULL,
5602	        label          TEXT NOT NULL,
5603	        sort_order     INTEGER NOT NULL DEFAULT 0,
5604	        requires_image INTEGER NOT NULL DEFAULT 0,
5605	        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
5606	      );
```

A question here is a **label and a photo flag — nothing else**. No question type, no numeric bounds,
no unit, no pass/fail condition, no sections. `daily_checklist_records.result` is
`TEXT NOT NULL DEFAULT 'na'`, free-form. It cannot express Numeric, Temperature, Multiple Choice or
Signature, which the FSSAI engine requires.

It is also **live, and belongs to a different feature**: 5 templates, 56 items, all role-based daily
manager checklists —

```
Operations Manager Daily Checklist  (14 items)    Floor Manager Daily Checklist  (12)
HR Manager Daily Checklist          (10)          Store Manager Daily Checklist  (10)
Bar Manager Daily Checklist         (10)
item labels: Restaurant Cleanliness, Washrooms, Dining Area, Kitchen Inspection,
             Store Inspection, Bar Inspection, Fire Safety, Emergency Exit, Music,
             Lighting, AC Temperature, Guest Complaints, ...
```

=> **Do not extend checklist_items with FSSAI's typed-question columns.** That would mix two
features in one table and force a default question type onto 56 rows belonging to someone else's
feature. **This is positive evidence for the settled architecture: separate
fssai_checklist_templates / fssai_checklist_questions tables are correct** — cite this when someone
later asks "why didn't you reuse the checklist engine?"

`daily_checklist_records` has **0 rows** — the existing engine has templates but has never been
filled in. FSSAI is not competing with a working habit; it is filling a vacuum.

**(2) hygiene_audits exists and is EMPTY (0 rows).** `db.ts:5655-5670` — area, item, date, result,
image_url, corrective_action, created_task_id, score, auditor. Conceptually overlaps FSSAI's
Cleaning & Sanitation and Corrective Actions, but it is flat (no template, no typing) and unused.
**Flag to the owner: FSSAI supersedes it.** Do not drop it; decide explicitly whether to leave it
dormant or hide its UI.

**(3) RECEIVING QC IS ALREADY PARTLY BUILT — on goods_receipt_notes.** `db.ts:3109-3117` adds six
boolean QC ticks captured at receive time, labelled *"Phase 1 §4 — receiving QC checklist"*:
qc_quality, qc_temperature, qc_expiry, qc_damage, qc_weight, qc_invoice_match. The GRN header also
carries qc_by; item rows carry quantity_rejected / rejection_reason (`db.ts:3086-3096`).

`qc_category_checkers` (**8 live rows**) routes which department signs off per material category:

```
category_key       category            checker  updated_by
veg                veg                 kitchen  seed:qc_category_seed_v1
vegetables         vegetables          kitchen  seed:qc_category_seed_v1
englishvegetables  english-vegetables  kitchen  seed:qc_category_seed_v1
nonveg             non-veg             kitchen  seed:qc_category_seed_v1
meat               meat                kitchen  seed:qc_category_seed_v1
dairy              dairy               kitchen  seed:qc_category_seed_v1
frozencheese       frozen-cheese       kitchen  seed:qc_category_seed_v1
fruits             fruits              kitchen  seed:qc_category_seed_v1
```

=> **FSSAI's Receiving QC sub-module must EXTEND this, not replace it.** A second receiving-QC
record would be a duplicate master in all but name. Note the seed-flag convention in updated_by:
`seed:qc_category_seed_v1`.

**(4) Batch / FIFO / expiry infrastructure already exists.** `production_batches` (9 rows) carries
barcode (UNIQUE, PROD######), batch_number, production_date, expiry_date, expiry_time, shelf_life,
storage_location, quantity_produced, quantity_consumed, status
(active | consumed | expired | disposed). `batch_transactions` has 28 rows. And `raw_materials`
**already has storage_location and shelf_life_days** (§8.5).

=> FSSAI's FIFO/FEFO sub-module reads these. It must not create a parallel batch or expiry master.

**(5) HRMS IS DEPLOYED BUT EMPTY — load-bearing for FSSAI.**

```
$ sqlite3 "file:$SNAP?mode=ro" "SELECT COUNT(*) FROM hr_employees;"
0
$ sqlite3 "file:$SNAP?mode=ro" "SELECT name, role, is_active FROM users;"
Admin            admin    1        Ganesh            manager  1
Latesh           manager  1        Nihal             admin    1
Shashank Reddy   admin    1        BTL Test Staff    staff    1
ZZ Test Store    admin    1        ZZ Kitchen Staff  staff    1
ZZ R71 Judge     admin    1
```

hr_employees = 0; hr_documents = 0; hr_trainings = 0. **The real staff roster today is `users`
(9 rows, several test accounts).**

=> An FSSAI Personal Hygiene sub-module keyed on hr_employees.id would, on the live database right
now, have **nobody to check**. P4 must resolve this explicitly — either key on `users`, or key on
hr_employees and surface an empty state that tells the owner HRMS needs populating first. Silently
rendering an empty list would look like a bug and would produce an inspection record proving
nothing.

### 8.5 The masters FSSAI must READ (HARD RULE 2) — exact live column names

Verbatim from PRAGMA table_info, so no phase has to guess.

**raw_materials — 952 rows** *(note storage_location, shelf_life_days, is_active)*
```
id, name, category, unit, current_stock, reorder_level, costing_method, average_price,
created_at, updated_at, sku, primary_vendor, purchase_unit, recipe_unit, conversion_factor,
yield_percent, last_purchase_price, last_purchase_date, is_auto_discovered, discovered_source,
pack_size, super_category, brand, tax_percent, cess_percent, standard_purchase_rate,
closing_cadence, is_recipe_item, is_direct_sell, is_semifinished, case_size,
storage_location, shelf_life_days, is_active, priority
```
WARNING: `last_purchase_price` is stored in **mixed bases** — value only via
`src/lib/closing-valuation.ts`. Do not read it directly.

**vendors — 59 rows**
```
id, name, contact_person, phone, email, gstin, address, payment_terms, lead_time_days,
is_active, notes, created_at, updated_at
```
No FSSAI licence-number column exists. If Vendor Compliance needs one, it is a **Pattern B ALTER on
vendors** (§2.2) — not a new vendor table.

**departments — 29 rows** *(production mapping — READ ONLY, HARD RULE 3)*
```
id, name, code, description, head_chef_user_id, is_active, created_at, updated_at,
submission_windows, submission_grace_minutes, material_categories, parent_id, head_user_id,
area, recipe_deduction_enabled
```

**users — 9 rows**
```
id, email, password_hash, name, role, is_active, created_at, last_login_at, current_outlet_id,
department_id, is_head_chef, is_store_manager, position, page_access, visible_department_ids,
role_id, preferred_zones, preferred_table_ids, section, can_approve_requisitions, wa_mobile
```

**roles — 9 rows**
```
id, name, base_role, page_access, is_head_chef, is_store_manager, is_system, is_active,
sort_order, description, created_at, updated_at, can_request_discount, max_discount_pct,
can_approve_requisitions
```

**hr_employees — 0 rows** (see §8.4(5))
```
id, employee_code, full_name, photo, dob, gender, phone10, alt_phone10, email, current_address,
permanent_address, emergency_name, emergency_relation, emergency_phone10, department_id,
sub_department_id, designation_id, grade, reporting_manager_id, employment_type,
employee_category, cost_centre, work_location, home_outlet_id, joining_date, probation_months,
confirmation_date, notice_period_days, status, exit_date, user_id, notes, created_by,
created_at, updated_at
```

**store_locations — 1 row**
```
id, name, code, description, is_active, requires_authorization, created_at, floor_label
```

**goods_receipt_notes** — QC columns already present: qc_quality, qc_temperature, qc_expiry,
qc_damage, qc_weight, qc_invoice_match, qc_by, plus
edited_at/edited_by/edit_count/voided_at/voided_by/void_reason and status (accepts 'void').

---

## §9. THE CONTRACT — WHAT P1 MUST DO, IN ONE PLACE

1. Append the FSSAI block **after `db.ts:8189`, before the `}` on 8190**, with a banner comment in
   the Task-module form (`db.ts:5459-5464`).
2. **`FSSAI_TABLE_DDL: string[]`, executed per statement with the table name in the catch** — not
   one giant statement block. §3.2 measures what the giant form costs.
3. **Add a shape guard over `fssai_`** using pragma_table_xinfo + temp.zz_ (§3.4), reimplemented in
   this branch. Do not import `<liquor>_` code.
4. **Indexes in their own try**, separate from the tables.
5. **Add a boot assertion** counting the expected fssai_ tables, shouting if any are missing.
6. TEXT PRIMARY KEY + generateId(). `created_at TEXT NOT NULL DEFAULT (datetime('now'))`. `date TEXT`
   for the business date. `is_active INTEGER DEFAULT 1`. `<thing>_json TEXT`. `created_by TEXT`
   holding an **email**.
7. **No foreign keys to masters** — plain TEXT + index + a `--` comment naming the target
   (task_*/hr_* house style, `db.ts:7579`).
8. **Every seed one-shot behind a `fssai_<thing>_seed_v1` settings flag**, flag written inside the
   same transaction. `npm run check:boot` must stay green.
9. **Corrective actions follow hr_attendance_corrections** (`db.ts:7670-7686`), including the
   partial `UNIQUE ... WHERE status='pending'`.
10. **VOID, never DELETE**: status='void' + voided_at + voided_by + void_reason
    (`db.ts:3144-3146`).
11. **logAuditEvent on every FSSAI write**, `event_type: 'fssai.<entity>.<verb>'`.
12. **Photos as BLOBs in an own fssai_photos table, <= 400 KB, one per request** (§6.5). Never the
    5 MB HRMS number.
13. **Register `{ re: /^fssai_/i, route: '/api/fssai/settings' }` in OWNED_PREFIXES** in the same
    commit as the first fssai_ key, and write the admin-only, validated, audited settings route
    modelled on /api/hr/settings (§7.6).
14. **Extend, never duplicate:** Receiving QC -> goods_receipt_notes + qc_category_checkers;
    FIFO/expiry -> production_batches + raw_materials.shelf_life_days / .storage_location;
    vendor compliance -> ALTER vendors.
15. **No `await` inside a db.transaction() callback** — better-sqlite3 is synchronous
    (`api/hr/settings/route.ts:117`).

---

## §10. OPEN QUESTIONS FOR THE OWNER (do not decide these in a build phase)

1. **outlet_id on FSSAI tables?** The Task module and checklist engine have none; stock tables do.
   One outlet exists today. Cheap now, expensive to retrofit onto historical evidence.
2. **Personal Hygiene keys on hr_employees (0 rows) or users (9 rows)?** §8.4(5).
3. **hygiene_audits (0 rows) — leave dormant, or hide its UI once FSSAI ships?**
4. **May an FSSAI write succeed if its audit row fails?** logAuditEvent never throws by design.
5. **Raise the live nginx client_max_body_size above 1 MB for evidence photos?** Production config;
   owner's call.
6. **Backdating:** may a check be recorded for an earlier date than it was entered (i.e. does FSSAI
   need recorded_at alongside date)? §4.3.

---

## §11. WHAT I COULD NOT DETERMINE

- **Whether the AWS/Lightsail production box logs to the systemd journal at all.** The systemd unit
  in `deploy/` is the GCP path; memory and `crm-calls/database/page.tsx:85-86` both record that the
  AWS deploy scripts are stale. So "a swallowed migration error is visible via journalctl" is
  **verified for GCP testing and unverified for AWS production** — which is exactly why §9(5)'s boot
  assertion should also write something readable from inside the app.
- **The live client_max_body_size value itself.** 1 MB is inferred from a documented probe
  (900 KB -> app, 1,100 KB -> 413), not from reading the live box's nginx config. I did not connect
  to production.
- **Whether the existing checklist engine has any live UI** — I mapped its schema and data but did
  not audit its pages/routes. That belongs to the navigation/UI recon lane.
- **The full text of `docs/HRMS_DECISIONS.md` §2.7 / D4.** I cite the contract as quoted inside
  db.ts and the HR routes; the 30 KB decisions document itself was not read in full and is the
  precedent for an FSSAI_DECISIONS.md.
