/**
 * GUEST FEEDBACK — THE TAKE SCREEN'S CONTRACT WITH THE SERVER.  (P3 Lane C)
 *
 * ── WHY THIS SUITE EXISTS, AND WHY THE OTHER 526 + 143 DID NOT CATCH THE BUG ──
 * The owner's report: "In Floor Feedback Page for the Table no FA3 it showing 2
 * items. Idli and Masala Dosa. But when i Click on Take Feedback It is not
 * showing the Ordered Items. Its showing the Other Items."
 *
 * The cause was that `src/app/feedback/take/[orderId]/page.tsx` rendered
 * `src/app/feedback/placeholder.ts` — one invented order, the same one for every
 * table — and its Submit button flashed "Shell only". The reason a
 * 526-assertion scope suite and a 143-assertion capture suite both went green
 * over it is that NEITHER COULD REACH IT:
 *   · `feedback-scope-tests.js` seeds `gf_` rows directly and exercises reporting;
 *   · `feedback-capture-tests.js` drives the real `POST /api/feedback` with
 *     bodies IT composes itself.
 * Nothing asserted what the SCREEN would send, because that lived inside a React
 * closure where no test could ask.
 *
 * So this suite tests the seam that was broken. `./draft.ts` now holds the two
 * decisions the screen makes — WHICH item entries are worth storing
 * (`isRecordable`) and WHAT body goes on the wire (`buildSubmitBody`) — as plain
 * functions, and every assertion below runs the SHIPPED function and posts its
 * output to the SHIPPED route, then reads the `gf_` rows back.
 *
 * THE CENTREPIECE is section D: the owner's own table, his own two dishes, one of
 * them flagged, and the proof that the complaint lands on THAT dish and the other
 * one gets no row at all. That is his product point —
 *   "i should get the items Which were ordered by the Guest and to that
 *    particular item if there is negative review their itself they can take the
 *    review for that item"
 * — expressed as rows in `gf_item_feedback`.
 *
 * Section C is the one that keeps the fix honest over time: `isRecordable` in the
 * client and `recordable()` in the writer are two implementations of one rule, so
 * every one of the 24 combinations is posted RAW to the real route and the
 * server's verdict is compared against the client's. If either side drifts, a
 * line here goes red instead of a GRE's complaint silently vanishing.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 * Every byte is written to a `VACUUM INTO` snapshot taken through a READONLY
 * handle on the live `fnb-controller.db`. The snapshot is named
 * `fnb-controller.db` inside a temp directory and the process `chdir()`s there
 * BEFORE the first `getDb()`, because `DB_PATH` is `process.cwd()/fnb-controller.db`
 * — which is how the shipped route gets a sandbox without knowing about tests.
 * There is an explicit abort if `getDb()` ever opens anything else.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const REPO = path.resolve(__dirname, '..');
const LIVE_DB = path.join(REPO, 'fnb-controller.db');
const SRC = path.join(REPO, 'src');
const TAKE_DIR = path.join(SRC, 'app', 'feedback', 'take', '[orderId]');

/* ── 0. SNAPSHOT ─────────────────────────────────────────────────────────── */

