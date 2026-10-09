#!/usr/bin/env node
/**
 * HR PAYROLL — STATUTORY STATE SCOPING
 * ====================================
 *
 * The first automated tests this module has ever had. Payroll computes real
 * salaries and real statutory deductions, and until now nothing in scripts/
 * referenced hr_ tables, computePayrollItem, or the word payroll.
 *
 * WHAT THEY GUARD. Professional Tax is a STATE levy. hr_statutory_configs.state
 * exists and the Statutory tab lets an admin fill it in, but the payroll compute
 * carried `AND state = ''` in its SQL *and* the only caller passed no opts, so a
 * Telangana PT row was Active in the UI, in effect by date, and deducted ZERO —
 * silently, with no trace that it had been skipped. Two independent filters had
 * to be removed for it to work, and exactly one of them being removed must not
 * quietly change anybody's pay.
 *
 * THE TEST THAT MATTERS MOST IS [1]: with hr_org_state unset, a state-scoped row
 * must STILL be ignored. That is the proof this change is a no-op on every
 * install that has not opted in, which is every install today.
 *
 * Harness is lifted from run-tests.js: a VACUUM INTO snapshot of the live DB in
 * a temp dir, the TypeScript loader, and a SAVEPOINT per test so fixtures never
 * accumulate. It NEVER writes to the real database — see assertSandboxed().
 *
 * NOTE ON SQL CONSTRUCTION: no statement here is built by interpolation. The
 * snapshot path is a BOUND parameter to `VACUUM INTO ?`, and the savepoint name
 * is a module constant, so there is no dynamic SQL anywhere in this file.
 *
 * Run: node scripts/hr-payroll-tests.js [--keep]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const REPO = path.resolve(__dirname, '..');
const LIVE_DB = path.join(REPO, 'fnb-controller.db');
const SRC = path.join(REPO, 'src');
const KEEP = process.argv.includes('--keep');

if (!fs.existsSync(LIVE_DB)) {
  console.error(`hr-payroll-tests: ${LIVE_DB} not found — nothing to snapshot.`);
  process.exit(2);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-hrpay-')));
const SNAP = path.join(TMP, 'fnb-controller.db');
{
  // readonly is the belt; VACUUM INTO is the braces — unlike a byte copy it
  // folds the WAL in, so the image is consistent even mid-write. The path is
  // BOUND, never interpolated.
  const src = new Database(LIVE_DB, { readonly: true });
  src.prepare('VACUUM INTO ?').run(SNAP);
  src.close();
}
process.chdir(TMP);

/* ── TypeScript loader ─────────────────────────────────────────────────────── */
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
const lib = (rel) => require(path.join(SRC, 'lib', rel));

const dbMod = lib('db.ts');
const { computePayrollItem } = lib('hr-payroll.ts');
const { getHrOrgState } = lib('hr-attendance.ts');
const db = dbMod.getDb();

function assertSandboxed() {
  const open = path.resolve(db.name || '');
  if (path.resolve(LIVE_DB) === open || !open.startsWith(path.resolve(TMP))) {
    console.error(`\nFATAL: tests opened ${open}, not the snapshot in ${TMP}. Aborting.`);
    process.exit(3);
  }
}
assertSandboxed();

/* ── harness ───────────────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
function ok(l) { pass++; console.log(`  ✓ ${l}`); }
function bad(l, d) { fail++; failures.push(l); console.log(`  ✗ ${l}`); if (d) console.log(`      ${d}`); }
function expect(a, e, l) {
  if (Number(a) === Number(e)) ok(`${l} — ${a}`);
  else bad(l, `expected ${e}, got ${a}`);
}
function expectTrue(c, l, h) { c ? ok(l) : bad(l, h); }
function section(n, t) { console.log(`\n[${n}] ${t}`); }

// Constant savepoint name — tests never nest, so nothing needs to be generated.
const SP_BEGIN = 'SAVEPOINT hrpay_t';
const SP_UNDO = 'ROLLBACK TO SAVEPOINT hrpay_t';
const SP_DONE = 'RELEASE SAVEPOINT hrpay_t';
/**
 * HERMETIC ISOLATION. The snapshot is a copy of the LIVE database, so it carries
 * whatever statutory configs the owner has already created — and
 * resolveStatutoryConfigs ranks effective_from DESC above created_at, so a real
 * row dated after the fixtures' hardcoded '2020-01-01' WINS and the assertion
 * fails. Measured: 10 of 26 assertions go red on exactly the install where the
 * bug was found, the flagship no-op test among them. A suite that only passes on
 * an empty database proves nothing about the one that matters.
 *
 * Deactivating inside the savepoint neutralises pre-existing rows for the test
 * and is rolled back with everything else, so the snapshot is never altered.
 */
