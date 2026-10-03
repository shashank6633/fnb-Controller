#!/usr/bin/env node
/**
 * GUEST FEEDBACK — CAPTURE. THE PATH THE OWNER'S TABLET TAKES. PROOF.
 *
 *   node scripts/feedback-capture-tests.js   (also: npm run test:feedback-capture)
 *
 * ── WHY THIS IS A SECOND SUITE AND NOT MORE OF `feedback-scope-tests.js` ─────
 * The 526-assertion suite is a REPORTING suite. Its fixture (`feedback-scope-
 * fixture.js`) seeds `gf_visits` / `gf_item_feedback` / `gf_follow_ups` with
 * prepared INSERTs and then drives `analytics()` and `buildReport()`. That is the
 * right shape for what it proves — the fairness ruling, venue invariance, eight
 * downloads — and it is exactly the wrong shape for proving CAPTURE, because its
 * two worlds are hand-built datasets whose numbers are computed by hand in that
 * file. Dropping a live submit into the middle of them would move every expected
 * total in a 1,433-line suite and prove nothing about capture that was not
 * already assumed.
 *
 * THAT IS ALSO HOW THE DEFECT SURVIVED 526 ASSERTIONS. Nothing in the module went
 * through capture, because capture did not exist: `src/lib/feedback/write.ts` was
 * absent, `POST /api/feedback` was absent, and `grep -rn "INSERT INTO gf_" src/`
 * returned nothing at all. The reporting side was measured to death over rows no
 * code could ever have produced. So this suite starts at the other end:
 *
 *     a REAL order  →  the REAL `POST` handler  →  the REAL `gf_` rows
 *                   →  the REAL `analytics()` and the REAL tracker query
 *
 * ── IT DRIVES THE SHIPPED HANDLER, NOT A RE-IMPLEMENTATION ──────────────────
 * `POST` is `require`d straight out of `src/app/api/feedback/route.ts` and called
 * with a real `Request`. That means the real `requireFeedbackRecorder()` →
 * `feedbackAccess()` gate, the real `getCurrentUser()` reading a real `sessions`
 * row through a stubbed `next/headers` cookie jar, the real `getDb()` opening the
 * snapshot, the real `submitFeedback()` transaction. The only stub in the process
 * is `next/headers` — Next's request store does not exist outside a server, and
 * stubbing the cookie jar is what lets the rest be genuine.
 *
 * `GET /api/feedback/order/[orderId]` is driven the same way, because the
 * owner's bug report is half about it: "In Floor Feedback Page for the Table no
 * FA3 it showing 2 items. Idli and Masala Dosa. But when i Click on Take
 * Feedback It is not showing the Ordered Items. Its showing the Other Items."
 * Gate B asserts the read route returns IDLI and MASALA DOSA for FA3 and nothing
 * else — the fixture is named after his own table and his own two dishes on
 * purpose, so a future reader can match the test to the complaint.
 *
 * ── SANDBOX CONTRACT ────────────────────────────────────────────────────────
 * Every byte is written to a `VACUUM INTO` snapshot taken through a READONLY
 * handle into a fresh `os.tmpdir()` directory. The snapshot is deliberately NAMED
 * `fnb-controller.db` inside that directory, and the process `chdir()`s there
 * BEFORE the first `getDb()`, because `DB_PATH` is `process.cwd()/fnb-controller
 * .db` — that is how the shipped route gets handed a sandbox without changing a
 * line of it. `assertSandboxed()` then re-reads the open handle's own filename
 * and aborts unless it is that file. Nothing here DELETEs a row it did not
 * create: every fixture id starts `fc-`, and the cleanup is scoped to them, so
 * running this against a database that holds real feedback cannot erase it.
 *
 * ── WHAT EACH GATE PROVES ───────────────────────────────────────────────────
 *   A  THE GATE IS THE MODULE'S OWN. Signed out → 401 `signed_out`. A Captain →
 *      403 `role_not_gre`. A login with NO role assigned → 403
 *      `no_role_assigned`, carrying the "ASSIGN the role" remedy verbatim. The
 *      assigned GRE and a Floor Manager are both let through. Nothing is written
 *      by any refusal.
 *   B  THE READ IS THE REAL ORDER. FA3 returns exactly Idli and Masala Dosa,
 *      split Food/Drinks SERVER-SIDE from `order_items.station`, with no money
 *      field anywhere in the payload; a blank station is reported as
 *      unrecognised and still counted under Food.
 *   C  THE 10-SECOND HAPPY PATH. "Everything Good" → 201, ONE `gf_visits` row,
 *      and ZERO `gf_item_feedback` rows. Silence is not a rating.
 *   D  PER-ITEM CAPTURE AT THE POINT OF COMPLAINT — the owner's product point.
 *      Masala Dosa rated Poor / Cold / Remade writes ONE item row with
 *      `is_negative = 1`, `menu_item_id` taken from `order_items` and not from the
 *      body, `item_group` derived from the station, and ONE OPEN follow-up. The
 *      Idli nobody tapped has NO ROW.
 *   E  SILENCE STAYS SILENT even when the body mentions the item: an entry whose
 *      only content is `action: 'none'` is ignored and reported, not stored.
 *   F  AN ITEM MUST BE ON THAT ORDER. A body carrying another table's
 *      `order_item_id` is refused 400 `item_not_on_order` and writes NOTHING.
 *   G  A DOUBLE-TAP CANNOT INFLATE COVERAGE. The same GRE posting twice gets 200
 *      `duplicate: true` and the `gf_visits` count does not move.
 *   H  A SECOND PERSON IS REFUSED BY NAME, 409 `already_taken`.
 *   I  THE REVISIT LIFECYCLE IS THE OWNER'S. "Yes - Happy" closes the follow-up;
 *      "Partially Happy" leaves it OPEN and stamps `escalated_at`.
 *   J  AN UNKNOWN ENUM IS A REFUSAL, not a silent ''. And an empty submit is
 *      `nothing_to_record`, so an abandoned form never becomes coverage.
 *   N  A BAD NIGHT WITH NO DISH TAPPED. A Poor overall with no item tapped stores
 *      the rating and stores `has_negative = 0`, because that column is a CACHE of
 *      the ITEM rows and the tracker recounts it as such. The consequence — the
 *      floor board calls that table "Feedback Taken", not "Issue Raised" — is
 *      asserted out loud instead of being discovered later.
 *   K  THE CACHED COUNTERS AGREE WITH THEIR CONSUMER. `has_negative` /
 *      `follow_ups_total` / `open_follow_ups` match a recount from the rows, and
 *      the shipped tracker query reports `cache_mismatch: 0`.
 *   L  🔒 THE POS IS UNTOUCHED. `orders`, `order_items` and `restaurant_tables`
 *      are hashed row by row before the first submit and after the last one and
 *      must be IDENTICAL — the owner's read-only rule, measured rather than
 *      asserted in a comment. Recording "Item Cancelled" must not cancel an item.
 *   M  ANALYTICS SEE WHAT WAS CAPTURED. The real `analytics()` payload is taken
 *      BEFORE and AFTER, and the DELTA is exactly the captured rows — feedbacks
 *      recorded, the negative count, the dish's own Menu Item Analysis row and
 *      the pending follow-up. Asserted as a delta, not an absolute, so the suite
 *      is honest on a database that already holds real feedback.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const REPO = path.resolve(__dirname, '..');
const LIVE_DB = path.join(REPO, 'fnb-controller.db');
const SRC = path.join(REPO, 'src');

/* ── 0. SNAPSHOT ─────────────────────────────────────────────────────────── */

