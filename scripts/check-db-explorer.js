#!/usr/bin/env node
/**
 * DATABASE-CONSOLE LOCK — the admin SQL console must stay read-only and bounded.
 *
 *   node scripts/check-db-explorer.js     # exits 1 on any failure
 *
 * WHY THIS EXISTS
 * ───────────────
 * /admin/database puts a SQL box inside a live restaurant system. The threat is
 * not a malicious owner — it is a mistake, a stolen session, or a staff account
 * that reached a page it should not have. Three controls stand between that and
 * a bad afternoon, and all three are the kind of code a future reader will want
 * to "simplify":
 *
 *   A  DRIVER   src/lib/db-explorer.ts opens its OWN better-sqlite3 handle with
 *               { readonly: true, fileMustExist: true }, never getDb().
 *   C  PARSER   src/lib/sql-guard.ts decides whether a typed statement is a read.
 *   D  BOUNDS   runQuery caps rows and SIGKILLs at a wall-clock deadline.
 *
 * Each suite below exists because somebody could reasonably argue the control it
 * covers is redundant. It is not, and this file is the receipt.
 *
 * SUITE 1 — DRIVER, INCLUDING ITS THREE KNOWN GAPS
 * ────────────────────────────────────────────────
 * The tempting simplification is "the handle is readonly, so drop the parser".
 * Measured against this app's own database, a readonly handle DOES refuse
 * UPDATE, WITH…DELETE and VACUUM — and DOES NOT refuse:
 *
 *   CREATE TEMP TABLE          the temp database is a separate, writable file
 *   PRAGMA writable_schema=ON  a pragma is not a write at the API level
 *   ATTACH '<another .db>'     opening a second readable file is not a write
 *
 * That last one is the commercially interesting one: ATTACH reads a database
 * this page's secret-masking knows nothing about — the stale fnbcontroller.db in
 * the repo root, or a nightly backup taken before a credential was rotated.
 *
 * So this suite asserts the three refusals AND asserts the three gaps are still
 * open. A gap-assertion that starts failing is GOOD NEWS — a newer SQLite closed
 * it — but it must be noticed and written down rather than assumed, because the
 * parser rules that cover those gaps are justified by them. Never delete a
 * parser rule on the strength of a memory of how SQLite behaves; delete it only
 * when this suite says the driver stops it, on the box that runs production.
 *
 * SUITE 2 — PARSER
 * ────────────────
 * Every string in ACCEPTANCE, with the exact GuardCode expected. The REJECTED
 * half is the security property; the ACCEPTED half is the usability property and
 * matters just as much — a guard that refuses
 *   SELECT note FROM x WHERE note LIKE '%delete from%'
 * gets switched off by the person it was protecting.
 *
 * Deliberately break guardSql (drop DELETE from WRITE_VERBS, say) and this suite
 * exits 1 printing the exact statement that got through.
 *
 * SUITE 3 — BOUNDS
 * ────────────────
 * better-sqlite3 is SYNCHRONOUS. A cartesian join does not make a page slow, it
 * takes the restaurant offline mid-service: the same Node process fires KOTs,
 * serves the KDS SSE stream and settles bills. worker.terminate() does NOT stop
 * a thread parked inside native sqlite3_step() — measured, still burning CPU two
 * minutes after terminate() — which is why runQuery uses a short-lived child
 * process and SIGKILL. This suite proves the two halves of that:
 *
 *   · a BLOCKING aggregate (count(*) over a triple cross join — produces no rows,
 *     so row-capping cannot save you) comes back TIMEOUT at the deadline, and the
 *     PARENT event loop kept ticking throughout, i.e. the POS stayed responsive;
 *   · a STREAMING cross join (no aggregate, no ORDER BY, so rows arrive
 *     immediately) stops at exactly MAX_ROWS with truncated:true.
 *
 * NO WRITES
 * ─────────
 * Rule 3: this feature never writes. The run is bracketed by a COUNT(*) on
 * audit_events, the one table the feature is allowed to append to at runtime, and
 * the counts must match exactly. This script itself only ever opens readonly
 * handles.
 */

const fs = require('fs');
const path = require('path');
const mod = require('module');
const { pathToFileURL } = require('url');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'fnb-controller.db');
const GUARD_TS = path.join(ROOT, 'src', 'lib', 'sql-guard.ts');
const EXPLORER_TS = path.join(ROOT, 'src', 'lib', 'db-explorer.ts');

