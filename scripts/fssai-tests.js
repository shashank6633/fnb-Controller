#!/usr/bin/env node
/**
 * FSSAI COMPLIANCE — THE PERMANENT SUITE
 * ======================================
 *
 * The FSSAI module shipped ~56,000 lines with ZERO tests in scripts/. Every proof
 * the build state cites was a throwaway probe under /tmp, and they were lost in a
 * reboot. This file is the part of those probes that must never be lost again.
 *
 * WHAT IT GUARDS — the rules a food-safety record lives or dies by:
 *   [1] the schema boots: 35 fssai_ tables, 116 indexes, and the app's own boot
 *       assertion says OK — on a fresh install, on a database one deploy behind,
 *       and on a snapshot of the real database when one is present;
 *   [2] the fifteen ready-made checklists seed ONCE: a second apply is refused and
 *       writes nothing, a retired checklist is never resurrected, the UNIQUE
 *       marker (not the friendly pre-check) is the gate that holds, and boot
 *       never seeds;
 *   [3] an UNJUDGED reading is NOT a pass (no range → judged:false), and
 *       out-of-range is caught WITHOUT ROUNDING (5.4 fails 0..5);
 *   [4] records are VOIDED, never deleted — on all eleven registers the shared
 *       void owns, through the real /api/fssai/void handler, and no FSSAI source
 *       file contains a DELETE against a record table;
 *   [5] a signed record's fingerprint verifies, a tampered one does not, and the
 *       things that must NOT break a signature (a re-save, the 12-month photo
 *       sweep dropping the image) do not;
 *   [6] the page gate refuses staff on admin and management pages under BOTH a
 *       NULL page_access map (NULL = all pages) and an empty [] map ([] = follow
 *       the role) — and neither ever turns into deny-all for a staff page.
 *
 * THE HYDERABAD AUDIT ROUND (2026-10-14) — every one through the REAL route
 * modules, each guard constructed and watched firing:
 *   [7]  the cooling curve: create_suggested on an EMPTY standards table, the
 *        fail-open case (a lone reading with minutes typed is judged against the
 *        rule's anchor; no anchor fails CLOSED), reheating (the hot direction),
 *        a batch across midnight, and an abandoned batch read as overdue;
 *   [8]  the food-handler register (#55 #56 #106 #107): per-person coverage,
 *        who is NOT in order named, FoSTaC 1-per-25, left/rejoined on one row,
 *        the void author rule, the HRMS training link, CSV formula escaping;
 *   [9]  evidence is VOIDED, never stripped: a file on a document or a pest
 *        visit keeps its image, the cross-record call is refused 404, the
 *        uploader may not void, a failed audit write rolls the void back;
 *   [10] pest: the chemicals applied (#78) and the station-by-station sheet
 *        (#113), all-or-nothing walks, a voided line kept on the sheet;
 *   [11] the waste handover log (#114);
 *   [12] closure photographs on corrective actions and inspection points (#120);
 *   [13] a deleted ready-made checklist is never resurrected by a later pack;
 *   [14] the audit-file PDF text — what the inspector's copy says it holds;
 *   [15] missed checks on WhatsApp stay DORMANT (bell only) with no approved
 *        template and no Meta app secret, and nothing leaves the machine.
 *
 * NOTHING LEAVES THIS MACHINE: global fetch is a tripwire that records every
 * call and answers 599, and web push is stubbed. Sections can be run alone:
 *   node scripts/fssai-tests.js --only=7,9
 *
 * HOW IT STAYS HERMETIC. The main database is a FRESH, EMPTY file in a temp dir,
 * booted by the app's own getDb() → initializeSchema() — so the suite never
 * depends on what anybody has clicked in the worktree database, and never writes
 * to it. Every test runs inside a SAVEPOINT that is rolled back, so fixtures never
 * accumulate. The real database is only ever opened READ-ONLY, to VACUUM INTO a
 * temp copy (which folds the WAL in), and only for the upgrade-path boot check.
 * See assertSandboxed().
 *
 * HOW IT AVOIDS BEING INERT. Every guard here is exercised by CONSTRUCTING the
 * case it exists for and watching it fire (a tampered sheet, a retired checklist,
 * a second apply, a staff user on an admin page) — never by reading the code.
 *
 * SQL CONSTRUCTION. The only interpolated identifiers are table and column names
 * that come from FSSAI_RECORD_TABLES or from SQLite's own PRAGMA output, and every
 * one passes IDENT before it is used. All values are bound.
 *
 * Run: node scripts/fssai-tests.js [--keep]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'src');
const LIVE_DB = path.join(REPO, 'fnb-controller.db');
const KEEP = process.argv.includes('--keep');
const BOOT_CHILD = process.argv.includes('--boot-child');
/* --only=7,9 runs just those sections (the summary says what was skipped). */
const ONLY = (() => {
  const a = process.argv.find((x) => x.startsWith('--only='));
  return a ? new Set(a.slice('--only='.length).split(',').map((s) => Number(s.trim())).filter(Boolean)) : null;
})();
const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));

/* ── TypeScript loader (same as hr-payroll-tests.js) ───────────────────────── */
function installTsLoader() {
  const ts = require(path.join(REPO, 'node_modules', 'typescript'));
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (typeof request === 'string' && request.startsWith('@/')) {
      request = path.join(SRC, request.slice(2));
    }
    return origResolve.call(this, request, ...rest);
  };
  require.extensions['.ts'] = function (module, filename) {
    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: filename,
    });
    module._compile(out.outputText, filename);
  };
}

/** Boot the app's real getDb() in the CURRENT directory and keep what it said. */
function bootQuietly() {
  const said = [];
  const keep = { log: console.log, error: console.error, warn: console.warn };
  const grab = (tag) => (...a) => said.push(tag + ' ' + a.map((x) => (x && x.stack) || String(x)).join(' '));
  console.log = grab('LOG'); console.error = grab('ERR'); console.warn = grab('WARN');
  let mod, db;
  try {
    mod = require(path.join(SRC, 'lib', 'db.ts'));
    db = mod.getDb();
  } finally {
    Object.assign(console, keep);
  }
  return { mod, db, said };
}

function countFssaiObjects(db) {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fssai\\_%' ESCAPE '\\' ORDER BY name`,
  ).all().map((r) => r.name);
  const indexes = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index'
       AND (name LIKE 'idx\\_fssai\\_%' ESCAPE '\\' OR name LIKE 'uq\\_fssai\\_%' ESCAPE '\\') ORDER BY name`,
  ).all().map((r) => r.name);
  return { tables, indexes };
}

/* ════════════════════════════════════════════════════════════════════════════
 * CHILD MODE — boot one database file in its own process.
 * db.ts computes DB_PATH from process.cwd() at import and holds ONE connection
 * per process, so booting a second file in the same process would mean two
 * copies of the module. A child process is the honest way to boot it again.
 * ══════════════════════════════════════════════════════════════════════════*/
if (BOOT_CHILD) {
  installTsLoader();
  const { db, said } = bootQuietly();
  const { tables, indexes } = countFssaiObjects(db);
  const out = {
    db: db.name,
    tables: tables.length,
    indexes: indexes.length,
    ok: said.filter((l) => /\[db\] fssai schema OK/.test(l)),
    notOk: said.filter((l) => /FSSAI SCHEMA NOT OK|fssai schema failed|FSSAI NAME CONFLICT|FSSAI SCHEMA INCOMPLETE|FSSAI INDEXES INCOMPLETE/.test(l)),
  };
  db.close();
  process.stdout.write('FSSAI_BOOT_CHILD ' + JSON.stringify(out) + '\n');
  process.exit(0);
}

/* ════════════════════════════════════════════════════════════════════════════
 * PARENT — the suite
 * ══════════════════════════════════════════════════════════════════════════*/
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-fssai-tests-')));
const FRESH_DIR = path.join(TMP, 'fresh');
fs.mkdirSync(FRESH_DIR);
process.chdir(FRESH_DIR);
installTsLoader();

/* THE NETWORK TRIPWIRE — installed before any app module loads. Every fetch is
 * recorded and answered 599, so a send path that should be DORMANT and is not
 * shows up as a recorded call instead of a message to a real phone. */
const FETCH = { calls: [] };
global.fetch = async (url, init) => {
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = String(init && init.body); }
  FETCH.calls.push({ url: String(url), method: init && init.method, body });
  return { ok: false, status: 599, json: async () => ({ error: { message: 'fssai-tests tripwire: no network' } }), text: async () => 'tripwire' };
};

const BOOT = bootQuietly();
const db = BOOT.db;

function assertSandboxed() {
  const open = path.resolve(db.name || '');
  if (path.resolve(LIVE_DB) === open || !open.startsWith(path.resolve(TMP))) {
    console.error(`\nFATAL: tests opened ${open}, not the scratch database in ${TMP}. Aborting.`);
    process.exit(3);
  }
}
assertSandboxed();

const lib = (rel) => require(path.join(SRC, 'lib', rel));
const F = lib('fssai.ts');
const FS = lib('fssai-server.ts');
const SEED = lib('fssai-seed-server.ts');
const PACK = lib('fssai-checklist-pack.ts');
const VOID = lib('fssai-void.ts');
const PC = lib('page-catalog.ts');
const AUTH = lib('auth.ts');
const P4 = require(path.join(SRC, 'app', 'api', 'fssai', '_p4', 'lib.ts'));

/* THE ONE STUB. Route handlers and the page gate read the session through
 * getCurrentUser(), which needs a Next request scope. Everything else they call —
 * the CSRF guard, the tier checks, the refusal, the SQL — is the real code. The
 * TS→CJS emit calls `(0, auth_1.getCurrentUser)()`, a live property read, so
 * replacing the export reaches every caller. */
let CURRENT_USER = null;
AUTH.getCurrentUser = async () => CURRENT_USER;
/* The outlet the routes write under: the fresh database's own default outlet. */
const ROUTE_OUTLET = (db.prepare('SELECT id FROM outlets WHERE is_default = 1 LIMIT 1').get() || {}).id || '';
AUTH.getCurrentOutletId = async () => ROUTE_OUTLET;
/* Web push talks https directly, past the fetch tripwire — so it is stubbed. */
const PUSHES = [];
lib('push.ts').sendPushToUser = async (_db, email, payload) => { PUSHES.push({ email, title: payload && payload.title }); return { sent: 0 }; };
const VOID_ROUTE = require(path.join(SRC, 'app', 'api', 'fssai', 'void', 'route.ts'));
const PAGE_GATE = lib('fssai-page-gate.ts');
const route = (rel) => require(path.join(SRC, 'app', 'api', 'fssai', ...rel.split('/'), 'route.ts'));

/* ── harness ───────────────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
function ok(l) { pass++; console.log(`  ✓ ${l}`); }
function bad(l, d) { fail++; failures.push(l); console.log(`  ✗ ${l}`); if (d) console.log(`      ${d}`); }
function expect(a, e, l) {
  if (a === e || (typeof e === 'number' && Number(a) === e)) ok(`${l} — ${a}`);
  else bad(l, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function expectTrue(c, l, h) { c ? ok(l) : bad(l, h); }
/** Deep equality by JSON — for the tuples the route tests compare. */
function expectSame(a, e, l) {
  const A = JSON.stringify(a), B = JSON.stringify(e);
  A === B ? ok(`${l} — ${A}`) : bad(l, `expected ${B}, got ${A}`);
}
let CURRENT_SECTION = 0;
const skippedSections = [];
const want = (n) => !ONLY || ONLY.has(n);
function section(n, t) {
  CURRENT_SECTION = n;
  if (!want(n)) { skippedSections.push(n); return; }
  console.log(`\n[${n}] ${t}`);
}

// Constant savepoint name — tests never nest, so nothing needs to be generated.
const SP_BEGIN = 'SAVEPOINT fssai_t';
const SP_UNDO = 'ROLLBACK TO SAVEPOINT fssai_t';
const SP_DONE = 'RELEASE SAVEPOINT fssai_t';
async function test(name, fn) {
  if (!want(CURRENT_SECTION)) return;
  db.prepare(SP_BEGIN).run();
  try { await fn(); }
  catch (e) { bad(`${name} — threw`, String((e && e.stack) || e)); }
  finally {
    CURRENT_USER = null;
    try { db.prepare(SP_UNDO).run(); db.prepare(SP_DONE).run(); }
    catch (e) { bad(`${name} — savepoint unwind failed`, String(e)); }
  }
}

const uid = () => 'fssaitest-' + Math.random().toString(36).slice(2, 12);
const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name) {
  if (!IDENT.test(String(name))) throw new Error(`refusing to interpolate identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}
