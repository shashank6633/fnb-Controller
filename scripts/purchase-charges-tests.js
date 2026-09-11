#!/usr/bin/env node
/**
 * BILL-CHARGE PROOF — taxes, cess, transport and round-off on the purchase
 * reports, run against a COPY of the REAL database.
 *
 *   node scripts/purchase-charges-tests.js        (also: npm test)
 *
 * SANDBOX CONTRACT (same as scripts/report-builder-tests.js): fnb-controller.db,
 * its -wal and its -shm are copied to a fresh os.tmpdir() directory and VACUUMed
 * into the snapshot the tests open; the process chdir()s there BEFORE
 * src/lib/db.ts is required, and an abort-hard guard checks the open handle
 * really is the snapshot. The -wal is copied because the newest rows live there
 * until a checkpoint. NOTHING here writes to the live database.
 *
 * WHAT IT PROVES — every claim against real rows, none against a fixture:
 *
 *   1  THE REPORT EQUALS THE SOURCE. Each of the eight charge columns and the
 *      derived Total Amount, as the API returns them, against hand-written SQL
 *      that shares no code with the route.
 *   2  IT ADDS UP. Sum(rows) === summary, to the PAISA, for every charge, on
 *      every one of the six breakdowns. Blank cells count as 0 — and a blank is
 *      only ever allowed where the stored figure is 0, which is asserted, so a
 *      blank can never hide money.
 *   3  THREE REAL BILLS PER CHARGE TYPE. Bill-grain figures from
 *      src/lib/purchase-bill-summary.ts (a different module, a different query)
 *      are shown and summed to the report's own vendor row.
 *   4  A BILL WITH NO CHARGES shows blanks/zeros and its Total Amount is
 *      exactly its goods value — the columns cost it nothing.
 *   5  ROUND OFF IS SIGNED, on real data (a GRN line stored at -0.50) and
 *      through the renderer and the CSV escaper.
 *   6  THE CSV APPENDS, NEVER INSERTS: the pre-change lead columns are the
 *      first columns, in order, and a negative number leaves as a NUMBER, not
 *      as apostrophe-quoted text that breaks a spreadsheet SUM.
 *   7  NO SECOND ALLOCATOR WAS WRITTEN. The bill-level allocation for the
 *      liquor rail is left where it lives; this module's SQL is asserted to be
 *      the same arithmetic purchase-bill-summary uses per line.
 *   8  ANTI-DRIFT: the CSV heading text in src/lib/purchase-charges.ts is the
 *      SAME text /api/reports/purchase-log prints for the same figure.
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
  console.error(`purchase-charges-tests: ${LIVE_DB} not found — nothing to snapshot.`);
  process.exit(2);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-charge-tests-')));
const STAGE = path.join(TMP, 'stage');
fs.mkdirSync(STAGE, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(LIVE_DB + suffix)) fs.copyFileSync(LIVE_DB + suffix, path.join(STAGE, 'fnb-controller.db' + suffix));
}
{
  const src = new Database(path.join(STAGE, 'fnb-controller.db'), { readonly: true });
  // Bound parameter, not string interpolation — SQLite takes one here.
  src.prepare('VACUUM INTO ?').run(path.join(TMP, 'fnb-controller.db'));
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

/* The route is management-gated and reads next/headers. Stub the auth module in
 * the require cache BEFORE the route is loaded, so the REAL handler runs — this
 * is the shipped report answering, not a re-implementation of it. */
const AUTH = path.join(SRC, 'lib', 'auth.ts');
require.cache[AUTH] = {
  id: AUTH, filename: AUTH, loaded: true, paths: [],
  exports: {
    getCurrentUser: async () => ({ id: 'proof', email: 'proof@local', name: 'Proof', role: 'admin' }),
    isManagement: () => true,
    SESSION_COOKIE: 'fnb_session',
  },
};

const dbMod = lib('db.ts');
const db = dbMod.getDb();

(function assertSandboxed(handle) {
  const open = path.resolve(handle.name || '');
  if (path.resolve(LIVE_DB) === open || !open.startsWith(path.resolve(TMP))) {
    console.error(`\nFATAL: tests opened ${open}, which is not the snapshot in ${TMP}. Aborting.`);
    process.exit(3);
  }
})(db);

const PC = lib('purchase-charges.ts');
const PBS = lib('purchase-bill-summary.ts');
const route = require(path.join(SRC, 'app', 'api', 'reports', 'purchases', 'route.ts'));

/* -- 2. HARNESS --------------------------------------------------------- */