/* Node 22.18+ strips TypeScript types on require() natively, so the libs load
   without a build step and without tsx — but the app's '@/…' path alias is a
   tsconfig invention Node knows nothing about, and these files use it. A
   synchronous resolve hook teaches it, for both the CJS and ESM edges of the
   graph (registerHooks covers both; Module._resolveFilename would only cover
   CJS, and these files are ESM once `export` appears). Keep the extension probe
   ordered: a directory index must lose to a sibling .ts file. */
function resolveAlias(spec) {
  const base = path.join(ROOT, 'src', spec.slice(2));
  const candidates = [base, base + '.ts', base + '.tsx', base + '.js',
                      path.join(base, 'index.ts'), path.join(base, 'index.js')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next candidate */ }
  }
  return base;
}
/* Fail with a sentence rather than a stack. registerHooks landed in Node 22.15 /
   23.5, and require()-of-TypeScript in 22.18 — on anything older this file dies
   with a bare TypeError at load, and the reader's first conclusion is "the
   security test is broken", which is one short step from deleting it. Say what
   is actually wrong and how to run it anyway. Measured on node v25.5.0.

   NOTE the exit code: 1, deliberately, the same as a real failure. "Could not
   run the read-only check" must never be mistaken for "the read-only check
   passed" by a CI step that only reads $?. */
if (typeof mod.registerHooks !== 'function') {
  console.log(`\n✗ CANNOT RUN — this node (${process.version}) has no module.registerHooks.`);
  console.log('  The libs under test import the app\'s "@/…" alias, which needs a resolve hook.');
  console.log('  Use node 22.18+ (registerHooks + require of .ts), or run it under tsx:');
  console.log('      npx tsx scripts/check-db-explorer.js\n');
  process.exit(1);
}
mod.registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) return next(pathToFileURL(resolveAlias(spec)).href, ctx);
    return next(spec, ctx);
  },
});

/* Type-stripping prints MODULE_TYPELESS_PACKAGE_JSON for every .ts file it
   reparses as ESM. That is noise here, and it drowns the diff this script exists
   to print. Everything else still surfaces.

   Filter on w.code, NOT w.name: Node emits this one with name 'Warning' and the
   identity in .code, and it is emitted on a later tick than the require that
   caused it — so a name-based filter does not merely fail, it fails by printing
   four lines of loader chatter into the middle of whichever suite happens to be
   running. Measured on node v25.5.0: name=[Warning] code=[MODULE_TYPELESS_PACKAGE_JSON]. */
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.code === 'MODULE_TYPELESS_PACKAGE_JSON' || w.name === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  console.warn(w.message);
});

/* ── tiny harness — same shape as scripts/run-tests.js ──────────────────────── */

const suites = [];
let cur = null;

function suite(name) { cur = { name, pass: 0, fail: 0, failures: [] }; suites.push(cur); console.log(`\n${name}`); }
function ok(label) { cur.pass++; console.log(`  ✓ ${label}`); }
function bad(label, expected, actual, hint) {
  cur.fail++;
  cur.failures.push({ label, expected, actual, hint });
  console.log(`  ✗ ${label}`);
  console.log(`      expected: ${expected}`);
  console.log(`      actual:   ${actual}`);
  if (hint) console.log(`      ${hint}`);
}
function eq(actual, expected, label, hint) {
  if (actual === expected) ok(label); else bad(label, String(expected), String(actual), hint);
}
function die(msg) {
  console.log(`\n✗ CANNOT RUN — ${msg}\n`);
  process.exit(1);
}

/* ── preflight ─────────────────────────────────────────────────────────────── */

if (!fs.existsSync(DB_PATH)) die(`no database at ${DB_PATH}`);
if (!fs.existsSync(GUARD_TS)) die(`src/lib/sql-guard.ts is missing — control C does not exist`);
if (!fs.existsSync(EXPLORER_TS)) die(`src/lib/db-explorer.ts is missing — control A/D does not exist`);

let guardSql, explorer;
try { ({ guardSql } = require(GUARD_TS)); }
catch (e) { die(`could not load sql-guard.ts: ${e.message.split('\n')[0]}`); }
try { explorer = require(EXPLORER_TS); }
catch (e) { die(`could not load db-explorer.ts: ${e.message.split('\n')[0]}`); }
if (typeof guardSql !== 'function') die('sql-guard.ts does not export guardSql()');
if (typeof explorer.runQuery !== 'function') die('db-explorer.ts does not export runQuery()');