if (!fs.existsSync(LIVE_DB)) {
  console.error('feedback-capture-tests: ' + LIVE_DB + ' not found - nothing to snapshot.');
  process.exit(2);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-feedback-capture-')));
/** NAMED fnb-controller.db on purpose: `DB_PATH` in src/lib/db.ts is
 *  `process.cwd()/fnb-controller.db`, so the chdir below is what hands the
 *  SHIPPED route a sandbox without the route knowing anything about tests. */
const SNAP = path.join(TMP, 'fnb-controller.db');
{
  const src = new Database(LIVE_DB, { readonly: true });
  src.prepare('VACUUM INTO ?').run(SNAP);   // parameterised - no filename in SQL
  src.close();
}
process.chdir(TMP);

console.log('Guest Feedback - CAPTURE. Snapshot in ' + TMP);

/* ── 1. THE LOADERS ──────────────────────────────────────────────────────── */

const ts = require(path.join(REPO, 'node_modules', 'typescript'));
const Module = require('module');

/**
 * The cookie jar. `getCurrentUser()` is `cookies()` from `next/headers`, which
 * needs Next's per-request async store and therefore cannot run here. This is
 * the ONLY stub in the process: everything it feeds — the session lookup, the
 * role join, `feedbackAccess()`, the transaction — is the shipped code.
 */
const STUB = path.join(TMP, 'next-headers-stub.js');
fs.writeFileSync(
  STUB,
  `'use strict';
let token = null;
module.exports.__setSession = (t) => { token = t; };
module.exports.cookies = async () => ({
  get: (name) => (name === 'fnb_session' && token ? { value: token } : undefined),
});
`,
);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'next/headers') return STUB;
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

const headers = require(STUB);
const DB = require(path.join(SRC, 'lib', 'db.ts'));
const V = require(path.join(SRC, 'lib', 'feedback.ts'));
const RD = require(path.join(SRC, 'lib', 'feedback', 'read.ts'));
const R = require(path.join(SRC, 'lib', 'feedback', 'reporting.ts'));
const W = require(path.join(SRC, 'lib', 'feedback', 'write.ts'));
const POST_ROUTE = require(path.join(SRC, 'app', 'api', 'feedback', 'route.ts'));
const ORDER_ROUTE = require(path.join(SRC, 'app', 'api', 'feedback', 'order', '[orderId]', 'route.ts'));
const TRACKER = require(path.join(SRC, 'app', 'api', 'feedback', 'tracker', 'query.ts'));

/* ── 2. THE SANDBOX ASSERTION ────────────────────────────────────────────── */

/** The gf_ tables are created at boot and nowhere else, so this snapshot almost
 *  certainly arrives WITHOUT them - the exact condition that killed
 *  feedback-scope-tests.js before its first assertion. Recorded, then fixed by
 *  the shipped `createGuestFeedbackSchema()`. */
const GF_ABSENT_IN_SNAPSHOT = (() => {
  const h = new Database(SNAP, { readonly: true });
  const n = h.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'gf\\_%' ESCAPE '\\'`).get().n;
  h.close();
  return Number(n) === 0;
})();

const db = DB.getDb();
{
  const open = typeof db.name === 'string' && db.name ? path.resolve(db.name) : '';
  if (open !== path.resolve(SNAP)) {
    console.error(`\nFATAL: getDb() opened ${JSON.stringify(open)}, not this run's snapshot `
      + `(${SNAP}). Refusing to write. Aborting.`);
    process.exit(3);
  }
}

/* ── 3. HARNESS ──────────────────────────────────────────────────────────── */

let pass = 0;
let fail = 0;
const failures = [];
function ok(label) { pass++; console.log('  ok   ' + label); }
function bad(label, detail) {
  fail++; failures.push(label);
  console.log('  FAIL ' + label);
  if (detail !== undefined) console.log('       ' + detail);
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(label); else bad(label, 'expected ' + e + ', got ' + a);
}
function truthy(label, v, detail) { if (v) ok(label); else bad(label, detail); }
function section(t) { console.log('\n' + t); }

/* ── 4. THE FIXTURE — the owner's own table and his own two dishes ───────── */

const GRE_ROLE = 'GRE';                    // == access.ts GRE_ROLE_NAME
const PEOPLE = {
  gre:     { id: 'fc-u-gre',    name: 'Asha GRE',       token: 'fc-tok-gre' },
  gre2:    { id: 'fc-u-gre2',   name: 'Bina GRE',       token: 'fc-tok-gre2' },
  capt:    { id: 'fc-u-capt',   name: 'Chandu Captain', token: 'fc-tok-capt' },
  norole:  { id: 'fc-u-norole', name: 'Dev NoRole',     token: 'fc-tok-norole' },
  mgr:     { id: 'fc-u-mgr',    name: 'Eshwar FloorMgr', token: 'fc-tok-mgr' },
};

const ORDERS = {
  fa3: { id: 'fc-o-fa3', table: 'fc-t-fa3', number: 77003, covers: 2 },
  fa4: { id: 'fc-o-fa4', table: 'fc-t-fa4', number: 77004, covers: 4 },
  fa5: { id: 'fc-o-fa5', table: 'fc-t-fa5', number: 77005, covers: 3 },
  fa6: { id: 'fc-o-fa6', table: 'fc-t-fa6', number: 77006, covers: 2 },
  fa7: { id: 'fc-o-fa7', table: 'fc-t-fa7', number: 77007, covers: 2 },
  fa8: { id: 'fc-o-fa8', table: 'fc-t-fa8', number: 77008, covers: 2 },
  fa9: { id: 'fc-o-fa9', table: 'fc-t-fa9', number: 77009, covers: 2 },
};

/** `order_items`, with the stations that decide Food vs Drinks server-side.
 *  'indian' and 'cocktail' are both REAL `menu_items.station` values on this
 *  database, so `knownStations()` recognises them; '' is the unrecognised case
 *  the classifier files under Food and the payload must own up to. */
const LINES = [
  { id: 'fc-oi-fa3-idli',  order: 'fc-o-fa3', name: 'Idli',         station: 'indian',   qty: 2, menu: 'fc-mi-idli' },
  { id: 'fc-oi-fa3-dosa',  order: 'fc-o-fa3', name: 'Masala Dosa',  station: 'indian',   qty: 1, menu: 'fc-mi-dosa' },
  { id: 'fc-oi-fa4-mojito', order: 'fc-o-fa4', name: 'Virgin Mojito', station: 'cocktail', qty: 2, menu: 'fc-mi-mojito' },
  { id: 'fc-oi-fa4-secret', order: 'fc-o-fa4', name: 'Chef Special',  station: '',         qty: 1, menu: '' },
  { id: 'fc-oi-fa5-idli',  order: 'fc-o-fa5', name: 'Idli',         station: 'indian',   qty: 3, menu: 'fc-mi-idli' },
  { id: 'fc-oi-fa6-dosa',  order: 'fc-o-fa6', name: 'Masala Dosa',  station: 'indian',   qty: 1, menu: 'fc-mi-dosa' },
  { id: 'fc-oi-fa7-dosa',  order: 'fc-o-fa7', name: 'Masala Dosa',  station: 'indian',   qty: 1, menu: 'fc-mi-dosa' },
  { id: 'fc-oi-fa8-idli',  order: 'fc-o-fa8', name: 'Idli',         station: 'indian',   qty: 1, menu: 'fc-mi-idli' },
  { id: 'fc-oi-fa9-idli',  order: 'fc-o-fa9', name: 'Idli',         station: 'indian',   qty: 1, menu: 'fc-mi-idli' },
];

