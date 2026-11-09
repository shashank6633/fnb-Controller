/**
 * BREWERY DASHBOARD — owner ruling 122 (2026-11-09) — THE PROOF.
 *
 *   npx tsx scripts/brewery-dashboard-tests.ts <dir holding a COPY of fnb-controller.db>
 *
 * RUNS ON A HARNESS COPY ONLY (same guard as brewery-dept-tests.ts): the
 * directory must sit under a `harness/` directory and must not be this
 * worktree; the script chdirs there BEFORE db.ts loads. It EMPTIES the copy's
 * production_batches / batch_transactions so every figure below is exact.
 *
 * DASH_ROUTE=<path to another dashboard route.ts> runs the same checks against
 * that route — point it at origin/main's to watch the Kitchen-view checks FAIL
 * (beer mixed into the Kitchen totals, Brewery view not refused).
 *
 * Proves, with the real route handler (next/headers stubbed to the test
 * user's session):
 *   A  Kitchen view (no kind = kind=kitchen) counts Kitchen batches only, for
 *      everyone — beer litres never join a Kitchen item's litres.
 *   B  Brewery view counts Brewery batches only; admin / manager / HOD get it,
 *      staff get 403 with no figures; bad kind → 400; signed out → 401.
 *   C  Kitchen + Brewery add up to the whole floor (nothing lost, nothing
 *      counted twice).
 *   A9/B7 also prove the FIFO Compliance fix (owner's call, 2026-11-09): the
 *      active-batch query never selected production_date / _time, so the KPI
 *      read 100% whatever happened; origin/main's route returns 100 here.
 *   D  Page access: /brewery-production/dashboard is mgmtOnly and agrees with
 *      canSeeBeerQuantities for every kind of user; a Brewery Production grant
 *      does not open it to staff; sidebar + catalog twins present.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const Module = require('module');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(String(process.argv[2] || ''));
const WT = path.resolve(__dirname, '..');
if (!dir || !fs.existsSync(path.join(dir, 'fnb-controller.db'))) {
  console.error('usage: npx tsx scripts/brewery-dashboard-tests.ts <dir holding a COPY of fnb-controller.db>');
  process.exit(2);
}
if (!dir.split(path.sep).includes('harness') || path.resolve(dir) === WT) {
  console.error(`refusing: ${dir} is not a harness copy (it must sit under a harness/ directory, never the worktree).`);
  process.exit(2);
}
const STUB = path.join(dir, 'next-headers-stub.cjs');
fs.writeFileSync(STUB, `
function jar() { const t = globalThis.__TOKEN; return {
  get: (n) => (n === 'fnb_session' && t ? { name: n, value: t } : undefined),
  getAll: () => (t ? [{ name: 'fnb_session', value: t }] : []), has: (n) => n === 'fnb_session' && !!t, set() {}, delete() {} }; }
exports.cookies = async () => jar();
exports.headers = async () => new Headers({ 'x-forwarded-for': '127.0.0.1' });
exports.draftMode = async () => ({ isEnabled: false });
`);
const prevResolve = Module._resolveFilename;
Module._resolveFilename = function (req: string, ...rest: unknown[]) {
  if (req === 'next/headers') return STUB;
  return prevResolve.call(this, req, ...rest);
};
process.chdir(dir);

let pass = 0;
const fails: string[] = [];
const ok = (cond: unknown, label: string) => { if (cond) pass++; else { fails.push(label); console.log(`  FAIL ${label}`); } };
const eq = (a: unknown, b: unknown, label: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${label} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

(async () => {
  const { getDb } = require(path.join(WT, 'src/lib/db.ts'));
  const { todayIST, fmtISTIsoDate } = require(path.join(WT, 'src/lib/format-date.ts'));
  const BB = require(path.join(WT, 'src/lib/brewery-beer.ts'));
  const PC = require(path.join(WT, 'src/lib/page-catalog.ts'));
  const ROUTE = process.env.DASH_ROUTE ? path.resolve(WT, process.env.DASH_ROUTE) : path.join(WT, 'src/app/api/kitchen-production/dashboard/route.ts');
  console.log(`route under test: ${ROUTE}`);
  const dash = require(ROUTE);
  const db = getDb();
  const TODAY = todayIST();
  const dayOff = (n: number) => fmtISTIsoDate(new Date(Date.now() + n * 86400000));
  const uid = () => `zzbd-${Math.random().toString(36).slice(2, 10)}`;
  const nowUtc = (db.prepare(`SELECT datetime('now') AS t`).get() as any).t as string;

  // ── Seed (copy only) ─────────────────────────────────────────────────
  db.prepare('DELETE FROM batch_transactions').run();
  db.prepare('DELETE FROM production_batches').run();
  const LAGER = uid(), GRAVY = uid(), SOUP = uid();
  const insItem = db.prepare(`INSERT INTO production_items (id, name, category, unit, shelf_life_hours, is_active, is_brewery)
                              VALUES (?,?,?,?,0,1,?)`);
  insItem.run(LAGER, 'ZZ Dash Lager', 'Beer', 'L', 1);
  insItem.run(GRAVY, 'ZZ Dash Gravy', 'Gravy', 'kg', 0);
  insItem.run(SOUP, 'ZZ Dash Soup', 'Soup', 'L', 0);      // a KITCHEN item in litres, beside the beer
  const mats = db.prepare('SELECT id FROM raw_materials LIMIT 2').all() as { id: string }[];
  const M_BEER = mats[0].id, M_GRAVY = mats[1].id;
  db.prepare(`UPDATE raw_materials SET unit='L', purchase_unit='L', pack_size=1, reorder_level=1000 WHERE id=?`).run(M_BEER);
  db.prepare(`UPDATE raw_materials SET unit='kg', purchase_unit='kg', pack_size=1, reorder_level=1000 WHERE id=?`).run(M_GRAVY);

  const insBatch = db.prepare(`INSERT INTO production_batches (id, batch_number, barcode, item_name, category, production_item_id, material_id,
                                 production_date, production_time, expiry_date, expiry_time, quantity_produced, quantity_consumed, unit, status)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const B1 = uid(), B2 = uid(), B3 = uid(), K1 = uid(), K2 = uid(), K3 = uid(), K4 = uid();
  //               id  batch#      barcode       name             cat      item   material  prod date     time    expiry       time   prod cons unit status
  insBatch.run(B1, 'ZZB-001', 'PROD991001', 'ZZ Dash Lager', 'Beer', LAGER, null,    dayOff(-9), '08:00', dayOff(-1), '10:00', 300, 0,  'L', 'active');
  insBatch.run(B2, 'ZZB-002', 'PROD991002', 'ZZ Dash Lager', 'Beer', LAGER, M_BEER,  TODAY,      '08:00', dayOff(5),  '10:00', 500, 90, 'L', 'active');
  insBatch.run(B3, 'ZZB-003', 'PROD991003', 'ZZ Dash Lager', 'Beer', LAGER, null,    dayOff(-20), '08:00', dayOff(9), '10:00', 100, 100, 'L', 'consumed');
  insBatch.run(K1, 'ZZK-001', 'PROD991004', 'ZZ Dash Gravy', 'Gravy', GRAVY, M_GRAVY, dayOff(-3), '08:00', dayOff(-1), '11:00', 10, 2, 'kg', 'active');
  insBatch.run(K2, 'ZZK-002', 'PROD991005', 'ZZ Dash Soup', 'Soup', SOUP, null,      TODAY,      '08:00', dayOff(5),  '11:00', 20, 4, 'L', 'active');
  insBatch.run(K3, 'ZZK-003', 'PROD991006', 'ZZ Legacy NoItem', 'Misc', null, null,  TODAY,      '08:00', dayOff(5),  '12:00', 5, 0, 'pcs', 'active');
  insBatch.run(K4, 'ZZK-004', 'PROD991007', 'ZZ Dash Gravy', 'Gravy', GRAVY, null,   dayOff(-1), '08:00', dayOff(9),  '11:00', 6, 6, 'kg', 'consumed');
  const insTx = db.prepare(`INSERT INTO batch_transactions (id, batch_id, type, quantity, balance_quantity, user, created_at) VALUES (?,?,?,?,?,?,?)`);
  // today (UTC now = IST today)
  insTx.run(uid(), B2, 'created', 500, 500, 't', nowUtc);
  insTx.run(uid(), B2, 'printed', 1, 500, 't', nowUtc);
  insTx.run(uid(), B2, 'reprinted', 1, 500, 't', nowUtc);
  insTx.run(uid(), B2, 'consumed', 40, 460, 't', nowUtc);
  insTx.run(uid(), B2, 'wasted', 50, 410, 't', nowUtc);
  insTx.run(uid(), K2, 'created', 20, 20, 't', nowUtc);
  insTx.run(uid(), K2, 'printed', 1, 20, 't', nowUtc);
  insTx.run(uid(), K2, 'consumed', 3, 17, 't', nowUtc);
  insTx.run(uid(), K2, 'wasted', 1, 16, 't', nowUtc);
  insTx.run(uid(), K1, 'created', 10, 10, 't', nowUtc);
  insTx.run(uid(), K1, 'consumed', 2, 8, 't', nowUtc);

  const mkUser = (label: string, role: string, head: number, pageAccess: string | null) => {
    const id = uid();
    db.prepare(`INSERT INTO users (id, email, password_hash, name, role, is_active, is_head_chef, is_store_manager, can_approve_requisitions, page_access)
                VALUES (?,?, 'x', ?, ?, 1, ?, 0, 0, ?)`).run(id, `${id}@test.local`, label, role, head, pageAccess);
    const tok = `tok-${id}`;
    db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01 00:00:00')`).run(tok, id);
    return { id, tok, label };
  };
  const ADMIN = mkUser('ZZ Admin', 'admin', 0, null);
  const MGR = mkUser('ZZ Manager', 'manager', 0, null);
  const HOD = mkUser('ZZ HOD', 'staff', 1, null);
  const STAFF = mkUser('ZZ Staff', 'staff', 0, null);
  const BREWER = mkUser('ZZ Brewer (staff, Brewery Production ticked)', 'staff', 0, JSON.stringify(['/brewery-production']));
  const as = (u: { tok: string } | null) => { (globalThis as any).__TOKEN = u ? u.tok : undefined; };
  const get = async (q: string) => {
    const res: Response = await dash.GET(new Request(`http://t/api/kitchen-production/dashboard${q}`));
    return { status: res.status, j: await res.json() };
  };
  const BREW_NOS = ['ZZB-001', 'ZZB-002', 'ZZB-003'];

  // ── A. Kitchen view — Kitchen batches only, for everyone ─────────────
  console.log('A. Kitchen view');
  for (const u of [ADMIN, MGR, HOD, STAFF, BREWER]) {
    as(u);
    const none = await get('');
    const kit = await get('?kind=kitchen');
    ok(none.status === 200 && kit.status === 200, `A1 ${u.label}: 200 (${none.status}/${kit.status})`);
    eq(JSON.stringify(none.j.widgets) === JSON.stringify(kit.j.widgets), true, `A2 ${u.label}: no kind = kind=kitchen`);
    const w = kit.j.widgets || {};
    eq(w.today_consumption_by_unit, [{ unit: 'l', qty: 3 }, { unit: 'kg', qty: 2 }], `A3 ${u.label}: consumption = soup 3 L + gravy 2 kg, NO beer litres`);
    eq(w.today_consumption_qty, 5, `A4 ${u.label}: legacy scalar has no beer`);
    eq([w.waste_pct, w.waste_pct_unit, w.waste_pct_by_unit], [5, 'l', [{ unit: 'l', pct: 5 }, { unit: 'kg', pct: 0 }]],
      `A5 ${u.label}: waste % = soup 1/20 L, gravy 0 kg — beer waste left out`);
    eq([w.expired, w.expiring_7d, w.expiring_3d], [1, 2, 0], `A6 ${u.label}: expiry tiles count Kitchen batches only`);
    eq([w.active_batches, w.total_batches, w.today_production], [3, 4, 2], `A7 ${u.label}: batch counts Kitchen only (no-item batch is Kitchen)`);
    eq(w.labels_printed_today, 1, `A8 ${u.label}: labels printed Kitchen only`);
    eq(w.fifo_compliance_pct, 66.7, `A9 ${u.label}: FIFO = Kitchen chains only (2 of 3)`);
    eq(w.low_stock_alerts, 1, `A10 ${u.label}: low stock = the gravy material only`);
    const soonNos = (kit.j.expiring_soon || []).map((r: any) => r.batch_number);
    ok(soonNos.length > 0 && !soonNos.some((n: string) => BREW_NOS.includes(n)), `A11 ${u.label}: expiring-soon list has no beer (${soonNos.join(',')})`);
  }

  // ── B. Brewery view — admin / manager / HOD only ────────────────────
  console.log('B. Brewery view');
  for (const u of [ADMIN, MGR, HOD]) {
    as(u);
    const r = await get('?kind=brewery');
    const w = r.j.widgets || {};
    ok(r.status === 200 && r.j.kind === 'brewery', `B1 ${u.label}: 200 kind=brewery (${r.status})`);
    eq(w.today_consumption_by_unit, [{ unit: 'l', qty: 40 }], `B2 ${u.label}: beer used today 40 L`);
    eq(w.today_consumption_qty, 40, `B3 ${u.label}: legacy scalar = beer only`);
    eq([w.waste_pct, w.waste_pct_unit], [10, 'l'], `B4 ${u.label}: beer waste 50/500 L`);
    eq([w.expired, w.expiring_7d, w.expiring_3d], [1, 1, 0], `B5 ${u.label}: expiry tiles count Brewery batches only`);
    eq([w.active_batches, w.total_batches, w.today_production, w.labels_printed_today], [2, 3, 1, 2], `B6 ${u.label}: batch counts Brewery only`);
    eq(w.fifo_compliance_pct, 50, `B7 ${u.label}: FIFO — B2 drawn while older B1 sits full; oldest B3 fine (1 of 2)`);
    eq(w.low_stock_alerts, 1, `B8 ${u.label}: low stock = the beer material only`);
    const soonNos = (r.j.expiring_soon || []).map((x: any) => x.batch_number);
    ok(soonNos.length > 0 && soonNos.every((n: string) => BREW_NOS.includes(n)), `B9 ${u.label}: expiring-soon list is beer only (${soonNos.join(',')})`);
  }
  for (const u of [STAFF, BREWER]) {
    as(u);
    const r = await get('?kind=brewery');
    ok(r.status === 403 && !('widgets' in r.j) && !('expiring_soon' in r.j), `B10 ${u.label}: 403, no figures (${r.status} ${JSON.stringify(r.j)})`);
  }
  as(ADMIN);
  ok((await get('?kind=bogus')).status === 400, 'B11 unknown kind → 400');
  ok((await get('?kind=Brewery')).status === 400, 'B12 kind is exact (no silent Kitchen for a typo)');
  as(null);
  ok((await get('?kind=brewery')).status === 401 && (await get('')).status === 401, 'B13 signed out → 401 on both views');

  // ── C. Kitchen + Brewery = the whole floor ───────────────────────────
  console.log('C. partition');
  as(ADMIN);
  const k = (await get('?kind=kitchen')).j.widgets, b = (await get('?kind=brewery')).j.widgets;
  const c = (sql: string) => Number((db.prepare(sql).get() as any).c);
  eq(k.active_batches + b.active_batches, c(`SELECT COUNT(*) c FROM production_batches WHERE status='active'`), 'C1 active batches add up');
  eq(k.total_batches + b.total_batches, c(`SELECT COUNT(*) c FROM production_batches`), 'C2 total batches add up');
  eq(k.today_consumption_qty + b.today_consumption_qty, c(`SELECT SUM(quantity) c FROM batch_transactions WHERE type='consumed'`), 'C3 consumption adds up');
  eq(k.labels_printed_today + b.labels_printed_today, c(`SELECT COUNT(*) c FROM batch_transactions WHERE type IN ('printed','reprinted')`), 'C4 labels add up');
  // The SQL helper splits every batch exactly once (also on the real batches of a production copy).
  const split = (kind: 'kitchen' | 'brewery') => c(`SELECT COUNT(*) c FROM production_batches WHERE ${BB.batchKindSql(kind)}`);
  eq(split('kitchen') + split('brewery'), c(`SELECT COUNT(*) c FROM production_batches`), 'C5 batchKindSql: every batch on exactly one side');

  // ── D. Page access ──────────────────────────────────────────────────
  console.log('D. page access');
  const P = '/brewery-production/dashboard';
  ok(PC.isMgmtOnlyPath(P) && !PC.isMgmtOnlyPath('/brewery-production') && !PC.isMgmtOnlyPath('/kitchen-production/dashboard'),
    'D1 only the Brewery dashboard is mgmtOnly');
  const people: [string, any][] = [
    ['admin', { role: 'admin', is_head_chef: false, page_access: null }],
    ['manager', { role: 'manager', is_head_chef: false, page_access: null }],
    ['HOD', { role: 'staff', is_head_chef: true, page_access: null }],
    ['staff', { role: 'staff', is_head_chef: false, page_access: null }],
    ['staff ticked Brewery Production', { role: 'staff', is_head_chef: false, page_access: JSON.stringify(['/brewery-production']) }],
    ['staff ticked Brewery Dashboard', { role: 'staff', is_head_chef: false, page_access: JSON.stringify([P]) }],
    ['manager ticked Brewery Production', { role: 'manager', is_head_chef: false, page_access: JSON.stringify(['/brewery-production']) }],
    ['manager ticked Requisitions only', { role: 'manager', is_head_chef: false, page_access: JSON.stringify(['/requisitions']) }],
  ];
  const want: Record<string, boolean> = {
    admin: true, manager: true, HOD: true, staff: false, 'staff ticked Brewery Production': false,
    'staff ticked Brewery Dashboard': false, 'manager ticked Brewery Production': true, 'manager ticked Requisitions only': false,
  };
  for (const [label, u] of people) eq(PC.canAccessPage(P, u), want[label], `D2 page gate: ${label}`);
  for (const [label, u] of people.filter(([, u]) => u.page_access === null)) {
    eq(PC.canAccessPage(P, u), BB.canSeeBeerQuantities(u), `D3 page gate agrees with canSeeBeerQuantities: ${label}`);
  }
  ok(PC.canAccessPage('/kitchen-production/dashboard', people[3][1]), 'D4 staff still open the Kitchen dashboard');
  const sidebar = fs.readFileSync(path.join(WT, 'src/components/Sidebar.tsx'), 'utf8');
  ok(sidebar.includes(`label: "Brewery Dashboard", href: "${P}"`), 'D5 sidebar row "Brewery Dashboard"');
  ok(sidebar.includes(`label: "Kitchen Dashboard", href: "/kitchen-production/dashboard"`) && !sidebar.includes('"Production Dashboard"'),
    'D6 sidebar "Production Dashboard" renamed "Kitchen Dashboard"');
  ok(PC.PAGE_CATALOG.flatMap((s: any) => s.pages).some((p: any) => p.path === P), 'D7 catalog twin row present');

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// A module, so its names never collide with another script's in `tsc --noEmit`.
export {};