/* Rule 3 bracket. audit_events is the only table this feature may append to, and
   the console itself must add nothing else anywhere. Read on a readonly handle so
   the check cannot be the thing that dirties the file.

   This suite calls runQuery() DIRECTLY — never the API route — so nothing in this
   process ever reaches logAuditEvent. Any new row therefore came from somewhere
   else, and the two "somewhere else"s mean opposite things:
     · a `database.query` row from the running dev server is CONTROL F WORKING —
       someone used the console while this ran;
     · anything else, or a row when nothing else is running, means the read-only
       promise leaked and that is the finding this bracket exists to catch.
   So we snapshot the rows, not just the count: a bare "24 became 25" sends the
   reader digging, and a flaky assertion nobody can attribute gets deleted. */
function auditSnapshot() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(
      'SELECT id, event_type, entity_type, actor_email, created_at FROM audit_events ORDER BY rowid'
    ).all();
  } finally { db.close(); }
}
const AUDIT_BEFORE_ROWS = auditSnapshot();
const AUDIT_BEFORE = AUDIT_BEFORE_ROWS.length;

console.log('\nDatabase-console lock — read-only at the driver, in the parser, and in time');
console.log(`database  ${DB_PATH}`);
console.log(`audit_events before: ${AUDIT_BEFORE} rows`);

/* ══ SUITE 1 — DRIVER ═══════════════════════════════════════════════════════ */

function runSuiteDriver() {
  suite('1. DRIVER — { readonly: true, fileMustExist: true } (control A)');

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    /* Every statement here is WHERE 0 / a temp object / an attach, so even in the
       impossible case that the readonly flag is ignored, nothing in the live
       database changes. Do not "improve" any of these into a real write. */
    const refusals = [
      ['UPDATE',       () => db.prepare("UPDATE settings SET value = value WHERE 0").run()],
      ['WITH…DELETE',  () => db.prepare("WITH x AS (SELECT 1) DELETE FROM settings WHERE 0").run()],
      ['VACUUM',       () => db.exec('VACUUM')],
    ];
    for (const [label, fn] of refusals) {
      let err = null;
      try { fn(); } catch (e) { err = e; }
      if (!err) {
        bad(`${label} is refused by the driver`, 'throws "attempt to write a readonly database"',
            'SUCCEEDED — the handle is not read-only',
            'Control A is gone. Check db-explorer.ts is not using getDb() or dropping the readonly flag.');
      } else if (!/readonly database/i.test(err.message)) {
        bad(`${label} is refused by the driver`, 'attempt to write a readonly database',
            err.message, 'Refused, but for a different reason than expected — read it before trusting it.');
      } else {
        ok(`${label} → "${err.message}"`);
      }
    }

    /* THE THREE KNOWN GAPS. These assert the driver still LETS THEM THROUGH.
       They are here so that the parser rules covering them (BANNED_DDL for
       CREATE, BANNED_PRAGMA, BANNED_ATTACH) can never be deleted on the strength
       of "surely readonly stops that". If one of these starts failing, a newer
       SQLite has closed the gap: write it down, re-measure on the production box,
       and only then consider relaxing the parser. */
    const gaps = [
      ['CREATE TEMP TABLE succeeds (temp db is separate and writable)',
       () => db.exec('CREATE TEMP TABLE __chk_tmp (a)'),
       'parser rule BANNED_DDL is what stops it'],
      ['PRAGMA writable_schema = ON succeeds (a pragma is not a write)',
       () => db.pragma('writable_schema = ON'),
       'parser rule BANNED_PRAGMA is what stops it'],
    ];

    /* ATTACH needs a real, readable database file that is NOT the live one. The
       stale fnbcontroller.db in the repo root is exactly the file that makes this
       gap dangerous, so prefer it; if it has been cleaned up, re-attaching the
       live file still demonstrates the same capability. */
    const stale = path.join(ROOT, 'fnbcontroller.db');
    const attachTarget = fs.existsSync(stale) ? stale : DB_PATH;
    gaps.push([
      `ATTACH '${path.basename(attachTarget)}' succeeds (another readable db this page cannot mask)`,
      () => db.exec(`ATTACH DATABASE '${attachTarget.replace(/'/g, "''")}' AS __chk_att`),
      'parser rule BANNED_ATTACH is what stops it — and it is the rule that keeps an old ' +
      'backup, taken before a credential rotation, out of reach',
    ]);

    for (const [label, fn, why] of gaps) {
      let err = null;
      try { fn(); } catch (e) { err = e; }
      if (err) {
        bad(`GAP STILL OPEN: ${label}`, 'succeeds on a readonly handle (as measured)',
            `now throws: ${err.message}`,
            'GOOD NEWS, probably — SQLite may have closed this gap. Re-measure on the ' +
            'production box before relaxing any parser rule, then update this expectation.');
      } else {
        ok(`GAP (expected): ${label}\n      → ${why}`);
      }
    }
  } finally {
    db.close();  // drops the temp table and the attachment with the connection
  }
}