function test(name, fn) {
  db.prepare(SP_BEGIN).run();
  db.prepare('UPDATE hr_statutory_configs SET is_active = 0').run();
  try { fn(); }
  catch (e) { bad(`${name} — threw`, String((e && e.stack) || e)); }
  finally {
    try { db.prepare(SP_UNDO).run(); db.prepare(SP_DONE).run(); }
    catch (e) { bad(`${name} — savepoint unwind failed`, String(e)); }
  }
}
const uid = () => 'hrtest-' + Math.random().toString(36).slice(2, 12);

/* ── fixtures ──────────────────────────────────────────────────────────────── */

const PERIOD = '2026-09';          // 30 days
const DAYS = 30;
const GROSS = 20000;               // basic 20000, no HRA/allowances

/** An employee who worked EVERY day of PERIOD, so earned gross == full gross
 *  and a PT slab match is deterministic. Without attendance rows presentDays is
 *  0, earned gross is 0, and every slab test would pass for the wrong reason. */
function mkEmployee(category = 'staff') {
  const id = uid();
  db.prepare(
    `INSERT INTO hr_employees (id, employee_code, full_name, employee_category, status)
     VALUES (?, ?, ?, ?, 'active')`,
  ).run(id, 'EMP-' + id.slice(-5), 'Test Employee', category);
  db.prepare(
    `INSERT INTO hr_salary_structures
       (id, employee_id, effective_from, effective_to, basic, hra, allowances_json,
        gross, deductions_json, net, created_at)
     VALUES (?, ?, '2020-01-01', '', ?, 0, '{}', ?, '{}', ?, datetime('now'))`,
  ).run(uid(), id, GROSS, GROSS, GROSS);
  const att = db.prepare(
    `INSERT INTO hr_attendance (id, employee_id, outlet_id, date, status)
     VALUES (?, ?, '', ?, 'PRESENT')`,
  );
  for (let d = 1; d <= DAYS; d++) {
    att.run(uid(), id, `${PERIOD}-${String(d).padStart(2, '0')}`);
  }
  return id;
}

/** A statutory config row exactly as the Statutory tab would store one.
 *  effectiveFrom is overridable so the specificity TIE-BREAK (same shape, later
 *  effective_from wins) can be exercised without a second insert helper. */
function mkConfig(kind, state, configJson, category = '', effectiveFrom = '2020-01-01') {
  const id = uid();
  db.prepare(
    `INSERT INTO hr_statutory_configs
       (id, kind, state, employee_category, effective_from, effective_to, config_json, is_active)
     VALUES (?, ?, ?, ?, ?, '', ?, 1)`,
  ).run(id, kind, state, category, effectiveFrom, JSON.stringify(configJson));
  return id;
}

/** Telangana-shaped PT: nil to 15k, 150 to 20k, 200 above. GROSS=20000 → 150. */
const TG_SLABS = { slabs: [{ upto: 15000, amount: 0 }, { upto: 20000, amount: 150 }, { upto: 0, amount: 200 }] };
/** A deliberately distinct all-India amount so precedence is unambiguous. */
const ALL_INDIA_SLABS = { slabs: [{ upto: 0, amount: 99 }] };