/** A dine-in order with NO TABLE — `orders.table_id` is nullable. It exists only
 *  so gate J can reach the "a visit without a table is unreadable" refusal
 *  honestly; it is NOT in `ORDERS`, so nothing else touches it. */
const NO_TABLE_ORDER = 'fc-o-notable';

/** Every id this suite is allowed to delete. Scoped cleanup, so running against
 *  a database that holds REAL feedback cannot erase any of it. */
const FC_ORDER_IDS = [...Object.values(ORDERS).map((o) => o.id), NO_TABLE_ORDER];

function seed() {
  DB.createGuestFeedbackSchema(db);            // the shipped DDL, not a copy

  const del = (sql, params) => db.prepare(sql).run(params);
  const inList = FC_ORDER_IDS.map(() => '?').join(',');
  db.prepare(`DELETE FROM gf_follow_ups    WHERE order_id IN (${inList})`).run(...FC_ORDER_IDS);
  db.prepare(`DELETE FROM gf_item_feedback WHERE order_id IN (${inList})`).run(...FC_ORDER_IDS);
  db.prepare(`DELETE FROM gf_visits        WHERE order_id IN (${inList})`).run(...FC_ORDER_IDS);
  db.prepare(`DELETE FROM order_items      WHERE order_id IN (${inList})`).run(...FC_ORDER_IDS);
  db.prepare(`DELETE FROM orders           WHERE id       IN (${inList})`).run(...FC_ORDER_IDS);
  del(`DELETE FROM restaurant_tables WHERE id LIKE 'fc-t-%'`, []);
  del(`DELETE FROM sessions WHERE token LIKE 'fc-tok-%'`, []);
  del(`DELETE FROM users WHERE id LIKE 'fc-u-%'`, []);

  /* ── roles. The three non-GRE ones are the owner's REAL production rows,
        reused rather than invented, so the deny/allow proof is about the roles
        that actually exist. 'GRE' is created only if it is absent. ─────────── */
  const roleIdByName = (name) => {
    const r = db.prepare('SELECT id FROM roles WHERE name = ?').get(name);
    return r ? String(r.id) : null;
  };
  let greRoleId = roleIdByName(GRE_ROLE);
  if (!greRoleId) {
    greRoleId = 'fc-role-gre';
    db.prepare(
      `INSERT INTO roles (id, name, base_role, page_access, is_active)
       VALUES (?, ?, 'staff', NULL, 1)`,
    ).run(greRoleId, GRE_ROLE);
  }
  const captRoleId = roleIdByName('Captain');
  const mgrRoleId = roleIdByName('Floor Manager');
  if (!captRoleId || !mgrRoleId) {
    console.error('feedback-capture-tests: this database has no "Captain" / "Floor Manager" role; '
      + 'gate A would be vacuous. Aborting.');
    process.exit(4);
  }

  const uIns = db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, is_active, role_id, section)
     VALUES (@id, @email, 'x', @name, @role, 1, @role_id, '')`,
  );
  uIns.run({ id: PEOPLE.gre.id, email: 'fc-gre@x.test', name: PEOPLE.gre.name, role: 'staff', role_id: greRoleId });
  uIns.run({ id: PEOPLE.gre2.id, email: 'fc-gre2@x.test', name: PEOPLE.gre2.name, role: 'staff', role_id: greRoleId });
  uIns.run({ id: PEOPLE.capt.id, email: 'fc-capt@x.test', name: PEOPLE.capt.name, role: 'staff', role_id: captRoleId });
  uIns.run({ id: PEOPLE.norole.id, email: 'fc-norole@x.test', name: PEOPLE.norole.name, role: 'staff', role_id: null });
  uIns.run({ id: PEOPLE.mgr.id, email: 'fc-mgr@x.test', name: PEOPLE.mgr.name, role: 'manager', role_id: mgrRoleId });

  const sIns = db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
  );
  for (const p of Object.values(PEOPLE)) sIns.run(p.token, p.id);

  /* ── the room. 'Ground' is a zone, which is what `floor` snapshots. ─────── */
  const tIns = db.prepare(
    `INSERT INTO restaurant_tables (id, outlet_id, table_number, zone, section, seats, is_active)
     VALUES (?, '', ?, 'Ground', 'A', 4, 1)`,
  );
  // NOW, so the order lands inside the CURRENT business day: the tracker reads
  // today's service and `feedbackBoardCutoff()` is the shipped answer for where
  // today starts. `bill_requested_at` makes the table eligible whatever the
  // admin item threshold is set to.
  const oIns = db.prepare(
    `INSERT INTO orders (id, outlet_id, order_number, table_id, status, order_type, covers,
                         server_name, created_at, bill_requested_at, total)
     VALUES (?, '', ?, ?, 'open', 'dine-in', ?, 'Captain One',
             datetime('now'), datetime('now'), 0)`,
  );
  for (const key of Object.keys(ORDERS)) {
    const o = ORDERS[key];
    tIns.run(o.table, o.table.replace('fc-t-', '').toUpperCase());
    oIns.run(o.id, o.number, o.table, o.covers);
  }

  // The table-less order. Dine-in, eligible, with a line — and no table, which
  // every reader in the module drops.
  db.prepare(
    `INSERT INTO orders (id, outlet_id, order_number, table_id, status, order_type, covers,
                         server_name, created_at, bill_requested_at, total)
     VALUES (?, '', 77099, NULL, 'open', 'dine-in', 2, 'Captain One',
             datetime('now'), datetime('now'), 0)`,
  ).run(NO_TABLE_ORDER);

  const oiIns = db.prepare(
    `INSERT INTO order_items (id, order_id, menu_item_id, name, station, quantity,
                              unit_price, line_total, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 120, 120, 'served', datetime('now'))`,
  );
  for (const l of LINES) oiIns.run(l.id, l.order, l.menu || null, l.name, l.station, l.qty);
  oiIns.run('fc-oi-notable-idli', NO_TABLE_ORDER, 'fc-mi-idli', 'Idli', 'indian', 1);
}

/* ── 5. DRIVING THE SHIPPED HANDLERS ─────────────────────────────────────── */

/** Sign in as somebody (or nobody) for the next handler call. */
const signIn = (who) => headers.__setSession(who ? who.token : null);

/** POST /api/feedback, through the real handler. */
async function post(who, body) {
  signIn(who);
  const res = await POST_ROUTE.POST(new Request('http://localhost/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  let json = null;
  try { json = await res.json(); } catch { /* keep null */ }
  return { status: res.status, body: json };
}

/** GET /api/feedback/order/[orderId], through the real handler. */
async function getOrder(who, orderId) {
  signIn(who);
  const res = await ORDER_ROUTE.GET(
    new Request(`http://localhost/api/feedback/order/${orderId}`),
    { params: Promise.resolve({ orderId }) },
  );
  let json = null;
  try { json = await res.json(); } catch { /* keep null */ }
  return { status: res.status, body: json };
}