/* ══ SUITE 2 — PARSER ═══════════════════════════════════════════════════════ */

const BT = String.fromCharCode(96);

/**
 * The acceptance list. `code: null` means the statement must be ACCEPTED.
 *
 * Order-sensitive cases are marked: guardSql runs length → skeletonise →
 * statement count → leading keyword → write verbs → banned words → EXPLAIN
 * operand, and the FIRST failure wins. "SELECT 1; DROP TABLE t" is therefore
 * MULTI_STATEMENT, not BANNED_DDL — if you reorder the steps, these expectations
 * change, and that is the point of pinning them.
 */
const ACCEPTANCE = [
  /* ── length ─────────────────────────────────────────────────────────────── */
  ['SELECT ' + 'x'.repeat(4100), 'TOO_LONG', 'over the 4000-character cap'],

  /* ── unterminated: refused, never guessed at ────────────────────────────── */
  ['SELECT 1 /* ; DELETE FROM users', 'UNTERMINATED', 'unclosed block comment hiding a second statement'],
  ["SELECT * FROM settings WHERE key = 'wa_access", 'UNTERMINATED', 'unclosed string literal'],
  ['SELECT [key FROM settings', 'UNTERMINATED', 'unclosed bracketed identifier'],
  ['SELECT "key FROM settings', 'UNTERMINATED', 'unclosed quoted identifier'],

  /* ── two statements ─────────────────────────────────────────────────────── */
  ['SELECT 1; DROP TABLE users', 'MULTI_STATEMENT', 'classic stacked statement'],
  ['SELECT * FROM settings ;  UPDATE settings SET value = 1', 'MULTI_STATEMENT', 'stacked write'],
  ['SELECT 1 -- x\n; SELECT 2', 'MULTI_STATEMENT', 'second statement after a line comment'],

  /* ── leading keyword ────────────────────────────────────────────────────── */
  ['DELETE FROM users', 'BAD_START', 'a bare write starts with the wrong word'],
  ['UPDATE settings SET value = 1', 'BAD_START', 'ditto'],
  ['CREATE TEMP TABLE zz AS SELECT * FROM settings', 'BAD_START', 'the temp-table gap, refused at the door'],
  ['BEGIN', 'BAD_START', 'transaction control'],
  ['', 'BAD_START', 'nothing to run'],
  ['   \n  ', 'BAD_START', 'whitespace only'],
  ['EXPLAIN', 'BAD_START', 'EXPLAIN with nothing to explain'],
  ['EXPLAIN QUERY PLAN VALUES (1)', 'BAD_START', 'EXPLAIN of a non-read'],
  ['EXPLAIN EXPLAIN SELECT 1', 'BAD_START', 'EXPLAIN of an EXPLAIN'],

  /* ── write verbs anywhere, at any depth (the WITH…write trap) ───────────── */
  ['WITH x AS (SELECT id FROM users) DELETE FROM users WHERE id IN (SELECT id FROM x)',
   'WRITE_VERB', 'SQLite grammar puts the verb AFTER the CTE list — a leading WITH proves nothing'],
  ['WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x',
   'WRITE_VERB', 'DML inside a CTE — refused without needing to know whether SQLite supports it'],
  ['WITH t AS (SELECT 1 AS a) INSERT INTO settings SELECT * FROM t', 'WRITE_VERB', 'WITH…INSERT'],
  ['WITH t AS (SELECT 1) UPDATE settings SET value = 1', 'WRITE_VERB', 'WITH…UPDATE'],
  ['WITH t AS (SELECT 1) REPLACE INTO settings VALUES (1, 2)', 'WRITE_VERB', 'REPLACE in statement form'],
  ['SELECT update FROM raw_materials', 'WRITE_VERB', 'bare verb as a bare identifier — quote it to use it'],
  ['EXPLAIN DELETE FROM users', 'WRITE_VERB', 'EXPLAIN does not execute, but there is no reason to allow it'],

  /* replace() the STRING FUNCTION is refused too, and that is deliberate.
     The tempting carve-out is "allow REPLACE when it is followed by an open
     paren, because the REPLACE *statement* is always REPLACE INTO". That reads
     as obviously safe and it is exactly the kind of exception that has to stay
     true forever, in every SQLite version, for the whole guard to hold — one
     grammar form where a keyword can be followed by '(' and the WRITE_VERB rule
     has a hole in it. sql-guard.ts chose the crude rule instead and spends the
     cost in its refusal message, which names substr()/instr() as the way through.
     Pinned here so that re-adding the carve-out cannot be a quiet one-line diff:
     this expectation flips to null in the same commit, or not at all. */
  ["SELECT replace(name, 'a', 'b') FROM raw_materials", 'WRITE_VERB',
   'no call-form carve-out — the usability cost is paid in the message, not in a grammar exception'],

  /* ── banned constructs ──────────────────────────────────────────────────── */
  ['SELECT * FROM settings WHERE drop IS NULL', 'BANNED_DDL', 'DDL word at any depth'],
  ['WITH x AS (SELECT 1) SELECT * FROM x WHERE alter IS NULL', 'BANNED_DDL', 'DDL inside a CTE query'],
  ['SELECT vacuum FROM settings', 'BANNED_DDL', 'storage rewrite'],
  ['SELECT analyze FROM settings', 'BANNED_DDL', 'statistics rewrite'],
  ["ATTACH DATABASE '/tmp/anything.db' AS z", 'BANNED_ATTACH', 'the gap the readonly driver does not close'],
  ["WITH x AS (SELECT 1) ATTACH DATABASE '/tmp/anything.db' AS z", 'BANNED_ATTACH', 'same, hidden behind a CTE'],
  ["DETACH DATABASE z", 'BANNED_ATTACH', 'the other half'],
  ["PRAGMA table_info('settings')", 'BANNED_PRAGMA', 'all pragmas refused — schema comes from the TVFs instead'],
  ['PRAGMA writable_schema = ON', 'BANNED_PRAGMA', 'succeeds on a readonly handle, so the parser owns it'],
  ['SELECT pragma FROM settings', 'BANNED_PRAGMA', 'bare word at any depth'],
  ['SELECT commit FROM settings', 'BANNED_TXN', 'transaction control mid-statement'],
  ['SELECT * FROM settings WHERE rollback IS NULL', 'BANNED_TXN', 'ditto'],
  ["SELECT load_extension('/tmp/evil.so')", 'BANNED_FUNCTION', 'loadable code'],
  ["SELECT readfile('/etc/passwd')", 'BANNED_FUNCTION', 'reaches the server file system'],
  ["SELECT writefile('/tmp/x', 'y')", 'BANNED_FUNCTION', 'writes the server file system'],

  /* ── ACCEPTED — the usability half. A guard that refuses these gets ────────
       switched off by the person it was meant to protect.                     */
  ['SELECT 1', null, 'the simplest read'],
  ['SELECT * FROM settings LIMIT 5', null, 'ordinary browse'],
  ["select key, value from settings where key = 'requisition_deduct_at_issue'", null, 'lowercase, saved query 1'],
  ['SELECT 1;', null, 'a bare trailing semicolon is one statement'],
  ["SELECT note FROM orders WHERE note LIKE '%delete from%'", null, 'verb inside a string literal'],
  ["SELECT name FROM sqlite_master WHERE sql LIKE '%CREATE TABLE%'", null, 'DDL word inside a string literal'],
  ['SELECT 1 -- delete from users', null, 'verb inside a line comment'],
  ['SELECT 1 /* drop table users */', null, 'verb inside a block comment'],
  ['SELECT "update" FROM raw_materials', null, 'the documented escape hatch: quote the column'],
  ['SELECT [delete] FROM raw_materials', null, 'bracketed identifier'],
  [`SELECT ${BT}insert${BT} FROM raw_materials`, null, 'backtick identifier'],
  ['SELECT delete_flag, insert_count FROM orders', null,
   'whole-word matching — delete_flag is not DELETE'],
  ["SELECT * FROM pragma_table_info('purchases')", null,
   'the table-valued form is a SELECT, which is how schema stays readable with PRAGMA banned'],
  ["SELECT * FROM pragma_foreign_key_list('purchases')", null, 'ditto, foreign keys'],
  ['WITH x AS (SELECT 1 AS a) SELECT * FROM x', null, 'an honest CTE'],
  ['EXPLAIN SELECT 1', null, 'EXPLAIN of a read'],
  ['EXPLAIN QUERY PLAN SELECT * FROM purchases', null, 'EXPLAIN QUERY PLAN of a read'],
  ["SELECT m.name FROM sqlite_master m WHERE m.type = 'table' AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name))",
   null, 'saved query 6 — correlated TVF argument'],
];

