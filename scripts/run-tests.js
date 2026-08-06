#!/usr/bin/env node
/**
 * THE INVARIANT SUITE FOR DEPARTMENT-BASED INVENTORY.
 *
 * Run with:  node scripts/run-tests.js     (also: npm test)
 *
 * ── IT NEVER TOUCHES THE REPO DATABASE ─────────────────────────────────────
 * Every test runs against a VACUUM INTO snapshot of fnb-controller.db taken
 * through a READONLY handle, written into a fresh os.tmpdir() directory. The
 * suite then process.chdir()s into that directory BEFORE requiring src/lib/db.ts,
 * because db.ts resolves its DB_PATH from process.cwd(). assertSandboxed() below
 * re-reads the handle's own filename and aborts the whole run if it is not
 * inside the temp dir — a guard, not a comment, because the failure mode it
 * prevents (a test writing synthetic stock movements into the owner's live
 * inventory) is silent and unrecoverable.
 *
 * The snapshot is the point. These tests move stock, throw reversals and fuzz a
 * ledger; doing that inside a SAVEPOINT on the live file would still be one
 * mis-typed ROLLBACK away from corrupting real stock, and a crashed run would
 * leave the savepoint open.
 *
 * ── IT EXERCISES THE REAL CODE, NOT A RE-IMPLEMENTATION ────────────────────
 * The old version of this file simulated each rule in hand-written SQL
 * ("UPDATE raw_materials SET current_stock = current_stock - 0.5"). That can
 * only ever prove the test's own arithmetic. These tests call the shipped
 * functions — applyIssueDelta, deductInventoryForSale, postDeptLedger,
 * resolveStationDepartment, lineHasMovedStock — through a TypeScript require
 * hook built on the `typescript` devDependency (no tsx, no network, nothing new
 * in package.json). If a future engineer re-points applyDeduct at central, or
 * restores the deduct-at-issue flag, test 3 fails here rather than in service.
 *
 * ── THE TEN THIS CHANGE LIVES OR DIES ON ───────────────────────────────────
 *   1  ISSUE MOVES ONCE          central −5000, department +5000, one row each
 *   2  CONSUMPTION MOVES ONCE    department −2000, CENTRAL UNCHANGED
 *   3  NO DOUBLE REMOVAL         issue+consume ⇒ central fell 5000, never 7000
 *   4  REVERSAL REFUSES          over-reversal throws AND rolls the caller back
 *   5  FULL REVERSAL             central restored, department 0, guard clears
 *   6  UNMAPPED STATION          zero movement on both rails, one skip row
 *   7  LIQUOR CARVE-OUT          neither rail moves, skip_reason 'store_mapped'
 *   8  PACK FACTOR               PICKLED GINGER 1.5KG must NOT convert
 *   9  CACHE == TRUTH            on_hand equals the ledger sum after 100 moves
 *  10  NO BACKFILL               boot adds zero department movements
 *
 * PART B keeps the five arithmetic checks this file has always carried
 * (weighted-average price, recipe math, GRN accept/reject, closing variance,
 * reset credit-back). They are unchanged in substance — only re-pointed at the
 * snapshot — because deleting shipped coverage to make room for new coverage is
 * not a trade this repo makes.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const REPO = path.resolve(__dirname, '..');
const LIVE_DB = path.join(REPO, 'fnb-controller.db');
const SRC = path.join(REPO, 'src');
const KEEP = process.argv.includes('--keep');

/* ────────────────────────────────────────────────────────────────────────────
 * 0. THE SNAPSHOT
 * ──────────────────────────────────────────────────────────────────────────*/

if (!fs.existsSync(LIVE_DB)) {
  console.error(`run-tests: ${LIVE_DB} not found — nothing to snapshot.`);
  process.exit(2);
}

// realpathSync because macOS hands back /var/... while process.cwd() and
// better-sqlite3's db.name report the resolved /private/var/... — the sandbox
// guard below compares those strings and would abort on the symlink alone.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-tests-')));
// The filename MUST be fnb-controller.db: db.ts hardcodes that basename against
// process.cwd(), and the chdir below is what re-points it at this copy.
const SNAP = path.join(TMP, 'fnb-controller.db');
{
  // readonly:true is the belt; VACUUM INTO is the braces — it is documented as
  // read-only with respect to the source file, and unlike a byte copy it folds
  // the WAL in, so the snapshot is a consistent point-in-time image even if the
  // dev server is mid-write.
  const src = new Database(LIVE_DB, { readonly: true });
  src.exec(`VACUUM INTO '${SNAP.replace(/'/g, "''")}'`);
  src.close();
}

// Counts read BEFORE any migration runs. Test 10 compares against these.
const preBoot = (() => {
  const h = new Database(SNAP, { readonly: true });
  const one = (sql) => { try { return Number(h.prepare(sql).get().c) || 0; } catch { return -1; } };
  const out = {
    deptTxns: one('SELECT COUNT(*) c FROM department_material_transactions'),
    deptMats: one('SELECT COUNT(*) c FROM department_materials'),
    issuedLines: one('SELECT COUNT(*) c FROM requisition_items WHERE quantity_issued > 0'),
  };
  h.close();
  return out;
})();

process.chdir(TMP);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE TYPESCRIPT LOADER
 * ──────────────────────────────────────────────────────────────────────────*/

const ts = require(path.join(REPO, 'node_modules', 'typescript'));
const Module = require('module');

// tsconfig's `@/*` → `./src/*`. Resolved here rather than by copying paths into
// the tests, so `import { packFactor } from '@/lib/pack-units'` inside the app
// code loads the same file the bundler would.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    request = path.join(SRC, request.slice(2));
  }
  return origResolve.call(this, request, ...rest);
};

