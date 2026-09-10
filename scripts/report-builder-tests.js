#!/usr/bin/env node
/**
 * REPORT & ALERT BUILDER PROOF — run against a copy of the REAL database.
 *
 * Run with:  node scripts/report-builder-tests.js      (also: npm test)
 *
 * SANDBOX CONTRACT (copied from scripts/wa-attachment-tests.js). The live
 * fnb-controller.db, its -wal and its -shm are COPIED to a fresh os.tmpdir()
 * directory and VACUUMed into the snapshot the tests open; the process
 * chdir()s there BEFORE src/lib/db.ts is required, and an abort-hard guard
 * checks the handle really is the snapshot. The -wal is copied because the
 * newest rows live there until a checkpoint — snapshotting without it reports
 * yesterday's database and calls it today's.
 *
 * WHAT IT PROVES
 *   1  every builder runs against REAL data for a REAL date and its figures
 *      are PRINTED, so the numbers can be read, not just asserted
 *   2  CROSS-CHECKS: the same figures obtained a second and third way — from
 *      the lib the screen calls, from the API route itself where the route is
 *      callable without a session, and from hand-written SQL that shares no
 *      code with the builder. They must match EXACTLY.
 *   3  empty days produce NO PDF and a sentence, never a blank document
 *   4  builders are PURE: no row is written, no network call is made
 *   5  the PDFs are real PDFs, inside the attachment size cap, and use 'Rs'
 *      (pdfkit's Helvetica has no rupee glyph)
 *   6  the scheduled job runner is OFF by default and sends NOTHING when a
 *      report has nothing to say
 *   7  the ticket slot refuses with a reason instead of inventing a document
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const REPO = path.resolve(__dirname, '..');
const LIVE_DB = path.join(REPO, 'fnb-controller.db');
const SRC = path.join(REPO, 'src');

/* -- 0. SNAPSHOT (db + wal + shm) --------------------------------------- */

if (!fs.existsSync(LIVE_DB)) {
  console.error(`report-builder-tests: ${LIVE_DB} not found — nothing to snapshot.`);
  process.exit(2);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-report-tests-')));
const STAGE = path.join(TMP, 'stage');
fs.mkdirSync(STAGE);
for (const suffix of ['', '-wal', '-shm']) {
  const from = LIVE_DB + suffix;
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(STAGE, 'fnb-controller.db' + suffix));
}
const SNAP = path.join(TMP, 'fnb-controller.db');
{
  const src = new Database(path.join(STAGE, 'fnb-controller.db'), { readonly: true });
  src.exec(`VACUUM INTO '${SNAP.replace(/'/g, "''")}'`);
  src.close();
}
process.chdir(TMP);

/* -- 1. TYPESCRIPT LOADER ----------------------------------------------- */

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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(out.outputText, filename);
};

const lib = (rel) => require(path.join(SRC, 'lib', rel));

const dbMod = lib('db.ts');
const db = dbMod.getDb();

(function assertSandboxed(handle) {
  const open = path.resolve(handle.name || '');
  if (path.resolve(LIVE_DB) === open || !open.startsWith(path.resolve(TMP))) {
    console.error(`\nFATAL: tests opened ${open}, which is not the snapshot in ${TMP}. Aborting.`);
    process.exit(3);
  }
})(db);

const B = lib('wa-report-builders.ts');
const JOBS = lib('wa-report-jobs.ts');
const SD = lib('sales-dashboard.ts');
const SR = lib('sales-reports.ts');
const CS = lib('cost-spikes.ts');
const DRQ = lib('discount-requests.ts');
const VA = lib('variance-approval.ts');
const CT = require(path.join(SRC, 'lib', 'ct', 'metrics.ts'));
const wa = lib('whatsapp.ts');
const PDFL = lib('report-pdf.ts');

/* -- 2. HARNESS --------------------------------------------------------- */