function oneLine(sql) {
  const s = sql.replace(/\n/g, '\\n');
  return s.length > 72 ? s.slice(0, 69) + '…' : s;
}

function runSuiteParser() {
  suite('2. PARSER — guardSql acceptance list (control C)');

  for (const [sql, expected, why] of ACCEPTANCE) {
    let r;
    try { r = guardSql(sql); }
    catch (e) { bad(oneLine(sql), expected === null ? 'accepted' : expected, `threw: ${e.message}`); continue; }

    const actual = r && r.ok ? null : (r && r.code) || '(no code)';
    if (actual === expected) {
      ok(`${expected === null ? 'accept ' : 'reject '} ${expected || '       '}  ${oneLine(sql)}`);
      continue;
    }
    if (expected === null) {
      bad(oneLine(sql), 'ACCEPTED — ' + why, `REFUSED as ${actual}: ${r.message}`,
          'A false refusal is not a safe failure. The owner works around a guard that ' +
          'blocks legitimate reads, and the workaround is turning it off.');
    } else if (actual === null) {
      bad(oneLine(sql), `REFUSED as ${expected} — ${why}`, 'ACCEPTED — this statement got through',
          'THIS IS A HOLE. The exact string above reached the database. Do not relax ' +
          'the expectation; fix src/lib/sql-guard.ts.');
    } else {
      bad(oneLine(sql), `${expected} — ${why}`, `${actual}: ${r.message}`,
          'Refused, but under the wrong rule — either the step order changed or a word ' +
          'moved between lists. Both change what else gets through.');
    }
  }
}