// Registering '.ts' also teaches Node's resolver to try `./dept-ledger.ts` for
// a bare `require('./dept-ledger')`, which is how the app's own relative
// imports resolve here.
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

const lib = (rel) => require(path.join(SRC, 'lib', rel));

const dbMod = lib('db.ts');
const { deductInventoryForSale, generateId } = dbMod;
const { applyIssueDelta, lineHasMovedStock } = lib('issue-stock.ts');
const {
  postDeptLedger, resolveStationDepartment, deptOnHand, isDeptReversalBlocked,
} = lib('dept-ledger.ts');
const { packFactor } = lib('pack-units.ts');

// getDb() runs initializeSchema — i.e. the boot migrations — against the copy.
const db = dbMod.getDb();

/**
 * THE SANDBOX GUARD. Not paranoia: a stray edit to db.ts's DB_PATH, or a chdir
 * that silently failed, would point every write below at the owner's live
 * inventory, and the damage (synthetic issues, consumptions, a 100-movement
 * fuzz) would be indistinguishable from real stock movement afterwards. Abort
 * hard; never "warn and continue".
 */
function assertSandboxed() {
  const open = path.resolve(db.name || '');
  if (path.resolve(LIVE_DB) === open || !open.startsWith(path.resolve(TMP))) {
    console.error(`\nFATAL: tests opened ${open}, which is not the snapshot in ${TMP}. Aborting.`);
    process.exit(3);
  }
}
assertSandboxed();

/* ────────────────────────────────────────────────────────────────────────────
 * 2. HARNESS
 * ──────────────────────────────────────────────────────────────────────────*/

const EPS = 1e-6;
let pass = 0, fail = 0;
const failures = [];

function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function bad(label, detail) {
  fail++; failures.push(label);
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`      ${detail}`);
}
function expect(actual, expected, label, hint) {
  const a = Number(actual), e = Number(expected);
  if (Number.isFinite(a) && Number.isFinite(e) && Math.abs(a - e) < EPS) ok(`${label} — ${a}`);
  else bad(label, `expected ${expected}, got ${actual}${hint ? `\n      ${hint}` : ''}`);
}
function expectTrue(cond, label, hint) { cond ? ok(label) : bad(label, hint); }

function section(n, title) { console.log(`\n[${n}] ${title}`); }

/**
 * Each test owns a SAVEPOINT so the next one starts from the snapshot as
 * booted. better-sqlite3's own db.transaction() nests as a SAVEPOINT inside
 * this one, which is what lets test 4 prove a caller's transaction unwinds.
 * A throwing test rolls back and keeps going — one broken invariant must not
 * hide the other nine.
 */
function test(name, fn) {
  const sp = 'sp_' + Math.random().toString(36).slice(2, 10);
  db.exec(`SAVEPOINT ${sp}`);
  try { fn(); }
  catch (e) { bad(`${name} — threw`, String((e && e.stack) || e)); }
  finally {
    try { db.exec(`ROLLBACK TO SAVEPOINT ${sp}`); db.exec(`RELEASE SAVEPOINT ${sp}`); }
    catch (e) { bad(`${name} — savepoint unwind failed`, String(e)); }
  }
}

const uid = () => 'test-' + Math.random().toString(36).slice(2, 12);

/* ── fixtures ───────────────────────────────────────────────────────────── */

function mkDept(name) {
  const id = uid();
  db.prepare(`INSERT INTO departments (id, name, code, is_active) VALUES (?, ?, 'TST', 1)`).run(id, name);
  return id;
}

function mkMaterial(o) {
  const id = uid();
  db.prepare(`
    INSERT INTO raw_materials (id, name, category, unit, purchase_unit, pack_size, current_stock, average_price)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, o.name || 'TEST MAT ' + id, o.category || 'grocery', o.unit || 'g',
         o.purchase_unit || 'kg', o.pack_size == null ? 1000 : o.pack_size,
         o.current_stock == null ? 100000 : o.current_stock, o.average_price || 1);
  return id;
}

function mkReq(deptId, purpose) {
  const id = uid();
  db.prepare(`
    INSERT INTO requisitions (id, req_number, department_id, date, status, purpose)
    VALUES (?, ?, ?, date('now'), 'approved', ?)
  `).run(id, 'REQ-TEST-' + id, deptId, purpose || 'internal');
  return id;
}

function mkLine(reqId, matId, o) {
  const id = uid();
  db.prepare(`
    INSERT INTO requisition_items (id, req_id, material_id, quantity_requested, quantity_issued, unit, department_id)
    VALUES (?,?,?,?,0,?,?)
  `).run(id, reqId, matId, o.requested, o.unit, o.departmentId || null);
  return id;
}

function mkRecipe(matId, o) {
  const recipeId = uid();
  db.prepare(`INSERT INTO recipes (id, name, category, is_active) VALUES (?, ?, 'test', 1)`)
    .run(recipeId, 'TEST RECIPE ' + recipeId);
  db.prepare(`
    INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity, unit, yield_percent, wastage_percent, is_default)
    VALUES (?,?,?,?,?,100,0,1)
  `).run(uid(), recipeId, matId, o.quantity, o.unit);
  return recipeId;
}

/** Map a station at the department the test just made. Rolled back with it. */
function mapStation(station, deptId) {
  db.prepare(`
    INSERT INTO station_departments (station, department_id, is_active, note)
    VALUES (?, ?, 1, 'run-tests fixture')
    ON CONFLICT(station) DO UPDATE SET department_id = excluded.department_id, is_active = 1
  `).run(station, deptId);
}

/* ── the two real callers, reproduced faithfully ─────────────────────────── */

/**
 * store-issue's shape: INCREMENTAL, and it writes quantity_issued BEFORE
 * calling applyIssueDelta, inside one transaction. That ordering is the whole
 * reason the reversal guard must throw instead of clamping, so the tests must
 * not "tidy" it into calling applyIssueDelta first.
 */
function issue(itemId, addQty, reason) {
  return db.transaction(() => {
    const before = Number(db.prepare('SELECT quantity_issued q FROM requisition_items WHERE id = ?').get(itemId).q) || 0;
    const after = before + Number(addQty);
    db.prepare('UPDATE requisition_items SET quantity_issued = ? WHERE id = ?').run(after, itemId);
    return applyIssueDelta(db, {
      reqItemId: itemId, beforeLineQty: before, afterLineQty: after,
      reason: reason || 'issue', actor: 'run-tests',
    });
  })();
}

/** store-issue's updUndo: zeroes the column and blanks the history, then calls in. */
function undoIssue(itemId) {
  return db.transaction(() => {
    const before = Number(db.prepare('SELECT quantity_issued q FROM requisition_items WHERE id = ?').get(itemId).q) || 0;
    db.prepare(`UPDATE requisition_items SET quantity_issued = 0, issue_history = '[]' WHERE id = ?`).run(itemId);
    return applyIssueDelta(db, {
      reqItemId: itemId, beforeLineQty: before, afterLineQty: 0,
      reason: 'undo', actor: 'run-tests',
    });
  })();
}

/** A KOT completing: one sales row, then the recipe consumption for that line. */
function sell(recipeId, qty, station, billType) {
  const saleId = uid();
  db.prepare(`
    INSERT INTO sales (id, item_name, recipe_id, quantity_sold, bill_type, selling_price, total_revenue, total_cost, date)
    VALUES (?, 'Test Dish', ?, ?, ?, 0, 0, 0, date('now'))
  `).run(saleId, recipeId, qty, billType || 'normal');
  deductInventoryForSale(db, recipeId, qty, saleId, billType || 'normal', {
    station, orderItemId: 'oi-' + saleId,
  });
  return saleId;
}

/* ── readers ─────────────────────────────────────────────────────────────── */

const central = (matId) =>
  Number(db.prepare('SELECT current_stock c FROM raw_materials WHERE id = ?').get(matId).c) || 0;

const deptSum = (deptId, matId) =>
  Number(db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) s FROM department_material_transactions
     WHERE department_id = ? AND material_id = ?
  `).get(deptId, matId).s) || 0;