function run(empId, state) {
  const r = computePayrollItem(db, empId, PERIOD, state === undefined ? undefined : { state });
  if (r.skip) throw new Error('compute skipped: ' + r.reason);
  return r;
}
const amountOf = (r, label) => {
  const line = JSON.parse(r.deductions_json).find((d) => d.label === label);
  return line ? line.amount : 0;
};
const ptOf = (r) => amountOf(r, 'Professional Tax');
const traceOf = (r) => JSON.parse(r.detail_json);

/* ════════════════════════════════════════════════════════════════════════════
 * TESTS
 * ══════════════════════════════════════════════════════════════════════════*/

console.log('\nHR PAYROLL — statutory state scoping');
console.log(`snapshot: ${SNAP}`);

section(1, 'NO-OP PROOF — an unset payroll state must behave exactly as before');
test('state-scoped row ignored when hr_org_state is unset', () => {
  const emp = mkEmployee();
  mkConfig('professional_tax', 'Telangana', TG_SLABS);
  const r = run(emp, '');
  expect(ptOf(r), 0, 'PT is NOT deducted with an empty state scope');
  expect(r.gross, GROSS, 'gross is the full month (attendance seeded)');
  expect(r.net, GROSS, 'net equals gross — no deduction of any kind');
});
test('omitting opts entirely behaves identically to state: ""', () => {
  const emp = mkEmployee();
  mkConfig('professional_tax', 'Telangana', TG_SLABS);
  expect(ptOf(run(emp, undefined)), 0, 'PT not deducted when the caller passes no opts');
});
test('getHrOrgState defaults to empty on a fresh install', () => {
  db.prepare(`DELETE FROM settings WHERE key = 'hr_org_state'`).run();
  expectTrue(getHrOrgState(db) === '', 'unset hr_org_state reads as ""');
});
test('getHrOrgState actually READS the stored value', () => {
  // The default-empty test above passes just as happily against a getter
  // sabotaged to `return ''`, which is why that sabotage killed zero tests.
  // Assert the READ, not only the default.
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('hr_org_state', 'Telangana')`).run();
  expectTrue(getHrOrgState(db) === 'Telangana', 'a stored state reads back');
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('hr_org_state', '  Kerala  ')`).run();
  expectTrue(getHrOrgState(db) === 'Kerala', 'and is trimmed');
});
test('the settings route PERSISTS hr_org_state', () => {
  // The opt-in is dead end-to-end if PUT never writes the key — and that
  // sabotage also killed zero tests. The route is an auth-gated Next handler,
  // so assert on its SOURCE; a static check is weaker than execution and is
  // labelled as such, but it is far better than nothing.
  const src = fs.readFileSync(path.join(SRC, 'app', 'api', 'hr', 'settings', 'route.ts'), 'utf8')
    .replace(/\n\s*/g, ' ');
  expectTrue(/upsert\.run\(\s*'hr_org_state'/.test(src),
    'PUT /api/hr/settings writes hr_org_state',
    'Without this the owner can tick the setting and it never persists.');
  expectTrue(/hr_org_state:\s*getHrOrgState\s*\(\s*db\s*\)/.test(src),
    'GET /api/hr/settings returns hr_org_state');
  expectTrue(/hr_org_state/.test(src.split('const after')[1] || ''),
    'the PUT response echoes hr_org_state back');
});

section(2, 'THE FIX — a matching state-scoped row is applied');
test('Telangana PT applies when hr_org_state is Telangana', () => {
  const emp = mkEmployee();
  mkConfig('professional_tax', 'Telangana', TG_SLABS);
  const r = run(emp, 'Telangana');
  expect(ptOf(r), 150, 'PT deducted at the 20,000 slab');
  expect(r.net, GROSS - 150, 'net is reduced by exactly the PT');
});
test('the slab is matched on gross, not guessed', () => {
  const emp = mkEmployee();
  mkConfig('professional_tax', 'Telangana',
    { slabs: [{ upto: 15000, amount: 0 }, { upto: 19999, amount: 150 }, { upto: 0, amount: 200 }] });
  expect(ptOf(run(emp, 'Telangana')), 200, 'gross 20,000 falls to the unbounded top slab');
});
test('PT is NOT prorated — it is a per-month levy', () => {
  const emp = mkEmployee();
  // Halve the month's attendance: earned gross halves, the slab amount does not.
  db.prepare(`DELETE FROM hr_attendance WHERE employee_id = ? AND date > ?`).run(emp, `${PERIOD}-15`);
  mkConfig('professional_tax', 'Telangana', { slabs: [{ upto: 0, amount: 200 }] });
  const r = run(emp, 'Telangana');
  expect(ptOf(r), 200, 'flat 200 even on a part-worked month');
  expectTrue(r.gross < GROSS, 'gross really did prorate', `gross was ${r.gross}`);
});

section(3, 'PRECEDENCE — a state row outranks an all-India row for the same kind');
test('Telangana beats all-India when the scope matches', () => {
  const emp = mkEmployee();
  mkConfig('professional_tax', '', ALL_INDIA_SLABS);
  mkConfig('professional_tax', 'Telangana', TG_SLABS);
  expect(ptOf(run(emp, 'Telangana')), 150, 'the Telangana rate wins');
});
test('all-India still applies when the scope does not match', () => {
  const emp = mkEmployee();
  mkConfig('professional_tax', '', ALL_INDIA_SLABS);
  mkConfig('professional_tax', 'Telangana', TG_SLABS);
  expect(ptOf(run(emp, 'Karnataka')), 99, 'falls back to the all-India rate');
});
test('a foreign state row alone deducts nothing', () => {
  const emp = mkEmployee();
  mkConfig('professional_tax', 'Telangana', TG_SLABS);
  expect(ptOf(run(emp, 'Karnataka')), 0, 'Telangana row ignored under a Karnataka scope');
});

section(4, 'THE CASE-SENSITIVITY TRAP — both sides are free text, matched exactly');
test('"telangana" does not match "Telangana"', () => {
  const emp = mkEmployee();
  mkConfig('professional_tax', 'Telangana', TG_SLABS);
  expect(ptOf(run(emp, 'telangana')), 0,
    'lower-case scope does NOT match — this is why the settings route offers stored spellings');
});

section(5, 'TRACE HONESTY — a skipped row must be visible on the payslip');
test('an out-of-scope row appears in the trace with a reason', () => {
  const emp = mkEmployee();
  mkConfig('professional_tax', 'Telangana', TG_SLABS);
  const t = traceOf(run(emp, 'Karnataka'));
  const considered = t.statutory.configs_considered;
  const tg = considered.find((c) => c.state === 'Telangana');
  expectTrue(!!tg, 'the Telangana row IS listed (it used to be filtered out of the trace entirely)');
  expectTrue(tg && tg.in_scope === false, 'it is marked out of scope');
  expectTrue(tg && /state 'Telangana' does not match/.test(tg.excluded_because),
    'and the reason names the mismatch', tg && tg.excluded_because);
});
test('an applied row is marked in scope', () => {
  const emp = mkEmployee();
  mkConfig('professional_tax', 'Telangana', TG_SLABS);
  const t = traceOf(run(emp, 'Telangana'));
  const tg = t.statutory.configs_considered.find((c) => c.state === 'Telangana');
  expectTrue(tg && tg.in_scope === true, 'in_scope true');
  expectTrue(/Telangana/.test(t.statutory.state_scope), 'state_scope names the state');
});

section(6, 'NO COLLATERAL CHANGE — the other statutory kinds are untouched');
test('all-India PF and ESI apply exactly as before, with a state set', () => {
  const emp = mkEmployee();
  mkConfig('pf', '', { percent_of_basic: 12, wage_cap: 15000 });
  mkConfig('esi', '', { percent_of_gross: 0.75, gross_cap: 21000 });
  const withState = JSON.parse(run(emp, 'Telangana').deductions_json);
  const without = JSON.parse(run(emp, '').deductions_json);
  const pf = (lines) => (lines.find((d) => d.label === 'PF') || {}).amount || 0;
  const esi = (lines) => (lines.find((d) => d.label === 'ESI') || {}).amount || 0;
  expect(pf(withState), 1800, 'PF = 12% of the 15,000 cap');
  expect(pf(withState), pf(without), 'PF identical with and without a state scope');
  expect(esi(withState), esi(without), 'ESI identical with and without a state scope');
});
test('employee-category scoping still excludes a non-matching row', () => {
  const emp = mkEmployee('staff');
  mkConfig('professional_tax', 'Telangana', TG_SLABS, 'manager');
  expect(ptOf(run(emp, 'Telangana')), 0, 'a manager-scoped row does not touch a staff payslip');
});

section(7, 'ROUTE WIRING — the second blocker, which the tests above cannot see');
/* Everything above drives computePayrollItem directly, so it would all still
 * pass if the ROUTE went back to calling it without opts — and that alone was
 * enough to make every state-scoped rate inert, because resolveStatutoryConfigs
 * drops them on an empty scope. There is no cheap way to execute the route here
 * (it is an auth-gated Next handler), so this asserts on its SOURCE instead.
 * A static check is weaker than an execution, and is labelled as such. */
test('the payroll route reads hr_org_state and passes it to the compute', () => {
  const routeSrc = fs.readFileSync(
    path.join(SRC, 'app', 'api', 'hr', 'payroll', 'route.ts'), 'utf8',
  );
  const flat = routeSrc.replace(/\n\s*/g, ' ');
  // Capture WHAT is passed as state, then assert that thing is the setting.
  // The old guard was /computePayrollItem\([^)]*\{\s*state:/ which a hardcoded
  // `{ state: '' }` satisfies perfectly — measured: sabotaging the route to
  // `{ state: '' }` while leaving a getHrOrgState call elsewhere in the file
  // left the suite at 26 passed / 0 failed while every state-scoped rate was
  // inert again. A guard that cannot fail is not a guard.
  const m = flat.match(/computePayrollItem\(\s*db\s*,[^)]*?\{\s*state:\s*([A-Za-z0-9_.]+|'[^']*'|"[^"]*")/);
  expectTrue(!!m, 'route passes a { state } option into computePayrollItem',
    'Without it every state-scoped rate is inert no matter what the SQL says.');
  const passed = m ? m[1] : '';
  expectTrue(!/^['"]/.test(passed),
    `the state passed is a variable, not a literal (saw: ${passed || 'nothing'})`,
    'A hardcoded literal means the setting is never consulted — the wire is dead.');
  const assign = new RegExp(
    'const\\s+' + (passed || '__none__').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '\\s*=\\s*getHrOrgState\\s*\\(\\s*db\\s*\\)');
  expectTrue(passed !== '' && assign.test(flat),
    `${passed || 'that variable'} is assigned from getHrOrgState(db)`,
    'The variable must come from the setting, not from somewhere else.');
  const compute = routeSrc.indexOf('computePayrollItem(db');
  const read = routeSrc.indexOf('getHrOrgState(db)');
  expectTrue(read > -1 && compute > -1 && read < compute,
    'the setting is read BEFORE the loop, so one run uses one rate set');
});

section(8, 'SCOPE RANKING — a STATE match outranks a CATEGORY match');
/* THE GAP THESE CLOSE. Sections 3 and 6 covered state-vs-all-India and a
 * non-matching category, but NOTHING covered the two scopes COMPETING: a
 * category-scoped all-India row against a state-scoped row for the same kind.
 * Measured on 9d6d700, the shipped ranking keyed on category FIRST, so an
 * all-India staff row of ₹99 beat a Telangana row of ₹150 for a Telangana staff
 * employee — the wrong statutory rate, with nothing on the payslip to say the
 * Telangana row had been outranked. Owner's decision, 2026-10-07: the state
 * match is the stronger signal and must win.
 *
 * THE FOUR SHAPES a row can have, with the amount each fixture carries:
 *   A  all-India + any category       ₹50   specificity 0
 *   B  all-India + category 'staff'   ₹99   specificity 1
 *   C  Telangana + any category       ₹150  specificity 2
 *   D  Telangana + category 'staff'   ₹175  specificity 3
 * Every amount is distinct, so the winner is readable off the deduction alone. */
const FLAT = (amount) => ({ slabs: [{ upto: 0, amount }] });
const mkA = () => mkConfig('professional_tax', '', FLAT(50), '');
const mkB = () => mkConfig('professional_tax', '', FLAT(99), 'staff');
const mkC = () => mkConfig('professional_tax', 'Telangana', FLAT(150), '');
const mkD = () => mkConfig('professional_tax', 'Telangana', FLAT(175), 'staff');

test('THE REPORTED CASE — category-scoped all-India ₹99 vs Telangana ₹150', () => {
  const emp = mkEmployee('staff');
  mkB();
  mkC();
  expect(ptOf(run(emp, 'Telangana')), 150,
    'the Telangana row wins — a state match outranks a category match');
});
test('each shape alone is applied, so the fixtures are distinguishable', () => {
  let emp = mkEmployee('staff'); mkA(); expect(ptOf(run(emp, 'Telangana')), 50, 'A alone');
});
test('shape B alone', () => {
  const emp = mkEmployee('staff'); mkB(); expect(ptOf(run(emp, 'Telangana')), 99, 'B alone');
});
test('shape C alone', () => {
  const emp = mkEmployee('staff'); mkC(); expect(ptOf(run(emp, 'Telangana')), 150, 'C alone');
});
test('shape D alone', () => {
  const emp = mkEmployee('staff'); mkD(); expect(ptOf(run(emp, 'Telangana')), 175, 'D alone');
});
test('state + category is the most specific and wins outright over all three', () => {
  const emp = mkEmployee('staff');
  mkA(); mkB(); mkC(); mkD();
  expect(ptOf(run(emp, 'Telangana')), 175, 'D beats C, B and A together');
});
test('the full order is D > C > B > A', () => {
  const emp = mkEmployee('staff');
  mkA(); mkB(); mkC();
  expect(ptOf(run(emp, 'Telangana')), 150, 'C wins when D is absent (C > B > A)');
});
test('C > B with no all-India fallback present', () => {
  const emp = mkEmployee('staff');
  mkB(); mkC(); mkD();
  expect(ptOf(run(emp, 'Telangana')), 175, 'D still wins');
});
test('B > A among all-India rows — the category rule itself is NOT weakened', () => {
  const emp = mkEmployee('staff');
  mkA(); mkB();
  expect(ptOf(run(emp, 'Telangana')), 99, 'a category match still beats the bare fallback');
});
test('C > A — a state match beats the bare all-India fallback', () => {
  const emp = mkEmployee('staff');
  mkA(); mkC();
  expect(ptOf(run(emp, 'Telangana')), 150, 'C wins');
});

section(9, 'THE NO-OP EDGE OF THE RANKING CHANGE');
/* With an empty payroll state — which is PRODUCTION, it has no hr_ settings rows
 * at all — no state-scoped row is in scope, so only shapes A and B can compete
 * and B-over-A is the order that already shipped. This is the structural reason
 * the change cannot move anybody's pay until the state is set. */
test('with an empty state scope the all-India order is category-first, as before', () => {
  const emp = mkEmployee('staff');
  mkA(); mkB(); mkC(); mkD();
  expect(ptOf(run(emp, '')), 99, 'B wins; the two Telangana rows are not in scope at all');
});
test('with a NON-matching state scope the all-India order is category-first too', () => {
  const emp = mkEmployee('staff');
  mkA(); mkB(); mkC(); mkD();
  expect(ptOf(run(emp, 'Karnataka')), 99, 'B wins under Karnataka');
});
test('a state match the employee CATEGORY excludes does not rescue the row', () => {
  // Telangana + 'manager' is specificity 3 but out of scope for a staff
  // employee, so it must not be ranked at all — the fallback applies.
  const emp = mkEmployee('staff');
  mkA();
  mkConfig('professional_tax', 'Telangana', FLAT(175), 'manager');
  expect(ptOf(run(emp, 'Telangana')), 50, 'the all-India fallback applies, not the manager row');
});
test('an uncategorised employee matches only the category-blind rows', () => {
  // employee_category '' is "no department"-shaped: the EMPTY STRING is a real
  // value, and a row scoped to 'staff' must not match it.
  const emp = mkEmployee('');
  mkA(); mkB(); mkC(); mkD();
  expect(ptOf(run(emp, 'Telangana')), 150, 'C wins — B and D are staff-scoped');
});

section(10, 'RANKING TIE-BREAKS SURVIVE THE CHANGE');
test('same specificity → the later effective_from wins', () => {
  const emp = mkEmployee('staff');
  mkConfig('professional_tax', 'Telangana', FLAT(150), '', '2020-01-01');
  mkConfig('professional_tax', 'Telangana', FLAT(210), '', '2026-01-01');
  expect(ptOf(run(emp, 'Telangana')), 210, 'the 2026 Telangana row supersedes the 2020 one');
});
test('specificity beats a later effective_from — it is the PRIMARY key', () => {
  const emp = mkEmployee('staff');
  mkConfig('professional_tax', '', FLAT(99), 'staff', '2026-01-01');   // newer, less specific
  mkConfig('professional_tax', 'Telangana', FLAT(150), '', '2020-01-01');
  expect(ptOf(run(emp, 'Telangana')), 150,
    'the older Telangana row still wins — scope outranks recency');
});

section(11, 'THE RANKING IS KIND-AGNOSTIC — every statutory kind resolves the same way');
test('PF ranks by the same rule (a state row beats a category-scoped all-India row)', () => {
  const emp = mkEmployee('staff');
  mkConfig('pf', '', { percent_of_basic: 10, wage_cap: 0 }, 'staff');
  mkConfig('pf', 'Telangana', { percent_of_basic: 12, wage_cap: 0 }, '');
  expect(amountOf(run(emp, 'Telangana'), 'PF'), 2400, 'PF = 12% of 20,000 — the Telangana row');
  expect(amountOf(run(emp, ''), 'PF'), 2000, 'and 10% with no state set — the all-India row, as before');
});
test('ESI ranks by the same rule', () => {
  const emp = mkEmployee('staff');
  mkConfig('esi', '', { percent_of_gross: 0.5, gross_cap: 0 }, 'staff');
  mkConfig('esi', 'Telangana', { percent_of_gross: 0.75, gross_cap: 0 }, '');
  expect(amountOf(run(emp, 'Telangana'), 'ESI'), 150, 'ESI = 0.75% of 20,000 — the Telangana row');
  expect(amountOf(run(emp, ''), 'ESI'), 100, 'and 0.5% with no state set — unchanged');
});
test('PF and ESI do NOT move when only Professional Tax scopes compete', () => {
  // The blast radius guard: resolveStatutoryConfigs serves every kind, so the
  // reported PT case must not disturb PF or ESI for the same employee.
  const emp = mkEmployee('staff');
  mkConfig('pf', '', { percent_of_basic: 12, wage_cap: 15000 });
  mkConfig('esi', '', { percent_of_gross: 0.75, gross_cap: 21000 });
  mkB(); mkC();
  const tg = run(emp, 'Telangana');
  const none = run(emp, '');
  expect(amountOf(tg, 'PF'), 1800, 'PF = 12% of the 15,000 cap');
  expect(amountOf(tg, 'PF'), amountOf(none, 'PF'), 'PF identical whichever PT row wins');
  expect(amountOf(tg, 'ESI'), amountOf(none, 'ESI'), 'ESI identical whichever PT row wins');
  expect(ptOf(tg), 150, 'only PT moved — to the Telangana rate');
  expect(ptOf(none), 99, 'and it is still the all-India rate with no state set');
});

section(12, 'TRACE — the payslip must name the winner and what it outranked');
test('the winner is marked selected with its specificity', () => {
  const emp = mkEmployee('staff');
  const bId = mkB();
  const cId = mkC();
  const t = traceOf(run(emp, 'Telangana'));
  const considered = t.statutory.configs_considered;
  const c = considered.find((x) => x.id === cId);
  const b = considered.find((x) => x.id === bId);
  expectTrue(c && c.selected === true, 'the Telangana row is selected: true');
  expect(c && c.specificity, 2, "its specificity is 2 (state match, category '')");
  expectTrue(b && b.selected === false, 'the all-India staff row is selected: false');
  expect(b && b.specificity, 1, 'its specificity is 1 (category match only)');
});
test('the winner LISTS what it outranked', () => {
  const emp = mkEmployee('staff');
  const bId = mkB();
  const cId = mkC();
  const t = traceOf(run(emp, 'Telangana'));
  const c = t.statutory.configs_considered.find((x) => x.id === cId);
  expectTrue(c && Array.isArray(c.outranked) && c.outranked.length === 1,
    'outranked has exactly one entry', c && JSON.stringify(c.outranked));
  expectTrue(c && c.outranked[0] && c.outranked[0].id === bId,
    'and it is the ₹99 all-India staff row');
  expectTrue(c && /category 'staff'/.test(c.outranked[0].scope_shape),
    'named by its scope shape', c && c.outranked[0] && c.outranked[0].scope_shape);
});
test('the LOSER says who outranked it — it used to say nothing at all', () => {
  const emp = mkEmployee('staff');
  const bId = mkB();
  const cId = mkC();
  const t = traceOf(run(emp, 'Telangana'));
  const b = t.statutory.configs_considered.find((x) => x.id === bId);
  expectTrue(b && b.in_scope === true, 'the losing row is still IN SCOPE (it was eligible)');
  expectTrue(b && b.excluded_because.includes(cId),
    'excluded_because names the winning config id', b && b.excluded_because);
  expectTrue(b && /outranked for kind 'professional_tax'/.test(b.excluded_because),
    'and says it was outranked, for which kind', b && b.excluded_because);
  expectTrue(b && /specificity 2/.test(b.excluded_because),
    "and quotes the winner's specificity", b && b.excluded_because);
});
test('a tie-break loss is explained as a tie-break, not as a scope loss', () => {
  const emp = mkEmployee('staff');
  const older = mkConfig('professional_tax', 'Telangana', FLAT(150), '', '2020-01-01');
  mkConfig('professional_tax', 'Telangana', FLAT(210), '', '2026-01-01');
  const t = traceOf(run(emp, 'Telangana'));
  const o = t.statutory.configs_considered.find((x) => x.id === older);
  expectTrue(o && /same specificity 2/.test(o.excluded_because),
    'the reason says the specificity was equal', o && o.excluded_because);
});
test('the ranking rule itself is written on the payslip', () => {
  const emp = mkEmployee('staff');
  mkC();
  const t = traceOf(run(emp, 'Telangana'));
  expectTrue(/state match outranks a CATEGORY match/i.test(String(t.statutory.ranking)),
    'statutory.ranking states that state outranks category', String(t.statutory.ranking));
  expectTrue(/outrank EVERY all-India row/.test(String(t.statutory.state_scope)),
    'and state_scope no longer promises only "the" all-India row',
    String(t.statutory.state_scope));
});
test('configs_considered still carries id — statutoryDriftSinceCompute reads it', () => {
  // The drift check compares statutory.configs_considered[].id against the live
  // candidate set. Dropping or renaming that field would silently disable the
  // finalize-time warning, which no other test would notice.
  const emp = mkEmployee('staff');
  const cId = mkC();
  const t = traceOf(run(emp, 'Telangana'));
  expectTrue(t.statutory.configs_considered.some((x) => x.id === cId),
    'every considered row still reports its id');
  expectTrue(typeof t.statutory.state_scope_value === 'string',
    'and state_scope_value is still a raw string');
});

/* ── summary ───────────────────────────────────────────────────────────────── */
console.log(`\n${pass} passed · ${fail} failed`);
if (fail) {
  console.log('failing:');
  failures.forEach((f) => console.log(`  · ${f}`));
}
if (KEEP) console.log(`\nsnapshot kept at ${TMP}`);
else fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