const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${ident(table)}`).get().c;

const OUTLET = 'outlet-test';
const ADMIN   = { id: 'u-admin', role: 'admin',   email: 'admin@fssai.test', name: 'Test Admin',   is_head_chef: false, page_access: null };
const MANAGER = { id: 'u-mgr',   role: 'manager', email: 'mgr@fssai.test',   name: 'Test Manager', is_head_chef: false, page_access: null };
const HOD     = { id: 'u-hod',   role: 'staff',   email: 'hod@fssai.test',   name: 'Test HOD',     is_head_chef: true,  page_access: null };
const STAFF   = { id: 'u-staff', role: 'staff',   email: 'staff@fssai.test', name: 'Test Staff',   is_head_chef: false, page_access: null };
const MANAGER2 = { ...MANAGER, id: 'u-mgr2', email: 'mgr2@fssai.test', name: 'Second Manager' };

/**
 * ONE MINIMUM ROW in any table, built from the table's own PRAGMA, so a fixture
 * cannot silently disagree with the schema. NOT NULL columns with no default get
 * a unique value; a NOT NULL foreign key gets a real parent row, recursively;
 * a nullable foreign key stays NULL — never '' (foreign_keys is ON, and '' would
 * be refused, which is the measured trap the build state records).
 */
function mkRow(table, over = {}, depth = 0) {
  if (depth > 6) throw new Error(`mkRow: foreign-key chain too deep at ${table}`);
  const cols = db.prepare('SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk FROM pragma_table_xinfo(?)').all(table);
  if (!cols.length) throw new Error(`mkRow: no such table ${table}`);
  const fks = db.prepare('SELECT "table" AS parent, "from" AS col, "to" AS ref FROM pragma_foreign_key_list(?)').all(table);
  const row = {};
  for (const c of cols) {
    if (Object.prototype.hasOwnProperty.call(over, c.name)) { row[c.name] = over[c.name]; continue; }
    const fk = fks.find((f) => f.col === c.name);
    if (c.pk) { row[c.name] = /INT/i.test(c.type) ? undefined : uid(); continue; }
    if (fk && c.nn) {
      const parent = mkRow(fk.parent, {}, depth + 1);
      row[c.name] = parent[fk.ref || 'id'];
      continue;
    }
    if (c.nn && c.dflt === null) {
      row[c.name] = /INT/i.test(c.type) ? 0 : /REAL|NUM|FLOA|DOUB/i.test(c.type) ? 0 : 't_' + uid();
    }
  }
  const names = Object.keys(row).filter((k) => row[k] !== undefined);
  const info = db.prepare(
    `INSERT INTO ${ident(table)} (${names.map(ident).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  ).run(...names.map((k) => row[k]));
  return db.prepare(`SELECT * FROM ${ident(table)} WHERE rowid = ?`).get(info.lastInsertRowid);
}

/* ── ROUTE HARNESS (sections 7–15) ─────────────────────────────────────────────
 * The REAL route modules, called with a real Request. Only getCurrentUser and
 * getCurrentOutletId are stubbed (above); the CSRF guard, the tier checks, the
 * refusals and the SQL are the shipped code. */
const CSRF_HEADERS = { 'content-type': 'application/json', cookie: 'fnb_csrf=fssai-test-token', 'x-csrf-token': 'fssai-test-token' };
const signIn = (u) => { CURRENT_USER = u; };
/* What the routes said on console.error / console.warn while the suite called
 * them — a refusal path that logs is expected; printed only with --keep. */