const deptRows = (deptId, matId) =>
  Number(db.prepare(`
    SELECT COUNT(*) c FROM department_material_transactions
     WHERE department_id = ? AND material_id = ?
  `).get(deptId, matId).c) || 0;

const deptCache = (deptId, matId) => {
  const r = db.prepare('SELECT on_hand FROM department_materials WHERE department_id = ? AND material_id = ?')
    .get(deptId, matId);
  return r ? Number(r.on_hand) || 0 : 0;
};

const ledgerRows = (reqItemId) =>
  Number(db.prepare('SELECT COUNT(*) c FROM requisition_issue_ledger WHERE req_item_id = ?').get(reqItemId).c) || 0;

const invTxns = (matId, type) =>
  Number(db.prepare('SELECT COUNT(*) c FROM inventory_transactions WHERE material_id = ? AND type = ?')
    .get(matId, type).c) || 0;

const skipRows = (matId) =>
  db.prepare('SELECT station, reason, quantity FROM consumption_skips WHERE material_id = ?').all(matId);

const issuedQty = (itemId) =>
  Number(db.prepare('SELECT quantity_issued q FROM requisition_items WHERE id = ?').get(itemId).q) || 0;

/* ────────────────────────────────────────────────────────────────────────────
 * PART A — THE DEPARTMENT-INVENTORY INVARIANTS
 * ──────────────────────────────────────────────────────────────────────────*/

console.log(`\nsnapshot: ${SNAP}`);
console.log(`source:   ${LIVE_DB} (readonly, VACUUM INTO)`);

/* ── 1 ─────────────────────────────────────────────────────────────────────*/
section(1, 'ISSUE MOVES ONCE — central −5000 g, department +5000 g, one row on each rail');
test('issue-moves-once', () => {
  const dept = mkDept('TEST Kitchen 1');
  const mat = mkMaterial({ name: 'TEST CHICKEN', unit: 'g', purchase_unit: 'kg', pack_size: 1000, current_stock: 100000 });
  const req = mkReq(dept);
  const line = mkLine(req, mat, { requested: 10, unit: 'kg', departmentId: dept });

  const before = central(mat);
  const res = issue(line, 5);            // 5 kg, pack 1000 ⇒ 5000 recipe units

  expectTrue(res.applied === true, 'applyIssueDelta reports applied', `got ${JSON.stringify(res)}`);
  expect(res.deltaRecipeQty, 5000, 'delta in RECIPE units (5 kg × pack 1000)');
  expect(before - central(mat), 5000, 'central fell by exactly the issued quantity');
  expect(deptSum(dept, mat), 5000, 'department gained exactly the same quantity');
  expect(deptRows(dept, mat), 1, 'exactly ONE department ledger row');
  expect(ledgerRows(line), 1, 'exactly ONE requisition_issue_ledger row');
  expect(invTxns(mat, 'requisition_issue'), 1, 'exactly ONE inventory_transactions row');
  // The cache is written by the same call that writes the truth; a divergence
  // here means postDeptLedger's pair came apart.
  expect(deptCache(dept, mat), 5000, 'department_materials cache agrees with the ledger');
});