if (!fs.existsSync(LIVE_DB)) {
  console.error('feedback-take-page-tests: ' + LIVE_DB + ' not found - nothing to snapshot.');
  process.exit(2);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-feedback-take-')));
const SNAP = path.join(TMP, 'fnb-controller.db');
{
  const src = new Database(LIVE_DB, { readonly: true });
  src.prepare('VACUUM INTO ?').run(SNAP);   // parameterised - no filename in SQL
  src.close();
}
process.chdir(TMP);

console.log('Guest Feedback - THE TAKE SCREEN CONTRACT. Snapshot in ' + TMP);

/* ── 1. THE LOADERS ──────────────────────────────────────────────────────── */

const ts = require(path.join(REPO, 'node_modules', 'typescript'));
const Module = require('module');

/** The only stub in the process. `getCurrentUser()` reads `cookies()` from
 *  `next/headers`, which needs Next's per-request async store. Everything it
 *  feeds - the session lookup, the role join, `feedbackAccess()`, the
 *  transaction - is the shipped code. */
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
const POST_ROUTE = require(path.join(SRC, 'app', 'api', 'feedback', 'route.ts'));
const ORDER_ROUTE = require(path.join(SRC, 'app', 'api', 'feedback', 'order', '[orderId]', 'route.ts'));
/** THE SCREEN'S OWN LOGIC, imported from the file the screen imports. */
const DRAFT = require(path.join(TAKE_DIR, 'draft.ts'));

const db = DB.getDb();
{
  const open = typeof db.name === 'string' && db.name ? path.resolve(db.name) : '';
  if (open !== path.resolve(SNAP)) {
    console.error(`\nFATAL: getDb() opened ${JSON.stringify(open)}, not this run's snapshot `
      + `(${SNAP}). Refusing to write. Aborting.`);
    process.exit(3);
  }
}

/* ── 2. HARNESS ──────────────────────────────────────────────────────────── */

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
function falsy(label, v, detail) { if (!v) ok(label); else bad(label, detail); }
function section(t) { console.log('\n' + t); }

/* ── 3. THE FIXTURE — the owner's table and the owner's two dishes ────────── */

const GRE_ROLE = 'GRE';                       // == GRE_ROLE_NAME in access.ts

const PEOPLE = {
  gre:    { id: 'tp-u-gre',    name: 'Asha GRE',  token: 'tp-tok-gre' },
  norole: { id: 'tp-u-norole', name: 'Dev NoRole', token: 'tp-tok-norole' },
};

/** FA3 is the owner's table. FD1 carries a drink, so the Food/Drinks split the
 *  screen renders is proved to come from `order_items.station` and not a name. */
const ORDERS = {
  fa3: { id: 'tp-o-fa3', table: 'tp-t-fa3', number: 88003, covers: 2 },
  fd1: { id: 'tp-o-fd1', table: 'tp-t-fd1', number: 88004, covers: 2 },
  tap: { id: 'tp-o-tap', table: 'tp-t-tap', number: 88005, covers: 2 },  // one-tap path
  dbl: { id: 'tp-o-dbl', table: 'tp-t-dbl', number: 88006, covers: 2 },  // double tap
  esc: { id: 'tp-o-esc', table: 'tp-t-esc', number: 88007, covers: 2 },  // still unhappy
  foreign: { id: 'tp-o-foreign', table: 'tp-t-foreign', number: 88008, covers: 2 },
};

/** `station` is what decides Food vs Drinks, server-side. 'indian' and 'cocktail'
 *  are real `menu_items.station` values on this database, so `knownStations()`
 *  recognises them. */
const LINES = [
  { id: 'tp-oi-fa3-idli', order: 'tp-o-fa3', name: 'Idli',        station: 'indian',   qty: 2, menu: 'tp-mi-idli' },
  { id: 'tp-oi-fa3-dosa', order: 'tp-o-fa3', name: 'Masala Dosa', station: 'indian',   qty: 1, menu: 'tp-mi-dosa' },
  { id: 'tp-oi-fd1-moj',  order: 'tp-o-fd1', name: 'Virgin Mojito', station: 'cocktail', qty: 2, menu: 'tp-mi-moj' },
  { id: 'tp-oi-fd1-dosa', order: 'tp-o-fd1', name: 'Masala Dosa', station: 'indian',   qty: 1, menu: 'tp-mi-dosa' },
  { id: 'tp-oi-tap-idli', order: 'tp-o-tap', name: 'Idli',        station: 'indian',   qty: 1, menu: 'tp-mi-idli' },
  { id: 'tp-oi-dbl-dosa', order: 'tp-o-dbl', name: 'Masala Dosa', station: 'indian',   qty: 1, menu: 'tp-mi-dosa' },
  { id: 'tp-oi-esc-dosa', order: 'tp-o-esc', name: 'Masala Dosa', station: 'indian',   qty: 1, menu: 'tp-mi-dosa' },
  { id: 'tp-oi-foreign-idli', order: 'tp-o-foreign', name: 'Idli', station: 'indian',  qty: 1, menu: 'tp-mi-idli' },
];

/* The 24 orders for the silence grid in section C - one per combination,
   because `uq_gf_visits_order` allows one visit per order. */
const RATINGS  = ['', 'good', 'poor'];
const ISSUES   = ['', 'cold'];
const COMMENTS = ['', 'the guest said it was cold'];
const ACTIONS  = ['none', 'remade'];
const GRID = [];
for (const rating of RATINGS) {
  for (const issue of ISSUES) {
    for (const comment of COMMENTS) {
      for (const action of ACTIONS) {
        const n = GRID.length;
        GRID.push({
          n,
          order: 'tp-o-g' + String(n).padStart(2, '0'),
          table: 'tp-t-g' + String(n).padStart(2, '0'),
          line: 'tp-oi-g' + String(n).padStart(2, '0'),
          number: 88100 + n,
          fb: { rating, issue, comment, action },
        });
      }
    }
  }
}

/** Every id this suite may delete. Scoped, so running against a database that
 *  holds REAL feedback cannot erase any of it. */
const ALL_ORDER_IDS = [...Object.values(ORDERS).map((o) => o.id), ...GRID.map((g) => g.order)];

function seed() {
  DB.createGuestFeedbackSchema(db);            // the shipped DDL, not a copy

  const inList = ALL_ORDER_IDS.map(() => '?').join(',');
  db.prepare(`DELETE FROM gf_follow_ups    WHERE order_id IN (${inList})`).run(...ALL_ORDER_IDS);
  db.prepare(`DELETE FROM gf_item_feedback WHERE order_id IN (${inList})`).run(...ALL_ORDER_IDS);
  db.prepare(`DELETE FROM gf_visits        WHERE order_id IN (${inList})`).run(...ALL_ORDER_IDS);
  db.prepare(`DELETE FROM order_items      WHERE order_id IN (${inList})`).run(...ALL_ORDER_IDS);
  db.prepare(`DELETE FROM orders           WHERE id       IN (${inList})`).run(...ALL_ORDER_IDS);
  db.prepare(`DELETE FROM restaurant_tables WHERE id LIKE 'tp-t-%'`).run();
  db.prepare(`DELETE FROM sessions WHERE token LIKE 'tp-tok-%'`).run();
  db.prepare(`DELETE FROM users WHERE id LIKE 'tp-u-%'`).run();

  const roleIdByName = (name) => {
    const r = db.prepare('SELECT id FROM roles WHERE name = ?').get(name);
    return r ? String(r.id) : null;
  };
  let greRoleId = roleIdByName(GRE_ROLE);
  if (!greRoleId) {
    greRoleId = 'tp-role-gre';
    db.prepare(
      `INSERT INTO roles (id, name, base_role, page_access, is_active)
       VALUES (?, ?, 'staff', NULL, 1)`,
    ).run(greRoleId, GRE_ROLE);
  }

  const uIns = db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, is_active, role_id, section)
     VALUES (@id, @email, 'x', @name, 'staff', 1, @role_id, '')`,
  );
  uIns.run({ id: PEOPLE.gre.id, email: 'tp-gre@x.test', name: PEOPLE.gre.name, role_id: greRoleId });
  uIns.run({ id: PEOPLE.norole.id, email: 'tp-norole@x.test', name: PEOPLE.norole.name, role_id: null });

  const sIns = db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
  );
  for (const p of Object.values(PEOPLE)) sIns.run(p.token, p.id);

  const tIns = db.prepare(
    `INSERT INTO restaurant_tables (id, outlet_id, table_number, zone, section, seats, is_active)
     VALUES (?, '', ?, 'Ground', 'A', 4, 1)`,
  );
  const oIns = db.prepare(
    `INSERT INTO orders (id, outlet_id, order_number, table_id, status, order_type, covers,
                         server_name, created_at, bill_requested_at, total)
     VALUES (?, '', ?, ?, 'open', 'dine-in', ?, 'Captain One',
             datetime('now'), datetime('now'), 0)`,
  );
  const oiIns = db.prepare(
    `INSERT INTO order_items (id, order_id, menu_item_id, name, station, quantity,
                              unit_price, line_total, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 120, 120, 'served', datetime('now'))`,
  );

  // FA3 is literally table "FA3", because the bug report names it.
  tIns.run(ORDERS.fa3.table, 'FA3');
  oIns.run(ORDERS.fa3.id, ORDERS.fa3.number, ORDERS.fa3.table, ORDERS.fa3.covers);
  for (const key of Object.keys(ORDERS)) {
    if (key === 'fa3') continue;
    const o = ORDERS[key];
    tIns.run(o.table, o.table.replace('tp-t-', '').toUpperCase());
    oIns.run(o.id, o.number, o.table, o.covers);
  }
  for (const l of LINES) oiIns.run(l.id, l.order, l.menu || null, l.name, l.station, l.qty);

  for (const g of GRID) {
    tIns.run(g.table, g.table.replace('tp-t-', '').toUpperCase());
    oIns.run(g.order, g.number, g.table, 2);
    oiIns.run(g.line, g.order, 'tp-mi-dosa', 'Masala Dosa', 'indian', 1);
  }
}

/* ── 4. DRIVING THE SHIPPED HANDLERS ─────────────────────────────────────── */

const signIn = (who) => headers.__setSession(who ? who.token : null);

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

/**
 * Strip comments, so a guard about CODE is not answered by PROSE.
 *
 * Learned the hard way: the first cut of B3/B4 below went red on the shipped
 * page because its own header comment EXPLAINS why it must not call a bare
 * `fetch()` and must not touch `/api/dine-in/orders/[id]`. A guard that a
 * warning comment can trip is a guard that teaches people to delete comments.
 *
 * `://` is spared so a URL inside a string survives.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
    .split('\n')
    .map((line) => {
      const i = line.search(/(^|[^:])\/\//);
      if (i === -1) return line;
      const cut = line.indexOf('//', i);
      return line.slice(0, cut);
    })
    .join('\n');
}

const itemRows = (orderId) => db
  .prepare(`SELECT * FROM gf_item_feedback WHERE order_id = ? ORDER BY item_name`)
  .all(orderId);
const visitRow = (orderId) => db.prepare(`SELECT * FROM gf_visits WHERE order_id = ?`).get(orderId);
const followRows = (orderId) => db
  .prepare(`SELECT * FROM gf_follow_ups WHERE order_id = ? ORDER BY created_at`)
  .all(orderId);
const countAll = () => ({
  visits: db.prepare('SELECT COUNT(*) AS n FROM gf_visits').get().n,
  items: db.prepare('SELECT COUNT(*) AS n FROM gf_item_feedback').get().n,
  follows: db.prepare('SELECT COUNT(*) AS n FROM gf_follow_ups').get().n,
});

/* ════════════════════════════════════════════════════════════════════════════
   THE RUN
   ════════════════════════════════════════════════════════════════════════════ */

async function run() {
  seed();

  const PAGE_SRC = fs.readFileSync(path.join(TAKE_DIR, 'page.tsx'), 'utf8');
  const UI_SRC = fs.readFileSync(path.join(SRC, 'app', 'feedback', 'ui.tsx'), 'utf8');
  /** The page with its commentary removed — what actually runs. */
  const PAGE_CODE = codeOnly(PAGE_SRC);

  /* ══ A. THE FICTION IS GONE ═════════════════════════════════════════════ */
  section('A. The placeholder is gone, and nothing reaches for it');

  falsy('A1: src/app/feedback/placeholder.ts no longer exists',
    fs.existsSync(path.join(SRC, 'app', 'feedback', 'placeholder.ts')),
    'the file of invented dishes is still on disk');

  // Walk every .ts/.tsx under src/ rather than trusting one grep.
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      const t = fs.readFileSync(p, 'utf8');
      if (/from\s+['"][^'"]*\bplaceholder['"]/.test(t)) offenders.push(path.relative(REPO, p));
    }
  })(SRC);
  eq('A2: no file under src/ imports a "placeholder" module', offenders, []);

  falsy('A3: TAKE_ORDER is not referenced by the take screen',
    /\bTAKE_ORDER\b/.test(PAGE_CODE));
  falsy('A4: the P1 SHELL banner component is gone from ui.tsx',
    /export function PlaceholderNote/.test(codeOnly(UI_SRC)));
  falsy('A5: the take screen renders no PlaceholderNote', /<PlaceholderNote/.test(PAGE_CODE));

  /* ══ B. THE SCREEN READS THE REAL ROUTE ════════════════════════════════ */
  section('B. The screen reads the module\'s own narrow route, and posts through api()');

  truthy('B1: it fetches GET /api/feedback/order/<id>',
    /api\(`\/api\/feedback\/order\/\$\{encodeURIComponent\(orderId\)\}`\)/.test(PAGE_CODE));
  truthy('B2: it posts to /api/feedback through api(), so CSRF is carried',
    /api\('\/api\/feedback',\s*\{\s*method:\s*'POST'/.test(PAGE_CODE));
  falsy('B3: it never calls a bare fetch() - the proxy would 403 a POST without the header',
    /[^.\w]fetch\(/.test(PAGE_CODE));
  falsy('B4: it never touches a POS order route (add_item/set_qty/remove_item/fire live there)',
    /api\/dine-in\/orders/.test(PAGE_CODE));
  /* B5/B6 are the two guards that MUST fire if anyone re-introduces the defect,
     so each one is defined once and then proved against a deliberately bad
     sample. The first cut of both was INERT: B5 matched `view?.food ?? NO_ITEMS`
     anywhere, including inside a spread that then re-filtered it, and B6's
     `[^)]*` could not cross the `)` in `.filter((i) => …)`. A mutation that put
     the client back in charge of grouping sailed through both. */

  /** The server's arrays must be bound WHOLE — an exact assignment, not a
   *  mention somewhere inside a client recomputation. */
  const bindsServerArrays = (src) =>
    src.includes('const food = view?.food ?? NO_ITEMS;')
    && src.includes('const drinks = view?.drinks ?? NO_ITEMS;');
  /** `[^;]` so the pattern can cross the parens of an arrow function. */
  const regroupsOnClient = (src) => /\.filter\([^;]{0,80}?\.group\b/.test(src);

  const BAD_SAMPLE = [
    'const allRaw = [...(view?.food ?? NO_ITEMS), ...(view?.drinks ?? NO_ITEMS)];',
    "const food = allRaw.filter((i) => i.group === 'food');",
    "const drinks = allRaw.filter((i) => i.group === 'drinks');",
  ].join('\n');

  truthy('B5: Food and Drinks are bound WHOLE from the server\'s two arrays',
    bindsServerArrays(PAGE_CODE));
  falsy('B6: and nothing on this screen re-groups the items itself',
    regroupsOnClient(PAGE_CODE));
  falsy('B7: no money is read on this surface',
    /unit_price|line_total|\btotal\b|discount|bill_amount|\bprice\b/.test(PAGE_CODE));

  /* ── the guards' own guards: each must FIRE on a known-bad sample ──────── */
  truthy('B8: (meta) the comment stripper leaves real code behind',
    /useState/.test(PAGE_CODE) && /buildSubmitBody/.test(PAGE_CODE));
  truthy('B9: (meta) the money guard fires on a line that has a price',
    /unit_price|line_total|\btotal\b|discount|bill_amount|\bprice\b/
      .test(codeOnly('const x = row.unit_price;')));
  falsy('B10: (meta) B5 FAILS on a page that re-derives the two lists',
    bindsServerArrays(BAD_SAMPLE));
  truthy('B11: (meta) B6 FIRES on a page that filters by group',
    regroupsOnClient(BAD_SAMPLE));
  falsy('B12: (meta) and B6 does not fire on the legitimate filters this page has',
    regroupsOnClient("allItems.filter((i) => isNegative(itemFb[i.id]?.rating || ''));"));
  truthy('B13: (meta) B3 fires on a bare fetch', /[^.\w]fetch\(/.test(codeOnly('await fetch(url);')));
  truthy('B14: (meta) B4 fires on a POS order call',
    /api\/dine-in\/orders/.test(codeOnly("api('/api/dine-in/orders/' + id);")));

  /* ══ C. THE SILENCE RULE: client and server, compared ══════════════════ */
  section('C. isRecordable() (client) vs recordable() (writer) - all 24 combinations, '
    + 'posted RAW to the real route');

  let gridAgree = 0;
  for (const g of GRID) {
    const clientVerdict = DRAFT.isRecordable(g.fb);
    // Posted RAW - every field present, empty strings included - so the SERVER
    // is forced to judge the entry rather than never seeing it. An overall
    // rating rides along so the visit itself is always valid and the only
    // question left is whether the ITEM row was stored.
    const res = await post(PEOPLE.gre, {
      order_id: g.order,
      overall_rating: 'good',
      items: [{
        order_item_id: g.line,
        rating: g.fb.rating,
        issue: g.fb.issue,
        comment: g.fb.comment,
        action: g.fb.action,
      }],
    });
    if (res.status !== 201) {
      bad(`C[${g.n}]: the visit itself was accepted`, JSON.stringify(res.body));
      continue;
    }
    const stored = itemRows(g.order).length === 1;
    const serverVerdict = stored;
    if (clientVerdict === serverVerdict) {
      gridAgree++;
    } else {
      bad(`C[${g.n}]: client and server disagree on ${JSON.stringify(g.fb)}`,
        `client isRecordable=${clientVerdict}, server stored=${serverVerdict}`);
    }
    // And the writer's own count agrees with what it stored.
    eq(`C[${g.n}]: items_recorded matches the rows for ${JSON.stringify(g.fb)}`,
      res.body.items_recorded, stored ? 1 : 0);
  }
  eq('C-ALL: every one of the 24 combinations agrees', gridAgree, GRID.length);

  // The one that matters most, called out by name.
  falsy('C-silence: an item opened and closed with nothing said is NOT recordable',
    DRAFT.isRecordable({}));
  falsy('C-silence: "No Action Required" alone is NOT recordable',
    DRAFT.isRecordable({ action: 'none' }));
  falsy('C-silence: whitespace is not a comment',
    DRAFT.isRecordable({ comment: '   ' }));
  truthy('C-silence: a rating alone IS recordable', DRAFT.isRecordable({ rating: 'good' }));
  truthy('C-silence: an action other than none IS recordable',
    DRAFT.isRecordable({ action: 'remade' }));

  /* ══ D. THE OWNER'S CASE, END TO END ═══════════════════════════════════ */
  section('D. Table FA3: Idli and Masala Dosa - flag ONE of them and watch where it lands');

  const fa3 = await getOrder(PEOPLE.gre, ORDERS.fa3.id);
  eq('D1: the GRE may read the order', fa3.status, 200);
  const view = fa3.body && fa3.body.order;
  truthy('D2: the payload carries an order', !!view);

  eq('D3: the table is the one in the bug report', view.table_number, 'FA3');
  eq('D4: and it shows exactly what was ORDERED - Idli and Masala Dosa',
    [...(view.food || []), ...(view.drinks || [])].map((i) => i.name).sort(),
    ['Idli', 'Masala Dosa']);
  eq('D5: both are Food, because order_items.station says "indian"',
    (view.food || []).map((i) => i.name).sort(), ['Idli', 'Masala Dosa']);
  eq('D6: nothing lands in Drinks', (view.drinks || []).length, 0);
  eq('D7: item_count agrees', view.item_count, 2);

  // THE SHAPE THAT BROKE THE SCREEN: the real route has no flat `items` key, and
  // the placeholder's `TakeOrder` had nothing else. A page bound to `order.items`
  // reads `undefined` here - which is exactly how it ended up rendering fiction.
  falsy('D8: the route returns NO flat `items` key - the shape the old page assumed',
    Object.prototype.hasOwnProperty.call(view, 'items'));
  truthy('D9: it returns `food` and `drinks` instead',
    Array.isArray(view.food) && Array.isArray(view.drinks));
  falsy('D10: and no money on any line',
    JSON.stringify(view).match(/unit_price|line_total|discount/) !== null);

  // Now the GRE taps ONLY Masala Dosa, because only that plate was wrong.
  const dosa = (view.food || []).find((i) => i.name === 'Masala Dosa');
  const idli = (view.food || []).find((i) => i.name === 'Idli');
  truthy('D11: the screen can address each line by its order_item_id', !!dosa && !!idli);

  const draft = DRAFT.emptyDraft(view.order_id);
  draft.overall = 'average';
  draft.categories = { food: 'poor' };
  draft.itemFb[dosa.id] = {
    rating: 'poor', issue: 'cold', comment: 'Dosa came cold, guest sent it back',
    action: 'remade',
  };
  draft.revisits[dosa.id] = { after: 'good', happy: 'happy' };

  truthy('D12: canSubmit() lights up', DRAFT.canSubmit(draft));

  const body = DRAFT.buildSubmitBody(draft);
  eq('D13: the body names the order the SERVER returned, not the URL',
    body.order_id, ORDERS.fa3.id);
  eq('D14: it carries exactly ONE item - the flagged one', body.items.length, 1);
  eq('D15: and that item is the Masala Dosa line', body.items[0].order_item_id, dosa.id);
  falsy('D16: the body never names the untouched Idli',
    JSON.stringify(body).includes(idli.id));
  falsy('D17: the body sends no item_group / station - the server decides that',
    /item_group|station/.test(JSON.stringify(body)));
  falsy('D18: the body sends no recorder - the session decides that',
    /gre_user_id|gre_name|gre_email/.test(JSON.stringify(body)));
  falsy('D19: and no money', /unit_price|line_total|price|total/.test(JSON.stringify(body)));

  const sub = await post(PEOPLE.gre, body);
  eq('D20: the real route accepts it - 201', sub.status, 201);
  truthy('D21: ok', sub.body && sub.body.ok === true);
  eq('D22: one item recorded', sub.body.items_recorded, 1);
  eq('D23: has_negative', sub.body.has_negative, true);

  const v = visitRow(ORDERS.fa3.id);
  truthy('D24: a gf_visits row exists', !!v);
  eq('D25: recorded under the GRE from the SESSION', v.gre_name, PEOPLE.gre.name);
  eq('D26: the table snapshot is FA3', v.table_number, 'FA3');
  eq('D27: everything_good is 0 - a poor plate was flagged', Number(v.everything_good), 0);
  eq('D28: overall_rating is what the screen sent', v.overall_rating, 'average');
  eq('D29: cat_food too', v.cat_food, 'poor');

  const rows = itemRows(ORDERS.fa3.id);
  eq('D30: EXACTLY ONE gf_item_feedback row - silence on Idli stored nothing', rows.length, 1);
  eq('D31: and it is the Masala Dosa', rows[0].item_name, 'Masala Dosa');
  eq('D32: keyed to the ordered line the guest actually got', rows[0].order_item_id, dosa.id);
  eq('D33: menu_item_id came from order_items, not the body', rows[0].menu_item_id, 'tp-mi-dosa');
  eq('D34: item_group resolved SERVER-SIDE from the station', rows[0].item_group, 'food');
  eq('D35: and the raw station is stored beside the verdict', rows[0].station, 'indian');
  eq('D36: the rating', rows[0].rating, 'poor');
  eq('D37: the issue', rows[0].issue, 'cold');
  eq('D38: the guest\'s own words', rows[0].comment, 'Dosa came cold, guest sent it back');
  eq('D39: the action the kitchen took', rows[0].action_taken, 'remade');
  eq('D40: flagged negative', Number(rows[0].is_negative), 1);
  eq('D41: quantity is the ORDERED line quantity', Number(rows[0].quantity), 1);

  // THE OWNER'S POINT, as a single assertion: the dish nobody complained about
  // has no row at all, so Page 4's per-item rates are about plates that were
  // actually judged.
  eq('D42: THE PRODUCT POINT - the Idli the guest was happy with has NO row',
    itemRows(ORDERS.fa3.id).filter((r) => r.item_name === 'Idli').length, 0);

  const fups = followRows(ORDERS.fa3.id);
  eq('D43: "Same Item Remade" raised a follow-up automatically', fups.length, 1);
  eq('D44: on the Masala Dosa', fups[0].item_name, 'Masala Dosa');
  eq('D45: and "Yes - Happy" closed it', fups[0].status, 'closed');
  eq('D46: so the visit has no open follow-up', sub.body.follow_ups_open, 0);
  eq('D47: status is "issue", not "follow_up"', sub.body.status, 'issue');

  /* ══ E. THE COMPLAINT THAT STAYS OPEN ══════════════════════════════════ */
  section('E. "No - Still Unhappy" keeps the complaint open - the owner\'s ruling');

  const escView = (await getOrder(PEOPLE.gre, ORDERS.esc.id)).body.order;
  const escLine = escView.food[0];
  const escDraft = DRAFT.emptyDraft(escView.order_id);
  escDraft.itemFb[escLine.id] = { rating: 'poor', issue: 'cold', action: 'replaced_same' };
  escDraft.revisits[escLine.id] = { after: 'still_poor', happy: 'unhappy' };
  const escRes = await post(PEOPLE.gre, DRAFT.buildSubmitBody(escDraft));
  eq('E1: accepted', escRes.status, 201);
  eq('E2: the follow-up is OPEN', escRes.body.follow_ups_open, 1);
  eq('E3: nothing was closed', escRes.body.follow_ups_closed, 0);
  eq('E4: and the visit status says follow_up', escRes.body.status, 'follow_up');
  const escFup = followRows(ORDERS.esc.id);
  eq('E5: the row is open', escFup[0].status, 'open');
  truthy('E6: and it is escalated', !!escFup[0].escalated_at);

  /* ══ F. THE 10-SECOND PATH ═════════════════════════════════════════════ */
  section('F. "Everything Good" - one tap, no item rows');

  const tapDraft = DRAFT.emptyDraft(ORDERS.tap.id);
  tapDraft.oneTap = true;
  tapDraft.overall = 'excellent';
  tapDraft.categories = { food: 'good', drinks: 'good', service: 'good', ambience: 'good' };
  const tapBody = DRAFT.buildSubmitBody(tapDraft);
  eq('F1: everything_good rides on the body', tapBody.everything_good, true);
  eq('F2: all four categories', Object.keys(tapBody.categories).sort(),
    ['ambience', 'drinks', 'food', 'service']);
  eq('F3: and no items at all', tapBody.items.length, 0);

  const tapRes = await post(PEOPLE.gre, tapBody);
  eq('F4: accepted', tapRes.status, 201);
  eq('F5: stored as everything_good', Number(visitRow(ORDERS.tap.id).everything_good), 1);
  eq('F6: status is a plain "taken"', tapRes.body.status, 'taken');
  eq('F7: no item rows', itemRows(ORDERS.tap.id).length, 0);
  eq('F8: and no negative', tapRes.body.has_negative, false);

  /* ══ G. THE TABLET DOUBLE-TAP ══════════════════════════════════════════ */
  section('G. A double-tap on a tablet must not count the table twice');

  const dblView = (await getOrder(PEOPLE.gre, ORDERS.dbl.id)).body.order;
  const dblDraft = DRAFT.emptyDraft(dblView.order_id);
  dblDraft.overall = 'good';
  dblDraft.itemFb[dblView.food[0].id] = { rating: 'average', comment: 'a bit dry' };
  const dblBody = DRAFT.buildSubmitBody(dblDraft);

  const first = await post(PEOPLE.gre, dblBody);
  eq('G1: the first submit is a 201', first.status, 201);
  const before = countAll();
  const second = await post(PEOPLE.gre, dblBody);   // byte-identical, as a retry is
  eq('G2: the SAME body again is a 200, not an error', second.status, 200);
  eq('G3: and it says duplicate', second.body.duplicate, true);
  eq('G4: the same visit_id comes back', second.body.visit_id, first.body.visit_id);
  eq('G5: NOTHING was written the second time', countAll(), before);
  eq('G6: still exactly one visit on that order',
    db.prepare('SELECT COUNT(*) AS n FROM gf_visits WHERE order_id = ?').get(ORDERS.dbl.id).n, 1);

  /* ══ H. A BODY THAT NAMES A DISH NOBODY ORDERED ════════════════════════ */
  section('H. Feedback cannot be attached to a dish that is not on the order');

  const strayBefore = countAll();
  const stray = await post(PEOPLE.gre, {
    order_id: ORDERS.foreign.id,
    overall_rating: 'poor',
    items: [{ order_item_id: 'tp-oi-fa3-dosa', rating: 'poor' }],  // FA3's line, not this order's
  });
  eq('H1: refused with 400', stray.status, 400);
  eq('H2: and the reason names the cause', stray.body.reason, 'item_not_on_order');
  eq('H3: nothing at all was written', countAll(), strayBefore);
  falsy('H4: no visit row was left behind', !!visitRow(ORDERS.foreign.id));

  /* ══ I. THE DENIAL THE SCREEN PRINTS VERBATIM ══════════════════════════ */
  section('I. A denial and an empty order must never look alike');

  const denied = await getOrder(PEOPLE.norole, ORDERS.fa3.id);
  truthy('I1: a login with no role is refused', denied.status === 401 || denied.status === 403);
  truthy('I2: the refusal carries an error line', !!(denied.body && denied.body.error));
  truthy('I3: and `what_to_do`, which is the step everyone misses (role never ASSIGNED)',
    !!(denied.body && denied.body.what_to_do));
  truthy('I4: the screen prints what_to_do verbatim', /denial\.what_to_do/.test(PAGE_CODE));
  truthy('I5: and it renders a denial branch instead of an empty form',
    /if \(denial\)/.test(PAGE_CODE));
  truthy('I6: a failed LOAD also refuses to render an empty item list',
    /if \(!view\)/.test(PAGE_CODE) && /NOT an empty order/.test(PAGE_CODE));

  const deniedPost = await post(PEOPLE.norole, DRAFT.buildSubmitBody(
    Object.assign(DRAFT.emptyDraft(ORDERS.foreign.id), { overall: 'good' }),
  ));
  truthy('I7: and the WRITE is refused for the same login',
    deniedPost.status === 401 || deniedPost.status === 403);
  falsy('I8: with nothing written', !!visitRow(ORDERS.foreign.id));

  /* ══ J. canSubmit() mirrors the writer's own "saysSomething" ═══════════ */
  section('J. An abandoned form must never become a row');

  falsy('J1: an empty draft cannot submit', DRAFT.canSubmit(DRAFT.emptyDraft('x')));
  falsy('J2: nor one holding only an opened-and-closed item',
    DRAFT.canSubmit(Object.assign(DRAFT.emptyDraft('x'), { itemFb: { a: { action: 'none' } } })));
  truthy('J3: the one-tap path can',
    DRAFT.canSubmit(Object.assign(DRAFT.emptyDraft('x'), { oneTap: true })));
  truthy('J4: an overall rating can',
    DRAFT.canSubmit(Object.assign(DRAFT.emptyDraft('x'), { overall: 'good' })));
  truthy('J5: a category alone can',
    DRAFT.canSubmit(Object.assign(DRAFT.emptyDraft('x'), { categories: { service: 'poor' } })));
  truthy('J6: a flagged item alone can',
    DRAFT.canSubmit(Object.assign(DRAFT.emptyDraft('x'), { itemFb: { a: { rating: 'poor' } } })));

  // And the server agrees: a body the screen would refuse to send is refused.
  const emptyRes = await post(PEOPLE.gre, DRAFT.buildSubmitBody(DRAFT.emptyDraft(ORDERS.foreign.id)));
  eq('J7: the route refuses the body an un-submittable draft would build', emptyRes.status, 400);
  eq('J8: with reason nothing_to_record', emptyRes.body.reason, 'nothing_to_record');

  /* ══ K. DRINKS COME FROM THE STATION, NOT THE NAME ═════════════════════ */
  section('K. Food vs Drinks is the station\'s decision, on a mixed order');

  const fd1 = (await getOrder(PEOPLE.gre, ORDERS.fd1.id)).body.order;
  eq('K1: the mojito is in Drinks', (fd1.drinks || []).map((i) => i.name), ['Virgin Mojito']);
  eq('K2: the dosa is in Food', (fd1.food || []).map((i) => i.name), ['Masala Dosa']);

  const mixDraft = DRAFT.emptyDraft(fd1.order_id);
  const moj = fd1.drinks[0];
  mixDraft.itemFb[moj.id] = { rating: 'poor', issue: 'other', comment: 'served warm' };
  const mixRes = await post(PEOPLE.gre, DRAFT.buildSubmitBody(mixDraft));
  eq('K3: a drink complaint is accepted', mixRes.status, 201);
  const mixRows = itemRows(ORDERS.fd1.id);
  eq('K4: one row', mixRows.length, 1);
  eq('K5: stored as a DRINK, decided by the station', mixRows[0].item_group, 'drinks');
  eq('K6: with the station recorded', mixRows[0].station, 'cocktail');
  eq('K7: and the untouched dosa has no row',
    mixRows.filter((r) => r.item_name === 'Masala Dosa').length, 0);

  /* ── done ─────────────────────────────────────────────────────────────── */
  console.log('\n' + '─'.repeat(72));
  console.log(`feedback-take-page-tests: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  · ' + f);
  }
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error('\nfeedback-take-page-tests CRASHED');
  console.error(e);
  process.exit(1);
});
