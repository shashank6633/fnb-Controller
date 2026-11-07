/**
 * BREWERY DEPARTMENT — owner rulings 118–121 (2026-11-07) — THE PROOF.
 *
 *   npx tsx scripts/brewery-dept-tests.ts <dir holding a COPY of fnb-controller.db>
 *
 * RUNS ON A HARNESS COPY ONLY (same guard as routed-requisition-tests.ts): the
 * directory must sit under a `harness/` directory and must not be this
 * worktree; the script chdirs there BEFORE db.ts loads, so getDb() and every
 * real route handler below open the copy and nothing else.
 *
 * Proves, with the real route handlers (next/headers stubbed to the test
 * user's session):
 *   A  beer in hand on a date — produced − consumed/wasted/disposed up to the
 *      IST day; a partial waste still leaves beer; today = produced − consumed.
 *   B  blind beer (ruling 121) — staff get no used / left figure for a BREWERY
 *      batch on list, details (+ history), by-barcode, scan (+ FIFO hints),
 *      take (+ its refusal text) and the FSSAI FIFO board; admin / manager /
 *      HOD do; a KITCHEN batch is untouched for everyone.
 *   C  Brewery Closing — page gate, blind expected, record-only save (batch
 *      untouched), one row per date+batch, whole-submit refusals.
 *   D  Beer in hand report — admin / manager / HOD only; past dates.
 *   E  readBatchTag — the Scan-into-New-Brewery-Batch rules (ruling 119).
 *   F  requisition approval (ruling 117, NO code) — why Brewery requisitions sat
 *      pending, and that the owner's on-screen setup (own main department,
 *      Head = brewer, 'Is HOD' ticked) puts them in the brewer's inbox + bell
 *      and lets the brewer approve.
 *   G  categories (ruling 117, NO code) — Manage Parents 'Brewery' + the four
 *      sub-categories, admin only.
 *   H  the near-expiry alert names no litres for a Brewery batch (its
 *      recipients and Slack include roles that may not see them); Kitchen as was.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const Module = require('module');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(String(process.argv[2] || ''));
const WT = path.resolve(__dirname, '..');
if (!dir || !fs.existsSync(path.join(dir, 'fnb-controller.db'))) {
  console.error('usage: npx tsx scripts/brewery-dept-tests.ts <dir holding a COPY of fnb-controller.db>');
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
  const { todayIST } = require(path.join(WT, 'src/lib/format-date.ts'));
  const BB = require(path.join(WT, 'src/lib/brewery-beer.ts'));
  const { readBatchTag } = require(path.join(WT, 'src/lib/brewery-tag.ts'));
  const list = require(path.join(WT, 'src/app/api/kitchen-production/route.ts'));
  const detail = require(path.join(WT, 'src/app/api/kitchen-production/[id]/route.ts'));
  const byBarcode = require(path.join(WT, 'src/app/api/kitchen-production/by-barcode/route.ts'));
  const scan = require(path.join(WT, 'src/app/api/kitchen-production/scan/route.ts'));
  const take = require(path.join(WT, 'src/app/api/kitchen-production/take/route.ts'));
  const fifo = require(path.join(WT, 'src/app/api/fssai/fifo/route.ts'));
  const closing = require(path.join(WT, 'src/app/api/kitchen-production/brewery-closing/route.ts'));
  const inHand = require(path.join(WT, 'src/app/api/kitchen-production/brewery-closing/in-hand/route.ts'));
  const db = getDb();
  const TODAY = todayIST();
  const uid = () => `zzbt-${Math.random().toString(36).slice(2, 10)}`;

  // ── Seed (copy only) ─────────────────────────────────────────────────
  const LAGER = uid(), STOUT = uid(), GRAVY = uid();
  const insItem = db.prepare(`INSERT INTO production_items (id, name, category, unit, shelf_life_hours, is_active, is_brewery, batch_number_mode, batch_serial_code)
                              VALUES (?,?,?,?,0,1,?,?,?)`);
  insItem.run(LAGER, 'ZZ Test Lager', 'Beer', 'L', 1, 'manual_serial', 'ZZL');
  insItem.run(STOUT, 'ZZ Test Stout', 'Beer', 'L', 1, 'manual', '');
  insItem.run(GRAVY, 'ZZ Test Gravy', 'Gravy', 'kg', 0, 'auto', '');
  const insBatch = db.prepare(`INSERT INTO production_batches (id, batch_number, barcode, item_name, category, production_item_id, production_date, production_time,
                                 quantity_produced, quantity_consumed, unit, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const B1 = uid(), B2 = uid(), K1 = uid();
  insBatch.run(B1, 'ZZL-901', 'PROD990001', 'ZZ Test Lager', 'Beer', LAGER, '2026-11-01', '09:00', 500, 175, 'L', 'disposed');
  insBatch.run(B2, 'ZZL-902', 'PROD990002', 'ZZ Test Lager', 'Beer', LAGER, '2026-11-05', '09:00', 200, 0, 'L', 'active');
  insBatch.run(K1, 'ZG261101001', 'PROD990003', 'ZZ Test Gravy', 'Gravy', GRAVY, '2026-11-01', '09:00', 10, 4, 'kg', 'active');
  const insTx = db.prepare(`INSERT INTO batch_transactions (id, batch_id, type, quantity, balance_quantity, user, created_at) VALUES (?,?,?,?,?,?,?)`);
  insTx.run(uid(), B1, 'created', 500, 500, 't', '2026-11-01 03:30:00');
  insTx.run(uid(), B1, 'consumed', 100, 400, 't', '2026-11-02 05:00:00');       // IST 02-Nov 10:30
  insTx.run(uid(), B1, 'wasted', 50, 350, 't', '2026-11-03 19:00:00');          // IST 04-Nov 00:30 (!)
  insTx.run(uid(), B1, 'transferred', 30, 350, 't', '2026-11-04 06:00:00');     // movement only, never lowers
  insTx.run(uid(), B1, 'disposed', 25, 325, 't', '2026-11-05 06:00:00');        // partial → status 'disposed'
  insTx.run(uid(), B1, 'scanned', 0, 325, 't', '2026-11-05 07:00:00');
  insTx.run(uid(), K1, 'consumed', 4, 6, 't', '2026-11-02 05:00:00');

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
  const NOPAGE = mkUser('ZZ NoPage', 'staff', 0, JSON.stringify(['/requisitions']));
  const as = (u: { tok: string }) => { (globalThis as any).__TOKEN = u.tok; };
  const get = async (mod: any, url: string, params?: Record<string, string>) => {
    const res: Response = await mod.GET(new Request(`http://t${url}`), params ? { params: Promise.resolve(params) } : undefined);
    return { status: res.status, j: await res.json() };
  };
  const post = async (mod: any, url: string, body: unknown) => {
    const res: Response = await mod.POST(new Request(`http://t${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: res.status, j: await res.json() };
  };

  // ── A. Beer in hand on a date ───────────────────────────────────────
  console.log('A. beer in hand on a date');
  const at = (d: string) => Object.fromEntries(BB.beerBatchesAsOf(db, d, null)
    .filter((r: any) => r.batch_id === B1 || r.batch_id === B2 || r.batch_id === K1).map((r: any) => [r.batch_id, r.in_hand]));
  eq(at('2026-10-31'), {}, 'A1 nothing brewed yet');
  eq(at('2026-11-01'), { [B1]: 500 }, 'A2 brewed day');
  eq(at('2026-11-02'), { [B1]: 400 }, 'A3 take on 02-Nov IST');
  eq(at('2026-11-03'), { [B1]: 400 }, 'A4 waste stamped 03-Nov 19:00 UTC is 04-Nov IST — not yet');
  eq(at('2026-11-04'), { [B1]: 350 }, 'A5 waste lands 04-Nov; transfer never lowers');
  eq(at('2026-11-05'), { [B1]: 325, [B2]: 200 }, 'A6 partial dispose (status disposed) still leaves 325; B2 brewed');
  ok(!(K1 in at(TODAY)), 'A7 a Kitchen batch is never beer');
  const todayRows = BB.beerBatchesAsOf(db, TODAY, null) as any[];
  const drift = todayRows.filter((r) => {
    const b = db.prepare('SELECT quantity_produced p, quantity_consumed c FROM production_batches WHERE id=?').get(r.batch_id) as any;
    return Math.abs(Math.max(0, b.p - b.c) - r.in_hand) > 1e-6;
  });
  eq(drift.map((r: any) => r.batch_number), [], 'A8 today = produced − consumed for EVERY Brewery batch on this DB');
  // A batch saved with no brew date counts from the IST day it was RECORDED
  // (created 03-Nov 20:00 UTC = 04-Nov IST), never from the beginning of time.
  const B0 = uid();
  insBatch.run(B0, 'ZZL-900', 'PROD990004', 'ZZ Test Lager', 'Beer', LAGER, '', '', 30, 0, 'L', 'active');
  db.prepare(`UPDATE production_batches SET created_at = '2026-11-03 20:00:00' WHERE id = ?`).run(B0);
  const has0 = (d: string) => BB.beerBatchesAsOf(db, d, null).some((r: any) => r.batch_id === B0);
  ok(!has0('2026-11-03') && has0('2026-11-04'), 'A10 no brew date → counts from the IST day it was recorded');
  db.prepare(`UPDATE production_batches SET status = 'consumed', quantity_consumed = 30 WHERE id = ?`).run(B0);
  insTx.run(uid(), B0, 'consumed', 30, 0, 't', '2026-11-04 00:00:00');
  const tot = BB.beerTotalsByItem([{ item_name: 'X', unit: 'L', produced: 1, out_by_date: 0, in_hand: 1 }, { item_name: 'x', unit: 'l', produced: 2, out_by_date: 1, in_hand: 1 }, { item_name: 'X', unit: 'keg', produced: 3, out_by_date: 0, in_hand: 3 }]);
  eq(tot.map((t: any) => [t.unit, t.batches, t.in_hand]), [['L', 2, 2], ['keg', 1, 3]], 'A9 totals per beer AND unit (never L + keg)');

  // ── B. Blind beer on every read ─────────────────────────────────────
  console.log('B. blind beer');
  const find = (arr: any[], id: string) => arr.find((b) => b.id === id);
  for (const [u, sees] of [[ADMIN, true], [MGR, true], [HOD, true], [STAFF, false]] as const) {
    as(u);
    const all = (await get(list, '/api/kitchen-production?status=all')).j.batches;
    const brew = (await get(list, '/api/kitchen-production?status=all&kind=brewery')).j.batches;
    const b1 = find(all, B1), b1k = find(brew, B1), k1 = find(all, K1);
    ok(sees ? b1.remaining_quantity === 325 && b1.quantity_consumed === 175 : b1.remaining_quantity === null && b1.quantity_consumed === null && b1.quantities_hidden === true,
      `B1 list (no kind) ${u.label}`);
    ok(sees ? b1k.remaining_quantity === 325 : b1k.remaining_quantity === null, `B2 list kind=brewery ${u.label}`);
    ok(k1.remaining_quantity === 6 && k1.quantity_consumed === 4 && !k1.quantities_hidden, `B3 Kitchen batch untouched ${u.label}`);
    ok(b1.is_brewery_batch === true && !('is_brewery_batch' in k1), `B16 Brewery batch marked for everyone, Kitchen never ${u.label}`);
    ok(b1.quantity_produced === 500, `B4 brewed amount still shown ${u.label}`);
    const d = (await get(detail, `/api/kitchen-production/${B1}`, { id: B1 })).j;
    const txQ = d.transactions.map((t: any) => [t.type, t.quantity, t.balance_quantity]);
    ok(sees ? d.batch.remaining_quantity === 325 && txQ.some((t: any[]) => t[0] === 'wasted' && t[1] === 50 && t[2] === 350)
            : d.batch.remaining_quantity === null && txQ.every((t: any[]) => t[2] === null && (t[0] === 'created' ? t[1] === 500 : t[1] === null)),
      `B5 details + history ${u.label}`);
    const kd = (await get(detail, `/api/kitchen-production/${K1}`, { id: K1 })).j;
    ok(kd.transactions.some((t: any) => t.type === 'consumed' && t.quantity === 4 && t.balance_quantity === 6), `B6 Kitchen history untouched ${u.label}`);
    const bb = (await get(byBarcode, '/api/kitchen-production/by-barcode?barcode=PROD990002')).j.batch;
    ok(sees ? bb.remaining_quantity === 200 : bb.remaining_quantity === null, `B7 by-barcode ${u.label}`);
    const fb = (await get(fifo, '/api/fssai/fifo?view=board')).j;
    const fbB2 = (fb.batches || []).find((b: any) => b.id === B2), fbK1 = (fb.batches || []).find((b: any) => b.id === K1);
    ok(!!fbB2 && (sees ? fbB2.remaining_quantity === 200 : fbB2.remaining_quantity === null && fbB2.quantities_hidden === true), `B8 FSSAI board Brewery ${u.label}`);
    ok(!!fbK1 && fbK1.remaining_quantity === 6, `B9 FSSAI board Kitchen untouched ${u.label}`);
  }
  // scan (FIFO hint): make B1 active again so it is "use first" before B2.
  db.prepare(`UPDATE production_batches SET status='active' WHERE id=?`).run(B1);
  as(STAFF);
  let s = (await post(scan, '/api/kitchen-production/scan', { barcode: 'PROD990002' })).j.batch;
  ok(s.remaining_quantity === null && s.fifo_use_first?.length >= 1 && s.fifo_use_first.every((f: any) => f.remaining_quantity === null), 'B10 scan + FIFO hint hidden for staff');
  as(MGR);
  s = (await post(scan, '/api/kitchen-production/scan', { barcode: 'PROD990002' })).j.batch;
  ok(s.remaining_quantity === 200 && s.fifo_use_first?.[0]?.remaining_quantity === 325, 'B11 scan + FIFO hint shown to manager');
  // take
  as(STAFF);
  let t = await post(take, '/api/kitchen-production/take', { barcode: 'PROD990002', quantity: 1000 });
  ok(t.status === 400 && !/200|Only/.test(t.j.error) && /more than this batch has left/.test(t.j.error), `B12 staff over-take refused without the figure: ${t.j.error}`);
  t = await post(take, '/api/kitchen-production/take', { barcode: 'PROD990002', quantity: 5 });
  ok(t.status === 200 && t.j.remaining === null && t.j.batch.remaining_quantity === null && t.j.taken === 5, 'B13 staff take works, answer blind');
  as(MGR);
  t = await post(take, '/api/kitchen-production/take', { barcode: 'PROD990002', quantity: 1000 });
  ok(t.status === 400 && /Only 195 L left/.test(t.j.error), `B14 manager over-take names the figure: ${t.j.error}`);
  as(STAFF);
  t = await post(take, '/api/kitchen-production/take', { barcode: 'PROD990003', quantity: 100 });
  ok(t.status === 400 && /Only 6 kg left/.test(t.j.error), `B15 Kitchen over-take unchanged for staff: ${t.j.error}`);

  // ── C. Brewery Closing (beer counts) ────────────────────────────────
  console.log('C. Brewery Closing');
  as(NOPAGE);
  eq((await get(closing, '/api/kitchen-production/brewery-closing')).status, 403, 'C1 no page grant → GET 403');
  eq((await post(closing, '/api/kitchen-production/brewery-closing', { date: TODAY, counts: [{ batch_id: B2, counted: 1 }] })).status, 403, 'C2 no page grant → POST 403');
  as(STAFF);
  let g = (await get(closing, `/api/kitchen-production/brewery-closing?date=${TODAY}`)).j;
  const gB2 = g.batches.find((b: any) => b.batch_id === B2);
  ok(g.can_see_expected === false && gB2 && gB2.expected === null && gB2.difference === null, 'C3 staff sheet is blind');
  ok(g.batches.every((b: any) => b.expected === null), 'C4 no expected on any staff row');
  const before = db.prepare('SELECT quantity_produced, quantity_consumed, status, updated_at FROM production_batches WHERE id IN (?,?) ORDER BY id').all(B1, B2);
  let p = await post(closing, '/api/kitchen-production/brewery-closing', { date: TODAY, counts: [{ batch_id: B2, counted: '190' }, { batch_id: B1, counted: '' }] });
  ok(p.status === 200 && p.j.saved === 1 && !('expected' in p.j) && !('difference' in p.j), 'C5 staff save: 1 saved (blank skipped), answer has no expected');
  p = await post(closing, '/api/kitchen-production/brewery-closing', { date: TODAY, counts: [{ batch_id: B2, counted: 0 }] });
  eq(db.prepare('SELECT COUNT(*) n, MAX(counted_qty) q FROM brewery_beer_counts WHERE batch_id=? AND count_date=?').get(B2, TODAY), { n: 1, q: 0 }, 'C6 re-save replaces (one row), 0 is a count');
  eq(db.prepare('SELECT quantity_produced, quantity_consumed, status, updated_at FROM production_batches WHERE id IN (?,?) ORDER BY id').all(B1, B2), before, 'C7 a count never changes a batch');
  const nBefore = (db.prepare('SELECT COUNT(*) n FROM brewery_beer_counts').get() as any).n;
  for (const [body, label] of [
    [{ date: TODAY, counts: [{ batch_id: B2, counted: -1 }] }, 'negative'],
    [{ date: TODAY, counts: [{ batch_id: B2, counted: 'abc' }] }, 'not a number'],
    [{ date: TODAY, counts: [{ batch_id: B2, counted: 5 }, { batch_id: K1, counted: 1 }] }, 'a Kitchen batch'],
    [{ date: '2026-11-04', counts: [{ batch_id: B2, counted: 5 }] }, 'a batch brewed after the date'],
    [{ date: '2099-01-01', counts: [{ batch_id: B2, counted: 5 }] }, 'a future date'],
    [{ date: TODAY, counts: [{ batch_id: B2, counted: '' }] }, 'nothing typed'],
  ] as const) {
    const r = await post(closing, '/api/kitchen-production/brewery-closing', body);
    ok(r.status === 400, `C8 refused (${label}) → ${r.status} ${r.j.error}`);
  }
  eq((db.prepare('SELECT COUNT(*) n FROM brewery_beer_counts').get() as any).n, nBefore, 'C9 a refused submit saves nothing');
  as(HOD);
  g = (await get(closing, `/api/kitchen-production/brewery-closing?date=${TODAY}`)).j;
  const hB2 = g.batches.find((b: any) => b.batch_id === B2);
  ok(g.can_see_expected === true && hB2.expected === 195 && hB2.counted === 0 && hB2.difference === -195, `C10 HOD sees expected + difference: ${JSON.stringify(hB2)}`);
  ok(g.others.every((o: any) => !('expected' in o) && !('produced' in o)), 'C11 "add a batch" list carries no figures');
  ok(!!db.prepare(`SELECT 1 FROM audit_events WHERE event_type='brewery.beer_count' AND entity_id=?`).get(TODAY), 'C12 save is audited');

  // ── D. Beer in hand report ──────────────────────────────────────────
  console.log('D. Beer in hand');
  as(STAFF);
  eq((await get(inHand, '/api/kitchen-production/brewery-closing/in-hand')).status, 403, 'D1 staff → 403');
  as(MGR);
  const ih = (await get(inHand, '/api/kitchen-production/brewery-closing/in-hand?date=2026-11-03')).j;
  const ihB1 = ih.batches.find((b: any) => b.batch_id === B1);
  ok(ihB1 && ihB1.in_hand === 400 && !ih.batches.some((b: any) => b.batch_id === B2), 'D2 past date 03-Nov: B1 400, B2 not brewed');
  const ihT = (await get(inHand, `/api/kitchen-production/brewery-closing/in-hand?date=${TODAY}`)).j;
  const lagerT = ihT.totals.find((x: any) => x.item_name === 'ZZ Test Lager' && x.unit === 'L');
  ok(lagerT && lagerT.in_hand === 325 + 195 && lagerT.batches === 2, `D3 today total per beer: ${JSON.stringify(lagerT)}`);
  eq((await get(inHand, '/api/kitchen-production/brewery-closing/in-hand?date=2099-01-01')).status, 400, 'D4 future date refused');

  // ── E. readBatchTag ─────────────────────────────────────────────────
  console.log('E. scan into New Brewery Batch');
  const items = [
    { id: 'L', name: 'Lager', is_brewery: 1, batch_number_mode: 'manual_serial', batch_serial_code: 'ZZL' },
    { id: 'Z', name: 'Zed', is_brewery: 1, batch_number_mode: 'manual_serial', batch_serial_code: 'ZZ' },
    { id: 'S', name: 'Stout', is_brewery: 1, batch_number_mode: 'manual', batch_serial_code: '' },
    { id: 'A', name: 'Auto', is_brewery: 1, batch_number_mode: 'auto', batch_serial_code: '' },
    { id: 'K', name: 'NotBrewery', is_brewery: 0, batch_number_mode: 'manual_serial', batch_serial_code: 'KK' },
  ];
  eq(readBatchTag('ZZL-248', items, null), { ok: true, itemId: 'L', entry: '248', switchedItem: false }, 'E1 code picks the item');
  eq(readBatchTag('zzl-249\r\n', items, null), { ok: true, itemId: 'L', entry: '249', switchedItem: false }, 'E2 case + scanner CR/LF');
  eq(readBatchTag('ZZ-7', items, null), { ok: true, itemId: 'Z', entry: '7', switchedItem: false }, 'E3 shorter code still matches its own');
  eq(readBatchTag('ZZL-5', items, 'S'), { ok: true, itemId: 'L', entry: '5', switchedItem: true }, 'E4 tag for another item switches it (flagged)');
  eq(readBatchTag('248', items, 'L'), { ok: true, itemId: 'L', entry: '248', switchedItem: false }, 'E5 bare number into the picked serial item');
  eq(readBatchTag('BATCH 7', items, 'S'), { ok: true, itemId: 'S', entry: 'BATCH 7', switchedItem: false }, 'E6 typed-number item takes the whole tag');
  ok(!readBatchTag('PROD000123', items, 'S').ok, 'E7 an app label is refused');
  ok(!readBatchTag('248', items, null).ok, 'E8 no item, no code → refused');
  ok(!readBatchTag('248', items, 'A').ok, 'E9 an Automatic item never takes a scan');
  ok(!readBatchTag('XYZ-12', items, 'L').ok, 'E10 another code on a serial item → refused');
  ok(!readBatchTag('ZZL-', items, null).ok, 'E11 code with no number → refused');
  ok(!readBatchTag('KK-1', items, null).ok, 'E12 a non-Brewery item\'s code is ignored');
  ok(!readBatchTag('   ', items, 'S').ok, 'E13 nothing read → refused');

  // ── H. Expiry alert text (ruling 121) ───────────────────────────────
  console.log('H. expiry alert text');
  const { checkKitchenExpiry } = require(path.join(WT, 'src/lib/kitchen-expiry-check.ts'));
  const soon = new Date(Date.now() + 30 * 3600 * 1000);   // ~30 h → inside the 3-day window
  const ist = new Date(soon.getTime() + 330 * 60 * 1000).toISOString();
  db.prepare(`UPDATE production_batches SET expiry_date = ?, expiry_time = ? WHERE id IN (?, ?)`)
    .run(ist.slice(0, 10), ist.slice(11, 16), B2, K1);
  await checkKitchenExpiry('manual');
  const bodyOf = (id: string) => (db.prepare(`SELECT body FROM notifications WHERE party_unique_id LIKE ? AND channel='inapp' LIMIT 1`).get(`kbatch-expiry:${id}:%`) as any)?.body || '';
  const beerBody = bodyOf(B2), kitBody = bodyOf(K1);
  ok(!!beerBody && !/\d+(\.\d+)? ?L still/.test(beerBody) && /Beer is still on hand/.test(beerBody), `H1 Brewery alert names no litres: ${beerBody}`);
  ok(/6 kg still on hand/.test(kitBody), `H2 Kitchen alert unchanged: ${kitBody}`);

  // ── F. Requisition approval — the owner's NO-CODE setup (ruling 117) ──
  // Cause: an HOD sees only the main department they head, so a Brewery MAIN
  // department with no Head is invisible to every HOD. Fix (owner, on screen):
  // Brewery = its own main department, Head = the brewer, 'Is HOD' on.
  console.log('F. requisition approval setup');
  const reqs = require(path.join(WT, 'src/app/api/requisitions/route.ts'));
  const inbox = require(path.join(WT, 'src/app/api/notifications/inbox/route.ts'));
  const chefApprove = require(path.join(WT, 'src/app/api/requisitions/[id]/chef-approve/route.ts'));
  const BREW = uid();
  db.prepare(`INSERT INTO departments (id, name, is_active) VALUES (?, 'ZZ Brewery', 1)`).run(BREW);
  const BREWER = mkUser('ZZ Brewer', 'manager', 1, null);
  const OTHER_HOD = mkUser('ZZ Other HOD', 'manager', 1, null);
  const BREWSTAFF = mkUser('ZZ Brew Staff', 'staff', 0, null);
  db.prepare(`UPDATE users SET department_id=? WHERE id IN (?,?)`).run(BREW, BREWER.id, BREWSTAFF.id);
  const mat = db.prepare(`SELECT id FROM raw_materials WHERE COALESCE(is_active,1)=1 LIMIT 1`).get() as { id: string };
  const REQ = uid();
  db.prepare(`INSERT INTO requisitions (id, req_number, department_id, date, status, drafted_by, submitted_at)
              VALUES (?, ?, ?, ?, 'submitted', ?, datetime('now'))`).run(REQ, `REQ-ZZ-${REQ.slice(-4)}`, BREW, TODAY, `${BREWSTAFF.id}@test.local`);
  db.prepare(`INSERT INTO requisition_items (id, req_id, material_id, quantity_requested, unit) VALUES (?,?,?,?,?)`).run(uid(), REQ, mat.id, 2, 'kg');
  const sees = async (u: any) => {
    as(u);
    const r = (await get(reqs, '/api/requisitions?inbox=chef')).j;
    const bell = (await get(inbox, '/api/notifications/inbox')).j;
    return {
      inInbox: (r.requisitions || []).some((x: any) => x.id === REQ),
      bell: ((bell.items || []).find((i: any) => i.key === 'chef_inbox')?.count) || 0,
    };
  };
  let v = await sees(BREWER);
  ok(!v.inInbox, 'F1 BEFORE: Brewery main dept with no Head — the brewer HOD does NOT see it (the "pending" cause)');
  v = await sees(OTHER_HOD);
  ok(!v.inInbox, 'F2 BEFORE: another HOD does not see it either');
  v = await sees(ADMIN);
  ok(v.inInbox, 'F3 BEFORE: only admin (and store / approvers) see it');
  db.prepare(`UPDATE departments SET head_user_id=? WHERE id=?`).run(BREWER.id, BREW);   // owner: Departments → Brewery → Head
  v = await sees(BREWER);
  ok(v.inInbox && v.bell >= 1, `F4 AFTER: Head = brewer → inbox + bell (${v.bell})`);
  v = await sees(OTHER_HOD);
  ok(!v.inInbox, 'F5 AFTER: other HODs still do not see Brewery requisitions');
  as(BREWER);
  const ap = await chefApprove.POST(new Request(`http://t/api/requisitions/${REQ}/chef-approve`, { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: REQ }) });
  eq([ap.status, (db.prepare('SELECT status FROM requisitions WHERE id=?').get(REQ) as any).status], [200, 'chef_approved'], 'F6 the brewer (HOD tick) approves it');
  db.prepare(`UPDATE users SET is_head_chef=0 WHERE id=?`).run(BREWER.id);
  const REQ2 = uid();
  db.prepare(`INSERT INTO requisitions (id, req_number, department_id, date, status, drafted_by, submitted_at)
              VALUES (?, ?, ?, ?, 'submitted', ?, datetime('now'))`).run(REQ2, `REQ-ZZ-${REQ2.slice(-4)}`, BREW, TODAY, `${BREWSTAFF.id}@test.local`);
  db.prepare(`INSERT INTO requisition_items (id, req_id, material_id, quantity_requested, unit) VALUES (?,?,?,?,?)`).run(uid(), REQ2, mat.id, 1, 'kg');
  const ap2 = await chefApprove.POST(new Request(`http://t/api/requisitions/${REQ2}/chef-approve`, { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: REQ2 }) });
  ok(ap2.status === 403, `F7 Head WITHOUT the HOD tick is refused (${ap2.status}) — why the setup needs both`);

  // ── G. Categories — the owner's NO-CODE steps (ruling 117) ──────────
  console.log('G. categories setup');
  const parents = require(path.join(WT, 'src/app/api/categories/parents/route.ts'));
  const cats = require(path.join(WT, 'src/app/api/categories/route.ts'));
  as(ADMIN);
  const pp = await parents.POST(new Request('http://t/api/categories/parents', { method: 'POST', body: JSON.stringify({ label: 'ZZ Brewery' }) }));
  ok(pp.status === 200 || pp.status === 201, `G1 Manage Parents: add 'ZZ Brewery' (${pp.status})`);
  const cc = await post(cats, '/api/categories', { create: ['Salts', 'Hops', 'Yeast', 'Malts'].map((c) => ({ category: `ZZ ${c}`, super_category: 'ZZ Brewery' })) });
  ok(cc.status === 200 && cc.j.created === 4, `G2 four sub-categories created (${JSON.stringify(cc.j)})`);
  const gc = (await get(cats, '/api/categories')).j;
  const grp = (gc.groups || []).find((x: any) => x.super_category_raw === 'ZZ Brewery');
  eq((grp?.leaves || []).map((l: any) => l.category).sort(), ['ZZ Hops', 'ZZ Malts', 'ZZ Salts', 'ZZ Yeast'], 'G3 they show under Brewery (what the item form dropdown reads)');
  as(STAFF);
  ok((await post(cats, '/api/categories', { create: [{ category: 'ZZ X', super_category: '' }] })).status === 403, 'G4 only an admin can add them');

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