/* ══ SUITE 3 — BOUNDS ═══════════════════════════════════════════════════════ */

/* We ASK for a 3 s deadline rather than waiting out the module's default, because
   a test that takes 5 s per runaway is a test people stop running. But asking is
   not the same as being obeyed: if runQuery ignores an unknown `timeoutMs`, the
   module default applies instead and a naive "must finish inside 4 s" assertion
   fails for a reason that has nothing to do with the control being tested. So the
   allowance is computed from whichever deadline can actually be in force, and the
   run prints which one it was. */
const TIMEOUT_MS = 3000;
const DESIGN_DEFAULT_TIMEOUT_MS = 5000;

/* The cap and the deadline belong to db-explorer.ts, not to this file — the route
   imports MAX_ROWS from there, so that constant is the real contract and pinning a
   private copy of it here would just drift. Read the module's own value when it
   exports one, and assert it is still a CAP: control D calls for about 1000 rows,
   and the reason is not tidiness. better-sqlite3 is synchronous, so every row it
   materialises is built on a thread that, in the app's process, also fires KOTs and
   settles bills. Someone raising this to 100000 "just for one report" is the change
   this assertion exists to interrupt. */
const CAP_CEILING = 1000;
function moduleNumber(...names) {
  for (const n of names) if (Number.isInteger(explorer[n]) && explorer[n] > 0) return explorer[n];
  return null;
}

/**
 * A table with enough rows that a triple cross join cannot finish, plus the name
 * of one of its columns.
 *
 * The column is looked up rather than assumed. `rowid` would be shorter, but a
 * WITHOUT ROWID table has no rowid and the streaming case would then fail as a
 * SQLite error dressed up as a bounds failure — a test that lies about which
 * control broke is worse than no test.
 */
function pickBigTable() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const quote = (n) => `"${n.replace(/"/g, '""')}"`;
  const withColumn = (name, rows) => {
    const cols = db.prepare(`SELECT * FROM pragma_table_info(?)`).all(name);
    return cols.length ? { name, rows, column: cols[0].name } : null;
  };
  try {
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((r) => r.name);
    if (names.includes('requisition_items')) {
      const c = db.prepare(`SELECT count(*) AS c FROM ${quote('requisition_items')}`).get().c;
      if (c >= 1000) {
        const picked = withColumn('requisition_items', c);
        if (picked) return picked;
      }
    }
    let best = null;
    for (const n of names) {
      let c = 0;
      try { c = db.prepare(`SELECT count(*) AS c FROM ${quote(n)}`).get().c; } catch { continue; }
      if (!best || c > best.rows) {
        const picked = withColumn(n, c);
        if (picked) best = picked;
      }
    }
    return best;
  } finally { db.close(); }
}