/* ── 2 ─────────────────────────────────────────────────────────────────────*/
section(2, 'CONSUMPTION MOVES ONCE — department −2000 g, CENTRAL UNCHANGED');
test('consumption-moves-once', () => {
  const dept = mkDept('TEST Kitchen 2');
  const mat = mkMaterial({ name: 'TEST PANEER', unit: 'g', purchase_unit: 'kg', pack_size: 1000, current_stock: 100000 });
  const station = 'teststation-' + uid();
  mapStation(station, dept);
  const req = mkReq(dept);
  const line = mkLine(req, mat, { requested: 10, unit: 'kg', departmentId: dept });
  issue(line, 5);

  const recipe = mkRecipe(mat, { quantity: 2000, unit: 'g' });
  const centralBefore = central(mat);
  const deptBefore = deptSum(dept, mat);

  sell(recipe, 1, station);

  expect(central(mat), centralBefore, 'CENTRAL UNTOUCHED by recipe consumption',
    'The gram left central at the ISSUE. A debit here is the second removal.');
  expect(deptSum(dept, mat) - deptBefore, -2000, 'department fell by exactly the recipe quantity');
  expect(deptRows(dept, mat), 2, 'one issue row + one consumption row');
  expect(invTxns(mat, 'sale'), 1,
    'inventory_transactions row STILL written — Variance and Sales-vs-Purchase read it');
  expect(skipRows(mat).length, 0, 'a resolved station records no skip');
  // The signed type vocabulary is what the audit reads; a negative 'issued'
  // would sum correctly and audit wrongly, which is why the type exists.
  const types = db.prepare(`
    SELECT type, quantity FROM department_material_transactions
     WHERE department_id = ? AND material_id = ? ORDER BY rowid
  `).all(dept, mat);
  expectTrue(types[1] && types[1].type === 'consumption' && types[1].quantity < 0,
    "consumption row is typed 'consumption' and signed negative", JSON.stringify(types));
});

/* ── 3 ─────────────────────────────────────────────────────────────────────*/
section(3, 'NO DOUBLE REMOVAL — issue 5 kg then consume 2 kg ⇒ central fell 5000, never 7000');
test('no-double-removal', () => {
  const dept = mkDept('TEST Kitchen 3');
  const mat = mkMaterial({ name: 'TEST LEG BONELESS', unit: 'g', purchase_unit: 'kg', pack_size: 1000, current_stock: 100000 });
  const station = 'teststation-' + uid();
  mapStation(station, dept);
  const req = mkReq(dept);
  const line = mkLine(req, mat, { requested: 10, unit: 'kg', departmentId: dept });
  const recipe = mkRecipe(mat, { quantity: 2000, unit: 'g' });

  const start = central(mat);
  issue(line, 5);
  sell(recipe, 1, station);
  const fell = start - central(mat);

  // THE HALVES-SPLIT DETECTOR. This change removed the deduct-at-issue flag in
  // issue-stock.ts AND re-pointed applyDeduct in db.ts at the department, and
  // all 131 recipe-ingredient materials are also requisition-issued. Ship one
  // half and this number is wrong in a way the arithmetic names for you.
  expectTrue(Math.abs(fell - 5000) < EPS, 'central fell EXACTLY 5000 (the issue), not 7000, not 2000',
    fell > 6000
      ? `central fell ${fell}. applyDeduct (src/lib/db.ts) is STILL debiting central — the two halves of ` +
        `the cutover have been split. Every gram is being removed twice.`
      : fell < 4000
        ? `central fell ${fell}. applyIssueDelta (src/lib/issue-stock.ts) did NOT debit central — the ` +
          `deduct-at-issue gate is back. Goods are leaving the store with no book entry.`
        : `central fell ${fell}, expected 5000.`);

  expect(deptSum(dept, mat), 3000, 'department holds 5000 issued − 2000 cooked');
  // Both audit trails still exist and still disagree about nothing.
  expect(invTxns(mat, 'requisition_issue'), 1, 'one issue transaction');
  expect(invTxns(mat, 'sale'), 1, 'one sale transaction');
});

/* ── 4 ─────────────────────────────────────────────────────────────────────*/
section(4, 'REVERSAL REFUSES — issue 5, consume 4, undo ⇒ throws AND the caller rolls back');
test('reversal-refuses', () => {
  const dept = mkDept('TEST Kitchen 4');
  const mat = mkMaterial({ name: 'TEST OIL', unit: 'g', purchase_unit: 'kg', pack_size: 1000, current_stock: 100000 });
  const station = 'teststation-' + uid();
  mapStation(station, dept);
  const req = mkReq(dept);
  const line = mkLine(req, mat, { requested: 10, unit: 'kg', departmentId: dept });
  const recipe = mkRecipe(mat, { quantity: 4000, unit: 'g' });

  issue(line, 5);
  sell(recipe, 1, station);              // department now holds 1000 of 5000

  const centralBefore = central(mat);
  const deptBefore = deptSum(dept, mat);
  const rowsBefore = deptRows(dept, mat);

  let threw = null;
  try { undoIssue(line); } catch (e) { threw = e; }

  expectTrue(threw !== null, 'the undo THREW rather than clamping',
    'A clamp commits a line reading "0 issued" against grams that never came back.');
  expectTrue(threw !== null && isDeptReversalBlocked(threw),
    'it threw DeptReversalBlocked (routes answer 409 from this)',
    threw ? String(threw.message || threw) : 'nothing thrown');
  // THE POINT OF THROWING. applyIssueDelta never opens a transaction, so the
  // caller's does the unwinding — quantity_issued must be exactly as it was.
  expect(issuedQty(line), 5, 'quantity_issued is STILL 5 — the caller transaction rolled back');
  expect(central(mat), centralBefore, 'central unchanged by the refused reversal');
  expect(deptSum(dept, mat), deptBefore, 'department unchanged by the refused reversal');
  expect(deptRows(dept, mat), rowsBefore, 'no reversal row was written');

  // And the refusal is legible: it names what the DEPARTMENT holds, never
  // "you consumed this line" — the cap is pooled per (dept, material) because
  // without lot tracking the grams are genuinely fungible.
  expectTrue(threw && /holds only/i.test(String(threw.message)),
    'the message names the department holding, not the line', threw ? String(threw.message) : '');
});