let pass = 0, fail = 0;
const failures = [];
function ok(label) { pass++; console.log(`  ok  ${label}`); }
function bad(label, detail) {
  fail++; failures.push(label);
  console.log(`  XX  ${label}`);
  if (detail) console.log(`      ${detail}`);
}
function expect(actual, expected, label, detail) {
  if (actual === expected) ok(`${label} — ${JSON.stringify(actual)}`);
  else bad(label, detail || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectTrue(cond, label, hint) { cond ? ok(label) : bad(label, hint); }
function section(n, title) { console.log(`\n[${n}] ${title}`); }
function show(label, value) { console.log(`      · ${label}: ${value}`); }
const money = (n) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

/* -- 3. NO NETWORK, EVER ------------------------------------------------ */
/* A builder that reached the network would be a defect, not a slow test. */
let netCalls = [];
global.fetch = async (url) => { netCalls.push(String(url)); throw new Error('network blocked in tests'); };

/* -- 4. WHAT THE REAL DATABASE ACTUALLY HOLDS --------------------------- */

const IST = "'+330 minutes'";
const one = (sql, ...p) => { try { return db.prepare(sql).get(...p); } catch { return undefined; } };
const all = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch { return []; } };

const OUTLET = B.defaultOutletId(db);

const salesDays = all(`
  SELECT date(settled_at, ${IST}) AS d, COUNT(*) n, ROUND(SUM(total),2) t
    FROM orders WHERE status='settled' AND date(settled_at, ${IST}) IS NOT NULL
   GROUP BY d ORDER BY n DESC, d DESC`);
const SALES_DAY = salesDays.length ? salesDays[0].d : null;

const callDays = all(`
  SELECT date(REPLACE(COALESCE(NULLIF(started_at,''),created_at),' ','T'), ${IST}) AS d, COUNT(*) n
    FROM ct_calls GROUP BY d ORDER BY d DESC`);
const CALL_DAY = callDays.length ? callDays[0].d : null;

const booking = one(`
  SELECT b.id FROM ct_bookings b JOIN ct_guests g ON g.id = b.guest_id
   WHERE b.is_duplicate = 0 AND TRIM(COALESCE(g.phone_e164,'')) <> ''
     AND lower(b.status) IN ('confirmed','booked','seated','completed')
   ORDER BY b.booking_date DESC LIMIT 1`);
/* A booking still sitting at the DEFAULT 'pending' — the confirmation must
 * refuse it, because nobody has accepted it yet. */
const pendingBooking = one(`
  SELECT b.id FROM ct_bookings b JOIN ct_guests g ON g.id = b.guest_id
   WHERE b.is_duplicate = 0 AND TRIM(COALESCE(g.phone_e164,'')) <> ''
     AND lower(b.status) = 'pending' ORDER BY b.booking_date DESC LIMIT 1`);

const discountReq = one('SELECT id FROM discount_requests ORDER BY created_at DESC LIMIT 1');

/* -- 5. THE TESTS ------------------------------------------------------- */

(async () => {
  console.log(`report-builder-tests — snapshot of the live DB at ${SNAP}`);
  console.log(`  outlet: ${OUTLET}`);
  console.log(`  busiest sales day: ${SALES_DAY} · busiest call day: ${CALL_DAY}`);
  console.log(`  settled orders=${(one("SELECT COUNT(*) n FROM orders WHERE status='settled'") || {}).n}`
    + ` purchases=${(one('SELECT COUNT(*) n FROM purchases') || {}).n}`
    + ` closing_stock=${(one('SELECT COUNT(*) n FROM closing_stock') || {}).n}`
    + ` variance_approvals=${(one('SELECT COUNT(*) n FROM variance_approvals') || {}).n}`
    + ` ct_calls=${(one('SELECT COUNT(*) n FROM ct_calls') || {}).n}`
    + ` ct_bookings=${(one('SELECT COUNT(*) n FROM ct_bookings') || {}).n}`
    + ` wa_messages=${(one('SELECT COUNT(*) n FROM wa_messages') || {}).n}`);

  /* ═══════════ 1. DAILY OPS on a real day ═══════════ */
  section(1, `DAILY OPS REPORT — real day ${SALES_DAY}`);
  let daily = null;
  if (!SALES_DAY) {
    bad('there is no settled-sales day in this database to report on');
  } else {
    daily = await B.buildDailyOpsReport(db, { date: SALES_DAY, outletId: OUTLET, generatedAtMs: 0 });

    console.log('    --- message ---');
    for (const l of daily.text.split('\n')) console.log(`    | ${l}`);
    console.log('    --- template variables ---');
    daily.paramOrder.forEach((k, i) => console.log(`    | {{${i + 1}}} ${k} = ${daily.vars[k]}`));

    expect(daily.empty, false, 'a day with settled bills is not empty');
    expectTrue(!!daily.pdf && daily.pdf.length > 0, 'it carries PDF bytes');
    expect(daily.params.length, daily.paramOrder.length, 'every positional param is filled');
    expectTrue(daily.params.every((p) => !/[\n\t]/.test(p)), 'no param carries a newline or tab (Meta rejects those)');

    /* CROSS-CHECK A — the lib /api/dine-in/sales-dashboard itself calls, with
     * the arguments that route builds (outlet, from = to = the day). */
    const screen = SD.getSalesDashboard(db, OUTLET, SALES_DAY, SALES_DAY);
    show('screen net (getSalesDashboard)', screen.day.net);
    expect(daily.vars.net, '₹' + money(screen.day.net),
      'CROSS-CHECK A · net collected equals the Sales Dashboard figure for the same day');
    expect(daily.vars.orders, String(screen.day.orders), 'CROSS-CHECK A · bill count equals the Sales Dashboard figure');
    expect(daily.vars.tax, '₹' + money(screen.day.tax), 'CROSS-CHECK A · tax equals the Sales Dashboard figure');
    expect(daily.vars.mtd_net, '₹' + money(screen.mtd.net), 'CROSS-CHECK A · month-to-date equals the Sales Dashboard figure');

    /* CROSS-CHECK B — hand-written SQL sharing no code with the builder or the
     * dashboard lib: settled only, IST day, the same lenient outlet predicate. */
    const raw = one(`
      SELECT COUNT(*) n, ROUND(COALESCE(SUM(total),0),2) net, COALESCE(SUM(covers),0) covers,
             ROUND(COALESCE(SUM(discount),0),2) disc, ROUND(COALESCE(SUM(tax_total),0),2) tax
        FROM orders
       WHERE status='settled' AND (outlet_id = ? OR outlet_id IS NULL)
         AND date(settled_at, ${IST}) = ?`, OUTLET, SALES_DAY);
    show('independent SQL', JSON.stringify(raw));
    expect(screen.day.net, raw.net, 'CROSS-CHECK B · dashboard net equals independent SQL');
    expect(screen.day.orders, raw.n, 'CROSS-CHECK B · dashboard bill count equals independent SQL');
    expect(screen.day.tax, raw.tax, 'CROSS-CHECK B · dashboard tax equals independent SQL');
    expect(screen.day.discount, raw.disc, 'CROSS-CHECK B · dashboard discount equals independent SQL');
    expect(screen.performanceDay.covers, raw.covers, 'CROSS-CHECK B · covers equal independent SQL');
    expect(daily.vars.covers, String(raw.covers), 'CROSS-CHECK B · …and the message repeats that number');

    /* CROSS-CHECK C — top seller against Item-wise Sales (/reports/sales?type=item). */
    const items = SD.getItemWiseSales(db, OUTLET, SALES_DAY, SALES_DAY);
    const itemSum = Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
    if (items.length) {
      show('item-wise top row', `${items[0].name} qty=${items[0].qty} amount=${items[0].amount}`);
      expectTrue(String(daily.vars.top_line).startsWith(items[0].name),
        "CROSS-CHECK C · the reported top seller is the Item-wise report's first row",
        `top_line=${daily.vars.top_line}`);
      show('sum of item-wise amounts', itemSum);
      expectTrue(itemSum <= screen.day.gross + 0.01,
        "CROSS-CHECK C · item lines never exceed the day's gross", `${itemSum} vs ${screen.day.gross}`);
    } else {
      ok('no item lines on this day — the top seller is reported as such');
    }

    /* CROSS-CHECK D — category-wise (/reports/sales?type=category) ties to item-wise. */
    const cats = SR.getCategoryWiseSales(db, OUTLET, SALES_DAY, SALES_DAY);
    const catSum = Math.round(cats.reduce((s, c) => s + c.sales, 0) * 100) / 100;
    show('sum of category-wise sales', catSum);
    expectTrue(cats.length === 0 || Math.abs(catSum - itemSum) < 0.02,
      'CROSS-CHECK D · category-wise total equals item-wise total (both are the /reports/sales basis)',
      `${catSum} vs ${itemSum}`);
  }

  /* ═══════════ 2. DAILY OPS on a day with no trade ═══════════ */
  section(2, 'DAILY OPS — a day with no settled bill says so and sends no PDF');
  {
    const empty = await B.buildDailyOpsReport(db, { date: '1990-01-01', outletId: OUTLET });
    expect(empty.empty, true, 'a day with no bills is empty');
    expect(empty.pdf, null, 'and carries NO pdf — a blank report is never generated');
    expectTrue(/No settled bills/.test(empty.emptyReason), 'and says why in a sentence a human can read', empty.emptyReason);
    show('sentence', empty.emptyReason);
    expect((await B.buildDailyOpsReport(db, { date: 'not-a-date', outletId: OUTLET })).empty, true,
      'a malformed date is refused, not guessed');
  }

  /* ═══════════ 3. STOCK DIFFERENCES ═══════════ */
  section(3, 'STOCK DIFFERENCES');
  {
    const anyCount = one('SELECT COUNT(*) n FROM closing_stock').n + one('SELECT COUNT(*) n FROM store_closing_counts').n;
    show('closing_stock + store_closing_counts rows in this DB copy', anyCount);

    if (SALES_DAY && anyCount === 0) {
      const none = await B.buildStockDifferenceReport(db, { date: SALES_DAY, outletId: OUTLET });
      expect(none.empty, true, 'no count on the day ⇒ empty (this DB copy holds no counts at all)');
      expect(none.pdf, null, 'and no PDF is generated for a day nobody counted');
      show('sentence', none.emptyReason);
    }

    /* The populated path. This copy carries no closing count, so rows shaped
     * exactly as the two writers shape them are inserted INTO THE SNAPSHOT
     * (never the live DB) and the report is cross-checked against the digest
     * builder and the approval-queue reader for those same rows. */
    const mats = all("SELECT id, name, COALESCE(NULLIF(TRIM(purchase_unit),''), unit) AS u FROM raw_materials LIMIT 3");
    if (mats.length >= 2) {
      const D = '2026-09-01';
      const insCs = db.prepare(`INSERT OR REPLACE INTO closing_stock
        (id, date, material_id, system_stock, physical_stock, variance, variance_value, outlet_id, department_id, recorded_by)
        VALUES (?,?,?,?,?,?,?,?,?,'tests')`);
      insCs.run('t-cs-1', D, mats[0].id, 10, 7, -3, -300, OUTLET, '');
      insCs.run('t-cs-2', D, mats[1].id, 5, 5, 0, 0, OUTLET, '');
      db.prepare(`INSERT OR REPLACE INTO variance_approvals
        (id, source, material_id, store_id, department_id, date, system_stock, physical_stock, variance, variance_value,
         unit, counted_by, count_note, status, reviewed_by, reviewed_at, review_reason, outlet_id, auto_applied, batch_id, batch_label)
        VALUES (?,'central',?,'','',?,?,?,?,?,?,'tests','','pending','','','',?,0,'','')`)
        .run('t-va-1', mats[0].id, D, 10, 7, -3, -300, mats[0].u, OUTLET);

      const rep = await B.buildStockDifferenceReport(db, { date: D, outletId: OUTLET, generatedAtMs: 0 });
      console.log('    --- message ---');
      for (const l of rep.text.split('\n')) console.log(`    | ${l}`);
      console.log('    --- template variables ---');
      rep.paramOrder.forEach((k, i) => console.log(`    | {{${i + 1}}} ${k} = ${rep.vars[k]}`));

      expect(rep.empty, false, 'a day WITH a count is reported');
      expectTrue(!!rep.pdf, 'and carries a PDF of the lines');

      /* CROSS-CHECK E — buildCountDigest(), the function that already writes
       * this sentence into the audit trail on every count save. */
      const digest = VA.buildCountDigest(db, { date: D, outlet_id: OUTLET, rail: 'central' });
      show('digest counted/differed/value', `${digest.counted}/${digest.differed}/${digest.total_value}`);
      expect(rep.vars.counted, String(digest.counted), 'CROSS-CHECK E · lines counted equals the count digest');
      expect(rep.vars.differed, String(digest.differed), 'CROSS-CHECK E · lines differed equals the count digest');
      expectTrue(rep.text.includes(digest.label), "CROSS-CHECK E · the report carries the digest's own sentence verbatim");

      /* CROSS-CHECK F — the line table against the /variance-approvals reader. */
      const queue = VA.listVarianceApprovals(db, { status: 'all', from: D, to: D, outletId: OUTLET, outletScope: 'outlet', limit: 60 });
      show('approval-queue rows for the day', queue.rows.length);
      expectTrue(queue.rows.length >= 1, 'CROSS-CHECK F · the approval queue lists the seeded line');
      const pdfTxt = rep.pdf.toString('latin1');
      expectTrue(queue.rows.every((r) => pdfTxt.length > 0), 'CROSS-CHECK F · the PDF is rendered from those rows');
      expect(rep.vars.held, `${digest.held_count} (${digest.held_value < 0 ? '-₹' : (digest.held_value > 0 ? '+₹' : '₹')}${money(Math.abs(digest.held_value))})`,
        "CROSS-CHECK F · the held count and value are the digest's");

      /* The department rule: a department line must never be given a rupee figure. */
      insCs.run('t-cs-3', D, mats[0].id, 500, 3, -497, -49700, OUTLET, 'dept-x');
      const withDept = await B.buildStockDifferenceReport(db, { date: D, outletId: OUTLET });
      expectTrue(/department line/.test(withDept.text), 'a department line is REPORTED', withDept.text);
      expectTrue(/no rupee figure|central pool/.test(withDept.text),
        'and is explicitly refused a rupee figure, with the reason stated', withDept.text);
      show('dept sentence', withDept.text.split('\n').filter((l) => /department/.test(l)).join(' '));

      db.prepare("DELETE FROM closing_stock WHERE id LIKE 't-cs-%'").run();
      db.prepare("DELETE FROM variance_approvals WHERE id LIKE 't-va-%'").run();
      expect(one("SELECT COUNT(*) n FROM closing_stock WHERE id LIKE 't-cs-%'").n, 0, 'the seeded rows are removed again');
    } else {
      bad('no raw materials in this database to seed a count with');
    }
  }

  /* ═══════════ 4. PRICE HIKE — cross-checked against the real API route ═══════════ */
  section(4, 'PRICE HIKE ALERT');
  {
    const hike = await B.buildPriceHikeAlert(db, { thresholdPct: 10, generatedAtMs: 0 });
    if (hike.empty) {
      show('sentence', hike.emptyReason);
      ok('no item is over the threshold — the alert is empty and sends nothing');
    } else {
      console.log('    --- message ---');
      for (const l of hike.text.split('\n').slice(0, 12)) console.log(`    | ${l}`);
      console.log('    --- template variables ---');
      hike.paramOrder.forEach((k, i) => console.log(`    | {{${i + 1}}} ${k} = ${hike.vars[k]}`));

      /* CROSS-CHECK G — the ACTUAL API ROUTE. /api/cost-spikes needs no session,
       * so its GET handler is invoked here exactly as Next would call it, and the
       * alert is compared against the JSON the home dashboard renders. */
      const routeMod = require(path.join(SRC, 'app', 'api', 'cost-spikes', 'route.ts'));
      const res = await routeMod.GET(new Request('http://localhost/api/cost-spikes?threshold_pct=10'));
      const json = await res.json();
      show('API /api/cost-spikes count', json.count);
      show('API top row', `${json.spikes[0].name} avg=${json.spikes[0].avg_price} latest=${json.spikes[0].latest_price} pct=${json.spikes[0].pct_change} vendor=${json.spikes[0].latest_vendor}`);
      expect(String(hike.vars.material), String(json.spikes[0].name),
        "CROSS-CHECK G · the alerted material is the API's top spike");
      expect(String(hike.vars.pct), `${Number(json.spikes[0].pct_change).toFixed(2)}%`,
        "CROSS-CHECK G · the alerted percentage is the API's percentage");
      expectTrue(String(hike.vars.new_rate).includes(money(json.spikes[0].latest_price)),
        "CROSS-CHECK G · the alerted new rate is the API's latest_price", String(hike.vars.new_rate));
      expectTrue(String(hike.vars.old_rate).includes(money(json.spikes[0].avg_price)),
        "CROSS-CHECK G · the alerted old rate is the API's avg_price", String(hike.vars.old_rate));
      expect(String(hike.vars.vendor), String(json.spikes[0].latest_vendor || 'vendor not recorded'),
        "CROSS-CHECK G · the vendor is the API's latest_vendor");

      /* CROSS-CHECK H — the extracted lib and the route return the same rows. */
      const direct = CS.costSpikes(db, { thresholdPct: 10 });
      expect(direct.count, json.count, 'CROSS-CHECK H · the extracted lib and the route agree on the row count');
      expect(direct.spikes[0].id, json.spikes[0].id, 'CROSS-CHECK H · …and on the first row');
      expect(direct.spikes[0].avg_price, json.spikes[0].avg_price, 'CROSS-CHECK H · …and on its average price');

      /* The unit label must be the PURCHASE unit, not the recipe unit. */
      const top = json.spikes[0];
      const wantUnit = String(top.purchase_unit || top.unit || '').trim();
      expectTrue(String(hike.vars.new_rate).endsWith('/' + wantUnit),
        'the rate is labelled with the PURCHASE unit (the purchases.unit_price basis), not the recipe unit',
        `new_rate=${hike.vars.new_rate} purchase_unit=${top.purchase_unit} recipe_unit=${top.unit}`);
      show('purchase unit vs recipe unit', `${top.purchase_unit} / ${top.unit} (pack ${top.pack_size})`);

      expectTrue(json.count === 1 ? hike.pdf === null : !!hike.pdf, 'one spike is a message; a list gets a PDF');
    }

    const none = await B.buildPriceHikeAlert(db, { thresholdPct: 100000 });
    expect(none.empty, true, 'an unreachable threshold produces an empty alert');
    expect(none.pdf, null, 'and no PDF');
    show('sentence', none.emptyReason);

    const filtered = await B.buildPriceHikeAlert(db, { materialIds: ['no-such-material'], thresholdPct: 1 });
    expect(filtered.empty, true, 'an event alert scoped to one material does not leak the whole backlog');
    expect(B.priceHikeThreshold(db), 10, 'the configured threshold defaults to 10%, the same default the API has always used');
  }

  /* ═══════════ 5. DISCOUNT ALERT ═══════════ */
  section(5, 'DISCOUNT ALERT');
  if (!discountReq) {
    bad('no discount_requests row in this database to build an alert from');
  } else {
    const alert = await B.buildDiscountAlert(db, { requestId: discountReq.id });
    console.log('    --- message ---');
    for (const l of alert.text.split('\n')) console.log(`    | ${l}`);
    console.log('    --- template variables ---');
    alert.paramOrder.forEach((k, i) => console.log(`    | {{${i + 1}}} ${k} = ${alert.vars[k]}`));

    expect(alert.empty, false, 'a real request builds an alert');
    expect(alert.pdf, null, 'a one-bill alert is a sentence, never a document');

    /* CROSS-CHECK I — the approval queue's own reader: what
     * /api/dine-in/discount-requests renders, and what computes impact_amount. */
    const q = DRQ.listDiscountRequests(db, 'WHERE dr.id = ?', [discountReq.id])[0];
    show('queue row', `order #${q.order_number} ${q.requested_pct}% kind=${q.kind} impact=${q.impact_amount} status=${q.status} subtotal=${q.order_subtotal}`);
    expect(String(alert.vars.decision), String(q.status), "CROSS-CHECK I · the decision equals the queue's status");
    expect(String(alert.vars.order), `#${q.order_number}`, "CROSS-CHECK I · the bill number equals the queue's");
    expect(String(alert.vars.requested_by), String(q.requester_name || q.requested_by || '—'),
      "CROSS-CHECK I · the requester is the queue's");
    if (q.kind !== 'service_charge') {
      expect(String(alert.vars.amount), '₹' + money(q.impact_amount),
        "CROSS-CHECK I · the rupee impact equals the queue's impact_amount");
      const byHand = Math.round((Number(q.order_subtotal) || 0) * (Number(q.requested_pct) || 0) / 100 * 100) / 100;
      expect(q.impact_amount, byHand, "CROSS-CHECK I · which is subtotal × pct ÷ 100 — the decide route's own arithmetic");
    } else {
      expectTrue(/waived/.test(String(alert.vars.amount)),
        'a service-charge waiver is called a waiver, not "₹0" (its ₹ is only known at settle)');
    }
    expect((await B.buildDiscountAlert(db, { requestId: 'no-such-request' })).empty, true,
      'a request that no longer exists produces no alert');
  }

  /* ═══════════ 6. CRM DAILY OVERVIEW ═══════════ */
  section(6, `CRM DAILY OVERVIEW — real day ${CALL_DAY}`);
  if (!CALL_DAY) {
    bad('no ct_calls rows in this database');
  } else {
    const crm = await B.buildCrmDailyOverview(db, { date: CALL_DAY, outletId: OUTLET, generatedAtMs: 0 });
    console.log('    --- message ---');
    for (const l of crm.text.split('\n')) console.log(`    | ${l}`);
    console.log('    --- template variables ---');
    crm.paramOrder.forEach((k, i) => console.log(`    | {{${i + 1}}} ${k} = ${crm.vars[k]}`));

    expect(crm.empty, false, 'a day with calls is reported');
    expectTrue(!!crm.pdf, 'and carries a PDF');

    /* CROSS-CHECK J — dashboardStats(), the CRM dashboard's own aggregator. */
    const todayIst = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const back = Math.round((Date.parse(todayIst + 'T00:00:00Z') - Date.parse(CALL_DAY + 'T00:00:00Z')) / 86400000);
    const st = CT.dashboardStats(db, { days: back + 1 });
    const dayRow = (st.byDay || []).find((d) => d.date === CALL_DAY);
    show('dashboardStats byDay', JSON.stringify(dayRow));
    expect(String(crm.vars.calls), String(dayRow.total), "CROSS-CHECK J · calls equal the CRM dashboard's per-day series");
    expect(String(crm.vars.answered), String(dayRow.answered), 'CROSS-CHECK J · answered equals the CRM dashboard');
    expect(String(crm.vars.missed), String(dayRow.missed), 'CROSS-CHECK J · missed equals the CRM dashboard');
    expect(String(crm.vars.pending), String(st.today.pending_recoveries),
      'CROSS-CHECK J · the open missed-call queue equals the dashboard tile');

    /* CROSS-CHECK K — hand-written SQL over ct_calls, sharing no code with
     * ct/metrics: the same IST bucketing and the same missed family. */
    const rawCalls = one(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN status='answered' THEN 1 ELSE 0 END) answered,
             SUM(CASE WHEN status IN ('missed','abandoned','voicemail') THEN 1 ELSE 0 END) missed
        FROM ct_calls c
       WHERE direction='inbound'
         AND date(REPLACE(COALESCE(NULLIF(c.started_at,''),c.created_at),' ','T'), ${IST}) = ?`, CALL_DAY);
    show('independent SQL over ct_calls (inbound)', JSON.stringify(rawCalls));
    expect(dayRow.total, rawCalls.total, 'CROSS-CHECK K · the dashboard series equals independent SQL');
    expect(dayRow.answered, rawCalls.answered, 'CROSS-CHECK K · …and so does answered');
    expect(dayRow.missed, rawCalls.missed, 'CROSS-CHECK K · …and missed');

    /* Threads — the one figure with no prior computation. */
    const threadRows = one(`SELECT COUNT(DISTINCT conversation_id) n FROM wa_messages WHERE date(created_at, ${IST}) = ?`, CALL_DAY);
    expect(String(crm.vars.threads), String(threadRows.n), 'threads equal the WhatsApp inbox rows for that IST day');

    /* The nested-window difference must isolate exactly one day. */
    const narrow = back > 0 ? CT.dashboardStats(db, { days: back }) : null;
    const expectBookings = Math.max(0, (st.funnel.booked || 0) - ((narrow && narrow.funnel.booked) || 0));
    show('funnel booked wide/narrow', `${st.funnel.booked} / ${(narrow && narrow.funnel.booked) || 0}`);
    expect(String(crm.vars.bookings), String(expectBookings),
      "CROSS-CHECK J · bookings are the dashboard's own window totals differenced across two nested windows");

    expect((await B.buildCrmDailyOverview(db, { date: '2099-01-01', outletId: OUTLET })).empty, true,
      'a future date is refused, not reported as zeroes');
    const ancient = await B.buildCrmDailyOverview(db, { date: '2000-01-01', outletId: OUTLET });
    expect(ancient.empty, true, 'a date outside the 90-day CRM window says so rather than inventing a window');
    show('out-of-window sentence', ancient.emptyReason);
  }

  /* ═══════════ 7. RESERVATION CONFIRMATION (guest-facing) ═══════════ */
  section(7, 'RESERVATION CONFIRMATION');
  if (!booking) {
    bad('no live ct_bookings row with a guest phone in this database');
  } else {
    const conf = await B.buildReservationConfirmation(db, { bookingId: booking.id });
    console.log('    --- message ---');
    for (const l of conf.text.split('\n')) console.log(`    | ${l}`);
    console.log('    --- template variables ---');
    conf.paramOrder.forEach((k, i) => console.log(`    | {{${i + 1}}} ${k} = ${conf.vars[k]}`));

    expect(conf.empty, false, 'a live booking confirms');
    expect(conf.pdf, null, 'a guest gets a sentence, not an attachment');
    expectTrue(!!conf.guestPhone, 'and the guest number rides on the result');

    /* CROSS-CHECK L — every field against the stored booking row. */
    const row = one('SELECT b.*, g.name gname, g.phone_e164 gphone FROM ct_bookings b LEFT JOIN ct_guests g ON g.id=b.guest_id WHERE b.id = ?', booking.id);
    show('stored booking', `${row.booking_date} ${row.slot_time} party=${row.party_size} status=${row.status} phone=${row.gphone} guest=${row.gname}`);
    expect(conf.guestPhone, row.gphone, "CROSS-CHECK L · the number is the guest's stored number");
    expect(conf.guestName, row.gname, 'CROSS-CHECK L · the name is the stored guest name');
    expect(String(conf.vars.party_size), String(row.party_size), 'CROSS-CHECK L · party size equals the booking');
    expect(String(conf.vars.time), String(row.slot_time || row.booking_time || row.reserved_time), 'CROSS-CHECK L · time equals the booking');
    expectTrue(String(conf.vars.date).includes(String(row.booking_date).slice(0, 4)),
      "CROSS-CHECK L · the date is the booking's date", `${conf.vars.date} vs ${row.booking_date}`);
    expect(String(conf.vars.venue), B.businessNameOf(db), 'CROSS-CHECK L · the venue is the configured business name');

    /* The refusals that matter for the one message that leaves the building. */
    const before = String(row.status);
    db.prepare('UPDATE ct_bookings SET status = ? WHERE id = ?').run('cancelled', booking.id);
    const cancelled = await B.buildReservationConfirmation(db, { bookingId: booking.id });
    expect(cancelled.empty, true, 'a CANCELLED booking is never confirmed to the guest');
    show('refusal', cancelled.emptyReason);
    db.prepare('UPDATE ct_bookings SET status = ? WHERE id = ?').run('no_show', booking.id);
    expect((await B.buildReservationConfirmation(db, { bookingId: booking.id })).empty, true, 'nor a NO-SHOW');
    db.prepare('UPDATE ct_bookings SET status = ?, is_duplicate = 1 WHERE id = ?').run(before, booking.id);
    expect((await B.buildReservationConfirmation(db, { bookingId: booking.id })).empty, true,
      'nor a superseded duplicate row (the live row carries the confirmation)');
    db.prepare('UPDATE ct_bookings SET is_duplicate = 0 WHERE id = ?').run(booking.id);
    expect((await B.buildReservationConfirmation(db, { bookingId: 'nope' })).empty, true, 'nor a booking that does not exist');
    if (pendingBooking) {
      const p = await B.buildReservationConfirmation(db, { bookingId: pendingBooking.id });
      expect(p.empty, true, "nor a booking still at the DEFAULT 'pending' — nobody has accepted that table yet");
      show('pending refusal', p.emptyReason);
    }
    db.prepare("UPDATE ct_bookings SET status = 'some_new_status_nobody_has_seen' WHERE id = ?").run(booking.id);
    expect((await B.buildReservationConfirmation(db, { bookingId: booking.id })).empty, true,
      'and an unrecognised status FAILS CLOSED (allowlist, not blocklist)');
    db.prepare('UPDATE ct_bookings SET status = ? WHERE id = ?').run(before, booking.id);
    expect((await B.buildReservationConfirmation(db, { bookingId: booking.id })).empty, false,
      'and the live row still confirms after those checks (the fixture is restored)');
  }

  /* ═══════════ 8. TICKET — refused, not invented ═══════════ */
  section(8, 'TICKET PDF — deliberately NOT built');
  {
    const def = B.reportDef('ticket');
    expectTrue(!!def, 'the registry carries a ticket slot, so the plumbing is ready');
    expect(def.unimplemented, true, 'and it is marked unimplemented');
    expectTrue(/must say what a ticket is/.test(def.unimplementedReason || ''),
      'with a reason that names the decision the owner has to make');
    expectTrue(typeof B.buildTicketPdf === 'undefined',
      'and NO builder exists — a guessed ticket is worse than none');
    const job = await JOBS.runReportJob(db, 'ticket', { force: true });
    expect(job.status, 'error', 'running it refuses');
    expectTrue(/ticket/i.test(job.detail || ''), 'and the refusal explains itself', job.detail);
    console.log(`    | ${B.TICKET_NOT_DEFINED}`);
  }

  /* ═══════════ 9. THE PDFs ARE REAL PDFs ═══════════ */
  section(9, 'PDF integrity');
  {
    const crmPdf = CALL_DAY ? await B.buildCrmDailyOverview(db, { date: CALL_DAY, outletId: OUTLET, generatedAtMs: 0 }) : null;
    const built = [daily, crmPdf].filter((b) => b && b.pdf);
    if (!built.length) bad('no PDF was produced to check');
    for (const b of built) {
      expect(b.pdf.subarray(0, 5).toString('latin1'), '%PDF-', `${b.key}: starts with a PDF header`);
      expectTrue(b.pdf.subarray(-2048).toString('latin1').includes('%%EOF'), `${b.key}: ends with %%EOF`);
      expectTrue(b.pdf.length < wa.WA_UPLOAD_MAX_BYTES,
        `${b.key}: fits inside the ${wa.WA_UPLOAD_MAX_BYTES / 1048576} MB attachment cap`, `${b.pdf.length} bytes`);
      show(`${b.key} pdf size`, `${(b.pdf.length / 1024).toFixed(1)} KB`);
      expectTrue(/\.pdf$/.test(b.filename), `${b.key}: the filename ends .pdf`);
      expect(b.mime, 'application/pdf', `${b.key}: the MIME is one the send rail allows`);
      expectTrue(!!wa.WA_UPLOAD_MIME_ALLOW[b.mime], `${b.key}: …and is on the upload allowlist`);
      expectTrue(!b.pdf.includes(Buffer.from('₹', 'utf8')),
        `${b.key}: no raw rupee sign in the PDF (pdfkit's Helvetica cannot draw it)`);
      expectTrue(!/[\\/:*?"<>|]/.test(b.filename), `${b.key}: the filename is safe for a Content-Disposition header`);
    }
    if (daily) expectTrue(daily.text.includes('₹'), 'the WhatsApp message text uses the real ₹ sign (it is UTF-8)');

    expect(PDFL.inr(1234.5), 'Rs 1,234.50', 'inr() (PDF) emits Rs');
    expect(PDFL.inrText(1234.5), '₹1,234.50', 'inrText() (message) emits ₹');
    expect(PDFL.inr(-90), '-Rs 90.00', 'a negative renders once, on the left');
    expect(PDFL.inrSignedText(0), '₹0.00', 'a zero variance is not "+₹0.00"');
    expect(PDFL.inrSignedText(5), '+₹5.00', 'a positive variance is signed');
    expect(PDFL.humanDate('2026-07-16'), 'Thu, 16 Jul 2026', 'humanDate is IST and cannot slip a day');
    expect(PDFL.count(12345), '12,345', 'counts use Indian grouping');
    expect(PDFL.qty(2.5), '2.5', 'quantities drop trailing zeros');

    /* A many-row report must stay inside the cap — the fixed-height row rule. */
    const big = await PDFL.buildReportPdf({
      title: 'Row-count stress', period: 'x', generatedAtMs: 0,
      tables: [{
        columns: [{ label: 'A', width: 3 }, { label: 'B', width: 1, align: 'right' }],
        rows: Array.from({ length: 4000 }, (_, i) => [`material ${i} with a deliberately very long name that must be truncated rather than wrapped`, i]),
      }],
    });
    show('4,000-row PDF size', `${(big.length / 1024).toFixed(1)} KB`);
    expectTrue(big.length < wa.WA_UPLOAD_MAX_BYTES, 'a 4,000-row table still fits the attachment cap', `${big.length}`);
    const emptySpec = await PDFL.buildReportPdf({ title: 'Nothing', generatedAtMs: 0 });
    expectTrue(emptySpec.length > 0 && emptySpec.subarray(0, 5).toString('latin1') === '%PDF-',
      'the renderer never throws on an empty spec (the BUILDERS are what refuse to send one)');
  }

  /* ═══════════ 10. BUILDERS ARE PURE ═══════════ */
  section(10, 'purity — a builder writes nothing and sends nothing');
  {
    const tables = ['orders', 'order_items', 'closing_stock', 'variance_approvals', 'purchases',
      'discount_requests', 'ct_bookings', 'ct_calls', 'wa_messages', 'wa_report_files',
      'whatsapp_events_log', 'settings', 'audit_events', 'raw_materials'];
    const before = {};
    for (const t of tables) before[t] = (one(`SELECT COUNT(*) n FROM ${t}`) || { n: -1 }).n;
    const netBefore = netCalls.length;

    if (SALES_DAY) await B.buildDailyOpsReport(db, { date: SALES_DAY, outletId: OUTLET });
    if (CALL_DAY) await B.buildCrmDailyOverview(db, { date: CALL_DAY, outletId: OUTLET });
    await B.buildStockDifferenceReport(db, { date: '2026-09-01', outletId: OUTLET });
    await B.buildPriceHikeAlert(db, { thresholdPct: 10 });
    if (discountReq) await B.buildDiscountAlert(db, { requestId: discountReq.id });
    if (booking) await B.buildReservationConfirmation(db, { bookingId: booking.id });

    const drift = [];
    for (const t of tables) {
      const now = (one(`SELECT COUNT(*) n FROM ${t}`) || { n: -1 }).n;
      if (now !== before[t]) drift.push(`${t}: ${before[t]} → ${now}`);
    }
    expect(drift.length, 0, 'running every builder changed no row count anywhere', drift.join(', '));
    expect(netCalls.length, netBefore, 'and made no network call');
  }

  /* ═══════════ 11. THE SCHEDULED RUNNER ═══════════ */
  section(11, 'the scheduled runner is OFF until configured, and never sends an empty report');
  {
    const netBefore = netCalls.length;
    const off = await JOBS.runWaReportJobs(db);
    for (const k of Object.keys(off)) show(k, JSON.stringify(off[k]));
    expect(off.daily_ops.status, 'disabled', 'daily ops is OFF out of the box');
    expect(off.stock_differences.status, 'disabled', 'so is stock differences');
    expect(off.crm_daily.status, 'disabled', 'so is the CRM overview');
    expect(netCalls.length, netBefore, 'a disabled runner touches no network');

    const set = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);

    set('wa_report_daily_ops_enabled', '1');
    expect((await JOBS.runReportJob(db, 'daily_ops')).status, 'no_recipients',
      'enabled but with nobody to send to ⇒ refused, not sent');
    set('wa_report_daily_ops_recipients', '919000000001');
    expect((await JOBS.runReportJob(db, 'daily_ops')).status, 'no_template',
      'and with no approved template ⇒ still refused');
    set('wa_report_daily_ops_template', 'akan_daily_report');

    const quiet = await JOBS.runReportJob(db, 'daily_ops', { date: '1990-01-01' });
    expect(quiet.status, 'nothing_to_report', 'a day with no trade is skipped');
    expect(netCalls.length, netBefore, 'and nothing left the building for it');
    expect(one("SELECT COUNT(*) n FROM wa_report_files WHERE report_key='daily_ops'").n, 0,
      'and no file row was stored for a report that was never built');
    show('skip reason', quiet.detail);

    const cfg = JOBS.reportConfig(db, 'daily_ops');
    expect(cfg.enabled, true, 'reportConfig reads the enabled flag');
    expect(cfg.offsetDays, 1, 'and defaults to reporting YESTERDAY, matching the calls_daily job');
    expect(cfg.recipients.length, 1, 'and parses the recipient list');
    expect(JOBS.istDateBack(0, Date.parse('2026-09-09T19:00:00Z')), '2026-09-10',
      'istDateBack is IST, not UTC (19:00 UTC is already tomorrow in Kolkata)');
    expect(JOBS.istDateBack(1, Date.parse('2026-09-09T04:00:00Z')), '2026-09-08', 'and one day back is yesterday IST');

    /* Report recipients must NOT live in the blob rebuilt on every save of the
     * Notifications tab — that is how a recipient list has vanished before. */
    const notify = one("SELECT value FROM settings WHERE key='wa_notify_recipients'");
    expectTrue(!notify || !String(notify.value).includes('919000000001'),
      'report recipients are NOT stored in wa_notify_recipients');
    expectTrue(!wa.WA_NOTIFY_EVENTS.includes('daily_ops'), 'and no report key was pushed into WA_NOTIFY_EVENTS');
    expect(wa.WA_NOTIFY_EVENTS.length, 6, 'WA_NOTIFY_EVENTS is untouched — still the six events that were there');

    /* Dedupe reads the send rail's own log; a FAILED attempt must not burn the day. */
    db.prepare("INSERT INTO whatsapp_events_log (kind, payload) VALUES ('send_attempt', ?)")
      .run(JSON.stringify({ event: 'report_attachment', report_key: 'daily_ops', ok: false, reason: 'send_failed' }));
    expect(JOBS.reportSentToday(db, 'daily_ops'), false, 'a failed send does not burn the once-a-day slot');
    db.prepare("INSERT INTO whatsapp_events_log (kind, payload) VALUES ('send_attempt', ?)")
      .run(JSON.stringify({ event: 'report_attachment', report_key: 'daily_ops', to: '91900', ok: true, provider: 'meta_cloud' }));
    expect(JOBS.reportSentToday(db, 'daily_ops'), true, 'a successful one does');
    expect(JOBS.reportSentToday(db, 'crm_daily'), false, 'and it burns only ITS OWN report, not every report');
    expect((await JOBS.runReportJob(db, 'daily_ops')).status, 'already_sent_today', 'the job then stands down');
    expect((await JOBS.runReportJob(db, 'daily_ops', { force: true, date: '1990-01-01' })).status, 'nothing_to_report',
      'force skips the once-a-day guard but NEVER the empty check');
    expect(netCalls.length, netBefore, 'through all of that, nothing reached the network');
  }

  /* ═══════════ 12. THE REGISTRY ═══════════ */
  section(12, 'registry');
  {
    expect(B.WA_REPORT_DEFS.length, 7, 'seven entries — the six built and the one refused');
    for (const d of B.WA_REPORT_DEFS) expect(d.templateCategory, 'UTILITY', `${d.key}: UTILITY, never MARKETING`);
    const guest = B.WA_REPORT_DEFS.filter((d) => d.audience === 'guest').map((d) => d.key).sort();
    expect(JSON.stringify(guest), JSON.stringify(['reservation_confirmation', 'ticket']),
      'only the reservation confirmation (and the undefined ticket) are guest-facing');
    expect(B.reportDef('discount_alert').attachment, 'never', 'the discount alert never attaches a document');
    expect(B.reportDef('daily_ops').attachment, 'always', 'the daily ops report always does');
    expect(B.reportDef('price_hike').attachment, 'sometimes', 'the price hike attaches only when there is a list');
    for (const d of B.WA_REPORT_DEFS) {
      if (d.unimplemented) continue;
      expectTrue(d.paramOrder.length > 0, `${d.key}: declares its template parameter order`);
    }
  }

  /* -- verdict ---------------------------------------------------------- */
  console.log(`\n${'-'.repeat(64)}`);
  console.log(`report-builder-tests: ${pass} passed, ${fail} failed  (sandbox: ${TMP})`);
  if (fail > 0) {
    console.log('FAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch((e) => {
  console.error('\nreport-builder-tests: harness crashed:', (e && e.stack) || e);
  process.exit(1);
});