async function runSuiteBounds() {
  suite('3. BOUNDS — row cap and wall-clock SIGKILL (control D)');

  const big = pickBigTable();
  if (!big || big.rows < 1000) {
    bad('a table large enough to build a runaway join', 'some table with ≥ 1000 rows',
        big ? `largest is ${big.name} with ${big.rows}` : 'none found',
        'Cannot test the bounds without one. This is an environment problem, not a code problem.');
    return;
  }
  const T = `"${big.name.replace(/"/g, '""')}"`;
  const COL = `"${big.column.replace(/"/g, '""')}"`;
  console.log(`  · runaway built on ${big.name} (${big.rows} rows → ${big.rows}³ ≈ ${(big.rows ** 3).toExponential(1)} row join)`);

  /* The row cap. Prefer the module's exported constant — that is the one the API
     route actually enforces — and fail loudly if it has grown past the ceiling. */
  const CAP = moduleNumber('MAX_ROWS') ?? CAP_CEILING;
  if (CAP <= CAP_CEILING) {
    ok(`row cap is ${CAP}${explorer.MAX_ROWS === undefined ? ' (module exports none; using the design value)' : ' (from db-explorer.MAX_ROWS)'}`);
  } else {
    bad('the row cap stays around 1000', `≤ ${CAP_CEILING}`, String(CAP),
        'A synchronous driver builds every one of these rows on a thread that also fires ' +
        'KOTs and settles bills. Raising the cap moves the failure from "the report is ' +
        'truncated" to "the restaurant is offline". Raise the export limit instead.');
  }

  /* Which deadline can be in force: the one we asked for, or the module's own. */
  const moduleTimeout = moduleNumber('DEFAULT_TIMEOUT_MS', 'TIMEOUT_MS', 'QUERY_TIMEOUT_MS');
  const optionHonoured = /timeoutMs/.test(fs.readFileSync(EXPLORER_TS, 'utf8'));
  const effectiveTimeout = optionHonoured ? TIMEOUT_MS
    : (moduleTimeout ?? DESIGN_DEFAULT_TIMEOUT_MS);
  console.log(optionHonoured
    ? `  · deadline ${effectiveTimeout} ms (asked for via the timeoutMs option)`
    : `  · deadline ${effectiveTimeout} ms (db-explorer.ts takes no timeoutMs option; its own default applies)`);

  /* 3a — the BLOCKING case. count(*) emits nothing until the whole join is
     consumed, so iterate()'s row cap cannot rescue it. Only a kill can. This is
     the case worker.terminate() was measured NOT to stop: V8's termination flag
     is checked when control returns to JS, and a thread inside native
     sqlite3_step() never gets there. */
  let ticks = 0;
  const beat = setInterval(() => { ticks++; }, 100);
  const t0 = Date.now();
  let res;
  try {
    res = await explorer.runQuery(
      `SELECT count(*) AS n FROM ${T} a, ${T} b, ${T} c`,
      { params: [], maxRows: CAP, timeoutMs: TIMEOUT_MS }
    );
  } catch (e) {
    clearInterval(beat);
    bad('blocking aggregate is stopped at the deadline', `a { ok:false, code:'TIMEOUT' } result`,
        `runQuery threw: ${e.message}`);
    return;
  }
  const elapsed = Date.now() - t0;
  clearInterval(beat);

  eq(res.ok, false, `blocking aggregate does not return rows (ok:${res.ok})`);
  eq(res.code, 'TIMEOUT', `blocking aggregate is refused as TIMEOUT`,
     res.code ? undefined : 'No code on the result — the UI has nothing to explain to the owner.');

  const bound = effectiveTimeout + 1000;
  if (elapsed <= bound) ok(`stopped after ${elapsed} ms (deadline ${effectiveTimeout} ms, allowance ${bound} ms)`);
  else bad('stopped at the deadline', `≤ ${bound} ms`, `${elapsed} ms`,
           'Either timeoutMs is being ignored or the kill is not SIGKILL. A soft kill does ' +
           'not stop a thread inside sqlite3_step() — that was measured at over 120 s.');

  if (ticks >= 20) ok(`parent event loop ticked ${ticks}× during the runaway — the POS stayed responsive`);
  else bad('the parent event loop keeps running', '≥ 20 ticks of a 100 ms heartbeat', `${ticks} ticks`,
           'The query is blocking the main thread. During service that is not a slow page, ' +
           'it is KOTs not firing and bills not settling. runQuery must run the statement in ' +
           'a CHILD PROCESS, not in-process and not in a worker thread.');

  /* 3b — the STREAMING case. No aggregate and no ORDER BY, so rows arrive from
     the first step and iterate() can break at the cap. Deliberately NOT
     `ORDER BY`: a sort would make this blocking too and would be testing 3a again
     under a different name. */
  const t1 = Date.now();
  const res2 = await explorer.runQuery(
    `SELECT a.${COL} AS r FROM ${T} a, ${T} b, ${T} c`,
    { params: [], maxRows: CAP, timeoutMs: TIMEOUT_MS }
  );
  const elapsed2 = Date.now() - t1;

  if (!res2.ok) {
    bad('streaming cross join is capped, not killed', `${CAP} rows with truncated:true`,
        `${res2.code}: ${res2.error}`,
        'The cap is what makes a streaming runaway cheap. If this timed out instead, ' +
        'runQuery is materialising with .all() rather than breaking out of .iterate().');
    return;
  }
  eq(res2.rows.length, CAP, `streaming cross join returns exactly ${CAP} rows (in ${elapsed2} ms)`,
     'The server caps regardless of what the user typed — a user LIMIT cannot raise it.');
  eq(res2.truncated, true, 'truncated:true so the UI can say "the first 1000 rows of a larger result"',
     'Silently showing 1000 rows as if they were all of them is a wrong answer, not a partial one.');
}