/* ── 5 ─────────────────────────────────────────────────────────────────────*/
section(5, 'FULL REVERSAL — issue 5, undo ⇒ central restored, department 0, guard clears');
test('full-reversal', () => {
  const dept = mkDept('TEST Kitchen 5');
  const mat = mkMaterial({ name: 'TEST FLOUR', unit: 'g', purchase_unit: 'kg', pack_size: 1000, current_stock: 100000 });
  const req = mkReq(dept);
  const line = mkLine(req, mat, { requested: 10, unit: 'kg', departmentId: dept });

  const start = central(mat);
  issue(line, 5);
  expectTrue(lineHasMovedStock(db, line), 'guard says stock HAS moved while the issue stands');

  const res = undoIssue(line);

  expect(central(mat), start, 'central restored to the exact starting figure');
  expect(deptSum(dept, mat), 0, 'department net 0 — every gram went back');
  expect(deptCache(dept, mat), 0, 'cache back to 0 as well');
  expect(deptRows(dept, mat), 2, 'two rows: the issue and its reversal (history preserved)');
  expect(res.deltaRecipeQty, -5000, 'the reversal delta is the exact negative of the issue');

  // The reversal is typed, not a negative 'issued'. Reports that group by type
  // or sum ABS(quantity) used to read a give-back as another issue.
  const revType = db.prepare(`
    SELECT type FROM department_material_transactions
     WHERE department_id = ? AND material_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(dept, mat);
  expectTrue(revType && revType.type === 'issue_reversal',
    "the give-back is typed 'issue_reversal'", JSON.stringify(revType));

  // THE DEADLOCK THIS REPLACED. The guard used to ask "did stock EVER move"
  // (EXISTS ... stock_applied = 1), so a fully-undone line stayed blocked
  // forever and cancel/PUT/chef-reject told the user to undo lines that were
  // already undone. It is a NET question now, and this is the assertion that
  // stops someone reverting it.
  expectTrue(lineHasMovedStock(db, line) === false,
    'guard clears after a full undo — cancel/PUT/chef-reject are possible again',
    'If this fails, lineHasMovedStock has been reverted to an EXISTS test and the line is dead-ended.');
});

/* ── 6 ─────────────────────────────────────────────────────────────────────*/
section(6, 'UNMAPPED STATION — sell on an unmapped station ⇒ zero movement, one skip row');
test('unmapped-station', () => {
  // 'kitchen' is kot-fire.ts's BLANK-STATION SENTINEL and also a real
  // department name. Mapping it would debit the busiest kitchen in the building
  // for every station-less item sold, which is why the seed leaves it NULL.
  // There is no legitimate reason for this to ever resolve.
  expectTrue(resolveStationDepartment(db, 'kitchen').departmentId === null,
    "the 'kitchen' sentinel resolves to NO department",
    'Someone mapped the blank-station sentinel. Every station-less sale now debits that department.');
  expectTrue(resolveStationDepartment(db, 'liquor').departmentId === null,
    "'liquor' resolves to NO department (it lives on the TGBCL store rail)");

  // The named case from the spec. If an owner deliberately maps sushi later,
  // fall back to a station that provably has no mapping so the MECHANISM stays
  // under test rather than the seed data.
  let station = 'sushi';
  if (resolveStationDepartment(db, station).departmentId) {
    station = 'unmapped-' + uid();
    console.log(`      note: 'sushi' is now mapped; testing the skip path on '${station}' instead`);
  }
  expectTrue(resolveStationDepartment(db, station).departmentId === null,
    `station '${station}' is unmapped — the deduction must be skipped, never guessed`);

  const mat = mkMaterial({ name: 'TEST SUSHI RICE', unit: 'g', purchase_unit: 'kg', pack_size: 1000, current_stock: 100000 });
  const recipe = mkRecipe(mat, { quantity: 300, unit: 'g' });
  const start = central(mat);
  const deptRowsBefore = Number(db.prepare(
    'SELECT COUNT(*) c FROM department_material_transactions WHERE material_id = ?').get(mat).c) || 0;

  sell(recipe, 2, station);              // 600 g that nobody may be charged for

  expect(central(mat), start, 'CENTRAL untouched — an unmapped station never falls back to central');
  expect(Number(db.prepare('SELECT COUNT(*) c FROM department_material_transactions WHERE material_id = ?')
    .get(mat).c) || 0, deptRowsBefore,
    'NO department row — guessing a kitchen reads as theft on the variance report');

  const skips = skipRows(mat);
  expect(skips.length, 1, 'exactly one consumption_skips row');
  expectTrue(skips[0] && skips[0].station === station.toLowerCase(),
    'the skip row NAMES the station so the banner can say which', JSON.stringify(skips[0]));
  expect(skips[0] ? skips[0].quantity : -1, 600, 'the skip records what WOULD have been deducted');
  expect(invTxns(mat, 'sale'), 1,
    'the inventory_transactions row is STILL written — gating it collapses recipe_to_date to 0');
});

/* ── 7 ─────────────────────────────────────────────────────────────────────*/
section(7, 'LIQUOR CARVE-OUT — a store-mapped material moves on NEITHER rail');
test('liquor-carve-out', () => {
  // THIS TEST CANNOT BE REPLACED BY PRODUCTION DATA. No live recipe uses a
  // store-mapped (liquor) category, so the only thing standing between the
  // TGBCL rail and the department rail is this synthetic case. If someone
  // "simplifies" the carve-out away, nothing else in the repo notices.
  const dept = mkDept('TEST Bar 7');
  const station = 'teststation-' + uid();
  mapStation(station, dept);

  // Prefer a category the live store_category_map already claims, so the real
  // wiring is what is under test; fall back to a synthetic store if the map is
  // ever emptied.
  let category = (db.prepare(`
    SELECT m.category FROM store_category_map m
      JOIN store_locations s ON s.id = m.store_id
     WHERE s.is_active = 1 ORDER BY m.created_at ASC, m.id ASC LIMIT 1
  `).get() || {}).category;
  if (!category) {
    const storeId = uid();
    category = 'test-liquor-' + uid();
    db.prepare(`INSERT INTO store_locations (id, name, code, is_active) VALUES (?, 'TEST STORE', 'TS', 1)`).run(storeId);
    db.prepare(`INSERT INTO store_category_map (id, store_id, category) VALUES (?,?,?)`).run(uid(), storeId, category);
  }

  const mat = mkMaterial({
    name: 'TEST WHISKY 750ML', category, unit: 'ml', purchase_unit: 'btl',
    pack_size: 750, current_stock: 7500,
  });
  const req = mkReq(dept);
  const line = mkLine(req, mat, { requested: 4, unit: 'btl', departmentId: dept });

  const start = central(mat);
  const res = issue(line, 2);

  expectTrue(res.applied === false, 'the issue reports applied === false', JSON.stringify(res));
  expectTrue(res.skipped === 'store_mapped', "skip reason is 'store_mapped'", JSON.stringify(res));
  expect(central(mat), start, 'NO central movement (the store rail owns this material)');
  expect(deptSum(dept, mat), 0, 'NO department movement');
  expect(deptRows(dept, mat), 0, 'no department ledger row at all');
  expect(invTxns(mat, 'requisition_issue'), 0, 'no central inventory transaction');

  // The hand-over is still a real event and the owner's log must see it —
  // recorded, not deducted. This is the difference between the new active
  // carve-out and the old passive stamp that debited central and credited
  // nobody, evaporating the material from both rails.
  expect(ledgerRows(line), 1, 'the hand-over IS recorded in requisition_issue_ledger');
  const led = db.prepare(`
    SELECT skip_reason, delta_recipe_qty, recorded_recipe_qty, stock_applied
      FROM requisition_issue_ledger WHERE req_item_id = ?
  `).get(line);
  expectTrue(led && led.skip_reason === 'store_mapped', "ledger row stamped skip_reason 'store_mapped'", JSON.stringify(led));
  expect(led ? led.delta_recipe_qty : -1, 0, 'delta_recipe_qty is 0 — nothing left central');
  expect(led ? led.stock_applied : -1, 0, 'stock_applied is 0');
  expectTrue(lineHasMovedStock(db, line) === false,
    'the guard reads no movement, so the line stays editable');

  // …and the same carve-out on the consumption leg.
  const recipe = mkRecipe(mat, { quantity: 60, unit: 'ml' });
  const centralBefore = central(mat);
  sell(recipe, 1, station);
  expect(central(mat), centralBefore, 'consumption leaves central alone too');
  expect(deptSum(dept, mat), 0, 'consumption posts nothing to the department either');
  const skips = skipRows(mat);
  expect(skips.length, 1, 'one consumption_skips row for the store-mapped material');
  expectTrue(skips[0] && skips[0].reason === 'store_mapped',
    "the consumption skip reason is 'store_mapped'", JSON.stringify(skips[0]));
});

/* ── 8 ─────────────────────────────────────────────────────────────────────*/
section(8, 'PACK FACTOR — PICKLED GINGER 1.5KG (pack 1.5, kg/kg) must NOT convert');
test('pack-factor', () => {
  // THE BOTH-HALVES GUARD, tested on the material that has always broken the
  // one-half version: pack_size IS > 1, but recipe unit == purchase unit, so
  // there is nothing to convert. Three hand-rolled copies of this rule elsewhere
  // in the repo each drop half of it and divide this row by 1.5.
  let mat = (db.prepare(`SELECT id FROM raw_materials WHERE name = 'PICKLED GINGER 1.5KG'`).get() || {}).id;
  if (!mat) {
    mat = mkMaterial({ name: 'PICKLED GINGER 1.5KG', unit: 'kg', purchase_unit: 'kg', pack_size: 1.5, current_stock: 100 });
    console.log('      note: the live row is gone; testing a synthetic clone of its shape');
  }
  const shape = db.prepare('SELECT unit, purchase_unit, pack_size, current_stock FROM raw_materials WHERE id = ?').get(mat);
  expectTrue(Number(shape.pack_size) > 1 && String(shape.unit).trim().toLowerCase() === String(shape.purchase_unit).trim().toLowerCase(),
    'the fixture really is the trap shape: pack_size > 1 AND unit === purchase_unit', JSON.stringify(shape));
  expect(packFactor(shape), 1, 'packFactor refuses to convert when the units already match');

  const dept = mkDept('TEST Kitchen 8');
  const station = 'teststation-' + uid();
  mapStation(station, dept);
  const req = mkReq(dept);
  const line = mkLine(req, mat, { requested: 5, unit: 'kg', departmentId: dept });

  db.prepare('UPDATE raw_materials SET current_stock = 100 WHERE id = ?').run(mat);
  const start = central(mat);
  const res = issue(line, 2);

  expect(res.packFactor, 1, 'the issue used pack factor 1');
  expect(start - central(mat), 2, 'central fell 2 kg — NOT 3 (2 × 1.5)');
  expect(deptSum(dept, mat), 2, 'the department gained 2 kg — NOT 3');

  // …and the consumption leg reads the same basis. A rail that converts on one
  // side and not the other invents 1 kg per issue out of thin air.
  const recipe = mkRecipe(mat, { quantity: 0.5, unit: 'kg' });
  sell(recipe, 1, station);
  expect(deptSum(dept, mat), 1.5, 'after cooking 0.5 kg the department holds 1.5 kg — NOT 2.25');
});

/* ── 9 ─────────────────────────────────────────────────────────────────────*/
section(9, 'CACHE == TRUTH — after a 100-movement fuzz, on_hand equals the ledger sum');
test('cache-equals-truth', () => {
  // department_materials.on_hand is a maintained CACHE and nothing may DECIDE
  // on it; the ledger SUM is the truth. They are written as one pair inside
  // postDeptLedger, and this asserts that pair never comes apart — the drift
  // /api/department-ledger/check exists to surface, proven here before it can
  // reach a screen. Deterministic seed so a failure is reproducible.
  let seed = 42;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  const depts = [mkDept('TEST Fuzz A'), mkDept('TEST Fuzz B'), mkDept('TEST Fuzz C')];
  const mats = [
    mkMaterial({ name: 'FUZZ MAT 1' }), mkMaterial({ name: 'FUZZ MAT 2' }), mkMaterial({ name: 'FUZZ MAT 3' }),
  ];
  // 'adjustment' is the only ± type; the rest are sign-locked by DEPT_TXN_TYPES
  // and postDeptLedger throws on a contradicting sign, so the fuzz must respect
  // the vocabulary rather than fight it.
  const plan = [
    { type: 'issued', sign: +1 }, { type: 'consumption', sign: -1 },
    { type: 'wastage', sign: -1 }, { type: 'staff_meal', sign: -1 },
    { type: 'adjustment', sign: 0 },
  ];

  let posted = 0;
  for (let i = 0; i < 100; i++) {
    const d = depts[Math.floor(rnd() * depts.length)];
    const m = mats[Math.floor(rnd() * mats.length)];
    const p = plan[Math.floor(rnd() * plan.length)];
    const mag = Math.round((rnd() * 500 + 1) * 1000) / 1000;
    const q = p.sign === 0 ? (rnd() < 0.5 ? -mag : mag) : p.sign * mag;
    postDeptLedger(db, {
      departmentId: d, materialId: m, type: p.type, quantity: q,
      referenceId: 'fuzz-' + i, source: 'run-tests-fuzz', notes: 'fuzz',
    });
    posted++;
  }
  expect(posted, 100, '100 movements posted');

  const drift = db.prepare(`
    SELECT dm.department_id, dm.material_id, dm.on_hand,
           COALESCE((SELECT SUM(t.quantity) FROM department_material_transactions t
                      WHERE t.department_id = dm.department_id AND t.material_id = dm.material_id), 0) AS truth
      FROM department_materials dm
  `).all().filter((r) => Math.abs(Number(r.on_hand) - Number(r.truth)) > 1e-6);

  expect(drift.length, 0, 'every department_materials row matches its ledger sum',
    drift.length ? JSON.stringify(drift.slice(0, 5)) : '');

  // And deptOnHand — the one derivation of a balance — reports NULL, not 0, for
  // a pair that was never counted. Reporting 0 would let "not counted yet" pass
  // as "empty shelf" on every screen.
  const uncounted = deptOnHand(db, depts[0], mats[0]);
  expectTrue(uncounted.neverCounted === true && uncounted.onHand === null,
    'an uncounted pair reports onHand = NULL and neverCounted = true, never 0',
    JSON.stringify(uncounted));
});

/* ── 10 ────────────────────────────────────────────────────────────────────*/
section(10, 'NO BACKFILL — booting the app adds ZERO department movements');
{
  // DECISION D, enforced. The 14,149 historic issued lines get no department
  // movements: department balances start at the admin's cutover count, not at a
  // replay of history. The counts below were read from the snapshot BEFORE
  // getDb() ran a single migration, and compared after.
  //
  // It is deliberately a DELTA, not "the table is empty". Once the owner runs
  // /api/department-ledger/cutover the table is legitimately non-empty forever,
  // and a test that demanded 0 rows would have to be deleted at exactly the
  // moment it starts mattering. What must never change is that a DEPLOY writes
  // none of them — scripts/check-boot-migrations.js guards the same boundary
  // from the other side.
  const postBoot = {
    deptTxns: Number(db.prepare('SELECT COUNT(*) c FROM department_material_transactions').get().c) || 0,
    deptMats: Number(db.prepare('SELECT COUNT(*) c FROM department_materials').get().c) || 0,
  };
  expectTrue(preBoot.issuedLines > 1000,
    `the snapshot really does carry the history this must ignore (${preBoot.issuedLines} issued lines)`,
    `only ${preBoot.issuedLines} issued lines found — this test proves little on an empty database`);
  expect(postBoot.deptTxns - preBoot.deptTxns, 0,
    'boot added ZERO department_material_transactions rows',
    'A boot migration is backfilling department movements. Opening balances are admin-owned state.');
  expect(postBoot.deptMats - preBoot.deptMats, 0,
    'boot added ZERO department_materials rows');
  // The cutover stamp is an admin action too; a deploy must not set it.
  const stamp = db.prepare("SELECT value FROM settings WHERE key = 'dept_ledger_cutover_at'").get();
  expectTrue(!stamp || !String(stamp.value || '').trim() || preBoot.deptTxns > 0,
    'boot did not stamp dept_ledger_cutover_at on an un-cut-over database',
    `settings.dept_ledger_cutover_at = ${JSON.stringify(stamp && stamp.value)}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * PART B — the pre-existing arithmetic checks, unchanged, now on the snapshot
 * ──────────────────────────────────────────────────────────────────────────*/

section('B1', 'weighted-average price across purchases');
test('weighted-avg', () => {
  const matId = uid();
  db.prepare(`INSERT INTO raw_materials (id, name, unit, current_stock, average_price)
              VALUES (?, 'TEST_MAT', 'kg', 0, 0)`).run(matId);
  db.prepare(`INSERT INTO purchases (id, material_id, vendor, quantity, unit_price, total_price, date)
              VALUES (?, ?, 'V1', 10, 100, 1000, date('now', '-5 day'))`).run(uid(), matId);
  db.prepare(`INSERT INTO purchases (id, material_id, vendor, quantity, unit_price, total_price, date)
              VALUES (?, ?, 'V1', 20, 130, 2600, date('now', '-2 day'))`).run(uid(), matId);
  const wavg = db.prepare(`SELECT SUM(quantity*unit_price)/SUM(quantity) AS w FROM purchases WHERE material_id = ?`).get(matId);
  expect(wavg.w, 120, 'weighted avg of 10@100 + 20@130 = 120');
});

section('B2', 'recipe-deduction: 1 sale of a recipe using 0.5 kg → 0.5 kg leaves the rail');
test('recipe-deduction-math', () => {
  const matId = uid();
  const recId = uid();
  db.prepare(`INSERT INTO raw_materials (id, name, unit, current_stock, average_price)
              VALUES (?, 'CHKN', 'kg', 100, 250)`).run(matId);
  db.prepare(`INSERT INTO recipes (id, name, selling_price, total_cost)
              VALUES (?, 'Test Curry', 500, 125)`).run(recId);
  db.prepare(`INSERT INTO recipe_ingredients (id, recipe_id, material_id, quantity)
              VALUES (?, ?, ?, 0.5)`).run(uid(), recId, matId);
  db.prepare(`UPDATE raw_materials SET current_stock = current_stock - 0.5 WHERE id = ?`).run(matId);
  const after = db.prepare(`SELECT current_stock FROM raw_materials WHERE id = ?`).get(matId);
  expect(after.current_stock, 99.5, 'stock 100 − 0.5 = 99.5');
});

section('B3', 'GRN receive — only quantity_accepted bumps stock');
test('grn-accept-reject', () => {
  const matId = uid();
  db.prepare(`INSERT INTO raw_materials (id, name, unit, current_stock, average_price)
              VALUES (?, 'POTATO', 'kg', 50, 30)`).run(matId);
  db.prepare(`UPDATE raw_materials SET current_stock = current_stock + 15 WHERE id = ?`).run(matId);
  const after = db.prepare(`SELECT current_stock FROM raw_materials WHERE id = ?`).get(matId);
  expect(after.current_stock, 65, 'stock 50 + 15 accepted = 65 (rejected 3 not counted)');
});

section('B4', 'closing_stock variance = physical − system, value = variance × avg price');
test('closing-variance', () => {
  const matId = uid();
  db.prepare(`INSERT INTO raw_materials (id, name, unit, current_stock, average_price)
              VALUES (?, 'OIL', 'l', 25, 200)`).run(matId);
  const csId = uid();
  db.prepare(`INSERT INTO closing_stock (id, material_id, date, system_stock, physical_stock, variance, variance_value, recorded_by)
              VALUES (?, ?, date('now'), 25, 22, -3, -600, 'test')`).run(csId, matId);
  const cs = db.prepare(`SELECT variance, variance_value FROM closing_stock WHERE id = ?`).get(csId);
  expect(cs.variance, -3, 'variance = 22 − 25 = −3');
  expect(cs.variance_value, -600, 'variance value = −3 × 200 = −600');
});

section('B5', 'admin reset (sales scope) credits the deduction back to stock');
test('reset-credit-back', () => {
  const matId = uid();
  const recId = uid();
  const saleId = uid();
  db.prepare(`INSERT INTO raw_materials (id, name, unit, current_stock, average_price)
              VALUES (?, 'BEER', 'pcs', 80, 100)`).run(matId);
  db.prepare(`INSERT INTO recipes (id, name) VALUES (?, 'TestBeerSale')`).run(recId);
  db.prepare(`INSERT INTO sales (id, item_name, quantity_sold, total_revenue, date, recipe_id)
              VALUES (?, 'Beer', 2, 400, date('now'), ?)`).run(saleId, recId);
  db.prepare(`INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id)
              VALUES (?, ?, 'sale', -2, ?)`).run(uid(), matId, saleId);
  db.prepare(`UPDATE raw_materials SET current_stock = current_stock - 2 WHERE id = ?`).run(matId);
  const creditRow = db.prepare(`
    SELECT it.material_id, SUM(it.quantity) AS net_qty
    FROM inventory_transactions it
    JOIN sales s ON s.id = it.reference_id
    WHERE it.type = 'sale' AND s.id = ?
  `).get(saleId);
  db.prepare(`UPDATE raw_materials SET current_stock = current_stock + ? WHERE id = ?`).run(-creditRow.net_qty, matId);
  const after = db.prepare(`SELECT current_stock FROM raw_materials WHERE id = ?`).get(matId);
  expect(after.current_stock, 80, 'after credit-back, stock returns to 80');
});

/* ────────────────────────────────────────────────────────────────────────────
 * SUMMARY
 * ──────────────────────────────────────────────────────────────────────────*/

assertSandboxed();
try { db.close(); } catch { /* nothing left to protect — the file is a copy */ }

console.log(`\n${'─'.repeat(60)}`);
console.log(`  ${pass} passed · ${fail} failed`);
if (fail) {
  console.log(`\n  failing:`);
  for (const f of failures) console.log(`    · ${f}`);
  console.log(`\n  snapshot kept for inspection: ${SNAP}`);
} else if (!KEEP) {
  // cwd is inside TMP; step out before removing it or the rm races the process.
  process.chdir(REPO);
  fs.rmSync(TMP, { recursive: true, force: true });
} else {
  console.log(`\n  snapshot kept (--keep): ${SNAP}`);
}
process.exit(fail > 0 ? 1 : 0);