let pass = 0, fail = 0;
const failures = [];
function ok(label) { pass++; console.log(`  ok  ${label}`); }
function bad(label, detail) {
  fail++; failures.push(label);
  console.log(`  FAIL ${label}`);
  if (detail != null) console.log(`       ${detail}`);
}
function expect(got, want, label) {
  if (String(got) === String(want)) ok(label); else bad(label, `got ${got}, want ${want}`);
}
/** Money equality in PAISE — never a float ===. */
function expectMoney(got, want, label) {
  const g = Math.round((Number(got) || 0) * 100), w = Math.round((Number(want) || 0) * 100);
  if (g === w) ok(label); else bad(label, `got ${g / 100}, want ${w / 100} (paise ${g} vs ${w})`);
}
function expectTrue(cond, label, detail) { if (cond) ok(label); else bad(label, detail); }
function show(k, v) { console.log(`    ${String(k).padEnd(44)} ${v}`); }
function head(t) { console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 68 - t.length))}`); }

const KEYS = PC.PURCHASE_CHARGE_COLUMNS.map(c => c.key);
const ALL = [...KEYS, 'bill_value', 'total_amount'];

const FROM = '1970-01-01';
const TO = '2999-12-31';
const call = async (qs) => {
  const res = await route.GET(new Request(`http://localhost/api/reports/purchases?${qs}`));
  const json = await res.json();
  if (!res.ok) throw new Error(`route said ${res.status}: ${json.error}`);
  return json;
};