/* ── 6. COUNTERS AND HASHES ──────────────────────────────────────────────── */

const gfCounts = () => ({
  visits: db.prepare('SELECT COUNT(*) AS n FROM gf_visits').get().n,
  items: db.prepare('SELECT COUNT(*) AS n FROM gf_item_feedback').get().n,
  follow_ups: db.prepare('SELECT COUNT(*) AS n FROM gf_follow_ups').get().n,
});

/**
 * 🔒 THE READ-ONLY PROOF. Every row of the three POS tables this module reads,
 * ordered and hashed. The owner's rule is "no orders, no quantities, no KOT
 * edits, no bills, no discounts", and the only way to know a writer honoured it
 * is to measure the tables it is forbidden to touch.
 */
/** Row count of EVERY table, so "only gf_ moved" can be asserted by name rather
 *  than by a hand-kept list of three tables. */
function tableCounts() {
  const out = {};
  const names = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => String(r.name));
  for (const n of names) {
    try {
      out[n] = db.prepare(`SELECT COUNT(*) AS c FROM "${n}"`).get().c;
    } catch { /* a view-like or corrupt table: skip rather than fail the gate */ }
  }
  return out;
}

function posHash() {
  const h = crypto.createHash('sha256');
  for (const sql of [
    'SELECT * FROM orders ORDER BY id',
    'SELECT * FROM order_items ORDER BY id',
    'SELECT * FROM restaurant_tables ORDER BY id',
  ]) {
    for (const row of db.prepare(sql).all()) h.update(JSON.stringify(row));
  }
  return h.digest('hex');
}

/** The venue analytics payload, through the SHIPPED entry points. */
function analytics(businessDate) {
  const filters = R.filtersFromQuery(
    new URLSearchParams(`range=custom&from=${businessDate}&to=${businessDate}`),
  );
  return R.analytics(db, { outletId: '', filters, nowMs: Date.now() });
}

/* ════════════════════════════════════════════════════════════════════════════
   THE RUN
   ════════════════════════════════════════════════════════════════════════════ */