/* ══ run ════════════════════════════════════════════════════════════════════ */

(async () => {
  runSuiteDriver();
  runSuiteParser();
  await runSuiteBounds();

  suite('4. NO WRITES — rule 3');
  const afterRows = auditSnapshot();
  if (afterRows.length === AUDIT_BEFORE) {
    ok(`audit_events is unchanged (${AUDIT_BEFORE} rows before and after)`);
  } else {
    const seen = new Set(AUDIT_BEFORE_ROWS.map((r) => r.id));
    const added = afterRows.filter((r) => !seen.has(r.id));
    const detail = added.length
      ? added.map((r) => `${r.created_at}  ${r.event_type}  by ${r.actor_email || '(none)'}`).join('\n                ')
      : '(rows were REMOVED, not added — that is worse; this table is append-only)';
    /* Name the likely cause rather than making the reader guess, but do not let it
       excuse the failure: "probably the dev server" is a hypothesis to confirm by
       re-running idle, not a pass. */
    const fromConsole = added.length > 0 && added.every((r) => r.entity_type === 'database');
    bad('audit_events is unchanged', `${AUDIT_BEFORE} rows`, `${afterRows.length} rows\n                ${detail}`,
        fromConsole
          ? 'Every new row is an entity_type=database row, i.e. someone used the Database page ' +
            'through the API while this ran — that is control F working, not a leak. This script ' +
            'calls runQuery() directly and never touches the route. Re-run with the dev server ' +
            'idle to get a clean bracket.'
          : 'This script must never write, and it only ever opens readonly handles. Rows that are ' +
            'not entity_type=database did not come from the console. Find out what wrote them ' +
            'before trusting any other result in this run.');
  }

  console.log('\n─────────────────────────────────────────────────────────────');
  let totalFail = 0;
  for (const s of suites) {
    totalFail += s.fail;
    console.log(`  ${s.fail ? '✗' : '✓'} ${s.name.padEnd(64)} ${s.pass} passed, ${s.fail} failed`);
  }
  console.log('─────────────────────────────────────────────────────────────');

  if (!totalFail) {
    console.log('\n✓ CLEAN — driver refuses writes, parser holds the line, runaways are bounded.\n');
    process.exit(0);
  }

  console.log(`\n✗ ${totalFail} failure(s):\n`);
  for (const s of suites) {
    for (const f of s.failures) {
      console.log(`  [${s.name.split(' —')[0]}] ${f.label}`);
      console.log(`      expected: ${f.expected}`);
      console.log(`      actual:   ${f.actual}`);
      if (f.hint) console.log(`      ${f.hint}`);
      console.log('');
    }
  }
  process.exit(1);
})().catch((e) => {
  console.log(`\n✗ CRASHED — ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