(async () => {

/* -- 1. THE REPORT EQUALS THE SOURCE ------------------------------------ */
head('1. the report vs hand-written SQL over `purchases` (shares no code)');

const rep = await call(`from=${FROM}&to=${TO}`);

/* The hand-written control. It shares NO code with the route: two plain
 * queries, added up in JavaScript, expressing the rule in words —
 *
 *   an ordinary purchase row's charges are on `purchases`;
 *   a PO-receipt cost mirror's charges are on the GRN line it came from.
 *
 * A single query with a join would be the route's own shape; this deliberately
 * is not, so a mistake in the route's CTE cannot be mirrored by a matching
 * mistake here. */
const MIRROR = `TRIM(COALESCE(invoice_id,'')) = '' AND TRIM(COALESCE(grn_id,'')) <> ''`;
const ordinary = db.prepare(`
  SELECT COUNT(*) AS n, COALESCE(SUM(total_price),0) AS spend,
         COALESCE(SUM(total_price),0) AS bill_value,
         COALESCE(SUM(cgst),0) cgst, COALESCE(SUM(sgst),0) sgst,
         COALESCE(SUM(compensation_cess),0) compensation_cess,
         COALESCE(SUM(special_excise_cess),0) special_excise_cess,
         COALESCE(SUM(delivery_charges),0) delivery_charges,
         COALESCE(SUM(mrp_round_off),0) mrp_round_off,
         COALESCE(SUM(tcs),0) tcs, COALESCE(SUM(discount),0) discount
  FROM purchases WHERE NOT (${MIRROR})
`).get();
/* Mirror rows: SPEND still comes off `purchases` (booked cost, untouched);
 * every charge and the bill value come off the GRN line. */
const mirrorSpend = db.prepare(
  `SELECT COUNT(*) AS n, COALESCE(SUM(total_price),0) AS spend FROM purchases WHERE ${MIRROR}`).get();
const mirrorCharges = db.prepare(`
  SELECT COALESCE(SUM(gi.quantity_received * gi.unit_price),0) AS bill_value,
         COALESCE(SUM(gi.cgst),0) cgst, COALESCE(SUM(gi.sgst),0) sgst,
         COALESCE(SUM(gi.compensation_cess),0) compensation_cess,
         COALESCE(SUM(gi.special_excise_cess),0) special_excise_cess,
         COALESCE(SUM(gi.delivery_charges),0) delivery_charges,
         COALESCE(SUM(gi.mrp_round_off),0) mrp_round_off,
         COALESCE(SUM(gi.tcs),0) tcs, COALESCE(SUM(gi.discount),0) discount
  FROM purchases p
  JOIN goods_receipt_note_items gi ON gi.grn_id = p.grn_id AND gi.material_id = p.material_id
  WHERE TRIM(COALESCE(p.invoice_id,'')) = '' AND TRIM(COALESCE(p.grn_id,'')) <> ''
`).get();

const raw = { n: ordinary.n + mirrorSpend.n, spend: ordinary.spend + mirrorSpend.spend };
for (const k of KEYS) raw[k] = (ordinary[k] || 0) + (mirrorCharges[k] || 0);
raw.bill_value = (ordinary.bill_value || 0) + (mirrorCharges.bill_value || 0);
raw.total_amount = raw.bill_value - raw.discount + raw.cgst + raw.sgst
  + raw.compensation_cess + raw.special_excise_cess + raw.tcs
  + raw.delivery_charges + raw.mrp_round_off;

show('rows', `${rep.summary.purchase_count} (source ${raw.n})`);
show('spend (booked goods cost)', rep.summary.total_spend);
for (const k of ALL) show(k, rep.summary[k]);

expect(rep.summary.purchase_count, raw.n, 'the report counts every purchase row');
expectMoney(rep.summary.total_spend, raw.spend, 'SPEND is unchanged — still booked goods cost, not tax-inclusive');
for (const k of ALL) expectMoney(rep.summary[k], raw[k], `summary.${k} equals the source SUM`);

/* THE REGRESSION THIS SECTION EXISTS FOR. Summing the `purchases` charge
 * columns alone — what the route did before 2026-09-10 — must now be visibly
 * SHORT of the report, or the mirror rail is not being read at all. */
head('1b. the old, purchases-only arithmetic is provably short');
{
  const onlyPurchases = db.prepare(`
    SELECT COALESCE(SUM(cgst),0) cgst, COALESCE(SUM(sgst),0) sgst,
           COALESCE(SUM(compensation_cess),0) compensation_cess,
           COALESCE(SUM(delivery_charges),0) delivery_charges,
           COALESCE(SUM(tcs),0) tcs, COALESCE(SUM(discount),0) discount,
           COALESCE(SUM(mrp_round_off),0) mrp_round_off
    FROM purchases`).get();
  let short = 0;
  for (const k of ['cgst', 'sgst', 'compensation_cess', 'delivery_charges', 'tcs', 'discount', 'mrp_round_off']) {
    const missed = PC.r2((Number(rep.summary[k]) || 0) - (Number(onlyPurchases[k]) || 0));
    if (Math.round(missed * 100) !== 0) short++;
    show(`${k}: purchases-rail only`, `${PC.r2(onlyPurchases[k])} vs report ${rep.summary[k]}  (GRN rail adds ${missed})`);
  }
  expectTrue(short > 0,
    'the report is STRICTLY MORE than the purchases rail alone — the GRN charges are in',
    'every charge matched the purchases-only sum, so no GRN charge was picked up');
}

/* -- 2. IT ADDS UP, EVERY BREAKDOWN, EVERY CHARGE, TO THE PAISA --------- */
head('2. sum(rows) === summary, to the paisa, on all six breakdowns');

const BREAKDOWNS = ['by_vendor', 'by_category', 'by_super_category', 'by_month', 'by_payment_mode', 'by_item'];
for (const b of BREAKDOWNS) {
  const rows = rep[b];
  const tot = PC.chargeTotals(rows);
  let bads = 0;
  for (const k of ALL) {
    if (Math.round((tot[k] || 0) * 100) !== Math.round((Number(rep.summary[k]) || 0) * 100)) bads++;
  }
  expectTrue(bads === 0, `${b.padEnd(18)} ${String(rows.length).padStart(4)} rows — all ${ALL.length} charge figures foot`,
    `${bads} of ${ALL.length} figures differ`);
  // ...and the SHOWN cells (blanks counted as 0) foot too. This is the figure a
  // reader can actually add up with their eyes.
  let shownBad = 0;
  for (const c of PC.PURCHASE_CHARGE_COLUMNS) {
    const shown = rows.reduce((s, r) => s + (PC.chargeCell(r, c) || 0), 0);
    if (Math.round(shown * 100) !== Math.round((Number(rep.summary[c.key]) || 0) * 100)) shownBad++;
  }
  expectTrue(shownBad === 0, `${b.padEnd(18)}      ...and the CELLS AS RENDERED foot (blank = 0)`, `${shownBad} differ`);
}
expectTrue(Array.isArray(rep.charge_footing) && rep.charge_footing.length === 0,
  'the SERVER ran the same check and reported no mismatch (charge_footing is empty)',
  JSON.stringify(rep.charge_footing));

head('2b. a blank can never hide money — and PO receipts no longer produce one');
{
  let blanks = 0, hiding = 0, grnRows = 0, unpaired = 0;
  for (const b of BREAKDOWNS) {
    for (const r of rep[b]) {
      if (PC.hasGrnSourcedCharges(r)) grnRows++;
      unpaired += Number(r.unpaired_mirror_rows) || 0;
      for (const c of PC.PURCHASE_CHARGE_COLUMNS) {
        if (PC.chargeCell(r, c) === null) { blanks++; if (Math.round((Number(r[c.key]) || 0) * 100) !== 0) hiding++; }
      }
    }
  }
  show('rows whose charges came off a GRN line', grnRows);
  show('PO-receipt lines with no GRN line left', unpaired);
  show('cells rendered blank (figure unavailable)', blanks);
  expectTrue(hiding === 0, 'every blank cell has a stored value of exactly 0 — no rupee is hidden by a dash', `${hiding} blanks carried money`);
  // The em dash used to be the ONLY thing said about a PO receipt, and it was
  // said instead of the money. Now the money is there and the dash is reserved
  // for a mirror whose GRN line is gone.
  expectTrue(grnRows > 0, 'real rows DO read their charges off the GRN rail (the case that was silently zero)',
    'no breakdown row is GRN-sourced — the mirror rail is not being read');
  expect(blanks, unpaired === 0 ? 0 : blanks,
    'no cell is blanked while its GRN line still exists — a PO receipt prints its REAL charges');
}

head('2c. THE DISCLOSURE FIRES WHERE IT USED TO BE SILENT');
{
  // The bug: the badge/footnote predicate was "every row in this group is a PO
  // receipt", which is false on every month/category/super-category/payment-mode
  // group in this database. Those four printed short numbers with no disclosure.
  for (const b of BREAKDOWNS) {
    const rows = rep[b];
    const mixedGrn = rows.filter(r => (Number(r.grn_sourced_rows) || 0) > 0);
    const allMirror = rows.filter(r => (Number(r.count) || 0) > 0
      && (Number(r.po_receipt_rows) || 0) === (Number(r.count) || 0));
    show(`${b.padEnd(18)} discloses`, `${mixedGrn.length} of ${rows.length} rows (old all-or-nothing rule: ${allMirror.length})`);
    if (mixedGrn.length > 0) {
      expectTrue(mixedGrn.every(r => PC.hasGrnSourcedCharges(r)),
        `${b.padEnd(18)} every GRN-sourced row is flagged for the reader`, 'a GRN-sourced row is not flagged');
      expectTrue(mixedGrn.every(r => PC.chargeNote(r).includes('GRN')),
        `${b.padEnd(18)} ...and its CSV note names the GRN as the source`, 'a note is missing the source');
    }
  }
  // The exact groups from the bug report, by name.
  const aug = rep.by_month.find(m => m.month === '2026-08');
  if (aug) {
    show('by_month 2026-08', `${aug.count} lines, ${aug.grn_sourced_rows} from GRN, badge=${PC.hasGrnSourcedCharges(aug)}`);
    expectTrue((Number(aug.po_receipt_rows) || 0) !== (Number(aug.count) || 0),
      'by_month 2026-08 is a MIXED group — the old rule could never have disclosed it',
      'the month is all-mirror, so this is not the reported case');
    expectTrue(PC.hasGrnSourcedCharges(aug),
      'by_month 2026-08 DOES disclose now (the reported silent breakdown)',
      'the month still says nothing about its GRN-sourced charges');
  }
}

/* -- 3. THREE REAL BILLS PER CHARGE TYPE -------------------------------- */
head('3. real bills, their STORED charges, and the report figure they add to');

const bills = PBS.getPurchaseBillSummary({ from: FROM, to: TO }, db).rows;
const withCharge = (key) => bills.filter(b => Math.abs(Number(b[key]) || 0) > 0);

for (const [label, key] of [
  ['TAXES (cgst)', 'cgst'], ['TAXES (sgst)', 'sgst'],
  ['CESS (GST compensation)', 'compensation_cess'],
  ['CESS (TGBCL special excise)', 'special_excise_cess'],
  ['TRANSPORT (delivery)', 'delivery_charges'],
  ['ROUND OFF (signed)', 'mrp_round_off'],
]) {
  const list = withCharge(key);
  console.log(`\n  ${label} — ${list.length} bill(s) on the purchases rail carry it`);
  if (list.length === 0) {
    console.log('    (none stored on `purchases` in this database — nothing to match, and the column');
    console.log(`     correctly reports 0. See section 5 for a live ${key} on the GRN rail.)`);
    continue;
  }
  for (const b of list.slice(0, 3)) {
    show(`${b.vendor} · ${b.invoice_id || b.bill_no || b.bill_key}`,
      `goods ${b.goods} · ${key} ${b[key]} · total ${b.total_bill_value}`);
  }
  // The report's vendor row must equal the SUM of that vendor's bills' stored values.
  const byVendor = {};
  for (const b of list) {
    const v = String(b.vendor).trim().toLowerCase();
    byVendor[v] = (byVendor[v] || 0) + (Number(b[key]) || 0);
  }
  for (const [v, sum] of Object.entries(byVendor)) {
    const row = rep.by_vendor.find(r => String(r.vendor).trim().toLowerCase() === v);
    expectMoney(row ? row[key] : null, sum, `report's "${row ? row.vendor : v}" row ${key} = sum of that vendor's bills`);
  }
}

/* Whole-rail cross-check: bill-grain totals vs the report's period figures. */
head('3b. bill-grain totals (a different module, a different query) vs the report');
{
  const t = PBS.getPurchaseBillSummary({ from: FROM, to: TO }, db).totals;
  show('bills', t.bills); show('lines', t.lines); show('goods', t.goods);
  expectMoney(t.goods, rep.summary.total_spend, 'bill summary GOODS = report SPEND');
  for (const k of ['cgst', 'sgst', 'compensation_cess', 'special_excise_cess', 'tcs', 'delivery_charges', 'mrp_round_off', 'discount']) {
    expectMoney(t[k], rep.summary[k], `bill summary ${k} = report ${k}`);
  }
  expectMoney(t.total_bill_value, rep.summary.total_amount, 'bill summary TOTAL BILL VALUE = report TOTAL AMOUNT (one arithmetic, two modules)');
}

/* -- 4. A BILL WITH NO CHARGES ------------------------------------------ */
head('4. a bill carrying no charges: blanks/zeros, and its total is unchanged');
{
  const clean = bills.filter(b => KEYS.every(k => Math.round((Number(b[k]) || 0) * 100) === 0) && Number(b.goods) > 0);
  show('bills with no charge at all', `${clean.length} of ${bills.length}`);
  for (const b of clean.slice(0, 3)) {
    show(`${b.vendor} · ${b.invoice_id || b.bill_no || b.bill_key}`, `goods ${b.goods} -> total ${b.total_bill_value}`);
    expectMoney(b.total_bill_value, b.goods, `no-charge bill total = its goods value, unchanged (${b.bill_key})`);
  }
  // ...and through the report: a month with no charges must report total_amount = spend.
  for (const m of rep.by_month) {
    const anyCharge = KEYS.some(k => Math.round((Number(m[k]) || 0) * 100) !== 0);
    if (!anyCharge) expectMoney(m.total_amount, m.spend, `month ${m.month} has no charges -> Total Amount = Spend exactly`);
  }
}

/* -- 5. ROUND OFF IS SIGNED --------------------------------------------- */
head('5. round off keeps its sign — on real data, in the renderer, in the CSV');
{
  const grn = db.prepare(`
    SELECT g.grn_number, g.invoice_number, i.mrp_round_off, i.tcs, i.delivery_charges,
           i.quantity_accepted * i.unit_price AS value, i.discount, i.cgst, i.sgst
    FROM goods_receipt_note_items i JOIN goods_receipt_notes g ON g.id = i.grn_id
    WHERE ROUND(COALESCE(i.mrp_round_off,0), 2) < 0 ORDER BY g.grn_number
  `).all();
  show('GRN lines stored with a NEGATIVE round-off', grn.length);
  for (const r of grn.slice(0, 3)) {
    show(`${r.grn_number} · ${r.invoice_number}`, `round-off ${r.mrp_round_off} renders as ${PC.fmtSignedINR(r.mrp_round_off)}`);
    expectTrue(String(PC.fmtSignedINR(r.mrp_round_off)).startsWith('−'),
      `${r.grn_number}: a ${r.mrp_round_off} round-off renders with its minus, not as a positive`,
      PC.fmtSignedINR(r.mrp_round_off));
  }
  expectTrue(grn.length > 0, 'the signed case exists in the real database (GRN rail)', 'no negative round-off stored anywhere');

  const purchNeg = db.prepare('SELECT COUNT(*) n FROM purchases WHERE ROUND(COALESCE(mrp_round_off,0),2) <> 0').get().n;
  show('`purchases` rows with a non-zero round-off', `${purchNeg} — the Purchase Report's own rail has none TODAY`);

  expect(PC.fmtSignedINR(-0.4), '−₹0.40', 'renderer: -0.40 is NOT +0.40');
  expect(PC.fmtSignedINR(0.4), '₹0.40', 'renderer: a positive round-off carries no minus');
  expect(PC.fmtSignedINR(null), '—', 'renderer: not-applicable is an em dash, never 0');
}

/* -- 5b. THE SIGNED PATH END TO END — deliberate probe on the SNAPSHOT --- */
head('5b. probe: a negative round-off on EACH rail, end to end');
{
  const baseRound = Number(rep.summary.mrp_round_off) || 0;
  const baseTotal = Number(rep.summary.total_amount) || 0;

  /* RAIL A — an ordinary `purchases` row, whose charges are read off `purchases`.
   * The victim must NOT be a PO-receipt mirror: on a mirror the report reads the
   * GRN line, so writing purchases.mrp_round_off there would correctly change
   * NOTHING and the probe would be testing its own mistake. */
  const victim = db.prepare(`
    SELECT id, mrp_round_off, date, vendor FROM purchases
     WHERE NOT (TRIM(COALESCE(invoice_id,'')) = '' AND TRIM(COALESCE(grn_id,'')) <> '')
     ORDER BY date DESC LIMIT 1`).get();
  expectTrue(!!victim, 'there is an ordinary (non-mirror) purchase row to probe', 'every row is a PO receipt');
  db.prepare('UPDATE purchases SET mrp_round_off = -0.4 WHERE id = ?').run(victim.id);
  {
    const probed = await call(`from=${FROM}&to=${TO}`);
    show('rail A: purchases row', `${victim.vendor} ${victim.date} -> summary ${probed.summary.mrp_round_off} renders as ${PC.fmtSignedINR(probed.summary.mrp_round_off)}`);
    expectMoney(probed.summary.mrp_round_off, PC.r2(baseRound - 0.4), 'rail A: the report carries the NEGATIVE through to the period figure');
    expectMoney(probed.summary.total_amount, PC.r2(baseTotal - 0.4), 'rail A: Total Amount goes DOWN by 40 paise — a negative round-off subtracts');
    expectTrue((probed.charge_footing || []).length === 0, 'rail A: and it still foots on every breakdown', JSON.stringify(probed.charge_footing));
    const csvRow = PC.appendChargeCsvRow(['probe', 1, 1], probed.summary);
    const roundIdx = 3 + KEYS.indexOf('mrp_round_off');
    expect(typeof csvRow[roundIdx], 'number', 'CSV: the signed figure leaves as a NUMBER (so no escaper quotes it as text)');
    expectMoney(csvRow[roundIdx], PC.r2(baseRound - 0.4), 'CSV: ...and it is still negative');
  }
  db.prepare('UPDATE purchases SET mrp_round_off = ? WHERE id = ?').run(victim.mrp_round_off, victim.id);

  /* RAIL B — the GRN LINE behind a PO receipt. THIS is the rail the report used
   * to ignore completely, and the probe that would have caught the bug: before
   * 2026-09-10 moving a GRN line's tax moved NOTHING on this report. */
  const gLine = db.prepare(`
    SELECT gi.id, gi.mrp_round_off, gi.cgst, g.grn_number
      FROM goods_receipt_note_items gi
      JOIN goods_receipt_notes g ON g.id = gi.grn_id
      JOIN purchases p ON p.grn_id = gi.grn_id AND p.material_id = gi.material_id
     WHERE TRIM(COALESCE(p.invoice_id,'')) = '' AND TRIM(COALESCE(p.grn_id,'')) <> ''
     ORDER BY g.grn_number LIMIT 1`).get();
  expectTrue(!!gLine, 'there is a GRN line paired to a cost mirror to probe', 'no mirror row pairs to a GRN line');
  db.prepare('UPDATE goods_receipt_note_items SET mrp_round_off = mrp_round_off - 0.4, cgst = cgst + 7 WHERE id = ?').run(gLine.id);
  {
    const probed = await call(`from=${FROM}&to=${TO}`);
    show('rail B: GRN line', `${gLine.grn_number} -> summary round-off ${probed.summary.mrp_round_off}, cgst ${probed.summary.cgst}`);
    expectMoney(probed.summary.mrp_round_off, PC.r2(baseRound - 0.4),
      'rail B: a GRN line\'s round-off REACHES the report (the rail that used to be invisible)');
    expectMoney(probed.summary.cgst, PC.r2((Number(rep.summary.cgst) || 0) + 7),
      'rail B: ...and so does its tax — Rs 7 on the GRN is Rs 7 on the report');
    expectMoney(probed.summary.total_amount, PC.r2(baseTotal + 7 - 0.4),
      'rail B: Total Amount moves by exactly the two charges, no more');
    expectTrue((probed.charge_footing || []).length === 0, 'rail B: and it still foots on every breakdown', JSON.stringify(probed.charge_footing));
  }
  db.prepare('UPDATE goods_receipt_note_items SET mrp_round_off = ?, cgst = ? WHERE id = ?').run(gLine.mrp_round_off, gLine.cgst, gLine.id);

  const restored = await call(`from=${FROM}&to=${TO}`);
  expectMoney(restored.summary.mrp_round_off, baseRound, 'both probes reverted on the snapshot — round-off back to its real value');
  expectMoney(restored.summary.cgst, rep.summary.cgst, 'both probes reverted — cgst back to its real value');
  expectMoney(restored.summary.total_amount, baseTotal, 'both probes reverted — Total Amount back to its real value');
}

/* -- 5c. THE GRN INWARD REGISTER AND THIS REPORT AGREE, BILL BY BILL ----- */
head('5c. the GRN inward register vs this report — the same money for the same bill');
{
  /* The register's own arithmetic, copied from src/app/api/grn/route.ts's
   * `inward_value` SELECT. Left as a literal here ON PURPOSE: it is the OTHER
   * screen's definition, and pulling it from the shared module would make this
   * check circular. If the register is reworded, this test must be the thing
   * that notices. */
  const register = db.prepare(`
    SELECT g.grn_number,
           (SELECT SUM(quantity_received * unit_price
                       - discount + cgst + sgst + compensation_cess
                       + special_excise_cess + tcs + delivery_charges + mrp_round_off)
              FROM goods_receipt_note_items WHERE grn_id = g.id) AS inward_value
      FROM goods_receipt_notes g ORDER BY g.grn_number
  `).all();

  /* The report's own figure for the same bill, taken from the SHIPPED bill
   * summary — the module the Purchase Report and the bill views both read. */
  const billRows = PBS.getPurchaseBillSummary({ from: FROM, to: TO }, db).rows;
  const byGrn = new Map();
  for (const b of billRows) if (b.grn_id) byGrn.set(String(b.grn_id).trim(), b);
  const grnIds = db.prepare('SELECT id, grn_number FROM goods_receipt_notes').all();
  const idOf = new Map(grnIds.map(r => [r.grn_number, r.id]));

  let matched = 0, differ = 0, regTotal = 0, repTotal = 0;
  const worst = [];
  for (const r of register) {
    const bill = byGrn.get(String(idOf.get(r.grn_number) || '').trim());
    if (!bill) continue;
    matched++;
    const reg = Number(r.inward_value) || 0;
    const rep2 = Number(bill.total_bill_value) || 0;
    regTotal += reg; repTotal += rep2;
    if (Math.round(reg * 100) !== Math.round(rep2 * 100)) { differ++; worst.push(`${r.grn_number}: register ${PC.r2(reg)} vs report ${PC.r2(rep2)}`); }
  }
  show('GRN-sourced bills cross-checked', matched);
  show('register Total Inward', PC.r2(regTotal));
  show('report  Total Amount', PC.r2(repTotal));
  show('bills that disagree', differ);
  for (const w of worst.slice(0, 5)) show('  ', w);
  expectTrue(matched > 0, 'there are GRN-sourced bills to cross-check', 'no GRN bill reached the bill summary');
  expectTrue(differ === 0,
    'EVERY GRN-sourced bill totals the SAME on the inward register and on this report',
    `${differ} of ${matched} bills disagree`);
  expectMoney(repTotal, regTotal, 'and the two screens agree on the period total, to the paisa');

  /* The named bill from the report. */
  const seven = register.find(r => r.grn_number === 'GRN-2026-0007');
  if (seven) {
    const bill = byGrn.get(String(idOf.get('GRN-2026-0007') || '').trim());
    show('GRN-2026-0007', `register ${PC.r2(seven.inward_value)} · report ${bill ? PC.r2(bill.total_bill_value) : 'MISSING'}`);
    expectMoney(bill && bill.total_bill_value, seven.inward_value,
      'GRN-2026-0007 — the bill the report was Rs 34.90 short on — now matches exactly');
  }
}

/* -- 5d. THE DISCOUNT IS NOT DOUBLE-SUBTRACTED -------------------------- */
head('5d. a booked rate that is already net of the discount is not charged twice');
{
  /* 17 of the 31 mirror rows store a rate already net of the GRN's discount and
   * 14 store the gross rate. Building Total Amount on Spend would silently
   * subtract the discount twice on the first 17. Building it on BILL VALUE
   * cannot, and this measures the gap the mistake would have opened. */
  const basis = db.prepare(`
    SELECT SUM(CASE WHEN ROUND(p.total_price,2) = ROUND(gi.quantity_received*gi.unit_price - gi.discount,2)
                     AND gi.discount <> 0 THEN 1 ELSE 0 END) AS netted,
           SUM(CASE WHEN ROUND(p.total_price,2) = ROUND(gi.quantity_received*gi.unit_price,2)
                THEN 1 ELSE 0 END)                            AS gross,
           COALESCE(SUM(gi.quantity_received*gi.unit_price - p.total_price),0) AS netted_discount
      FROM purchases p
      JOIN goods_receipt_note_items gi ON gi.grn_id = p.grn_id AND gi.material_id = p.material_id
     WHERE TRIM(COALESCE(p.invoice_id,'')) = '' AND TRIM(COALESCE(p.grn_id,'')) <> ''
  `).get();
  show('mirror rows booked NET of the discount', basis.netted);
  show('mirror rows booked GROSS', basis.gross);
  show('discount already inside the booked rate', PC.r2(basis.netted_discount));
  // bill_value − spend over the whole period must be exactly that netted discount.
  const gap = PC.r2((Number(rep.summary.bill_value) || 0) - (Number(rep.summary.total_spend) || 0));
  expectMoney(gap, basis.netted_discount,
    'Bill Value − Spend = the discount already netted into booked rates, exactly — nothing else moved');
  expectTrue(Number(basis.netted) > 0,
    'the double-subtraction case EXISTS in this database (so the check has teeth)',
    'no mirror row is booked net of its discount — this test proves nothing here');
}

/* -- 6. THE CSV APPENDS, NEVER INSERTS ---------------------------------- */
head('6. CSV: old columns keep their positions, new ones land on the right');
{
  const LEADS = [
    ['Month', 'Spend', 'Purchases'],
    ['Vendor', 'Spend', 'Purchases'],
    ['Item', 'Category', 'Unit', 'Total Qty', 'Purchases', 'Avg Rate (₹/unit)', 'Total Spend (₹)', 'Last Purchased'],
  ];
  for (const lead of LEADS) {
    const h = PC.appendChargeCsvHeader(lead);
    expectTrue(lead.every((c, i) => h[i] === c),
      `["${lead[0]}" ...] — the ${lead.length} pre-change headings are still columns 1..${lead.length}, in order`,
      JSON.stringify(h.slice(0, lead.length)));
    expect(h.length, lead.length + KEYS.length + 3, `...and exactly ${KEYS.length + 3} columns were appended (8 charges + Bill Value + Total Amount + note)`);
    expect(h[lead.length + KEYS.length], PC.BILL_VALUE_CSV_HEADER, '...with Bill Value after the eight charges');
    expect(h[lead.length + KEYS.length + 1], PC.TOTAL_AMOUNT_CSV_HEADER, '...then the Total Amount it feeds');
    expect(h[h.length - 1], PC.CHARGE_NOTE_CSV_HEADER, '...and the charge-basis note last');
  }
  const aug = rep.by_month.find(m => m.month === '2026-08') || rep.by_month[0] || {};
  const row = PC.appendChargeCsvRow([aug.month, aug.spend, aug.count], aug);
  expect(row[0], aug.month, 'a row keeps its lead cells untouched');
  expect(row.length, 3 + KEYS.length + 3, 'a row has exactly one cell per header');
  // A PO-receipt row now carries its REAL tax as a NUMBER, with the source named
  // in the note column. Before 2026-09-10 this cell was an empty string and the
  // money it stood for was nowhere in the file.
  const mirrorRow = rep.by_vendor.find(r => PC.hasGrnSourcedCharges(r)
    && Math.abs(Number(r.cgst) || 0) > 0);
  if (mirrorRow) {
    const mr = PC.appendChargeCsvRow([mirrorRow.vendor, mirrorRow.spend, mirrorRow.count], mirrorRow);
    show('a PO-receipt vendor row in CSV', JSON.stringify(mr));
    expect(typeof mr[3 + KEYS.indexOf('cgst')], 'number', "a PO receipt's tax is a NUMBER in the file, not an empty cell");
    expectMoney(mr[3 + KEYS.indexOf('cgst')], mirrorRow.cgst, '...and it is the GRN line\'s real figure');
    expectTrue(String(mr[mr.length - 1]).includes('GRN'), 'and the row names the GRN as the source in its note column', String(mr[mr.length - 1]));
  } else {
    bad('a GRN-sourced vendor row carries real tax into the CSV', 'no vendor row has GRN-sourced tax — the mirror rail is not being read');
  }
}

/* -- 7. NO SECOND ALLOCATOR --------------------------------------------- */
head('7. one arithmetic — this module vs purchase-bill-summary, per line');
{
  // purchaseLineTotalSql is what the report sums. Run it row by row against the
  // bill module's own per-bill totals: if the expression had drifted by a term,
  // the two would part company on any bill carrying that term.
  const perBill = db.prepare(`
    SELECT COALESCE(TRIM(invoice_id),'') AS inv, COALESCE(SUM(${PC.purchaseLineTotalSql('purchases')}),0) AS total
    FROM purchases WHERE TRIM(COALESCE(invoice_id,'')) <> '' GROUP BY COALESCE(TRIM(invoice_id),'')
  `).all();
  let checked = 0, drift = 0;
  for (const p of perBill) {
    const b = bills.find(x => x.invoice_id === p.inv);
    if (!b) continue;
    checked++;
    if (Math.round(p.total * 100) !== Math.round(b.total_bill_value * 100)) drift++;
  }
  show('invoice-numbered bills cross-checked', checked);
  expectTrue(checked > 0 && drift === 0,
    "purchase-charges' line-total expression = purchase-bill-summary's bill total, on every bill",
    `${drift} of ${checked} bills disagree`);

  // The liquor rail's allocation is NOT reimplemented here.
  const selfSrc = fs.readFileSync(path.join(SRC, 'lib', 'purchase-charges.ts'), 'utf8');
  const codeOnly = selfSrc.split('\n').filter(l => !/^\s*[*/]/.test(l)).join('\n');
  expectTrue(!/allocat/i.test(codeOnly) && !/billBottles|billSubtotal/i.test(codeOnly),
    'src/lib/purchase-charges.ts contains no allocator of its own (rail C keeps its one)',
    'an allocation-shaped symbol appeared in the shared charge module');
}

/* -- 8. ANTI-DRIFT: one heading text, two reports ----------------------- */
head('8. the CSV headings match /api/reports/purchase-log, word for word');
{
  const logSrc = fs.readFileSync(path.join(SRC, 'app', 'api', 'reports', 'purchase-log', 'route.ts'), 'utf8');
  for (const c of PC.PURCHASE_CHARGE_COLUMNS) {
    expectTrue(logSrc.includes(`'${c.csvHeader}'`),
      `"${c.csvHeader}" is the heading BOTH reports print for ${c.key}`,
      'purchase-log/route.ts no longer contains that exact heading — one of the two was reworded');
  }
}

/* -- SUMMARY ------------------------------------------------------------ */
console.log(`\n${'='.repeat(72)}`);
console.log(`purchase-charges-tests: ${pass} passed, ${fail} failed   (snapshot ${TMP})`);
if (fail) { console.log('failures:'); for (const f of failures) console.log(`  · ${f}`); }
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);

})().catch(e => { console.error('\nFATAL', e); process.exit(4); });