async function main() {
  section('0. THE SNAPSHOT AND THE SCHEMA');
  truthy('the snapshot arrived WITHOUT the gf_ tables (they are created at boot only)',
    GF_ABSENT_IN_SNAPSHOT,
    'this database already had gf_ tables - the schema-lift regression below is not being exercised');
  for (const t of V.GF_TABLES) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name = ?')
      .get('table', t);
    eq(`getDb() boot created ${t}`, row.n, 1);
  }
  eq('uq_gf_visits_order exists (one visit per order, enforced by the database)',
    db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='uq_gf_visits_order'`).get().n, 1);

  seed();
  const day = RD.feedbackBoardCutoff(db);
  truthy('the board cutoff resolved a business date for today', /^\d{4}-\d{2}-\d{2}$/.test(day.businessDate), day.businessDate);

  const posBefore = posHash();
  const countsBefore = tableCounts();
  const analyticsBefore = analytics(day.businessDate);

  /* ── GATE A ────────────────────────────────────────────────────────────── */
  section('A. THE GATE IS THE MODULE\'S OWN, AND IT FAILS CLOSED');
  {
    const base = gfCounts();

    const out = await post(null, { order_id: ORDERS.fa3.id, everything_good: true });
    eq('A1: signed out → 401', out.status, 401);
    eq('A1: reason', out.body && out.body.reason, 'signed_out');

    const capt = await post(PEOPLE.capt, { order_id: ORDERS.fa3.id, everything_good: true });
    eq('A2: a Captain → 403', capt.status, 403);
    eq('A2: reason', capt.body && capt.body.reason, 'role_not_gre');

    const nor = await post(PEOPLE.norole, { order_id: ORDERS.fa3.id, everything_good: true });
    eq('A3: a login with NO role assigned → 403', nor.status, 403);
    eq('A3: reason', nor.body && nor.body.reason, 'no_role_assigned');
    truthy('A3: the refusal carries the "ASSIGN that role" remedy the screen prints verbatim',
      !!(nor.body && /ASSIGN that role/.test(String(nor.body.what_to_do || ''))),
      JSON.stringify(nor.body && nor.body.what_to_do));

    eq('A4: not one refusal wrote a gf_ row', gfCounts(), base);

    // And the two populations that MAY record. Different orders, because the
    // first accepted submit consumes the one visit row its order is allowed.
    const mgr = await post(PEOPLE.mgr, { order_id: ORDERS.fa7.id, everything_good: true });
    eq('A5: a Floor Manager may record → 201', mgr.status, 201);
    eq('A5: and the row is attributed to the role, not the tier',
      db.prepare('SELECT gre_role FROM gf_visits WHERE order_id = ?').get(ORDERS.fa7.id).gre_role,
      'Floor Manager');
  }

  /* ── GATE B ────────────────────────────────────────────────────────────── */
  section('B. THE READ IS THE REAL ORDER — the owner\'s own complaint');
  {
    const res = await getOrder(PEOPLE.gre, ORDERS.fa3.id);
    eq('B1: GET /api/feedback/order/fc-o-fa3 → 200', res.status, 200);
    const o = res.body && res.body.order;
    truthy('B1: it answers with an order', !!o);
    eq('B2: FA3 shows exactly the two dishes the guest ordered',
      [...(o.food || []), ...(o.drinks || [])].map((i) => i.name).sort(),
      ['Idli', 'Masala Dosa']);
    eq('B2: both are Food, from order_items.station — not guessed from the name',
      (o.food || []).map((i) => i.station), ['indian', 'indian']);
    eq('B2: and nothing lands in Drinks', (o.drinks || []).length, 0);
    eq('B3: table number is the owner\'s FA3', o.table_number, 'FA3');
    eq('B3: item_count', o.item_count, 2);

    // The money rule, measured over the whole payload rather than asserted per
    // field: a price that reappears in a future projection fails this.
    const flat = JSON.stringify(res.body);
    const moneyWords = ['unit_price', 'line_total', 'total', 'discount', 'tax_value', 'cgst', 'sgst', 'amount'];
    eq('B4: no money anywhere in the payload', moneyWords.filter((w) => flat.includes(w)), []);

    const fa4 = await getOrder(PEOPLE.gre, ORDERS.fa4.id);
    const o4 = fa4.body.order;
    eq('B5: a cocktail station splits into Drinks server-side',
      (o4.drinks || []).map((i) => i.name), ['Virgin Mojito']);
    eq('B5: a BLANK station still counts under Food', (o4.food || []).map((i) => i.name), ['Chef Special']);
    eq('B5: and the payload owns up to it', o4.unclassified_count, 1);
    truthy('B5: with the reason in words, not only in a comment',
      String(o4.unclassified_reason || '').includes('blank or not on the menu master'));

    const captRead = await getOrder(PEOPLE.capt, ORDERS.fa3.id);
    eq('B6: a Captain cannot even read the order', captRead.status, 403);
  }

  /* ── GATE C ────────────────────────────────────────────────────────────── */
  section('C. THE 10-SECOND HAPPY PATH — and silence is not a rating');
  {
    const before = gfCounts();
    const res = await post(PEOPLE.gre, {
      order_id: ORDERS.fa5.id,
      everything_good: true,
      overall_rating: 'excellent',
      categories: { food: 'good', drinks: 'good', service: 'good', ambience: 'good' },
    });
    eq('C1: "Everything Good" → 201', res.status, 201);
    eq('C1: duplicate flag is false on the first submit', res.body.duplicate, false);
    eq('C1: status', res.body.status, 'taken');
    eq('C1: ZERO item rows — the GRE tapped no item, so no item was rated',
      res.body.items_recorded, 0);

    const after = gfCounts();
    eq('C2: exactly one gf_visits row was created', after.visits - before.visits, 1);
    eq('C2: and no gf_item_feedback row at all', after.items - before.items, 0);
    eq('C2: and no follow-up', after.follow_ups - before.follow_ups, 0);

    const v = db.prepare('SELECT * FROM gf_visits WHERE order_id = ?').get(ORDERS.fa5.id);
    eq('C3: everything_good stored', v.everything_good, 1);
    eq('C3: has_negative stored 0', v.has_negative, 0);
    eq('C3: the four categories landed in their own columns',
      [v.cat_food, v.cat_drinks, v.cat_service, v.cat_ambience], ['good', 'good', 'good', 'good']);
    eq('C3: the recorder came from the SESSION', [v.gre_user_id, v.gre_name, v.gre_role],
      [PEOPLE.gre.id, PEOPLE.gre.name, GRE_ROLE]);
    eq('C3: table / floor / pax / captain snapshots',
      [v.table_number, v.floor, v.covers, v.captain_name], ['FA5', 'Ground', 3, 'Captain One']);
    eq('C3: items_ordered is the count AT VISIT TIME', v.items_ordered, 1);
    truthy('C3: created_at is stored in the SQL-UTC shape every reader parses',
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(v.created_at)), String(v.created_at));

    // The body cannot name its own recorder. This is the line that stops one
    // tablet posting coverage under somebody else's name.
    const forged = await post(PEOPLE.gre, {
      order_id: ORDERS.fa8.id, everything_good: true,
      gre_user_id: 'fc-u-gre2', gre_name: 'Bina GRE', gre_role: 'Administrator',
    });
    eq('C4: a body that names a recorder → 201 (the fields are simply not read)', forged.status, 201);
    eq('C4: and the row still says who was signed in',
      db.prepare('SELECT gre_user_id, gre_name FROM gf_visits WHERE order_id = ?').get(ORDERS.fa8.id),
      { gre_user_id: PEOPLE.gre.id, gre_name: PEOPLE.gre.name });
  }

  /* ── GATE F (before D, because D consumes FA3's one visit row) ──────────── */
  section('F. AN ITEM MUST BE ON THAT ORDER');
  {
    const before = gfCounts();
    const res = await post(PEOPLE.gre, {
      order_id: ORDERS.fa3.id,
      overall_rating: 'poor',
      items: [
        { order_item_id: 'fc-oi-fa3-dosa', rating: 'poor', issue: 'cold' },
        { order_item_id: 'fc-oi-fa4-mojito', rating: 'poor', issue: 'cold' },  // ANOTHER TABLE'S LINE
      ],
    });
    eq('F1: a dish nobody at this table ordered → 400', res.status, 400);
    eq('F1: reason', res.body.reason, 'item_not_on_order');
    eq('F1: and the refusal names the offending line', res.body.offending_item_ids, ['fc-oi-fa4-mojito']);
    eq('F2: NOTHING was written — not even the half of the body that was valid',
      gfCounts(), before);

    const ghost = await post(PEOPLE.gre, {
      order_id: ORDERS.fa3.id,
      items: [{ order_item_id: 'fc-oi-does-not-exist', rating: 'poor' }],
    });
    eq('F3: an invented line id → 400 item_not_on_order', [ghost.status, ghost.body.reason],
      [400, 'item_not_on_order']);

    const twice = await post(PEOPLE.gre, {
      order_id: ORDERS.fa3.id,
      items: [
        { order_item_id: 'fc-oi-fa3-dosa', rating: 'poor' },
        { order_item_id: 'fc-oi-fa3-dosa', rating: 'good' },
      ],
    });
    eq('F4: the same line twice in one body → 400 duplicate_item',
      [twice.status, twice.body.reason], [400, 'duplicate_item']);
    eq('F5: still nothing written', gfCounts(), before);
  }

  /* ── GATE J ────────────────────────────────────────────────────────────── */
  section('J. AN UNKNOWN VALUE IS A REFUSAL, NOT A SILENT \'\'');
  {
    const before = gfCounts();

    const r1 = await post(PEOPLE.gre, { order_id: ORDERS.fa3.id, overall_rating: 'awful' });
    eq('J1: an overall rating off the enum → 400 bad_value', [r1.status, r1.body.reason], [400, 'bad_value']);
    truthy('J1: and the message names the field and the value',
      /overall_rating/.test(r1.body.error) && /awful/.test(r1.body.error), r1.body.error);

    const r2 = await post(PEOPLE.gre, {
      order_id: ORDERS.fa3.id,
      items: [{ order_item_id: 'fc-oi-fa3-dosa', rating: 'terrible' }],
    });
    eq('J2: an item rating off the enum → 400 bad_value', [r2.status, r2.body.reason], [400, 'bad_value']);

    const r3 = await post(PEOPLE.gre, {
      order_id: ORDERS.fa3.id,
      items: [{ order_item_id: 'fc-oi-fa3-dosa', rating: 'poor', action: 'thrown_away' }],
    });
    eq('J3: an action off the enum → 400 bad_value', [r3.status, r3.body.reason], [400, 'bad_value']);

    const r4 = await post(PEOPLE.gre, { order_id: ORDERS.fa3.id });
    eq('J4: an abandoned form → 400 nothing_to_record (never coverage)',
      [r4.status, r4.body.reason], [400, 'nothing_to_record']);

    const r5 = await post(PEOPLE.gre, { everything_good: true });
    eq('J5: no order_id → 400 order_id_required', [r5.status, r5.body.reason], [400, 'order_id_required']);

    const r6 = await post(PEOPLE.gre, { order_id: 'fc-o-nope', everything_good: true });
    eq('J6: an order that does not exist → 404 order_not_found',
      [r6.status, r6.body.reason], [404, 'order_not_found']);

    const r7 = await post(PEOPLE.gre, 'not json at all');
    eq('J7: a body that is not JSON → 400', r7.status, 400);

    // A TAKEAWAY ORDER. Every reader in the module drops a non-dine-in order, so
    // a visit recorded against one would be a row no report could ever show.
    db.prepare(`UPDATE orders SET order_type = 'takeaway' WHERE id = ?`).run(ORDERS.fa4.id);
    const r8 = await post(PEOPLE.gre, { order_id: ORDERS.fa4.id, everything_good: true });
    db.prepare(`UPDATE orders SET order_type = 'dine-in' WHERE id = ?`).run(ORDERS.fa4.id);
    eq('J8: a takeaway order → 400 not_a_table_visit (not an unreadable gf_visits row)',
      [r8.status, r8.body.reason], [400, 'not_a_table_visit']);

    // AND AN ORDER WITH NO TABLE AT ALL — same trap, other half. `table_id` is
    // nullable and carries an FK to `restaurant_tables`, so the honest way to
    // reach this state is a NULL, not a dangling id (the FK is ON at boot and
    // refuses one).
    const r9 = await post(PEOPLE.gre, { order_id: 'fc-o-notable', everything_good: true });
    eq('J9: an order with no table → 400 not_a_table_visit',
      [r9.status, r9.body.reason], [400, 'not_a_table_visit']);

    eq('J10: nine refusals, zero rows', gfCounts(), before);
  }

  /* ── GATE D + E ────────────────────────────────────────────────────────── */
  section('D/E. PER-ITEM CAPTURE AT THE POINT OF COMPLAINT');
  {
    const before = gfCounts();
    const res = await post(PEOPLE.gre, {
      order_id: ORDERS.fa3.id,
      overall_rating: 'average',
      categories: { food: 'poor', service: 'good' },
      comment: 'Dosa came cold, guest asked for a fresh one',
      items: [
        // THE COMPLAINT: the dish the guest actually complained about.
        {
          order_item_id: 'fc-oi-fa3-dosa',
          rating: 'poor', issue: 'cold', comment: 'cold in the middle', action: 'remade',
        },
        // THE SILENCE: mentioned by the client, says nothing about the dish.
        { order_item_id: 'fc-oi-fa3-idli', action: 'none' },
      ],
    });
    eq('D1: → 201', res.status, 201);
    eq('D1: one item recorded, one ignored as empty',
      [res.body.items_recorded, res.body.items_ignored_empty], [1, 1]);
    eq('D1: status is follow_up (an open follow-up outranks a raised issue)', res.body.status, 'follow_up');
    eq('D1: one follow-up created, open', [res.body.follow_ups_created, res.body.follow_ups_open], [1, 1]);

    const after = gfCounts();
    eq('D2: one visit, ONE item row, one follow-up',
      [after.visits - before.visits, after.items - before.items, after.follow_ups - before.follow_ups],
      [1, 1, 1]);

    const rows = db.prepare('SELECT * FROM gf_item_feedback WHERE order_id = ? ORDER BY item_name').all(ORDERS.fa3.id);
    eq('E1: the Idli nobody rated has NO ROW — silence is not a negative rating',
      rows.map((r) => r.item_name), ['Masala Dosa']);

    const it = rows[0];
    eq('D3: the complaint is attached to the real ordered line', it.order_item_id, 'fc-oi-fa3-dosa');
    eq('D3: menu_item_id came from order_items, NOT from the body', it.menu_item_id, 'fc-mi-dosa');
    eq('D3: item_name snapshot', it.item_name, 'Masala Dosa');
    eq('D3: the RAW station is kept', it.station, 'indian');
    eq('D3: and item_group was resolved server-side', it.item_group, 'food');
    eq('D3: quantity is the ORDERED quantity (Page 4 sums it)', it.quantity, 1);
    eq('D3: rating / issue / action', [it.rating, it.issue, it.action_taken], ['poor', 'cold', 'remade']);
    eq('D3: is_negative follows isNegative(rating)', it.is_negative, 1);
    eq('D3: created_by is the session user', it.created_by, PEOPLE.gre.id);

    const fu = db.prepare('SELECT * FROM gf_follow_ups WHERE order_id = ?').get(ORDERS.fa3.id);
    eq('D4: Remade ⇒ a follow-up, born OPEN', fu.status, 'open');
    eq('D4: it points at the item feedback row, not just the visit', fu.item_feedback_id, it.id);
    eq('D4: and names the dish', fu.item_name, 'Masala Dosa');
    eq('D4: nothing revisited it yet', [fu.revisited_at, fu.closed_at, fu.escalated_at], ['', '', '']);

    const v = db.prepare('SELECT * FROM gf_visits WHERE order_id = ?').get(ORDERS.fa3.id);
    eq('D5: the visit says it has a negative', v.has_negative, 1);
    eq('D5: counters', [v.follow_ups_total, v.open_follow_ups], [1, 1]);
    eq('D5: everything_good was NOT claimed', v.everything_good, 0);
    eq('D5: the free comment is stored', v.comment, 'Dosa came cold, guest asked for a fresh one');

    // The contradiction guard: "Everything Good" cannot coexist with a Poor plate.
    const contra = await post(PEOPLE.gre, {
      order_id: ORDERS.fa4.id,
      everything_good: true,
      items: [{ order_item_id: 'fc-oi-fa4-mojito', rating: 'poor', issue: 'taste' }],
    });
    eq('D6: "Everything Good" alongside a Poor plate → 201 but the flag is overridden',
      [contra.status, contra.body.everything_good_overridden], [201, true]);
    eq('D6: the stored row stays honest',
      db.prepare('SELECT everything_good, has_negative FROM gf_visits WHERE order_id = ?').get(ORDERS.fa4.id),
      { everything_good: 0, has_negative: 1 });
    eq('D6: and a drink\'s complaint files under Drinks',
      db.prepare('SELECT item_group FROM gf_item_feedback WHERE order_item_id = ?').get('fc-oi-fa4-mojito').item_group,
      'drinks');
  }

  /* ── GATE G + H ────────────────────────────────────────────────────────── */
  section('G/H. A SECOND SUBMIT CANNOT INFLATE COVERAGE');
  {
    const before = gfCounts();
    const firstVisit = db.prepare('SELECT id FROM gf_visits WHERE order_id = ?').get(ORDERS.fa3.id).id;

    const again = await post(PEOPLE.gre, {
      order_id: ORDERS.fa3.id,
      overall_rating: 'average',
      items: [{ order_item_id: 'fc-oi-fa3-dosa', rating: 'poor', issue: 'cold', action: 'remade' }],
    });
    eq('G1: the SAME GRE submitting again → 200, not an error', again.status, 200);
    eq('G1: duplicate: true', again.body.duplicate, true);
    eq('G1: it hands back the SAME visit id', again.body.visit_id, firstVisit);
    eq('G2: no second visit, no second item row, no second follow-up', gfCounts(), before);

    const other = await post(PEOPLE.gre2, { order_id: ORDERS.fa3.id, everything_good: true });
    eq('H1: a DIFFERENT person → 409', other.status, 409);
    eq('H1: reason', other.body.reason, 'already_taken');
    eq('H1: and the refusal names who holds the record', other.body.taken_by, PEOPLE.gre.name);
    truthy('H1: and points at the honest next step', /revisit/.test(other.body.error), other.body.error);
    eq('H2: still exactly one visit row for FA3',
      db.prepare('SELECT COUNT(*) AS n FROM gf_visits WHERE order_id = ?').get(ORDERS.fa3.id).n, 1);
    eq('H3: nothing moved', gfCounts(), before);
  }

  /* ── GATE I ────────────────────────────────────────────────────────────── */
  section('I. THE REVISIT LIFECYCLE IS THE OWNER\'S');
  {
    // Three lifecycles have to be driven, and one order may hold ONE visit — so
    // FA6's gf_ rows are cleared between them. Scoped to this suite's own ids
    // (FC_ORDER_IDS), and it is a TEST-ONLY delete: `write.ts` has no delete at
    // all and the route exports no verb but POST.
    const reset = (orderId) => {
      db.prepare('DELETE FROM gf_follow_ups WHERE order_id = ?').run(orderId);
      db.prepare('DELETE FROM gf_item_feedback WHERE order_id = ?').run(orderId);
      db.prepare('DELETE FROM gf_visits WHERE order_id = ?').run(orderId);
    };

    // "Yes - Happy" closes. Recorded in the same submit, which is what the screen
    // offers the moment an action raises a follow-up.
    const closed = await post(PEOPLE.gre, {
      order_id: ORDERS.fa6.id,
      overall_rating: 'good',
      items: [{
        order_item_id: 'fc-oi-fa6-dosa',
        rating: 'average', issue: 'delay', action: 'replaced_same',
        revisit: { rating: 'good', happiness: 'happy', comment: 'happy with the fresh one' },
      }],
    });
    eq('I1: Fresh Item Replaced + "Yes - Happy" → 201', closed.status, 201);
    eq('I1: one follow-up, created and CLOSED in the same submit',
      [closed.body.follow_ups_created, closed.body.follow_ups_closed, closed.body.follow_ups_open],
      [1, 1, 0]);
    eq('I1: so the visit is "issue", not "follow_up"', closed.body.status, 'issue');
    {
      const fu = db.prepare('SELECT * FROM gf_follow_ups WHERE order_id = ?').get(ORDERS.fa6.id);
      eq('I2: status closed', fu.status, 'closed');
      eq('I2: happiness + revisit rating + comment stored',
        [fu.happiness, fu.revisit_rating, fu.revisit_comment],
        ['happy', 'good', 'happy with the fresh one']);
      truthy('I2: closed_at and closed_by are stamped', !!fu.closed_at && fu.closed_by === PEOPLE.gre.id);
      truthy('I2: revisited_at is stamped', !!fu.revisited_at);
      eq('I2: and it did NOT escalate — happy closes it', fu.escalated_at, '');
      eq('I2: the visit counters agree',
        db.prepare('SELECT follow_ups_total, open_follow_ups FROM gf_visits WHERE order_id = ?').get(ORDERS.fa6.id),
        { follow_ups_total: 1, open_follow_ups: 0 });
    }

    // "Partially Happy" is deliberately NOT a close.
    reset(ORDERS.fa6.id);
    const partial = await post(PEOPLE.gre, {
      order_id: ORDERS.fa6.id,
      items: [{
        order_item_id: 'fc-oi-fa6-dosa',
        rating: 'poor', issue: 'cold', action: 'remade',
        revisit: { rating: 'average', happiness: 'partial' },
      }],
    });
    eq('I3: "Partially Happy" → the complaint STAYS OPEN',
      [partial.status, partial.body.follow_ups_open, partial.body.follow_ups_closed], [201, 1, 0]);
    {
      const fu = db.prepare('SELECT * FROM gf_follow_ups WHERE order_id = ?').get(ORDERS.fa6.id);
      eq('I3: status open', fu.status, 'open');
      truthy('I3: and escalated_at is stamped — "stays open for Manager attention"', !!fu.escalated_at);
      eq('I3: closed_at stays empty', fu.closed_at, '');
      eq('I3: the visit is follow_up', db.prepare('SELECT status FROM gf_visits WHERE order_id = ?').get(ORDERS.fa6.id).status, 'follow_up');
    }

    // An action that is service recovery but NOT a remake/replacement raises no
    // follow-up: there is nothing to revisit.
    reset(ORDERS.fa6.id);
    const cancelled = await post(PEOPLE.gre, {
      order_id: ORDERS.fa6.id,
      items: [{ order_item_id: 'fc-oi-fa6-dosa', rating: 'poor', issue: 'too_salty', action: 'cancelled' }],
    });
    eq('I4: Item Cancelled records the complaint and raises NO follow-up',
      [cancelled.status, cancelled.body.items_recorded, cancelled.body.follow_ups_created], [201, 1, 0]);
    eq('I4: the visit is "issue"', cancelled.body.status, 'issue');
    eq('I4: and `requiresFollowUp` is the authority, not a list in the writer',
      [V.requiresFollowUp('cancelled'), V.requiresFollowUp('returned'), V.requiresFollowUp('remade'),
        V.requiresFollowUp('replaced_same'), V.requiresFollowUp('replaced_other')],
      [false, false, true, true, true]);
  }

  /* ── GATE N ────────────────────────────────────────────────────────────── */
  section('N. A BAD NIGHT WITH NO DISH TAPPED — what has_negative is measured against');
  {
    // A real case the screen allows and the owner's own copy invites: the guest
    // grumbles about the service, the GRE rates the night Poor and taps NO dish.
    //
    // `gf_visits.has_negative` is a documented CACHE of the ITEM rows, and the
    // shipped tracker (`query.ts:603-607`) RECOUNTS it as "at least one
    // gf_item_feedback row with is_negative = 1" and reports any disagreement as
    // meta.cache_mismatch. So this visit stores has_negative 0 and status 'taken'
    // — the rating is NOT lost (overall_rating is 'poor' and Page 4's rating split
    // counts it), but the FLOOR BOARD will show this table as "Feedback Taken"
    // rather than "Issue Raised". That consequence is asserted here rather than
    // left to be discovered, and it is a question for the owner, not a bug to fix
    // by making the cache disagree with the only code that checks it.
    const res = await post(PEOPLE.gre, {
      order_id: ORDERS.fa9.id,
      overall_rating: 'poor',
      categories: { service: 'poor' },
      comment: 'Waited 40 minutes for the bill',
    });
    eq('N1: a Poor night with no dish tapped → 201', res.status, 201);
    eq('N1: no item rows, because no item was tapped', res.body.items_recorded, 0);
    const v = db.prepare('SELECT * FROM gf_visits WHERE order_id = ?').get(ORDERS.fa9.id);
    eq('N2: the Poor rating IS stored', [v.overall_rating, v.cat_service], ['poor', 'poor']);
    eq('N2: and the guest\'s words', v.comment, 'Waited 40 minutes for the bill');
    eq('N3: has_negative is 0 — it caches the ITEM rows, which is what the tracker recounts',
      v.has_negative, 0);
    eq('N3: so status is "taken", not "issue"', v.status, 'taken');
  }

  /* ── GATE K ────────────────────────────────────────────────────────────── */
  section('K. THE CACHED COUNTERS AGREE WITH THEIR CONSUMER');
  {
    const visits = db.prepare(`SELECT * FROM gf_visits WHERE order_id IN (${FC_ORDER_IDS.map(() => '?').join(',')})`)
      .all(...FC_ORDER_IDS);
    truthy('K0: there are captured visits to check', visits.length >= 4, String(visits.length));

    let mismatches = [];
    for (const v of visits) {
      const negs = db.prepare('SELECT COUNT(*) AS n FROM gf_item_feedback WHERE visit_id = ? AND is_negative = 1').get(v.id).n;
      const total = db.prepare('SELECT COUNT(*) AS n FROM gf_follow_ups WHERE visit_id = ?').get(v.id).n;
      const open = db.prepare(`SELECT COUNT(*) AS n FROM gf_follow_ups WHERE visit_id = ? AND status = 'open'`).get(v.id).n;
      if (v.has_negative !== (negs > 0 ? 1 : 0) || v.follow_ups_total !== total || v.open_follow_ups !== open) {
        mismatches.push({ order: v.order_id, stored: [v.has_negative, v.follow_ups_total, v.open_follow_ups], counted: [negs > 0 ? 1 : 0, total, open] });
      }
      const expected = open > 0 ? 'follow_up' : negs > 0 ? 'issue' : 'taken';
      if (v.status !== expected) mismatches.push({ order: v.order_id, status: v.status, expected });
    }
    eq('K1: every stored counter equals a recount from the rows it counts', mismatches, []);

    // And the SHIPPED consumer's own verdict, which is the one that matters:
    // `readTracker()` RECOUNTS from the rows and reports every disagreement as
    // `meta.cache_mismatch`. 0 is the expected value; a non-zero would mean the
    // writer's cached counters and Page 3's arithmetic disagree, which is how a
    // follow-up stops appearing on the board it is supposed to appear on.
    const tracker = TRACKER.readTracker(db, { outletId: '', scope: {} });
    eq('K2: the shipped tracker query reports cache_mismatch 0', tracker.meta.cache_mismatch, 0);
    truthy('K2: and it actually had the captured records in scope to check',
      tracker.records.some((r) => FC_ORDER_IDS.includes(r.order_id)),
      'the tracker saw none of this suite\'s orders, so cache_mismatch 0 is vacuous');
    truthy('K3: the open follow-up reaches Page 3\'s Follow-Up Required count',
      tracker.counts.follow_up >= 1, JSON.stringify(tracker.counts));
  }

  /* ── GATE L ────────────────────────────────────────────────────────────── */
  section('L. 🔒 THE POS IS UNTOUCHED');
  const countsAfter = tableCounts();
  {
    eq('L1: orders + order_items + restaurant_tables are byte-identical after every submit',
      posHash(), posBefore);
    eq('L2: the Masala Dosa line is still on the order, still quantity 1, still served — '
      + 'recording "Item Cancelled" cancelled nothing',
      db.prepare('SELECT quantity, status FROM order_items WHERE id = ?').get('fc-oi-fa6-dosa'),
      { quantity: 1, status: 'served' });
    // THE WIDE CHECK, so this gate is not a list of three tables somebody has to
    // remember to extend. EVERY table in the database is counted before the first
    // submit and after the last, and the only names allowed to have moved are the
    // three `gf_` ones. A writer that touched `kots`, `dept_stock_ledger`,
    // `order_guests` or anything else fails here by name.
    const moved = Object.keys(countsAfter)
      .filter((t) => countsAfter[t] !== countsBefore[t])
      .sort();
    eq('L3: the ONLY tables whose row count moved are the three gf_ tables',
      moved, ['gf_follow_ups', 'gf_item_feedback', 'gf_visits']);
  }

  /* ── GATE M ────────────────────────────────────────────────────────────── */
  section('M. ANALYTICS SEE WHAT WAS CAPTURED — the delta, end to end');
  {
    const after = analytics(day.businessDate);
    const s0 = analyticsBefore.summary;
    const s1 = after.summary;

    const capturedVisits = db.prepare(`SELECT COUNT(*) AS n FROM gf_visits WHERE order_id IN (${FC_ORDER_IDS.map(() => '?').join(',')})`).get(...FC_ORDER_IDS).n;
    const capturedNegItems = db.prepare(`SELECT COUNT(*) AS n FROM gf_item_feedback WHERE order_id IN (${FC_ORDER_IDS.map(() => '?').join(',')}) AND is_negative = 1`).get(...FC_ORDER_IDS).n;
    const capturedOpen = db.prepare(`SELECT COUNT(*) AS n FROM gf_follow_ups WHERE order_id IN (${FC_ORDER_IDS.map(() => '?').join(',')}) AND status = 'open'`).get(...FC_ORDER_IDS).n;

    truthy('M0: the capture actually produced rows to look for',
      capturedVisits > 0 && capturedNegItems > 0 && capturedOpen > 0,
      JSON.stringify({ capturedVisits, capturedNegItems, capturedOpen }));

    eq('M1: "feedbacks recorded" rose by exactly the visits that were captured',
      s1.feedbacks_recorded - s0.feedbacks_recorded, capturedVisits);
    eq('M2: the negative item count rose by exactly the negative item rows',
      s1.negative_item_feedbacks - s0.negative_item_feedbacks, capturedNegItems);
    eq('M3: pending follow-ups rose by exactly the open follow-ups',
      s1.pending_follow_ups - s0.pending_follow_ups, capturedOpen);
    truthy('M3: and coverage is now computable for the day', s1.coverage_pct !== null,
      JSON.stringify([s1.eligible_tables, s1.eligible_tables_covered, s1.coverage_pct]));

    // The owner's product point, read back out of the REAL Menu Item Analysis:
    // the dish he complained about has to carry the complaint.
    const dosa = (after.menu_items || []).find((m) => m.menu_item === 'Masala Dosa');
    truthy('M4: Masala Dosa appears in Menu Item Analysis', !!dosa,
      JSON.stringify((after.menu_items || []).map((m) => m.menu_item)));
    if (dosa) {
      truthy('M4: with its negative feedback counted', Number(dosa.negative) >= 1, JSON.stringify(dosa));
      truthy('M4: and the plates sold alongside it, so a RATE is computable',
        Number(dosa.sold) >= 1, JSON.stringify(dosa));
      truthy('M4: and the Return / Remake Rate is a real number, not a dash',
        dosa.return_remake_pct && dosa.return_remake_pct.pct !== null,
        JSON.stringify(dosa.return_remake_pct));
    }

    // "Clickable through to the real comments" is §3's own requirement, and
    // `itemComments()` is the shipped entry point behind it. The guest's own words
    // are the whole reason a GRE types anything, so they have to come back out.
    if (dosa) {
      const drill = R.itemComments(db, {
        outletId: '',
        filters: R.filtersFromQuery(new URLSearchParams(
          `range=custom&from=${day.businessDate}&to=${day.businessDate}`)),
        itemKey: dosa.item_key,
        nowMs: Date.now(),
      });
      const mine = (drill.rows || []).filter((r) => r.comment === 'cold in the middle');
      eq('M5: clicking through to the real comments returns the GRE\'s own words', mine.length, 1);
      if (mine.length === 1) {
        eq('M5: with the table, the recorder, the issue and the action beside them',
          [mine[0].table_number, mine[0].gre_name, mine[0].issue, mine[0].action_taken],
          ['FA3', PEOPLE.gre.name, 'cold', 'remade']);
      }
      eq('M5: and the header row it drilled from is the dish that was clicked',
        drill.item && drill.item.menu_item, 'Masala Dosa');
    }

    // The fairness ruling still holds over CAPTURED rows, not only over
    // hand-seeded ones: picking the recorder's name must not move the venue's
    // rating split.
    const filtersP = R.filtersFromQuery(new URLSearchParams(
      `range=custom&from=${day.businessDate}&to=${day.businessDate}&gre=${encodeURIComponent(PEOPLE.gre.name)}`));
    const person = R.analytics(db, { outletId: '', filters: filtersP, nowMs: Date.now() });
    const split = (p) => [p.summary.excellent, p.summary.good, p.summary.average, p.summary.poor,
      p.summary.unrated, p.summary.negative_item_feedbacks];
    eq('M6: the rating split and the negative tile are the VENUE\'s under her own name — '
      + 'the fairness ruling, now proved over rows SHE created through the real route',
      split(person), split(after));
  }

  /* ── summary ───────────────────────────────────────────────────────────── */
  console.log('\n' + '─'.repeat(72));
  console.log(`feedback-capture-tests: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\nfeedback-capture-tests: threw —', e);
  process.exit(1);
});