const ROUTE_SAID = [];
async function call(mod, method, url, body, { csrf = true } = {}) {
  const init = { method, headers: csrf ? CSRF_HEADERS : { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const keep = { error: console.error, warn: console.warn };
  console.error = (...a) => ROUTE_SAID.push(`${method} ${url}: ` + a.map((x) => (x && x.message) || String(x)).join(' '));
  console.warn = console.error;
  let res;
  try { res = await mod[method](new Request('http://localhost' + url, init)); }
  finally { Object.assign(console, keep); }
  const ct = res.headers.get('content-type') || '';
  const out = { status: res.status, headers: res.headers, j: null, buf: null, text: '' };
  if (ct.includes('json')) { try { out.j = await res.json(); } catch { out.j = null; } }
  else if (ct.includes('csv') || ct.startsWith('text/')) out.text = await res.text();
  else out.buf = Buffer.from(await res.arrayBuffer());
  return out;
}
/** The suite's people as LOGINS — some routes look an address up in users. */
function seedUsers(...extra) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO users (id, email, password_hash, name, role, is_head_chef, department_id, wa_mobile)
     VALUES (?, ?, 'not-a-real-hash', ?, ?, ?, ?, ?)`,
  );
  for (const u of [ADMIN, MANAGER, MANAGER2, HOD, STAFF, ...extra]) {
    ins.run(u.id, u.email, u.name, u.role, u.is_head_chef ? 1 : 0, u.department_id || null, u.wa_mobile || '');
  }
}
/** A valid 1×1 PNG whose bytes differ per seed (a tEXt chunk), so digests differ. */
function png(seed) {
  const head = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d', 'hex');
  const txt = Buffer.from('seed' + seed);
  const len = Buffer.alloc(4); len.writeUInt32BE(txt.length);
  const end = Buffer.from('0000000049454e44ae426082', 'hex');
  const bytes = Buffer.concat([head, len, Buffer.from('tEXt'), txt, Buffer.alloc(4), end]);
  return 'data:image/png;base64,' + bytes.toString('base64');
}
const attRow = (id) => db.prepare('SELECT * FROM fssai_attachments WHERE id = ?').get(id);
const auditRows = (table, id, action) => db.prepare(
  `SELECT * FROM fssai_audit_log WHERE entity_table = ? AND entity_id = ?${action ? ' AND action = ?' : ''} ORDER BY rowid`,
).all(...[table, id, action].filter((x) => x !== undefined));

/**
 * THE TEXT OF A PDF, without a dependency. The audit file is drawn by pdfkit in
 * the standard Helvetica faces, which write every run of text as a hex string
 * of WinAnsi codes inside a TJ/Tj operator in a Flate-compressed content
 * stream. Inflate each stream, decode each string, keep one line per BT…ET.
 * Enough to ask "does the inspector's copy SAY this?" — not a layout engine.
 */
function pdfTextOf(buf) {
  const zlib = require('zlib');
  const src = buf.toString('latin1');
  const lines = [];
  let at = 0;
  for (;;) {
    const s = src.indexOf('stream', at);
    if (s < 0) break;
    let start = s + 'stream'.length;
    if (src[start] === '\r') start += 1;
    if (src[start] === '\n') start += 1;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    at = end + 'endstream'.length;
    let content = '';
    try { content = zlib.inflateSync(buf.subarray(start, end)).toString('latin1'); }
    catch { continue; }
    for (const bt of content.split(/\bBT\b/).slice(1)) {
      const body = bt.split(/\bET\b/)[0];
      let line = '';
      for (const t of body.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)/g)) {
        if (t[1] !== undefined) {
          const hex = t[1].replace(/\s+/g, '');
          for (let i = 0; i + 1 < hex.length; i += 2) line += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        } else {
          line += t[2].replace(/\\([()\\])/g, '$1');
        }
      }
      if (line.trim()) lines.push(line);
    }
  }
  // WinAnsi → the characters the renderer meant (the few that differ from Latin-1).
  const WIN = { '\x95': '•', '\x96': '–', '\x97': '—', '\x91': '‘', '\x92': '’', '\x93': '“', '\x94': '”', '\x85': '…' };
  return lines.join('\n').replace(/[\x85\x91-\x97]/g, (c) => WIN[c] || c);
}

/* ════════════════════════════════════════════════════════════════════════════
 * TESTS
 * ══════════════════════════════════════════════════════════════════════════*/

(async () => {
  console.log('\nFSSAI COMPLIANCE — permanent suite');
  console.log(`scratch database: ${db.name}`);

  /* ─────────────────────────────────────────────────────────────────────── */
  /* THE SCHEMA CONTRACT, ASSERTED EXACTLY AND ON PURPOSE. It was 30 / 99 until
   * the Hyderabad audit round (2026-10-14) added five tables — fssai_food_handlers,
   * fssai_training_links, fssai_pest_device_checks, fssai_waste_handovers,
   * fssai_job_notices — and seventeen indexes. A table or index added or lost by
   * accident must fail here; one added deliberately changes these numbers. */
  const FSSAI_TABLES = 35;
  const FSSAI_INDEXES = 116;
  const P1_TABLE_COUNT = 11;
  section(1, `SCHEMA BOOTS — ${FSSAI_TABLES} tables, ${FSSAI_INDEXES} indexes, and the boot assertion says OK`);

  // The DECLARED lists, read out of db.ts exactly as assertFssaiSchema reads them.
  const dbSrc = fs.readFileSync(path.join(SRC, 'lib', 'db.ts'), 'utf8');
  const tStart = dbSrc.indexOf('const FSSAI_TABLE_DDL: string[] = [');
  const iStart = dbSrc.indexOf('const FSSAI_INDEX_DDL: string[] = [');
  const iEnd = dbSrc.indexOf('\n];', iStart);
  const declTables = [...new Set([...dbSrc.slice(tStart, iStart).matchAll(/`\s*CREATE TABLE IF NOT EXISTS (fssai_[a-z_]+)/g)].map((m) => m[1]))];
  const declIndexes = [...new Set([...dbSrc.slice(iStart, iEnd).matchAll(/`\s*CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1]))];
  const live = countFssaiObjects(db);

  await test(`the DDL declares ${FSSAI_TABLES} tables and ${FSSAI_INDEXES} indexes`, () => {
    expectTrue(tStart > -1 && iStart > tStart && iEnd > iStart, 'both DDL arrays found in src/lib/db.ts');
    // If the schema grows on purpose, change these two numbers on purpose.
    expect(declTables.length, FSSAI_TABLES, 'declared fssai_ tables');
    expect(declIndexes.length, FSSAI_INDEXES, 'declared idx_fssai_/uq_fssai_ indexes');
  });
  await test('a FRESH database boots every declared table and index', () => {
    expect(live.tables.length, FSSAI_TABLES, 'fssai_ tables in sqlite_master');
    expect(live.indexes.length, FSSAI_INDEXES, 'fssai indexes in sqlite_master');
    const missT = declTables.filter((t) => !live.tables.includes(t));
    const missI = declIndexes.filter((i) => !live.indexes.includes(i));
    expectTrue(missT.length === 0, 'no declared table is missing', missT.join(', '));
    expectTrue(missI.length === 0, 'no declared index is missing', missI.join(', '));
    const extraI = live.indexes.filter((i) => !declIndexes.includes(i));
    expectTrue(extraI.length === 0, 'no undeclared fssai index exists', extraI.join(', '));
  });
  await test("the app's own boot assertion said OK, and nothing said NOT OK", () => {
    const okLine = BOOT.said.find((l) => /\[db\] fssai schema OK/.test(l)) || '';
    expectTrue(okLine.includes(`fssai schema OK (${FSSAI_TABLES} tables, ${FSSAI_INDEXES} indexes)`),
      `boot printed "${okLine.replace(/^LOG /, '')}"`, 'no OK line was printed — initializeSchema swallows errors per block, so this is the only proof');
    const notOk = BOOT.said.filter((l) => /FSSAI SCHEMA NOT OK|fssai schema failed|FSSAI NAME CONFLICT|INCOMPLETE/.test(l));
    expectTrue(notOk.length === 0, 'no FSSAI failure line during boot', notOk.join(' | '));
  });
  await test('foreign keys are ON — the reason NULL, never "", is the rule', () => {
    expect(db.pragma('foreign_keys', { simple: true }), 1, 'PRAGMA foreign_keys');
    const tpl = mkRow('fssai_templates');
    const run = mkRow('fssai_runs', { template_id: tpl.id });
    let threw = '';
    try {
      db.prepare(`INSERT INTO fssai_corrective_actions (id, ca_number, run_id, title) VALUES (?, ?, '', 'x')`)
        .run(uid(), 'CA-T-' + uid());
    } catch (e) { threw = String(e.message); }
    expectTrue(/FOREIGN KEY/i.test(threw), `run_id = '' is REFUSED by the foreign key (${threw || 'it was accepted'})`);
    expectTrue(!!run.id, 'and a real parent is accepted');
  });
  await test('every record table carries the void trio', () => {
    for (const t of F.FSSAI_RECORD_TABLES) {
      const cols = db.prepare('SELECT name FROM pragma_table_xinfo(?)').all(t.table).map((c) => c.name);
      const missing = ['status', 'voided_at', 'voided_by', 'void_reason'].filter((c) => !cols.includes(c));
      expectTrue(missing.length === 0, `${t.table} has status/voided_at/voided_by/void_reason`, 'missing: ' + missing.join(', '));
    }
    expectTrue(VOID.FSSAI_VOIDABLE_MISSING.length === 0, 'every record table has void facts (FSSAI_VOIDABLE_MISSING empty)', VOID.FSSAI_VOIDABLE_MISSING.join(', '));
    expectTrue(VOID.FSSAI_VOIDABLE_ORPHANS.length === 0, 'no void facts for a table that no longer exists', VOID.FSSAI_VOIDABLE_ORPHANS.join(', '));
  });

  /* The two upgrade paths, each booted in its own process. Run OUTSIDE a
   * savepoint: VACUUM INTO cannot run inside a transaction. */
  function bootChild(dir) {
    const r = spawnSync(process.execPath, [__filename, '--boot-child'], { cwd: dir, encoding: 'utf8', timeout: 180000 });
    const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('FSSAI_BOOT_CHILD '));
    if (r.status !== 0 || !line) return { error: `exit ${r.status}${r.signal ? ' ' + r.signal : ''}: ${String(r.stderr || '').slice(-400)}` };
    return JSON.parse(line.slice('FSSAI_BOOT_CHILD '.length));
  }

  if (want(1)) {
    // A DATABASE ONE DEPLOY BEHIND — the measured W1 upgrade: only the eleven P1
    // tables exist (every record-module table and its indexes are absent) and
    // two live rows sit in them. The next boot must build the rest and leave
    // both rows exactly as they were.
    const P1_TABLES = ['fssai_templates', 'fssai_sections', 'fssai_questions', 'fssai_equipment',
      'fssai_assignments', 'fssai_runs', 'fssai_responses', 'fssai_evidence', 'fssai_approvals',
      'fssai_corrective_actions', 'fssai_audit_log'];
    const dir = path.join(TMP, 'behind');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'fnb-controller.db');
    db.prepare('VACUUM INTO ?').run(file);
    const old = new Database(file);
    old.pragma('foreign_keys = OFF');
    const dropped = live.tables.filter((t) => !P1_TABLES.includes(t));
    for (const t of dropped) old.prepare(`DROP TABLE ${ident(t)}`).run();
    const tplId = uid(), runId = uid();
    old.prepare(`INSERT INTO fssai_templates (id, code, name) VALUES (?, 'ZZ-SENTINEL', 'kept across the upgrade')`).run(tplId);
    old.prepare(`INSERT INTO fssai_runs (id, template_id, business_date, recorded_by) VALUES (?, ?, '2026-01-01', 'sentinel@fssai.test')`).run(runId, tplId);
    const before = countFssaiObjects(old);
    old.close();

    const child = bootChild(dir);
    await test(`a database ONE DEPLOY BEHIND (${P1_TABLE_COUNT} tables) is brought to ${FSSAI_TABLES} by the next boot`, () => {
      expect(dropped.length, FSSAI_TABLES - P1_TABLE_COUNT, 'record-module tables absent before the boot');
      expect(before.tables.length, P1_TABLE_COUNT, 'tables before the boot');
      if (child.error) { bad('the child boot ran', child.error); return; }
      expect(child.tables, FSSAI_TABLES, 'tables after the boot');
      expect(child.indexes, FSSAI_INDEXES, 'indexes after the boot');
      expectTrue(child.ok.length === 1 && child.ok[0].includes(`${FSSAI_TABLES} tables, ${FSSAI_INDEXES} indexes`), 'the boot assertion said OK', JSON.stringify(child.ok));
      expectTrue(child.notOk.length === 0, 'and nothing said NOT OK', child.notOk.join(' | '));
      const after = new Database(file, { readonly: true });
      const tpl = after.prepare('SELECT name FROM fssai_templates WHERE id = ?').get(tplId);
      const run = after.prepare('SELECT recorded_by, template_id FROM fssai_runs WHERE id = ?').get(runId);
      after.close();
      expectTrue(!!tpl && tpl.name === 'kept across the upgrade', 'the live checklist row is untouched');
      expectTrue(!!run && run.recorded_by === 'sentinel@fssai.test' && run.template_id === tplId, 'the live record row is untouched');
    });
  }

  if (want(1)) {
    // THE REAL DATABASE, if this checkout has one: snapshot READ-ONLY, boot the
    // copy. Proves the boot is idempotent on a database that already has the
    // module, and that it neither seeds nor removes records.
    if (!fs.existsSync(LIVE_DB)) {
      console.log('  · real-database boot skipped — no fnb-controller.db in this checkout (not counted)');
    } else {
      const dir = path.join(TMP, 'snapshot');
      fs.mkdirSync(dir);
      const file = path.join(dir, 'fnb-controller.db');
      const src = new Database(LIVE_DB, { readonly: true });
      src.prepare('VACUUM INTO ?').run(file);
      src.close();
      const peek = (f) => {
        const d = new Database(f, { readonly: true });
        const has = (t) => !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
        const n = (t) => (has(t) ? d.prepare(`SELECT COUNT(*) AS c FROM ${ident(t)}`).get().c : null);
        const out = { purchases: n('purchases'), templates: n('fssai_templates'), runs: n('fssai_runs'), seeded: has('fssai_templates') ? d.prepare('SELECT COUNT(*) AS c FROM fssai_templates WHERE is_seeded = 1').get().c : null };
        d.close();
        return out;
      };
      const before = peek(file);
      const child = bootChild(dir);
      await test('a snapshot of the REAL database boots clean, and the boot changes no record', () => {
        if (child.error) { bad('the child boot ran', child.error); return; }
        expect(child.tables, FSSAI_TABLES, 'tables after booting the snapshot');
        expect(child.indexes, FSSAI_INDEXES, 'indexes after booting the snapshot');
        expectTrue(child.ok.length === 1, 'the boot assertion said OK', JSON.stringify(child.ok));
        expectTrue(child.notOk.length === 0, 'and nothing said NOT OK', child.notOk.join(' | '));
        const after = peek(file);
        expect(after.purchases, before.purchases, 'purchases unchanged by the boot');
        expectTrue(before.templates === null || after.templates === before.templates, `fssai_templates unchanged (${before.templates} → ${after.templates})`);
        expectTrue(before.seeded === null || after.seeded === before.seeded, `seeded checklists unchanged — boot never seeds (${before.seeded} → ${after.seeded})`);
        expectTrue(before.runs === null || after.runs === before.runs, `fssai_runs unchanged (${before.runs} → ${after.runs})`);
      });
    }
  }

  /* ─────────────────────────────────────────────────────────────────────── */
  section(2, 'THE FIFTEEN READY-MADE CHECKLISTS — applied once, never twice, never resurrected');

  /* THE PACK SIZE, ASSERTED EXACTLY AND ON PURPOSE. It was 12 until pack v2
   * (2026-10-14) added the Hyderabad Food Safety Authority's three audit pages
   * (CHK-HYD-AUDIT-1/2/3). A checklist added or lost by accident must fail this
   * suite; one added deliberately changes this number in the same commit. */
  const PACK_CHECKLISTS = 15;

  const validation = PACK.validateFssaiChecklistPack();
  const C = validation.counts || {};
  const seedOpts = () => ({ actor: { email: ADMIN.email, name: ADMIN.name }, outletId: OUTLET });
  const seedCounts = () => ({
    templates: count('fssai_templates'), sections: count('fssai_sections'), questions: count('fssai_questions'),
    seed_log: count('fssai_seed_log'), audit: count('fssai_audit_log'), runs: count('fssai_runs'),
  });

  await test('the pack itself is renderable by this build', () => {
    expectTrue(validation.ok, 'validateFssaiChecklistPack() is ok', JSON.stringify(validation.problems || []).slice(0, 300));
    expect(C.templates, PACK_CHECKLISTS, 'checklists in the pack');
    console.log(`      (pack: ${C.templates} checklists · ${C.sections} sections · ${C.questions} questions)`);
  });
  await test('boot never seeds — a freshly booted database holds no seeded checklist', () => {
    expect(db.prepare('SELECT COUNT(*) AS c FROM fssai_templates WHERE is_seeded = 1').get().c, 0, 'seeded templates after boot');
    expect(count('fssai_seed_log'), 0, 'seed_log rows after boot');
    const usesPack = /applyFssaiChecklistPack|FSSAI_CHECKLIST_PACK|fssai-seed-server|fssai-checklist-pack/.test(dbSrc);
    expectTrue(!usesPack, 'db.ts does not reference the pack or its applier (static)');
  });
  await test('FIRST apply creates exactly the pack, as drafts, and touches no record', () => {
    const b = seedCounts();
    const r = SEED.applyFssaiChecklistPack(db, seedOpts());
    expectTrue(r.ok === true, 'apply returned ok', JSON.stringify(r).slice(0, 300));
    expect(r.inserted, PACK_CHECKLISTS, 'inserted');
    expect(r.skipped, 0, 'skipped');
    const a = seedCounts();
    expect(a.templates - b.templates, PACK_CHECKLISTS, 'templates +');
    expect(a.sections - b.sections, C.sections, 'sections + (the pack’s own count)');
    expect(a.questions - b.questions, C.questions, 'questions + (the pack’s own count)');
    expect(a.seed_log - b.seed_log, 1 + PACK_CHECKLISTS, `seed_log + (1 pack marker + ${PACK_CHECKLISTS} checklists)`);
    expect(a.runs, b.runs, 'fssai_runs unchanged');
    const drafts = db.prepare(`SELECT COUNT(*) AS c FROM fssai_templates WHERE is_seeded = 1 AND status = 'draft' AND outlet_id = ?`).get(OUTLET).c;
    expect(drafts, PACK_CHECKLISTS, `all ${PACK_CHECKLISTS} seeded as DRAFT (invisible to staff until published)`);
    const orphans = db.prepare(
      `SELECT COUNT(*) AS c FROM fssai_questions q LEFT JOIN fssai_templates t ON t.id = q.template_id WHERE t.id IS NULL`,
    ).get().c;
    expect(orphans, 0, 'orphan questions');
  });
  await test('SECOND apply is refused and writes NOTHING', () => {
    SEED.applyFssaiChecklistPack(db, seedOpts());
    const b = seedCounts();
    const r = SEED.applyFssaiChecklistPack(db, seedOpts());
    expectTrue(r.ok === false && r.code === 'already_applied', `second apply refused: ${r.code}`, JSON.stringify(r).slice(0, 300));
    expectTrue(/not added a second time/.test(String(r.message || '')), 'and says so in words');
    const a = seedCounts();
    for (const k of Object.keys(b)) expect(a[k], b[k], `${k} unchanged`);
    const dupes = db.prepare(
      `SELECT COUNT(*) AS c FROM (SELECT code FROM fssai_templates WHERE outlet_id = ? AND code <> '' GROUP BY code HAVING COUNT(*) > 1)`,
    ).get(OUTLET).c;
    expect(dupes, 0, 'duplicated checklist codes');
  });
  await test('a RETIRED checklist stays retired — apply again does not resurrect it', () => {
    SEED.applyFssaiChecklistPack(db, seedOpts());
    const victim = db.prepare(`SELECT id, code FROM fssai_templates WHERE is_seeded = 1 AND outlet_id = ? ORDER BY code LIMIT 1`).get(OUTLET);
    db.prepare(`UPDATE fssai_templates SET status = 'archived', is_active = 0 WHERE id = ?`).run(victim.id);
    const b = seedCounts();
    const r = SEED.applyFssaiChecklistPack(db, seedOpts());
    expectTrue(r.ok === false && r.code === 'already_applied', 'still refused after a retirement');
    expect(seedCounts().templates, b.templates, 'templates unchanged');
    const rows = db.prepare('SELECT status, is_active FROM fssai_templates WHERE code = ? AND outlet_id = ?').all(victim.code, OUTLET);
    expect(rows.length, 1, `rows carrying ${victim.code}`);
    expectTrue(rows[0].status === 'archived' && rows[0].is_active === 0, 'and it is still archived and inactive');
  });
  await test('the UNIQUE marker is the gate that holds — not the friendly pre-check', () => {
    SEED.applyFssaiChecklistPack(db, seedOpts());
    const pack = PACK.FSSAI_CHECKLIST_PACK;
    let threw = '';
    try {
      db.prepare(
        `INSERT INTO fssai_seed_log (id, pack_key, pack_version, item_kind, item_code, item_id, action, detail, applied_by, outlet_id)
         VALUES (?, ?, ?, 'pack', '', '', 'inserted', 'a racing second apply', 'race@fssai.test', ?)`,
      ).run(uid(), pack.key, pack.version, OUTLET);
    } catch (e) { threw = String(e.message); }
    expectTrue(/UNIQUE constraint failed/i.test(threw) && /fssai_seed_log/.test(threw),
      `a second marker row is refused by uq_fssai_seed_item (${threw || 'it was ACCEPTED'})`);
  });
  await test('a NEW pack version overwrites nothing the owner edited', () => {
    SEED.applyFssaiChecklistPack(db, seedOpts());
    const edited = db.prepare(`SELECT id, code FROM fssai_templates WHERE is_seeded = 1 AND outlet_id = ? ORDER BY code DESC LIMIT 1`).get(OUTLET);
    db.prepare(`UPDATE fssai_templates SET name = 'Owner renamed this' WHERE id = ?`).run(edited.id);
    const b = seedCounts();
    const pack = PACK.FSSAI_CHECKLIST_PACK;
    const r = SEED.applyFssaiChecklistPack(db, { ...seedOpts(), pack: { ...pack, version: pack.version + 1 } });
    expectTrue(r.ok === true, 'v+1 applies (its marker is new)', JSON.stringify(r).slice(0, 200));
    expect(r.inserted, 0, 'inserted by v+1');
    expect(r.skipped, PACK_CHECKLISTS, 'skipped by v+1 (codes already in use)');
    const a = seedCounts();
    expect(a.templates, b.templates, 'templates unchanged');
    expect(a.questions, b.questions, 'questions unchanged');
    expect(db.prepare('SELECT name FROM fssai_templates WHERE id = ?').get(edited.id).name, 'Owner renamed this', "the owner's edit survives");
  });
  await test('an unknown department is refused BEFORE the marker — a later apply is not poisoned', () => {
    const b = seedCounts();
    const pack = PACK.FSSAI_CHECKLIST_PACK;
    const r = SEED.applyFssaiChecklistPack(db, { ...seedOpts(), departmentByCode: { [pack.templates[0].code]: 'no-such-department-' + uid() } });
    expectTrue(r.ok === false && r.code === 'unknown_department', `refused: ${r.code}`);
    const a = seedCounts();
    expect(a.seed_log, b.seed_log, 'no marker row written');
    expect(a.templates, b.templates, 'no checklist written');
    const again = SEED.applyFssaiChecklistPack(db, seedOpts());
    expectTrue(again.ok === true && again.inserted === PACK_CHECKLISTS, 'and a correct apply afterwards still works');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  section(3, 'A READING AGAINST A RANGE — unjudged is NOT a pass; no rounding');

  await test('no range → judged:false, and NOT a pass', () => {
    const r = F.fssaiRangeCheck(4, null, null, '°C');
    expect(r.judged, false, 'judged');
    expect(r.out_of_range, false, 'out_of_range');
    expectTrue(/not judged/i.test(r.why), `the words say so: "${r.why}"`);
    const u = F.fssaiRangeCheck(4, undefined, undefined);
    expect(u.judged, false, 'judged with undefined bounds');
    const nan = F.fssaiRangeCheck(4, Number.NaN, Number.NaN);
    expect(nan.judged, false, 'judged with NaN bounds (a bad parse is not a rule)');
  });
  await test('no reading → judged:false, never a phantom 0', () => {
    expect(F.fssaiRangeCheck(null, 0, 5).judged, false, 'null reading against 0..5');
    expect(F.fssaiRangeCheck(undefined, 0, 5).judged, false, 'undefined reading against 0..5');
    expect(F.fssaiRangeCheck(Number.NaN, 0, 5).judged, false, 'NaN reading against 0..5');
  });
  await test('5.4 against 0..5 FAILS — nothing rounds it to 5', () => {
    const r = F.fssaiRangeCheck(5.4, 0, 5, '°C');
    expect(r.judged, true, 'judged');
    expect(r.out_of_range, true, 'out_of_range');
    expectTrue(/5\.4/.test(r.why) && /above/i.test(r.why), `the words carry the real reading: "${r.why}"`);
    expect(F.fssaiRangeCheck(5.0001, 0, 5).out_of_range, true, '5.0001 against 0..5');
    expect(F.fssaiRangeCheck(-0.1, 0, 5).out_of_range, true, '-0.1 against 0..5 (below)');
  });
  await test('the bounds are inclusive, and 0 is a real bound', () => {
    expect(F.fssaiRangeCheck(5, 0, 5).out_of_range, false, '5 against 0..5');
    expect(F.fssaiRangeCheck(0, 0, 5).out_of_range, false, '0 against 0..5');
    expect(F.fssaiRangeCheck(-1, 0, null).out_of_range, true, '-1 against min 0 only — 0 is not "missing"');
    expect(F.fssaiRangeCheck(-17.5, null, -18).out_of_range, true, 'freezer at -17.5 against max -18');
    expect(F.fssaiRangeCheck(-20, null, -18).out_of_range, false, 'freezer at -20 against max -18');
  });
  await test('a checklist temperature answer of 5.4 fails a 0..5 question even at decimals 0', () => {
    const v = F.evaluateFssaiAnswer({ qtype: 'temperature', min_value: 0, max_value: 5, decimals: 0 }, { value_num: 5.4 });
    expect(v.is_fail, true, 'is_fail');
    expect(F.evaluateFssaiAnswer({ qtype: 'temperature', min_value: 0, max_value: 5 }, { value_num: null }).answered, false,
      'a blank reading is NOT answered');
  });
  await test('the P4 record path: no standard on file → is_judged 0, is_fail 0', () => {
    expect(count('fssai_temp_standards'), 0, 'standards on a fresh install');
    const range = P4.resolveFssaiRange(db, { logKind: 'cold_storage', uom: 'C' });
    expect(range.source, 'none', 'resolved source');
    expect(range.min, null, 'min');
    expect(range.max, null, 'max');
    const v = P4.judgeFssaiReading({ value: 9, min: range.min, max: range.max, uomForWords: '°C' });
    expect(v.is_judged, 0, 'is_judged for a 9 °C fridge with no rule');
    expect(v.is_fail, 0, 'is_fail — it raises nothing either');
  });
  await test('…and the moment a standard exists, the same reading is judged and fails', () => {
    mkRow('fssai_temp_standards', { applies_to: 'cold_storage', min_value: 0, max_value: 5, is_active: 1, material_id: '', equipment_kind: '' });
    const range = P4.resolveFssaiRange(db, { logKind: 'cold_storage', uom: 'C' });
    expect(range.source, 'standard', 'resolved source');
    const v = P4.judgeFssaiReading({ value: 5.4, min: range.min, max: range.max, uomForWords: '°C' });
    expect(v.is_judged, 1, 'is_judged');
    expect(v.is_fail, 1, 'is_fail for 5.4 against the stored 0..5');
  });
  await test('the three-way tick-box: "" is NOT assessed, never a pass and never a fail', () => {
    expect(F.fssaiCheckResultAnswered(''), false, "'' answered");
    expect(F.fssaiCheckResultIsFail(''), false, "'' fail");
    expect(F.fssaiCheckResultIsFail('not_ok'), true, "'not_ok' fail");
    expect(F.fssaiCheckResultAnswered('na'), true, "'na' answered");
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  section(4, 'VOID, NEVER DELETE — every register, the real route, and the source');

  const voidable = VOID.FSSAI_VOIDABLE_RECORDS.filter((d) => !d.delegate);
  const delegated = VOID.FSSAI_VOIDABLE_RECORDS.filter((d) => d.delegate);

  /** A record filed by `author`, in whichever author column this table uses. */
  function mkRecord(desc, author) {
    const over = { outlet_id: OUTLET };
    if (desc.authorCols[0]) over[desc.authorCols[0]] = author.email;
    return mkRow(desc.table, over);
  }

  await test(`the shared void covers ${voidable.length} registers; ${delegated.length} delegate to their own route`, () => {
    expect(voidable.length + delegated.length, F.FSSAI_RECORD_TABLES.length, 'every record table is accounted for');
    expectTrue(delegated.every((d) => ['fssai_runs', 'fssai_corrective_actions'].includes(d.table)),
      `delegated: ${delegated.map((d) => d.table).join(', ')}`);
  });
  for (const desc of voidable) {
    await test(`${desc.table}: voided in place — the row stays, with its reason`, () => {
      const row = mkRecord(desc, STAFF);
      const before = count(desc.table);
      const auditBefore = db.prepare(`SELECT COUNT(*) AS c FROM fssai_audit_log WHERE entity_table = ? AND entity_id = ? AND action = 'void'`).get(desc.table, row.id).c;
      const reason = 'Entered against the wrong unit';
      const refusal = VOID.fssaiVoidRefusalForRecord(MANAGER, row, reason, desc);
      expect(refusal, '', 'a manager with a reason may void');
      const res = VOID.voidFssaiRecord(db, { desc, row, reason, actor: MANAGER, outletId: OUTLET });
      expectTrue(res && res.ok === true, 'voidFssaiRecord returned ok', JSON.stringify(res));
      expect(count(desc.table), before, 'row count unchanged — nothing deleted');
      const after = db.prepare(`SELECT * FROM ${ident(desc.table)} WHERE id = ?`).get(row.id);
      expectTrue(!!after, 'the row is still there');
      expect(after.status, desc.voidStatus, 'status');
      expect(after.void_reason, reason, 'void_reason');
      expect(after.voided_by, MANAGER.email, 'voided_by');
      expectTrue(String(after.voided_at || '') !== '', 'voided_at is stamped');
      if (desc.extraSet.includes('is_active = 0')) expect(after.is_active, 0, 'a cancelled document is no longer active');
      const auditAfter = db.prepare(`SELECT COUNT(*) AS c FROM fssai_audit_log WHERE entity_table = ? AND entity_id = ? AND action = 'void'`).get(desc.table, row.id).c;
      expect(auditAfter - auditBefore, 1, 'one void row in fssai_audit_log');
      const again = VOID.voidFssaiRecord(db, { desc, row, reason: 'A second, different reason', actor: MANAGER2, outletId: OUTLET });
      expectTrue(again && again.conflict, 'a second void is a conflict, not an overwrite');
      expect(db.prepare(`SELECT void_reason FROM ${ident(desc.table)} WHERE id = ?`).get(row.id).void_reason, reason, 'the first reason stands');
    });
  }
  await test('WHO may void — staff never, a short reason never, the author never (a manager)', () => {
    const desc = VOID.fssaiVoidableRecord('fssai_temperature_logs');
    const row = mkRecord(desc, MANAGER);
    expectTrue(VOID.fssaiVoidRefusalForRecord(STAFF, row, 'a good long reason', desc) !== '', 'staff is refused');
    expectTrue(VOID.fssaiVoidRefusalForRecord(MANAGER2, row, 'no', desc) !== '', 'a reason under four characters is refused');
    expectTrue(VOID.fssaiVoidRefusalForRecord(null, row, 'a good long reason', desc) !== '', 'signed out is refused');
    expectTrue(/yourself/.test(VOID.fssaiVoidRefusalForRecord(MANAGER, row, 'a good long reason', desc)),
      'the manager who FILED it is refused — the person with the motive');
    expect(VOID.fssaiVoidRefusalForRecord(MANAGER2, row, 'a good long reason', desc), '', 'a different manager is allowed');
    expect(VOID.fssaiVoidRefusalForRecord(HOD, row, 'a good long reason', desc), '', 'an HOD is allowed');
  });

  const csrfRequest = (body, { csrf = true } = {}) => new Request('http://localhost/api/fssai/void', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(csrf ? { cookie: 'fnb_csrf=fssai-test-token', 'x-csrf-token': 'fssai-test-token' } : {}),
    },
    body: JSON.stringify(body),
  });
  await test('THE REAL ROUTE: POST /api/fssai/void cancels in place and deletes nothing', async () => {
    expectTrue(typeof VOID_ROUTE.DELETE === 'undefined', 'the void route exports NO DELETE handler');
    const desc = VOID.fssaiVoidableRecord('fssai_pest_sightings');
    const row = mkRecord(desc, STAFF);
    const before = count(desc.table);

    CURRENT_USER = MANAGER;
    let res = await VOID_ROUTE.POST(csrfRequest({ entity_table: desc.table, id: row.id, reason: 'Duplicate of an earlier report' }, { csrf: false }));
    expect(res.status, 403, 'no CSRF pair → 403');

    CURRENT_USER = STAFF;
    res = await VOID_ROUTE.POST(csrfRequest({ entity_table: desc.table, id: row.id, reason: 'Duplicate of an earlier report' }));
    expect(res.status, 403, 'staff → 403');

    CURRENT_USER = MANAGER;
    res = await VOID_ROUTE.POST(csrfRequest({ entity_table: desc.table, id: row.id, reason: 'no' }));
    expect(res.status, 400, 'a manager with no real reason → 400');

    res = await VOID_ROUTE.POST(csrfRequest({ entity_table: 'users', id: row.id, reason: 'Duplicate of an earlier report' }));
    expect(res.status, 400, 'a table outside the allowlist → 400');

    res = await VOID_ROUTE.POST(csrfRequest({ entity_table: 'fssai_runs', id: 'x', reason: 'Duplicate of an earlier report' }));
    expect(res.status, 409, 'a delegated register → 409 with the endpoint to use');

    res = await VOID_ROUTE.POST(csrfRequest({ entity_table: desc.table, id: row.id, reason: 'Duplicate of an earlier report' }));
    const body = await res.json();
    expect(res.status, 200, 'a manager with a reason → 200');
    expect(body.status, 'void', 'response status');
    expect(count(desc.table), before, 'row count unchanged');
    const after = db.prepare(`SELECT status, void_reason FROM ${ident(desc.table)} WHERE id = ?`).get(row.id);
    expectTrue(after && after.status === 'void' && after.void_reason === 'Duplicate of an earlier report', 'the row is still there, void, with the reason');

    // An already-void record is refused by the shared refusal (403, "already been
    // voided"); 409 is the race path inside voidFssaiRecord. Either is a refusal —
    // what matters is that the first reason is never overwritten.
    CURRENT_USER = MANAGER2;
    res = await VOID_ROUTE.POST(csrfRequest({ entity_table: desc.table, id: row.id, reason: 'Trying to void it twice' }));
    const again = await res.json();
    expectTrue(res.status === 403 || res.status === 409, `a second void is refused — ${res.status}: "${again.error}"`);
    expect(db.prepare(`SELECT void_reason FROM ${ident(desc.table)} WHERE id = ?`).get(row.id).void_reason,
      'Duplicate of an earlier report', 'the first reason stands');
    CURRENT_USER = null;
  });

  // The static half. Weaker than execution and labelled as such — but it is the
  // one check that catches a DELETE added to a register route tomorrow.
  const DELETE_RE = /DELETE\s+FROM\s+["`]?([a-z_]+)/gi;
  function sourceFiles(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) sourceFiles(p, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  await test('no FSSAI source file DELETEs from a record table (static)', () => {
    const recordSet = new Set(F.FSSAI_RECORD_TABLES.map((t) => t.table));
    const sample = 'db.prepare(`DELETE FROM fssai_temperature_logs WHERE id = ?`)';
    const caught = [...sample.matchAll(DELETE_RE)].map((m) => m[1]).filter((t) => recordSet.has(t));
    expect(caught.length, 1, 'the scanner itself fires on a planted DELETE (self-test)');
    const files = [
      ...sourceFiles(path.join(SRC, 'app', 'api', 'fssai')),
      ...sourceFiles(path.join(SRC, 'app', 'fssai')),
      ...fs.readdirSync(path.join(SRC, 'lib')).filter((f) => /^fssai.*\.ts$/.test(f)).map((f) => path.join(SRC, 'lib', f)),
    ];
    const hits = [];
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(DELETE_RE)) {
        if (recordSet.has(m[1])) hits.push(`${path.relative(REPO, f)}: DELETE FROM ${m[1]}`);
      }
    }
    expectTrue(files.length > 50, `scanned ${files.length} FSSAI source files`);
    expectTrue(hits.length === 0, 'zero DELETEs against a record table', hits.join(' | '));
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  section(5, 'THE SIGNATURE FINGERPRINT — a signed sheet verifies; a tampered one does not');

  /** A run with two answers and a photograph, ready to sign. */
  function mkSignedSheet() {
    const tpl = mkRow('fssai_templates', { status: 'published', outlet_id: OUTLET });
    const qT = mkRow('fssai_questions', { template_id: tpl.id, qtype: 'temperature', min_value: 0, max_value: 5, uom: 'C' });
    const qY = mkRow('fssai_questions', { template_id: tpl.id, qtype: 'yes_no' });
    const run = mkRow('fssai_runs', { template_id: tpl.id, status: 'in_progress', recorded_by: STAFF.email, outlet_id: OUTLET });
    const rT = mkRow('fssai_responses', { run_id: run.id, question_id: qT.id, qtype: 'temperature', value_num: 3.8, is_fail: 0, note: '' });
    const rY = mkRow('fssai_responses', { run_id: run.id, question_id: qY.id, qtype: 'yes_no', value_bool: 1, is_fail: 0, note: 'clean' });
    const ev = mkRow('fssai_evidence', { run_id: run.id, response_id: rT.id, kind: 'photo', mime: 'image/jpeg', size_bytes: 123456, data_uri: 'data:image/jpeg;base64,AAAA' });
    const sig = FS.signFssaiRun(db, run.id, run, { email: STAFF.email, name: STAFF.name }, F.fssaiSignatureStatement(), OUTLET, 'explicit');
    return { tpl, run, rT, rY, ev, sig };
  }
  const state = (runId) => FS.fssaiSignatureState(db, runId);

  await test('a freshly signed sheet VERIFIES', () => {
    const s = mkSignedSheet();
    const st = state(s.run.id);
    expect(st.is_signed, true, 'is_signed');
    expect(st.is_stale, false, 'is_stale');
    expectTrue(/^[0-9a-f]{64}$/.test(st.signature.sheet_digest), 'the stored fingerprint is a SHA-256');
    expect(st.signature.sheet_digest, st.digest_now, 'stored fingerprint === recomputed fingerprint');
    expect(st.signature.answers, 2, 'answers covered');
    expect(st.signature.photos, 1, 'photographs covered');
    expect(st.signature.mode, 'explicit', 'mode read back');
    expect(db.prepare('SELECT signed_by FROM fssai_runs WHERE id = ?').get(s.run.id).signed_by, STAFF.email, 'fssai_runs.signed_by');
    expect(FS.computeFssaiSheetDigest(db, s.run.id).digest, st.digest_now, 'the digest is deterministic across reads');
  });
  const tampers = [
    ['a reading changed 3.8 → 3.9', (s) => db.prepare('UPDATE fssai_responses SET value_num = 3.9 WHERE id = ?').run(s.rT.id)],
    ['a yes flipped to no', (s) => db.prepare('UPDATE fssai_responses SET value_bool = 0 WHERE id = ?').run(s.rY.id)],
    ['a frozen verdict flipped', (s) => db.prepare('UPDATE fssai_responses SET is_fail = 1 WHERE id = ?').run(s.rT.id)],
    ['a note rewritten', (s) => db.prepare(`UPDATE fssai_responses SET note = 'it was fine really' WHERE id = ?`).run(s.rY.id)],
    ['marked not-applicable after signing', (s) => db.prepare('UPDATE fssai_responses SET is_na = 1 WHERE id = ?').run(s.rY.id)],
    ['a photograph added after signing', (s) => mkRow('fssai_evidence', { run_id: s.run.id, response_id: s.rY.id, kind: 'photo', mime: 'image/jpeg', size_bytes: 999 })],
    ['a photograph swapped for a different size', (s) => db.prepare('UPDATE fssai_evidence SET size_bytes = 99 WHERE id = ?').run(s.ev.id)],
    ['an answer removed', (s) => { db.prepare('DELETE FROM fssai_evidence WHERE response_id = ?').run(s.rY.id); db.prepare('DELETE FROM fssai_responses WHERE id = ?').run(s.rY.id); }],
    ['the stored fingerprint forged', (s) => db.prepare(
      `UPDATE fssai_audit_log SET after_json = json_set(after_json, '$.sheet_digest', ?)
        WHERE entity_table = 'fssai_runs' AND entity_id = ? AND action = 'sign'`).run('0'.repeat(64), s.run.id)],
  ];
  for (const [what, tamper] of tampers) {
    await test(`TAMPERED — ${what} — does NOT verify`, () => {
      const s = mkSignedSheet();
      expect(state(s.run.id).is_stale, false, 'verifies before');
      tamper(s);
      const st = state(s.run.id);
      expect(st.is_signed, true, 'still reads as signed');
      expect(st.is_stale, true, 'is_stale after the tamper');
    });
  }
  await test('undoing the tamper restores the match — the digest is a function of the sheet', () => {
    const s = mkSignedSheet();
    db.prepare('UPDATE fssai_responses SET value_num = 3.9 WHERE id = ?').run(s.rT.id);
    expect(state(s.run.id).is_stale, true, 'stale while changed');
    db.prepare('UPDATE fssai_responses SET value_num = 3.8 WHERE id = ?').run(s.rT.id);
    expect(state(s.run.id).is_stale, false, 'verifies again once restored');
  });
  await test('NOT a tamper: a re-save that changes nothing a person sees', () => {
    const s = mkSignedSheet();
    db.prepare(`UPDATE fssai_responses SET updated_at = '2099-01-01 00:00:00' WHERE run_id = ?`).run(s.run.id);
    db.prepare(`UPDATE fssai_runs SET updated_at = '2099-01-01 00:00:00', template_version = template_version + 1 WHERE id = ?`).run(s.run.id);
    expect(state(s.run.id).is_stale, false, 'is_stale after updated_at / template_version moved');
  });
  await test('NOT a tamper: the 12-month sweep dropping the IMAGE keeps the signature intact', () => {
    const s = mkSignedSheet();
    db.prepare(`UPDATE fssai_evidence SET data_uri = '', image_dropped_at = datetime('now') WHERE id = ?`).run(s.ev.id);
    expect(state(s.run.id).is_stale, false, 'is_stale after data_uri cleared (size_bytes kept)');
  });
  await test('a withdrawn signature reads as UNSIGNED; signing again verifies', () => {
    const s = mkSignedSheet();
    FS.fssaiAudit(db, { entity_table: 'fssai_runs', entity_id: s.run.id, action: FS.FSSAI_UNSIGN_ACTION, actor: { email: STAFF.email } });
    expect(state(s.run.id).is_signed, false, 'is_signed after an unsign row');
    db.prepare('UPDATE fssai_responses SET value_num = 4.1 WHERE id = ?').run(s.rT.id);
    FS.signFssaiRun(db, s.run.id, s.run, { email: STAFF.email, name: STAFF.name }, F.fssaiSignatureStatement(), OUTLET, 'explicit');
    const st = state(s.run.id);
    expect(st.is_signed, true, 'signed again');
    expect(st.is_stale, false, 'and the new fingerprint covers the new answer');
  });
  await test('the mode is never UPGRADED on read-back', () => {
    for (const m of ['explicit', 'on_submit', 'not_asked']) {
      const s = mkSignedSheet();
      db.prepare(`UPDATE fssai_audit_log SET after_json = json_set(after_json, '$.mode', ?) WHERE entity_id = ? AND action = 'sign'`).run(m, s.run.id);
      expect(FS.readFssaiSignature(db, s.run.id).mode, m, `stored "${m}" reads back as`);
    }
    expect(F.fssaiSignatureModeFrom(''), 'explicit', 'absent (a pre-mode row) →');
    expect(F.fssaiSignatureModeFrom('from-a-newer-build'), 'not_asked', 'unrecognised → the WEAKEST claim');
    expect(F.FSSAI_REQUIRE_EXPLICIT_SIGNATURE, false,
      'FSSAI_REQUIRE_EXPLICIT_SIGNATURE stays false until the owner’s phone run (Q17) — flipping it must be a deliberate edit here too');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  section(6, 'THE PAGE GATE — staff refused on admin/management pages under NULL and []');

  const ADMIN_PAGES = ['/fssai/settings', '/fssai/settings/equipment', '/fssai/settings/checklists', '/fssai/settings/checklists/abc123', '/fssai/settings/ready-made'];
  const MGMT_PAGES = ['/fssai/verification', '/fssai/inspections', '/fssai/inspection-mode', '/fssai/documents', '/fssai/reports', '/fssai/audit-log',
    // the Hyderabad round: the audit file, and the food-handler register (gated by its /fssai/documents prefix)
    '/fssai/audit-file', '/fssai/documents/food-handlers'];
  const STAFF_PAGES = ['/fssai', '/fssai/temperature', '/fssai/checklists', '/fssai/checklists/run/abc123', '/fssai/receiving', '/fssai/pest-control', '/fssai/corrective-actions',
    // porters file the waste handover at the back door — no tier flag
    '/fssai/waste'];
  const MAPS = [['NULL (all pages)', null], ['[] (follow the role)', '[]']];
  const as = (u, page_access) => ({ ...u, page_access });

  await test('the catalog flags the pages this section relies on', () => {
    expectTrue(ADMIN_PAGES.every((p) => PC.isAdminOnlyPath(p)), 'every ADMIN page resolves adminOnly (longest prefix)');
    expectTrue(MGMT_PAGES.every((p) => PC.isMgmtOnlyPath(p) && !PC.isAdminOnlyPath(p)), 'every MANAGEMENT page resolves mgmtOnly');
    expectTrue(STAFF_PAGES.every((p) => !PC.isMgmtOnlyPath(p) && !PC.isAdminOnlyPath(p) && !PC.isHodOnlyPath(p)), 'no STAFF page carries a tier flag');
  });
  for (const [label, map] of MAPS) {
    await test(`page_access = ${label}`, () => {
      for (const p of ADMIN_PAGES) {
        expect(PC.canAccessPage(p, as(STAFF, map)), false, `staff   refused ${p}`);
        expect(PC.canAccessPage(p, as(MANAGER, map)), false, `manager refused ${p}`);
        expect(PC.canAccessPage(p, as(HOD, map)), false, `HOD     refused ${p}`);
        expect(PC.canAccessPage(p, as(ADMIN, map)), true, `admin   allowed ${p}`);
      }
      for (const p of MGMT_PAGES) {
        expect(PC.canAccessPage(p, as(STAFF, map)), false, `staff   refused ${p}`);
        expect(PC.canAccessPage(p, as(MANAGER, map)), true, `manager allowed ${p}`);
        expect(PC.canAccessPage(p, as(HOD, map)), true, `HOD     allowed ${p}`);
      }
      for (const p of STAFF_PAGES) {
        expect(PC.canAccessPage(p, as(STAFF, map)), true, `staff   allowed ${p} — never deny-all`);
      }
    });
  }
  await test('a granted "/fssai" prefix still cannot open an admin or management page', () => {
    const map = JSON.stringify(['/fssai']);
    for (const p of [...ADMIN_PAGES, ...MGMT_PAGES]) expect(PC.canAccessPage(p, as(STAFF, map)), false, `staff ["/fssai"] refused ${p}`);
    expect(PC.canAccessPage('/fssai/temperature', as(STAFF, map)), true, 'staff ["/fssai"] allowed /fssai/temperature');
  });
  await test('a real map is honoured — [] is not simply "always yes"', () => {
    const map = JSON.stringify(['/dashboard']);
    expect(PC.canAccessPage('/fssai/temperature', as(STAFF, map)), false, 'staff ["/dashboard"] refused /fssai/temperature');
    expect(PC.canAccessPage('/fssai/temperature', as(STAFF, '[]')), true, 'staff [] allowed /fssai/temperature');
  });
  async function gate(user, p) {
    CURRENT_USER = user;
    try { await PAGE_GATE.assertFssaiPageAccess(p); return 'allowed'; }
    catch (e) { return String((e && e.digest) || (e && e.message) || e); }
    finally { CURRENT_USER = null; }
  }
  await test('THE REAL GATE: assertFssaiPageAccess redirects staff off admin pages, NULL and []', async () => {
    for (const [label, map] of MAPS) {
      for (const p of ['/fssai/settings', '/fssai/settings/checklists/print-abc', '/fssai/verification']) {
        const out = await gate(as(STAFF, map), p);
        expectTrue(/NEXT_REDIRECT/.test(out) && out.includes('forbidden=' + encodeURIComponent(p)),
          `staff ${label} → redirected off ${p}`, out);
      }
      expect(await gate(as(STAFF, map), '/fssai/checklists/run/abc123'), 'allowed', `staff ${label} → the runner opens`);
      expect(await gate(as(ADMIN, map), '/fssai/settings/checklists/print-abc'), 'allowed', `admin ${label} → the builder opens`);
    }
    const anon = await gate(null, '/fssai/settings');
    expectTrue(/NEXT_REDIRECT/.test(anon) && anon.includes('/login?next='), 'signed out → /login', anon);
  });
  await test('the API authoring gate is admin-only too (canAuthorFssai)', () => {
    expect(F.canAuthorFssai(ADMIN), true, 'admin');
    expect(F.canAuthorFssai(MANAGER), false, 'manager');
    expect(F.canAuthorFssai(HOD), false, 'HOD');
    expect(F.canAuthorFssai(STAFF), false, 'staff');
    expect(F.canAuthorFssai(null), false, 'signed out');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  section(7, 'THE COOLING CURVE — anchored, fail-closed, both directions, across midnight');

  const TEMP = route('temperature');
  const STD = route('temp-standards');
  const T_TODAY = F.fssaiToday();
  const T_YDAY = F.addDaysISO(T_TODAY, -1);
  /** One reading, as the cook files it (staff, no department). */
  const reading = (body) => { signIn(STAFF); return call(TEMP, 'POST', '/api/fssai/temperature', { action: 'record', uom: 'C', shift: '', business_date: T_TODAY, ...body }); };
  const suggest = () => { signIn(ADMIN); return call(STD, 'POST', '/api/fssai/temp-standards', { action: 'create_suggested', codes: ['TEMP-COOLING', 'TEMP-REHEAT', 'TEMP-CHILLER'] }); };
  const stdRow = (code) => db.prepare('SELECT * FROM fssai_temp_standards WHERE code = ?').get(code);
  const setAnchor = (code, v) => { signIn(ADMIN); return call(STD, 'POST', '/api/fssai/temp-standards', { action: 'update', id: stdRow(code).id, start_value: v, reason: 'fssai-tests: anchor changed' }); };
  const caOf = (readingId) => db.prepare(`SELECT ca_number, title FROM fssai_corrective_actions WHERE response_id = ?`).get(readingId);

  await test('create_suggested on an EMPTY standards table answers 200 and stores the anchors', async () => {
    expect(count('fssai_temp_standards'), 0, 'standards before');
    let r = await suggest();
    expect(r.status, 200, 'create_suggested (the 2026-10-14 finding: it answered 409 duplicate_code and wrote nothing)');
    expectSame([stdRow('TEMP-COOLING').start_value, stdRow('TEMP-COOLING').max_minutes, stdRow('TEMP-COOLING').target_value], [60, 240, 5], 'TEMP-COOLING anchor/minutes/target');
    expectSame([stdRow('TEMP-REHEAT').start_value, stdRow('TEMP-REHEAT').max_minutes, stdRow('TEMP-REHEAT').target_value], [5, 120, 75], 'TEMP-REHEAT anchor/minutes/target');
    expect(stdRow('TEMP-CHILLER').start_value, null, 'a level rule (TEMP-CHILLER) carries no anchor');
    r = await suggest();
    expectSame([r.status, r.j.created.length, r.j.skipped.length], [200, 0, 3], 'a second press skips all three, never duplicates');
    r = await call(STD, 'POST', '/api/fssai/temp-standards', { action: 'create', code: 'TEMP-COOLING', label: 'dupe', applies_to: 'cooling', max_value: 5, max_minutes: 240 });
    expectSame([r.status, r.j.code], [409, 'duplicate_code'], 'a real reused code is still refused 409 duplicate_code');
    // A constraint that is NOT a duplicate must never be dressed up as one.
    db.prepare(`CREATE TRIGGER fssai_t_block BEFORE INSERT ON fssai_temp_standards WHEN NEW.label = 'FSSAI-T-TRIGGER'
                BEGIN SELECT RAISE(ABORT, 'fssai-tests constraint'); END`).run();
    r = await call(STD, 'POST', '/api/fssai/temp-standards', { action: 'create', code: 'T-TRIG', label: 'FSSAI-T-TRIGGER', applies_to: 'equipment', max_value: 5 });
    expectSame([r.status, r.j.code || null], [500, null], 'a non-UNIQUE constraint is a 500, not "duplicate"');
    for (const [label, body] of [
      ['a cooling rule with no temperature to reach', { label: 'No goal', applies_to: 'cooling', max_minutes: 240 }],
      ['an anchor on a level rule', { label: 'Fridge anchor', applies_to: 'equipment', max_value: 5, start_value: 10 }],
      ['a cooling anchor at or below its target', { label: 'Bad cool anchor', applies_to: 'cooling', max_value: 5, target_value: 5, max_minutes: 240, start_value: 4 }],
      ['a reheating anchor at or above its target', { label: 'Bad reheat anchor', applies_to: 'reheating', min_value: 75, max_minutes: 120, start_value: 80 }],
    ]) {
      r = await call(STD, 'POST', '/api/fssai/temp-standards', { action: 'create', ...body });
      expect(r.status, 400, `refused: ${label}`);
    }
  });

  await test('THE FAIL-OPEN CASE: a lone reading with minutes typed is judged against the rule’s anchor', async () => {
    await suggest();
    let r = await reading({ log_kind: 'cooling', value_num: 65, area_label: 'Kitchen', item_label: 'Curry B1', reading_at: '05:00', elapsed_minutes: 239 });
    expectSame([r.status, r.j.code], [400, 'action_taken_required'], '65 °C typed 239 min is a FAILURE — refused until the action is said (it used to PASS)');
    r = await reading({ log_kind: 'cooling', value_num: 65, area_label: 'Kitchen', item_label: 'Curry B1', reading_at: '05:00', elapsed_minutes: 239, action_taken: 'Binned the batch' });
    const rd = r.j.reading;
    expectSame([rd.is_judged, rd.is_fail, rd.curve_start_source, rd.curve_start_used, rd.curve_start_minute], [1, 1, 'standard_anchor', 60, 0], '65 @239 judged FAIL from the frozen 60 °C anchor');
    const ca = caOf(rd.id);
    expectTrue(!!ca && ca.title.indexOf('Curry B1') > -1 && ca.title.indexOf('Curry B1') < ca.title.indexOf('Kitchen'),
      `a corrective action was raised, naming the FOOD first: "${ca && ca.title}"`);
    const create = auditRows('fssai_temperature_logs', rd.id, 'create')[0];
    const after = create ? JSON.parse(create.after_json) : {};
    expectSame([after.curve_start_used, after.curve_start_minute, after.curve_start_source], [60, 0, 'standard_anchor'], 'the create audit row freezes where the line started');
    for (const [v, e, wantFail] of [[60, 230, 1], [40, 120, 1], [30, 60, 0], [5, 100, 0]]) {
      r = await reading({ log_kind: 'cooling', value_num: v, area_label: 'Kitchen', item_label: `Lone ${v}@${e}`, reading_at: '05:00', elapsed_minutes: e, action_taken: wantFail ? 'Moved to the blast chiller' : '' });
      expectSame([r.status, r.j.reading && r.j.reading.is_judged, r.j.reading && r.j.reading.is_fail], [200, 1, wantFail], `lone ${v} °C typed ${e} min → ${wantFail ? 'FAIL (behind the line from 60 °C)' : 'on schedule'}`);
    }
  });

  await test('NO ANCHOR fails CLOSED — a part-way reading short of the target is never passed', async () => {
    await suggest();
    let r = await setAnchor('TEMP-COOLING', null);
    expectSame([r.status, stdRow('TEMP-COOLING').start_value], [200, null], 'the anchor is cleared');
    r = await reading({ log_kind: 'cooling', value_num: 30, area_label: 'Kitchen', item_label: 'No anchor D1', reading_at: '07:00', elapsed_minutes: 60, action_taken: 'Rechecked the probe' });
    expectSame([r.j.reading.is_judged, r.j.reading.is_fail, r.j.reading.curve_start_source], [1, 1, ''], '30 °C typed 60 min with no anchor → FAIL (it used to pass)');
    r = await reading({ log_kind: 'cooling', value_num: 4, area_label: 'Kitchen', item_label: 'No anchor D2', reading_at: '07:00', elapsed_minutes: 60 });
    expectSame([r.j.reading.is_judged, r.j.reading.is_fail], [1, 0], '4 °C typed 60 min reached the target — a real pass');
    r = await reading({ log_kind: 'cooling', value_num: 70, area_label: 'Kitchen', item_label: 'No anchor D3', reading_at: '07:00' });
    const d3 = r.j.reading;
    expectSame([d3.is_fail, d3.elapsed_minutes, d3.curve_start_source, d3.curve_start_used, d3.verdict_word, d3.minutes_words], [0, 0, 'first_reading', 70, 'On schedule', '0 of 240'],
      'a 0-minute first reading starts its own line, and reads "On schedule", "0 of 240"');
    r = await reading({ log_kind: 'cooling', value_num: 50, area_label: 'Kitchen', item_label: 'No anchor D3', reading_at: '08:00' });
    expectSame([r.j.reading.curve_id, r.j.reading.is_fail, r.j.reading.schedule_value], [d3.id, 0, 53.7], '50 °C an hour later joins the batch, on schedule (needed ≤ 53.7)');
    r = await reading({ log_kind: 'cooling', value_num: 40, area_label: 'Kitchen', item_label: 'No anchor D3', reading_at: '09:00', action_taken: 'Ice bath' });
    expectSame([r.j.reading.is_fail, r.j.reading.schedule_value], [1, 37.5], '40 °C at 120 min is behind its own line (needed ≤ 37.5) → FAIL');
  });

  await test('REHEATING — the hot direction: below the rising line fails, ahead of it passes', async () => {
    await suggest();
    let r = await reading({ log_kind: 'reheating', value_num: 4, area_label: 'Line', item_label: 'Dal E1', reading_at: '10:00' });
    const e1 = r.j.reading;
    expectSame([e1.is_fail, e1.curve_start_source, e1.verdict_word], [0, 'first_reading', 'On schedule'], 'a reheat batch starts from its own 0-minute reading');
    r = await reading({ log_kind: 'reheating', value_num: 35, area_label: 'Line', item_label: 'Dal E1', reading_at: '11:00', action_taken: 'Turned the burner up' });
    expectSame([r.j.reading.curve_id, r.j.reading.is_fail, r.j.reading.schedule_value], [e1.id, 1, 39.5], '35 °C at 60 min is BELOW the rising line (needed ≥ 39.5) → FAIL');
    expectTrue(/^Reheating behind schedule/.test((caOf(r.j.reading.id) || {}).title || ''), 'and raises "Reheating behind schedule"');
    r = await reading({ log_kind: 'reheating', value_num: 76, area_label: 'Line', item_label: 'Dal E1', reading_at: '12:00' });
    expectSame([r.j.reading.is_fail, r.j.reading.elapsed_minutes, r.j.reading.verdict_word], [0, 120, 'In range'], '76 °C at 120 min reached 75 °C in time');
    r = await reading({ log_kind: 'reheating', value_num: 70, area_label: 'Line', item_label: 'Lone E3', reading_at: '10:00', elapsed_minutes: 90 });
    expectSame([r.j.reading.is_fail, r.j.reading.verdict_word], [0, 'On schedule'], 'a lone 70 °C typed 90 min is ahead of the line from the 5 °C anchor');
    r = await reading({ log_kind: 'reheating', value_num: 30, area_label: 'Line', item_label: 'Lone E2', reading_at: '10:00', elapsed_minutes: 90, action_taken: 'Kept heating' });
    expectSame([r.j.reading.is_fail, r.j.reading.curve_start_source], [1, 'standard_anchor'], 'a lone 30 °C typed 90 min is short of the line → FAIL');
    r = await reading({ log_kind: 'reheating', value_num: 60, area_label: 'Line', item_label: 'Lone E4', reading_at: '10:00', elapsed_minutes: 130, action_taken: 'Discarded' });
    expect(r.j.reading.is_fail, 1, '60 °C typed 130 min (past the 120 allowed) fails on the clock');
    await setAnchor('TEMP-REHEAT', null);
    r = await reading({ log_kind: 'reheating', value_num: 70, area_label: 'Line', item_label: 'Lone E5', reading_at: '10:00', elapsed_minutes: 90, action_taken: 'Kept heating' });
    expectSame([r.j.reading.is_judged, r.j.reading.is_fail], [1, 1], 'with no reheat anchor, a part-way reading short of 75 °C fails closed');
  });

  await test('A BATCH ACROSS MIDNIGHT is one curve; a post-midnight reading under the old date is refused', async () => {
    await suggest();
    let r = await reading({ log_kind: 'cooling', value_num: 72, area_label: 'Kitchen', item_label: 'Biryani F1', business_date: T_YDAY, reading_at: '23:30', backdate_reason: 'Last night’s batch' });
    const f1 = r.j.reading;
    r = await reading({ log_kind: 'cooling', value_num: 55, area_label: 'Kitchen', item_label: 'Biryani F1', reading_at: '00:30' });
    expectSame([r.j.reading.curve_id, r.j.reading.elapsed_minutes, r.j.reading.is_fail, r.j.reading.schedule_value], [f1.id, 60, 0, 55.2], 'after midnight it JOINS the batch: 60 minutes counted across the date change');
    r = await reading({ log_kind: 'cooling', value_num: 4, area_label: 'Kitchen', item_label: 'Biryani F1', reading_at: '03:30' });
    expectSame([r.j.reading.elapsed_minutes, r.j.reading.is_fail], [240, 0], 'reached 4 °C at minute 240: in time');
    signIn(MANAGER);
    const curve = await call(TEMP, 'GET', `/api/fssai/temperature?curve=${f1.id}`);
    expectSame([curve.j.curve.outcome, curve.j.readings.map((x) => x.elapsed_minutes)], ['reached_in_time', [0, 60, 240]], 'GET ?curve= reads the batch across midnight, in order');
    r = await reading({ log_kind: 'cooling', value_num: 70, area_label: 'Kitchen', item_label: 'Pulao F2', business_date: T_YDAY, reading_at: '23:40', backdate_reason: 'Last night’s batch' });
    const f2 = r.j.reading;
    r = await reading({ log_kind: 'cooling', value_num: 60, area_label: 'Kitchen', item_label: 'Pulao F2', business_date: T_YDAY, reading_at: '00:40', backdate_reason: 'Last night’s batch' });
    expectSame([r.status, r.j.code], [409, 'before_curve_start'], 'dated yesterday at 00:40 → refused (it used to start a new batch that passed at minute 0)');
    expectTrue(String(r.j.error).includes(`date it ${T_TODAY}`), 'and the refusal names the date it needs');
    r = await reading({ log_kind: 'cooling', value_num: 50, area_label: 'Kitchen', item_label: 'Pulao F2', curve_id: f2.id, reading_at: '00:40' });
    expectSame([r.status, r.j.reading.elapsed_minutes, r.j.reading.curve_id, r.j.reading.is_fail], [200, 60, f2.id, 0], 'dated today, it joins its batch at 60 minutes, on schedule');
  });

  await test('an ABANDONED batch reads as overdue (fssaiOpenCurves, which the escalation job reads)', async () => {
    await suggest();
    const r = await reading({ log_kind: 'cooling', value_num: 68, area_label: 'Kitchen', item_label: 'Abandoned G1', business_date: T_YDAY, reading_at: '05:00', backdate_reason: 'Found on the sheet' });
    const g1 = r.j.reading;
    const open = P4.fssaiOpenCurves(db, { today: T_TODAY, nowMinute: P4.fssaiClockMinute(T_TODAY, '10:00') });
    const og = open.find((c) => c.id === g1.id);
    expectSame([!!og, og && og.outcome, og && og.label], [true, 'overdue', 'Abandoned G1 · Kitchen'], 'the batch with no reading at the target is overdue');
    signIn(MANAGER);
    const g = await call(TEMP, 'GET', '/api/fssai/temperature?curves=open');
    expectTrue(g.status === 200 && g.j.curves.some((c) => c.id === g1.id), 'GET ?curves=open lists it');
    expectSame(P4.fssaiTempVerdictWord({ log_kind: 'cooling', is_judged: 1, is_fail: 0, value_num: 68, max_used: 5 }), 'On schedule', 'fssaiTempVerdictWord never says "In range" for a cooling reading above its target');
  });

  /* ─────────────────────────────────────────────────────────────────────── */
  section(8, 'THE FOOD-HANDLER REGISTER — who is covered, who is NOT, by name (#55 #56 #106 #107)');

  const FH = route('documents/food-handlers');
  const DOCS = route('documents');
  const FHL = lib('fssai-food-handlers.ts');
  const D_TODAY = F.fssaiToday();
  const plus = (n) => F.addDaysISO(D_TODAY, n);
  const fhGet = async (q = '') => { signIn(MANAGER); return (await call(FH, 'GET', `/api/fssai/documents/food-handlers${q}`)).j; };
  const fhPost = (body, who = MANAGER) => { signIn(who); return call(FH, 'POST', '/api/fssai/documents/food-handlers', body); };
  const docPost = (body, who = MANAGER) => { signIn(who); return call(DOCS, 'POST', '/api/fssai/documents', body); };
  /** File a certificate and (by default) its scan — the scan by the ADMIN, so a manager is never the uploader. */
  async function fileCert(body, scan = true) {
    const r = await docPost({ action: 'create', ...body });
    if (r.status === 200 && scan) await docPost({ action: 'attach', id: r.j.document.id, data_uri: png(body.title) }, ADMIN);
    return r;
  }
  const covOf = (j, id) => j.handlers.find((h) => h.id === id);

  await test('a cook with NO login is on the register, and a certificate counts only with a live scan', async () => {
    seedUsers();
    let j = await fhGet();
    expectTrue(j.available === true && j.handlers.length === 0, 'an empty register answers');
    let r = await fhPost({ action: 'create', full_name: 'Ravi Kumar', designation: 'Tandoor cook', phone10: '+91 98480 12345', joined_on: '2025-04-01' });
    expectSame([r.status, r.j.handler.handler_no, r.j.handler.key_kind, r.j.handler.phone10], [200, 'FH-0001', 'name_only', '9848012345'], 'name-only row (Q18: the name alone is legal)');
    const RAVI = r.j.handler.id;
    r = await docPost({ action: 'create', doc_type: 'medical_fitness', title: 'Medical — Ravi', person_email: 'ravi@nowhere.example', expiry_date: plus(200) });
    expect(r.status, 400, 'a person_email that is not a login is refused (file it against the register instead)');
    r = await fileCert({ doc_type: 'medical_fitness', title: 'Medical fitness — Ravi Kumar', handler_id: RAVI, issued_on: plus(-100), expiry_date: plus(265) }, false);
    expectSame([r.status, r.j.document.handler_id, r.j.document.holder_label], [200, RAVI, 'Ravi Kumar (FH-0001)'], 'a certificate filed against the handler, holder named');
    const MED = r.j.document.id;
    j = await fhGet();
    expectSame([covOf(j, RAVI).coverage.medical.verdict, covOf(j, RAVI).coverage.medical.in_order], ['no_copy', false], 'before a scan: medical is NOT in order (no copy)');
    expectTrue(j.not_in_order.medical.some((x) => x.id === RAVI) && j.not_in_order.training.some((x) => x.id === RAVI),
      'not_in_order NAMES Ravi under medical and training — a person with no certificate is a row');
    await docPost({ action: 'attach', id: MED, data_uri: png('ravi-med') }, ADMIN);
    j = await fhGet();
    expectSame([covOf(j, RAVI).coverage.medical.verdict, covOf(j, RAVI).coverage.medical.in_order], ['valid', true], 'after the scan: medical valid');
    // VOIDED scans never count as a copy.
    const att = db.prepare(`SELECT id FROM fssai_attachments WHERE entity_table = 'fssai_documents' AND entity_id = ? AND status <> 'void'`).get(MED);
    r = await docPost({ action: 'void_file', id: MED, attachment_id: att.id, reason: 'The scan was of the wrong person' }, MANAGER2);
    expect(r.status, 200, 'another manager voids the scan');
    j = await fhGet();
    expect(covOf(j, RAVI).coverage.medical.verdict, 'no_copy', 'with its only scan VOIDED the certificate has no copy again');
  });

  await test('expiry rules: medical/FoSTaC with no expiry is NOT in order, training is; FoSTaC counts as training', async () => {
    seedUsers();
    const S = (await fhPost({ action: 'create', full_name: 'Store Supervisor', is_fostac_supervisor: 1 })).j.handler.id;
    await fileCert({ doc_type: 'medical_fitness', title: 'Medical — no date', handler_id: S, expiry_date: '' });
    await fileCert({ doc_type: 'food_handler_training', title: 'Training — no date', handler_id: S, expiry_date: '' });
    let h = covOf(await fhGet(), S);
    expectSame([h.coverage.medical.verdict, h.coverage.medical.in_order], ['no_expiry', false], 'medical with no expiry date');
    expectSame([h.coverage.training.verdict, h.coverage.training.in_order], ['no_expiry', true], 'training with no expiry date');
    await fileCert({ doc_type: 'food_handler_training', title: 'Training — ending soon', handler_id: S, issued_on: plus(-355), expiry_date: plus(10) });
    const A = (await fhPost({ action: 'create', full_name: 'Anil Sous Chef', is_food_handler: 1 })).j.handler.id;
    await fileCert({ doc_type: 'fostac_certificate', title: 'FoSTaC Basic — Anil', handler_id: A, expiry_date: plus(500) });
    h = covOf(await fhGet(), A);
    expectSame([h.coverage.training.verdict, h.coverage.training.best && h.coverage.training.best.doc_type], ['valid', 'fostac_certificate'], 'a FoSTaC certificate satisfies TRAINING');
    const old = await fileCert({ doc_type: 'medical_fitness', title: 'Medical — lapsed', handler_id: A, issued_on: plus(-400), expiry_date: plus(-3) });
    h = covOf(await fhGet(), A);
    expectSame([h.coverage.medical.verdict, h.coverage.medical.in_order], ['expired', false], 'a lapsed medical is expired');
    const ren = await docPost({ action: 'renew', id: old.j.document.id, issued_on: D_TODAY, expiry_date: plus(365) });
    expectSame([ren.status, ren.j.document.handler_id], [200, A], 'a renewal keeps the same person');
    h = covOf(await fhGet(), A);
    expect(h.coverage.medical.verdict, 'no_copy', 'the renewed version has no scan yet — the SUPERSEDED one never counts');
    const r = await fhPost({ action: 'create', full_name: 'Nobody Special', is_food_handler: 0, is_fostac_supervisor: 0 });
    expect(r.status, 400, 'neither a food handler nor the supervisor is refused');
  });

  await test('FoSTaC: at least ONE certified supervisor per 25 food handlers', async () => {
    seedUsers();
    let j = await fhGet();
    const S = (await fhPost({ action: 'create', full_name: 'Head Supervisor', is_fostac_supervisor: 1 })).j.handler.id;
    j = await fhGet();
    expectSame([j.fostac.supervisors, j.fostac.certified, j.fostac.required, j.fostac.ok], [1, 0, 1, false], 'a supervisor with no certificate → not ok');
    await fileCert({ doc_type: 'fostac_certificate', title: 'FoSTaC Advanced — supervisor', handler_id: S, issued_on: plus(-30), expiry_date: plus(700) });
    j = await fhGet();
    expectSame([j.fostac.certified, j.fostac.ok], [1, true], 'one certified supervisor for up to 25 handlers → ok');
    const n = j.totals && j.totals.active !== undefined ? j.totals.active : j.handlers.length;
    for (let i = n; i < 26; i++) await fhPost({ action: 'create', full_name: `Handler ${String(i).padStart(2, '0')}` });
    j = await fhGet();
    expectSame([j.fostac.required, j.fostac.ok], [2, false], `26 food handlers need 2 certified supervisors — 1 is not enough (${j.fostac.words})`);
  });

  await test('one person, one row: LEFT keeps the row; a re-add is 409; Rejoined reactivates the SAME row', async () => {
    seedUsers();
    db.prepare(`INSERT INTO hr_employees (id, employee_code, full_name, status) VALUES ('fh-t-emp-1', 'T-EMP-1', 'Suresh Babu', 'active')`).run();
    db.prepare(`INSERT INTO hr_employees (id, employee_code, full_name, status, exit_date) VALUES ('fh-t-emp-2', 'T-EMP-2', 'Gone Person', 'resigned', '2026-09-01')`).run();
    let r = await fhPost({ action: 'import', source: 'hrms', ids: ['fh-t-emp-1', 'fh-t-emp-2'] });
    expectSame([r.status, r.j.created.length, r.j.skipped.length], [200, 1, 1], 'import from HRMS: the active one added, the resigned one skipped');
    const SURESH = r.j.created[0].id;
    expect(r.j.created[0].key_kind, 'hrms', 'keyed by the HRMS employee_id');
    r = await fhPost({ action: 'create', employee_id: 'fh-t-emp-1', full_name: 'Suresh again' });
    expectSame([r.status, r.j.code], [409, 'already_on_register'], 'the same HR record twice');
    r = await fhPost({ action: 'leave', id: SURESH, left_on: plus(5) });
    expect(r.status, 400, 'a leaving date in the future');
    r = await fhPost({ action: 'leave', id: SURESH, left_on: D_TODAY, note: 'Resigned' });
    expectSame([r.status, r.j.handler.status], [200, 'left'], 'has left');
    expectTrue(!covOf(await fhGet(), SURESH) && !!covOf(await fhGet('?include_left=1'), SURESH), 'off the active register, still there with include_left');
    r = await fhPost({ action: 'create', employee_id: 'fh-t-emp-1' });
    expectSame([r.status, r.j.code, r.j.existing_id], [409, 'left_row_exists', SURESH], 're-adding the person who left → 409 left_row_exists');
    r = await fhPost({ action: 'rejoin', id: SURESH, note: 'Came back' });
    expectSame([r.status, r.j.handler.id, r.j.handler.status], [200, SURESH, 'active'], 'Rejoined → the SAME row, active');
    expect(db.prepare(`SELECT COUNT(*) AS c FROM fssai_food_handlers WHERE employee_id = 'fh-t-emp-1'`).get().c, 1, 'rows for that employee');
    r = await fhPost({ action: 'create', full_name: 'Suresh Babu' });
    expectTrue(r.status === 200 && (r.j.warnings || []).length > 0, `a duplicate NAME warns, never refuses (Q16): "${(r.j.warnings || [])[0]}"`);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM hr_employees`).get().c, 2, 'HRMS rows (read, never written)');
  });

  await test('a row entered by MISTAKE is voided — never by the manager who added it; the row stays', async () => {
    seedUsers();
    const X = (await fhPost({ action: 'create', full_name: 'Typo Persn' })).j.handler.id;
    let r = await fhPost({ action: 'void', id: X, reason: 'Duplicate of Ravi' });
    expectTrue(r.status === 403 && /yourself/.test(r.j.error), `the manager who added the row → ${r.status}`);
    r = await fhPost({ action: 'void', id: X, reason: 'x' }, MANAGER2);
    expect(r.status, 400, 'no real reason');
    const before = count('fssai_food_handlers');
    r = await fhPost({ action: 'void', id: X, reason: 'Entered twice — same person as Ravi' }, MANAGER2);
    const row = db.prepare('SELECT status, voided_by, void_reason FROM fssai_food_handlers WHERE id = ?').get(X);
    expectSame([r.status, row.status, row.voided_by, count('fssai_food_handlers')], [200, 'void', MANAGER2.email, before], 'another manager voids it; the row is kept');
    expectTrue(auditRows('fssai_food_handlers', X, 'void').length === 1, 'one void row in fssai_audit_log');
    r = await docPost({ action: 'create', doc_type: 'medical_fitness', title: 'Medical — typo', handler_id: X, expiry_date: plus(100) });
    expect(r.status, 400, 'a certificate cannot be filed against a voided person');
    const Y = (await fhPost({ action: 'create', full_name: 'Second Typo' })).j.handler.id;
    signIn(ADMIN);
    r = await call(VOID_ROUTE, 'POST', '/api/fssai/void', { entity_table: 'fssai_food_handlers', id: Y, reason: 'Misspelt duplicate row' });
    expectSame([r.status, r.j.status], [200, 'void'], 'the generic /api/fssai/void handles the register too');
  });

  await test('the HRMS training link: completions joined LIVE; switching it off needs a reason; never medical', async () => {
    seedUsers();
    db.prepare(`INSERT INTO hr_employees (id, employee_code, full_name, status) VALUES ('fh-t-emp-3', 'T-EMP-3', 'Lakshmi P', 'active')`).run();
    db.prepare(`INSERT INTO hr_trainings (id, name) VALUES ('fh-t-train', 'Food Safety Basics (test)')`).run();
    db.prepare(`INSERT INTO hr_training_assignments (id, training_id, employee_id, completed_date, status) VALUES ('fh-t-ta', 'fh-t-train', 'fh-t-emp-3', ?, 'completed')`).run(plus(-30));
    const L = (await fhPost({ action: 'import', source: 'hrms', ids: ['fh-t-emp-3'] })).j.created[0].id;
    expect(covOf(await fhGet(), L).coverage.training.verdict, 'missing', 'before the mapping the HRMS completion does not count');
    let r = await fhPost({ action: 'link_training', hr_training_id: 'fh-t-train', counts_as: 'food_handler_training', valid_months: 12 });
    expectSame([r.status, r.j.link.completions], [200, 1], 'map the HRMS training');
    const LINK = r.j.link.id;
    const h = covOf(await fhGet(), L);
    expectSame([h.coverage.training.in_order, h.coverage.training.best && h.coverage.training.best.source], [true, 'hrms'], 'the completion now counts as training');
    r = await fhPost({ action: 'link_training', hr_training_id: 'fh-t-train', counts_as: 'food_handler_training' });
    expectSame([r.status, r.j.code], [409, 'link_exists'], 'the same training mapped twice');
    r = await fhPost({ action: 'update_link', id: LINK, counts_as: 'medical_fitness' });
    expect(r.status, 400, 'an HRMS training can never count as a MEDICAL');
    r = await fhPost({ action: 'update_link', id: LINK, is_active: 0 });
    expect(r.status, 400, 'switching it off with no reason');
    r = await fhPost({ action: 'update_link', id: LINK, is_active: 0, reason: 'HR renamed the course' });
    expectSame([r.status, covOf(await fhGet(), L).coverage.training.verdict], [200, 'missing'], 'switched off with a reason → the completion stops counting');
    expect(auditRows('fssai_training_links', LINK).length, 2, 'create + update on the mapping, both audited');
    expect(db.prepare('SELECT COUNT(*) AS c FROM hr_training_assignments').get().c, 1, 'HRMS assignments (never written)');
  });

  await test('gates, the CSV (formula cells escaped) and the holder names for Inspection Mode', async () => {
    seedUsers();
    const R = (await fhPost({ action: 'create', full_name: 'Ravi Kumar' })).j.handler.id;
    await fhPost({ action: 'create', full_name: '=HYPERLINK("http://x")' });
    signIn(STAFF);
    expect((await call(FH, 'GET', '/api/fssai/documents/food-handlers')).status, 403, 'staff GET');
    expect((await call(FH, 'POST', '/api/fssai/documents/food-handlers', { action: 'create', full_name: 'Sneaky' })).status, 403, 'staff POST');
    signIn(null);
    expect((await call(FH, 'GET', '/api/fssai/documents/food-handlers')).status, 401, 'signed out');
    signIn(MANAGER);
    expect((await call(FH, 'POST', '/api/fssai/documents/food-handlers', { action: 'create', full_name: 'No CSRF' }, { csrf: false })).status, 403, 'no CSRF pair');
    const csv = await call(FH, 'GET', '/api/fssai/documents/food-handlers?format=csv');
    const lines = csv.text.split('\r\n');
    expectTrue(csv.status === 200 && lines.some((l) => l.includes('Ravi Kumar')), 'the CSV lists the register');
    expectTrue(lines.some((l) => l.includes(`"'=HYPERLINK`)), 'a name starting with "=" is written as text, not a formula');
    const holders = FHL.fssaiDocumentHolders(db, [{ id: 'd1', handler_id: R, person_email: '' }]);
    expect(holders.get('d1').label, 'Ravi Kumar (FH-0001)', 'fssaiDocumentHolders labels whose certificate it is');
    const cov = FHL.readFssaiFoodHandlerCoverage(db, { today: D_TODAY });
    expectTrue(cov.available && cov.not_in_order.medical.some((x) => /Ravi Kumar/.test(x.full_name || x.name || x.label || '')),
      'readFssaiFoodHandlerCoverage (the audit file reads this) names Ravi as not in order');
  });

  /* @@NEW_SECTIONS@@ */

  /* ── summary ─────────────────────────────────────────────────────────────── */
  console.log(`\n${pass} passed · ${fail} failed`);
  if (skippedSections.length) console.log(`(--only: sections ${skippedSections.join(', ')} were not run)`);
  if (FETCH.calls.length) console.log(`network calls caught by the tripwire: ${FETCH.calls.length}`);
  if (fail) {
    console.log('failing:');
    failures.forEach((f) => console.log(`  · ${f}`));
  }
  try { db.close(); } catch { /* already closed */ }
  if (KEEP && ROUTE_SAID.length) console.log(`\nroutes logged ${ROUTE_SAID.length} line(s):\n  ` + ROUTE_SAID.slice(0, 200).join('\n  '));
  if (KEEP) console.log(`\nscratch kept at ${TMP}`);
  else fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\nFATAL — the suite itself crashed:', (e && e.stack) || e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(2);
});
