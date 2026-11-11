/**
 * REQUESTED → ORDERED → RECEIVED (owner, 2026-11-09) — THE PROOF.
 *
 *   npx tsx scripts/req-recon-tests.ts <dir holding a COPY of fnb-controller.db>
 *
 * RUNS ON A HARNESS COPY ONLY: the directory must sit under a `harness/`
 * directory and must not be this worktree; the script chdirs there BEFORE
 * db.ts loads, so getDb() and every real route handler below open the copy and
 * nothing else. It SEEDS that copy (documents dated 2031, clear of real data).
 *
 *   A  REAL DATA (before any seeding): for whole months on the copy, All
 *      departments — Σ ₹ Received = the Purchase Report's booked total, and,
 *      item by item, ₹ / qty Received = the Purchase Report's Item-wise
 *      Spend / Total Qty, through the two REAL routes.
 *   B  SEEDED CASES (March 2031): requested in a recipe / line unit vs bought
 *      in the purchase unit (pack conversion); a cancelled PO; a vendor-closed
 *      PO line; a void GRN; a QC-held receipt; a direct purchase with no PO; a
 *      merged PO line serving two requests; an item shared by Kitchen and Bar;
 *      a Kitchen sub-department; HOD-rejected / cancelled / chef-rejected /
 *      draft / store-rejected lines; a blank and an unconvertible unit; the
 *      rate fallbacks; part- and fully-rejected deliveries.
 *   C  WINDOWS: empty window, one-item window, the last day of the window.
 *   D  ACCESS: 401 signed out, 403 for staff (an HOD on the staff tier too),
 *      200 for admin, manager tier and the store manager (staff-tier too);
 *      the catalog row (mgmtOnly) and its Sidebar twin.
 *   E  THE EXCEL FILE: sheets, rows, figures, no email in it.
 *   F  ROUND-2 FIXES (June 2031): ₹ Requested to the paisa per item (rows add
 *      up to the total; ₹ Received keeps its sub-paisa = the Purchase Report);
 *      an id with no item record still gets its latest purchase rate; the
 *      no-rate words on the page and in the file.
 *   G  ROUND-3 FIXES (August 2031): a "Multiple departments" party requisition
 *      — each line counts for ITS OWN department (requisition_items
 *      .department_id), not the header's; a line with none takes the header's;
 *      the drill-down, "Raised for" (all three PO links) and the Excel sheets
 *      name the line's department. And the file's quantities read back with
 *      their number formats: no whole number prints with a trailing ".".
 *   H  ROUND-2 FIXER (November 2031): an HOD-approved (chef_approved)
 *      requisition says "With Store" or "With Mgmt" as the store inbox (the
 *      REAL GET /api/requisitions?inbox=store) places it — internal always with
 *      the store; party with Mgmt only while require_mgmt_approval is '1' —
 *      on the real copy's own chef_approved lines and on seeded ones, with the
 *      setting absent, '0' and '1'; the drill-down and the Excel file agree.
 *   I  WORDING FIXES (September 2031): the Held-for-QC card's line names its
 *      scope (a department view: "these items"; zero: "in this period") while
 *      the outlet has a delivery held for another item and an older one still
 *      held; the Excel held column says the goods were delivered; the dialog
 *      keeps "PO" in capitals; "with its sections" only for a department that
 *      has sections (the report's own subtree rule) — picker, "Showing", dialog
 *      and the Excel Summary.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const Module = require('module');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(String(process.argv[2] || ''));
const WT = path.resolve(__dirname, '..');
if (!process.argv[2] || !fs.existsSync(path.join(dir, 'fnb-controller.db'))) {
  console.error('usage: npx tsx scripts/req-recon-tests.ts <dir holding a COPY of fnb-controller.db>');
  process.exit(2);
}
if (!dir.split(path.sep).includes('harness') || dir === WT || dir.startsWith(WT + path.sep)) {
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
const paise = (n: unknown) => Math.round((Number(n) || 0) * 100);
const near = (a: number, b: number, label: string, tol = 1e-6) => ok(Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tol, `${label} — got ${a}, want ${b}`);

(async () => {
  const { getDb } = require(path.join(WT, 'src/lib/db.ts'));
  const T = require(path.join(WT, 'src/lib/req-recon-types.ts'));
  const route = require(path.join(WT, 'src/app/api/reports/requested-vs-received/route.ts'));
  const purchases = require(path.join(WT, 'src/app/api/reports/purchases/route.ts'));
  const catalog = require(path.join(WT, 'src/lib/page-catalog.ts'));
  const XLSX = require('xlsx');
  const db = getDb();
  if (path.resolve(db.name) !== path.join(dir, 'fnb-controller.db')) {
    console.error(`refusing: getDb() opened ${db.name}, not the copy.`); process.exit(2);
  }

  let n = 0;
  const uid = (p = 'x') => `zzrr-${p}-${(++n).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const mkUser = (name: string, role: string, opts: { hod?: number; store?: number; email?: string } = {}) => {
    const id = uid('u');
    db.prepare(`INSERT INTO users (id, email, password_hash, name, role, is_active, is_head_chef, is_store_manager, can_approve_requisitions, page_access)
                VALUES (?, ?, 'x', ?, ?, 1, ?, ?, 0, NULL)`).run(id, opts.email || `${id}@test.local`, name, role, opts.hod || 0, opts.store || 0);
    const tok = `tok-${id}`;
    db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01 00:00:00')`).run(tok, id);
    return { id, tok };
  };
  const ADMIN = mkUser('ZZRR Admin', 'admin');
  const as = (u: { tok: string } | null) => { (globalThis as any).__TOKEN = u ? u.tok : null; };
  const call = async (qs: string) => {
    const res = await route.GET(new Request(`http://t/api/reports/requested-vs-received?${qs}`));
    const ct = res.headers.get('Content-Type') || '';
    const body = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body, headers: res.headers };
  };
  const purchaseReport = async (from: string, to: string) => {
    const res = await purchases.GET(new Request(`http://t/api/reports/purchases?from=${from}&to=${to}`));
    return { status: res.status, body: await res.json() };
  };

  /* ══════════ A — real data, before any seeding ══════════ */
  console.log('A  real data: ₹ Received = the Purchase Report, item by item');
  as(ADMIN);
  const months = (db.prepare(`SELECT substr(date,1,7) AS m, COUNT(*) AS n FROM purchases WHERE date < '2031' GROUP BY m ORDER BY n DESC LIMIT 3`).all() as any[]).map(r => r.m);
  ok(months.length > 0, 'the copy has real purchases to prove against');
  for (const m of months) {
    const from = `${m}-01`;
    const to = `${m}-${String(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate()).padStart(2, '0')}`;
    const r = await call(`from=${from}&to=${to}&dept=all`);
    const p = await purchaseReport(from, to);
    eq([r.status, p.status], [200, 200], `${m}: both routes answer`);
    eq(paise(r.body.purchase_report_booked), paise(p.body.summary.total_spend), `${m}: purchase_report_booked = Purchase Report total_spend`);
    eq(paise(r.body.totals.received_value), paise(p.body.summary.total_spend), `${m}: Σ ₹ Received = Purchase Report total_spend`);
    eq(r.body.matches_purchase_report, true, `${m}: the page's own check says it matches`);
    eq(r.body.counts.receipt_lines, p.body.summary.purchase_count, `${m}: receipt lines = Purchase Report purchase count`);
    // Keyed by NAME (the Purchase Report's by_item carries no id) and summed on
    // both sides, so two materials that share a name still compare like for like.
    const sumBy = (rows: any[], name: (x: any) => string, v: (x: any) => number[]) => {
      const out = new Map<string, number[]>();
      for (const x of rows) {
        const k = name(x); const prev = out.get(k) || [0, 0, 0]; const add = v(x);
        out.set(k, prev.map((p, j) => p + add[j]));
      }
      return out;
    };
    const mine = sumBy(r.body.items.filter((i: any) => i.received_lines > 0), i => i.item, i => [i.received_value, i.received_qty, i.received_lines]);
    const theirs = sumBy(p.body.by_item, b => b.material_name, b => [b.spend, b.qty, b.count]);
    let compared = 0; let bad = 0;
    for (const [name, [spend, qty, count]] of theirs) {
      const it = mine.get(name);
      if (!it) { bad++; console.log(`    missing item ${name}`); continue; }
      compared++;
      if (paise(it[0]) !== paise(spend) || Math.abs(it[1] - qty) > 1e-6 || it[2] !== count) {
        bad++; console.log(`    item ${name}: mine ₹${it[0]} ${it[1]} (${it[2]}) vs report ₹${spend} ${qty} (${count})`);
      }
    }
    ok(bad === 0 && compared === theirs.size && mine.size === theirs.size, `${m}: every Purchase Report item (${compared}) has the same ₹, qty and line count here, and no extra`);
    console.log(`    ${m}: ${compared} items compared, ₹${r.body.totals.received_value} = ₹${p.body.summary.total_spend}`);
    // Round-2 fix (screen-r1): ₹ Requested is rounded to the paisa per item, so
    // the rows as printed add up to the total printed under them — All and Kitchen.
    for (const v of [r, await call(`from=${from}&to=${to}`)]) {
      const label = `${m} ${v.body.department ? v.body.department.name : 'All'}`;
      const vals = (v.body.items as any[]).map(i => i.requested_value).filter(x => x != null) as number[];
      ok(vals.every(x => Math.abs(x * 100 - Math.round(x * 100)) < 1e-6), `${label}: every ₹ Requested is a whole number of paise`);
      eq(paise(v.body.totals.requested_value), vals.reduce((s, x) => s + paise(x), 0), `${label}: Σ ₹ Requested rows (to the paisa) = the total`);
    }
  }
  // A department view's ₹ Received is the same per-item figure (whole outlet).
  if (months[0]) {
    const m = months[0];
    const from = `${m}-01`; const to = `${m}-28`;
    const all = await call(`from=${from}&to=${to}&dept=all`);
    const kit = await call(`from=${from}&to=${to}`);
    const allBy = new Map<string, any>(all.body.items.map((i: any) => [i.material_id, i]));
    let same = 0; let diff = 0;
    for (const i of kit.body.items) {
      const a = allBy.get(i.material_id);
      if (a && paise(a.received_value) === paise(i.received_value) && paise(a.ordered_value) === paise(i.ordered_value)) same++; else diff++;
    }
    ok(diff === 0, `${m}: Kitchen view's Ordered / Received per item = the All view's (${same} items)`);
    eq(kit.body.department?.name, 'Kitchen', 'no dept parameter → the main department named Kitchen');
  }

  /* ══════════ B — seeded cases, March 2031 ══════════ */
  console.log('B  seeded cases');
  const mainNamed = (name: string) => db.prepare(`SELECT id FROM departments WHERE LOWER(TRIM(name)) = ? AND (parent_id IS NULL OR parent_id = '')`).get(name) as any;
  const KIT = mainNamed('kitchen')?.id; const BAR = mainNamed('bar')?.id;
  ok(KIT && BAR, 'the copy has main departments Kitchen and Bar');
  const KSEC = (db.prepare(`SELECT id, name FROM departments WHERE parent_id = ? ORDER BY name LIMIT 1`).get(KIT) as any);
  const BSEC = (db.prepare(`SELECT id, name FROM departments WHERE parent_id = ? ORDER BY name LIMIT 1`).get(BAR) as any);
  ok(KSEC && BSEC, 'Kitchen and Bar each have a section');

  const RAISER = mkUser('ZZRR Raiser', 'staff', { email: 'zzrr.raiser@test.local' });
  void RAISER;
  const mat = (name: string, unit: string, pu: string, pack: number, avg = 0) => {
    const id = uid('m');
    db.prepare(`INSERT INTO raw_materials (id, name, category, unit, purchase_unit, pack_size, average_price, current_stock, sku)
                VALUES (?, ?, 'zzrr', ?, ?, ?, ?, 0, ?)`).run(id, name, unit, pu, pack, avg, `ZZRR-${n}`);
    return id;
  };
  const M1 = mat('ZZRR FLOUR', 'g', 'kg', 1000, 0.05);
  const M2 = mat('ZZRR OIL', 'ml', 'L', 1000);
  const M3 = mat('ZZRR SALT', 'kg', 'kg', 1);
  const M4 = mat('ZZRR SUGAR', 'kg', 'kg', 1);
  const M5 = mat('ZZRR TOMATO', 'kg', 'kg', 1);
  const M6 = mat('ZZRR PAPER', 'pcs', 'pcs', 1);
  const M7 = mat('ZZRR LIME', 'kg', 'kg', 1);
  const M8 = mat('ZZRR MINT', 'kg', 'kg', 1);
  const M9 = mat('ZZRR BOUNDARY', 'kg', 'kg', 1, 10);
  const M10 = mat('ZZRR CREAM', 'ml', 'btl', 750);
  const M11 = mat('ZZRR SAFFRON', 'g', 'g', 1, 300);
  const M12 = mat('ZZRR NO RATE', 'kg', 'kg', 1, 0);
  const M13 = mat('ZZRR REJECT PART', 'kg', 'kg', 1);
  const M14 = mat('ZZRR TURNED AWAY', 'kg', 'kg', 1);
  const M15 = mat('ZZRR ZERO ONLY', 'kg', 'kg', 1);

  let reqNo = 0;
  // A line carries the header's department unless `dept` says otherwise (a "Multiple departments"
  // party line, or a line with NULL / blank department_id as legacy rows have).
  const req = (deptId: string, date: string, status: string, lines: Array<{ m: string; q: number; unit: string; rej?: number; srej?: number; dept?: string | null }>, drafted = 'zzrr.raiser@test.local') => {
    const id = uid('r');
    const number = `ZZRR-REQ-${String(++reqNo).padStart(3, '0')}`;
    db.prepare(`INSERT INTO requisitions (id, req_number, department_id, date, status, drafted_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, number, deptId, date, status, drafted);
    const itemIds: string[] = [];
    for (const l of lines) {
      const iid = uid('ri');
      db.prepare(`INSERT INTO requisition_items (id, req_id, material_id, quantity_requested, unit, is_rejected, store_rejected, department_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(iid, id, l.m, l.q, l.unit, l.rej || 0, l.srej || 0, l.dept === undefined ? deptId : l.dept);
      itemIds.push(iid);
    }
    return { id, number, itemIds };
  };
  let poNo = 0;
  const po = (date: string, status: string, lines: Array<{ m: string; q: number; rate: number; vendor?: string }>, merged = 0) => {
    const id = uid('po');
    const number = `ZZRR-PO-${String(++poNo).padStart(3, '0')}`;
    db.prepare(`INSERT INTO purchase_orders (id, po_number, date, vendor, status, merged) VALUES (?, ?, ?, 'ZZRR Vendor', ?, ?)`).run(id, number, date, status, merged);
    const itemIds: string[] = [];
    for (const l of lines) {
      const iid = uid('poi');
      db.prepare(`INSERT INTO purchase_order_items (id, po_id, material_id, quantity, unit_price, total_price, vendor) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(iid, id, l.m, l.q, l.rate, l.q * l.rate, l.vendor || 'ZZRR Vendor');
      itemIds.push(iid);
    }
    return { id, number, itemIds };
  };
  let grnNo = 0;
  const grn = (date: string, status: string, poId: string | null, lines: Array<{ m: string; recv: number; acc: number; rej?: number; rate: number; poItem?: string; book?: boolean }>) => {
    const id = uid('g');
    const number = `ZZRR-GRN-${String(++grnNo).padStart(3, '0')}`;
    db.prepare(`INSERT INTO goods_receipt_notes (id, grn_number, date, po_id, vendor, status) VALUES (?, ?, ?, ?, 'ZZRR Vendor', ?)`).run(id, number, date, poId, status);
    for (const l of lines) {
      db.prepare(`INSERT INTO goods_receipt_note_items (id, grn_id, po_item_id, material_id, quantity_received, quantity_accepted, quantity_rejected, unit_price)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(uid('gi'), id, l.poItem || null, l.m, l.recv, l.acc, l.rej || 0, l.rate);
      if (l.book) {
        db.prepare(`INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, grn_id)
                    VALUES (?, ?, 'ZZRR Vendor', '', ?, ?, ?, ?, ?, ?)`).run(uid('p'), l.m, l.acc, l.rate, l.acc * l.rate, date, `${number} test`, id);
      }
    }
    return { id, number };
  };
  const direct = (m: string, date: string, q: number, rate: number) =>
    db.prepare(`INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, invoice_id)
                VALUES (?, ?, 'ZZRR Shop', '', ?, ?, ?, ?, 'direct test', ?)`).run(uid('p'), m, q, rate, q * rate, date, `PINV-ZZRR-${n}`);

  const K = KSEC.id;   // a Kitchen SECTION — every Kitchen request below is raised by a sub-department
  // M1 — pack conversion: 5 kg + 2,000 g + a store-rejected 1 kg = 8 kg; not counted: HOD-rejected line,
  // a cancelled requisition, a chef-rejected requisition; a draft is not shown at all.
  req(K, '2031-03-02', 'fulfilled', [{ m: M1, q: 5, unit: 'kg' }, { m: M1, q: 2000, unit: 'g' }, { m: M1, q: 100, unit: 'kg', rej: 1 }, { m: M1, q: 0, unit: 'kg' }]);
  req(K, '2031-03-03', 'store_processed', [{ m: M1, q: 1, unit: 'kg', srej: 1 }]);
  req(K, '2031-03-04', 'cancelled', [{ m: M1, q: 50, unit: 'kg' }]);
  req(K, '2031-03-05', 'chef_rejected', [{ m: M1, q: 40, unit: 'kg' }]);
  req(K, '2031-03-06', 'draft', [{ m: M1, q: 30, unit: 'kg' }]);
  const p1 = po('2031-03-07', 'received', [{ m: M1, q: 7, rate: 50 }]);
  grn('2031-03-08', 'received', p1.id, [{ m: M1, recv: 6, acc: 6, rate: 50, poItem: p1.itemIds[0], book: true }]);
  // M2 — a cancelled PO (10 L, not counted) and a pending one (4 L, counted).
  req(K, '2031-03-02', 'submitted', [{ m: M2, q: 4, unit: 'L' }]);
  po('2031-03-07', 'cancelled', [{ m: M2, q: 10, rate: 100 }]);
  po('2031-03-08', 'pending', [{ m: M2, q: 4, rate: 100 }]);
  // M3 — vendor closed on the PO before anything arrived.
  req(K, '2031-03-02', 'fulfilled', [{ m: M3, q: 8, unit: 'kg' }]);
  const p3 = po('2031-03-09', 'approved', [{ m: M3, q: 8, rate: 20, vendor: 'ZZRR Closed Vendor' }, { m: M6, q: 0.5, rate: 40, vendor: 'ZZRR Other Vendor' }]);
  db.prepare(`INSERT INTO po_vendor_closures (id, po_id, vendor_id, vendor_name, reason, closed_by) VALUES (?, ?, NULL, 'ZZRR Closed Vendor', 'call 9876543210', 'test')`).run(uid('c'), p3.id);
  // M4 — the receipt was voided (its purchases row is gone, as grn-reversal leaves it).
  req(K, '2031-03-02', 'fulfilled', [{ m: M4, q: 5, unit: 'kg' }]);
  const p4 = po('2031-03-09', 'approved', [{ m: M4, q: 5, rate: 40 }]);
  grn('2031-03-10', 'void', p4.id, [{ m: M4, recv: 5, acc: 5, rate: 40, poItem: p4.itemIds[0], book: false }]);
  // M5 — held for the kitchen's quality check (no purchases row yet).
  req(K, '2031-03-02', 'fulfilled', [{ m: M5, q: 3, unit: 'kg' }]);
  grn('2031-03-11', 'awaiting_qc', null, [{ m: M5, recv: 3, acc: 0, rate: 100, book: false }]);
  // M6 — a direct purchase with no PO (and the 0.5 pcs line on PO 3 from another vendor, counted).
  req(K, '2031-03-02', 'fulfilled', [{ m: M6, q: 2, unit: 'pcs' }]);
  direct(M6, '2031-03-12', 2, 40);
  // M7 — ONE merged PO line serving a Kitchen request (3) AND a Bar request (2).
  const rk7 = req(K, '2031-03-02', 'fulfilled', [{ m: M7, q: 3, unit: 'kg' }]);
  const rb7 = req(BSEC.id, '2031-03-02', 'fulfilled', [{ m: M7, q: 2, unit: 'kg' }]);
  const p7 = po('2031-03-10', 'received', [{ m: M7, q: 5, rate: 60 }], 1);
  for (const [r, q] of [[rk7, 3], [rb7, 2]] as const) {
    db.prepare(`INSERT INTO po_requisition_lines (id, po_id, po_item_id, requisition_id, req_item_id, department_id, qty_purchase, qty_line, line_unit)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'kg')`).run(uid('l'), p7.id, p7.itemIds[0], r.id, r.itemIds[0], r === rk7 ? K : BSEC.id, q, q);
  }
  grn('2031-03-12', 'received', p7.id, [{ m: M7, recv: 5, acc: 5, rate: 60, poItem: p7.itemIds[0], book: true }]);
  // M8 — the Bar alone.
  req(BAR, '2031-03-02', 'fulfilled', [{ m: M8, q: 2, unit: 'kg' }]);
  // M9 — the last day of March is in; 1 April is out (and is alone in its own window).
  req(K, '2031-03-31', 'fulfilled', [{ m: M9, q: 1, unit: 'kg' }]);
  req(K, '2031-04-01', 'fulfilled', [{ m: M9, q: 9, unit: 'kg' }]);
  // M10 — a blank unit (read as the purchase unit) and a unit that cannot be converted; rate = latest purchase (January).
  req(K, '2031-03-02', 'fulfilled', [{ m: M10, q: 2, unit: '' }, { m: M10, q: 1, unit: 'box' }]);
  direct(M10, '2031-01-15', 1, 500);
  // M11 — no purchases ever: rate = average cost (₹300/g, pack 1).
  req(K, '2031-03-02', 'fulfilled', [{ m: M11, q: 0.5, unit: 'g' }]);
  // M12 — no rate at all; raised by a login that is not a user (an email).
  req(K, '2031-03-02', 'fulfilled', [{ m: M12, q: 1, unit: 'kg' }], 'ghost@nowhere.test');
  // M13 — 2 kg turned away at the door, 8 kg booked.
  req(K, '2031-03-02', 'fulfilled', [{ m: M13, q: 10, unit: 'kg' }]);
  const p13 = po('2031-03-09', 'received', [{ m: M13, q: 10, rate: 30 }]);
  grn('2031-03-13', 'received', p13.id, [{ m: M13, recv: 10, acc: 8, rej: 2, rate: 30, poItem: p13.itemIds[0], book: true }]);
  // M14 — the whole delivery turned away (nothing booked).
  req(K, '2031-03-02', 'fulfilled', [{ m: M14, q: 4, unit: 'kg' }]);
  grn('2031-03-14', 'received', null, [{ m: M14, recv: 4, acc: 0, rej: 4, rate: 25, book: false }]);
  // M15 — a line with no quantity asked (as the Recaho import left them) and nothing else: no row.
  req(K, '2031-03-02', 'fulfilled', [{ m: M15, q: 0, unit: 'kg' }]);
  // SUB-PAISA — three items bought at ₹10.005 each (nobody asked): rounding each to the
  // paisa first (10.01 × 3 = 30.03) would drift from the Purchase Report's SUM (30.015).
  const SP = [mat('ZZRR SUBPAISA A', 'kg', 'kg', 1), mat('ZZRR SUBPAISA B', 'kg', 'kg', 1), mat('ZZRR SUBPAISA C', 'kg', 'kg', 1)];
  for (const m of SP) direct(m, '2031-03-15', 1, 10.005);

  const MAR = 'from=2031-03-01&to=2031-03-31';
  const kit = await call(`${MAR}&dept=${KIT}`);
  eq(kit.status, 200, 'Kitchen, March 2031 answers');
  const K_ = kit.body;
  const by = (id: string) => K_.items.find((i: any) => i.material_id === id);
  eq(K_.department?.name, 'Kitchen', 'department named in the answer');
  eq(K_.items.map((i: any) => i.item).sort(), ['ZZRR BOUNDARY', 'ZZRR CREAM', 'ZZRR FLOUR', 'ZZRR LIME', 'ZZRR NO RATE', 'ZZRR OIL', 'ZZRR PAPER',
    'ZZRR REJECT PART', 'ZZRR SAFFRON', 'ZZRR SALT', 'ZZRR SUGAR', 'ZZRR TOMATO', 'ZZRR TURNED AWAY'],
    'Kitchen rows = the items a Kitchen SECTION asked for (Bar-only MINT and zero-only ZERO ONLY absent)');
  const f1 = by(M1);
  eq([f1.unit, f1.requested_qty, f1.requested_lines], ['kg', 8, 3], 'FLOUR: 5 kg + 2,000 g + store-rejected 1 kg = 8 kg (pack conversion), 3 counted lines');
  eq([f1.ordered_qty, f1.ordered_value, f1.received_qty, f1.received_value], [7, 350, 6, 300], 'FLOUR: ordered 7 kg ₹350, received 6 kg ₹300');
  eq([f1.ordered_minus_requested, f1.received_minus_ordered], [-1, -1], 'FLOUR: short 1 at each step');
  eq([f1.rate, f1.rate_basis, f1.requested_value], [50, 'received', 400], 'FLOUR: ₹ Requested estimate = 8 × the period’s received rate ₹50');
  const f2 = by(M2);
  eq([f2.ordered_qty, f2.ordered_value, f2.ordered_lines, f2.rate_basis, f2.requested_value], [4, 400, 1, 'ordered', 400], 'OIL: cancelled PO not counted; pending PO counted; rate from orders');
  const f3 = by(M3);
  eq([f3.ordered_qty, f3.closed_qty, f3.closed_lines, f3.received_qty], [0, 8, 1, 0], 'SALT: vendor-closed line not in Ordered, shown as closed 8');
  const f4 = by(M4);
  eq([f4.ordered_qty, f4.received_qty, f4.received_value], [5, 0, 0], 'SUGAR: voided receipt not in Received');
  const f5 = by(M5);
  eq([f5.received_qty, f5.held_qty, f5.held_value, f5.held_lines], [0, 3, 300, 1], 'TOMATO: QC-held 3 kg ₹300 shown separately, not received');
  const f6 = by(M6);
  eq([f6.ordered_qty, f6.received_qty, f6.received_value, f6.received_minus_ordered], [0.5, 2, 80, 1.5], 'PAPER: direct purchase with no PO counts as received; other-vendor PO line on the closed PO still counted');
  const f7 = by(M7);
  eq([f7.requested_qty, f7.ordered_qty, f7.received_qty], [3, 5, 5], 'LIME: Kitchen asked 3; merged PO line 5 (whole outlet); received 5');
  eq(f7.others, [{ department: 'Bar', qty: 2, lines: 1 }], 'LIME: the Bar’s 2 kg is named on the row');
  const f9 = by(M9);
  eq([f9.requested_qty, f9.rate_basis, f9.rate, f9.requested_value], [1, null, null, null], 'BOUNDARY: 31 March in, 1 April out; never bought → no rate (its average cost ₹10 is NOT used)');
  const f10 = by(M10);
  eq([f10.unit, f10.requested_qty, f10.requested_unit_assumed, f10.requested_unconverted], ['btl', 2, 1, 1], 'CREAM: blank unit read as btl; "box" left out');
  eq([f10.rate_basis, f10.rate, f10.rate_as_of, f10.requested_value], ['last_purchase', 500, '2031-01-15', 1000], 'CREAM: rate = latest purchase (January)');
  const f11 = by(M11);
  eq([f11.requested_qty, f11.rate_basis, f11.rate, f11.requested_value], [0.5, null, null, null], 'SAFFRON: never bought → no rate (its average cost ₹300/g is NOT used)');
  const f12 = by(M12);
  eq([f12.rate, f12.requested_value], [null, null], 'NO RATE: no rate → ₹ Requested blank');
  const f13 = by(M13);
  eq([f13.received_qty, f13.received_value, f13.received_minus_ordered], [8, 240, -2], 'REJECT PART: 8 kg booked, 2 short against the order');
  const f14 = by(M14);
  eq([f14.received_qty, f14.received_value], [0, 0], 'TURNED AWAY: nothing booked');
  // No rate under the rule: nothing booked or ordered (counted) in the period and no purchase ever.
  // SALT's only PO line was closed, TOMATO's only delivery is still held, TURNED AWAY booked nothing,
  // BOUNDARY and SAFFRON carry an average cost that is deliberately not used.
  eq(K_.items.filter((i: any) => i.requested_qty > 0 && i.rate == null).map((i: any) => i.item).sort(),
    ['ZZRR BOUNDARY', 'ZZRR NO RATE', 'ZZRR SAFFRON', 'ZZRR SALT', 'ZZRR TOMATO', 'ZZRR TURNED AWAY'], 'items with no rate are exactly the six with nothing counted at a price and no priced purchase on record');
  eq(K_.totals.items_without_rate, 6, 'six items without a rate, counted on the card');
  eq([by(M4).requested_value, by(M6).requested_value, by(M7).requested_value, by(M13).requested_value], [200, 80, 180, 300],
    'estimates: SUGAR 5 × PO ₹40, PAPER 2 × ₹40, LIME 3 × ₹60, REJECT PART 10 × ₹30');
  near(K_.totals.requested_value, 400 + 400 + 1000 + 200 + 80 + 180 + 300, 'Σ ₹ Requested = the rows that have a rate', 0.005);
  eq(paise(K_.totals.received_value), paise(300 + 80 + 300 + 240), 'Kitchen ₹ Received = FLOUR + PAPER + LIME + REJECT PART');
  eq(K_.counts.shared_items, 1, 'one shared item');
  eq([K_.counts.request_lines, K_.counts.requisitions, f10.requested_lines], [15, 14, 1],
    'counted request lines exclude the unconvertible and zero lines (15 lines, 14 requisitions; CREAM 1)');
  const d10 = (await call(`${MAR}&dept=${KIT}&material_id=${M10}`)).body;
  eq(d10.requests.map((r: any) => [r.qty, r.line_unit, r.qty_purchase, r.counted]), [[2, '', 2, true], [1, 'box', null, false]],
    'CREAM detail: the blank line keeps no unit (read as 2 btl, counted); the box line is not counted');
  ok(/No unit recorded on the line — read as btl/.test(d10.requests[0].note) && /“box” cannot be converted to btl/.test(d10.requests[1].note), 'CREAM detail: both notes say what happened');
  eq(K_.counts.unconverted_lines, 1, 'one unconvertible line counted in the note');
  eq(K_.counts.unit_assumed_lines, 1, 'one blank-unit line counted in the note');
  eq(K_.matches_purchase_report, null, 'a department view does not claim to match the whole Purchase Report');
  ok(!JSON.stringify(K_).includes('@'), 'no email anywhere in the Kitchen answer');

  // All departments: Received = the Purchase Report; the Bar-only item appears.
  const all = await call(`${MAR}&dept=all`);
  eq(all.body.items.length, 17, 'All departments: 17 items (MINT and the three bought-only SUBPAISA items included)');
  eq(all.body.matches_purchase_report, true, 'All departments: ₹ Received matches the Purchase Report');
  const pr = await purchaseReport('2031-03-01', '2031-03-31');
  near(all.body.totals.received_value, pr.body.summary.total_spend, 'All: Σ ₹ Received = Purchase Report total_spend, sub-paisa kept (₹950.015)', 1e-6);
  near(pr.body.summary.total_spend, 950.015, 'the Purchase Report books ₹950.015 for March 2031', 1e-6);
  near(all.body.items.filter((i: any) => i.item.startsWith('ZZRR SUBPAISA')).reduce((s: number, i: any) => s + i.received_value, 0), 30.015,
    'the three ₹10.005 items add to ₹30.015, not ₹30.03', 1e-9);
  for (const bi of pr.body.by_item as any[]) {
    const it = all.body.items.find((i: any) => i.item === bi.material_name);
    eq([paise(it?.received_value), it?.received_qty], [paise(bi.spend), bi.qty], `All: ${bi.material_name} = Purchase Report Item-wise Spend / Qty`);
  }
  eq(all.body.items.find((i: any) => i.material_id === M7).others, [], 'All: no "other departments" note');

  // Bar view.
  const bar = await call(`${MAR}&dept=${BAR}`);
  eq(bar.body.items.map((i: any) => i.item).sort(), ['ZZRR LIME', 'ZZRR MINT'], 'Bar: LIME (via its section) and MINT');
  eq(bar.body.items.find((i: any) => i.material_id === M7).others, [{ department: 'Kitchen', qty: 3, lines: 1 }], 'Bar: Kitchen’s 3 kg named');
  // A SECTION picked on its own (the API takes any department id).
  const sec = await call(`${MAR}&dept=${K}`);
  eq(sec.body.items.length, 13, 'the Kitchen section on its own has the same 13 items');

  /* ── drill-downs ── */
  const d1 = (await call(`${MAR}&dept=${KIT}&material_id=${M1}`)).body;
  const own1 = d1.requests.filter((r: any) => r.in_view);
  eq(own1.length, 7, 'FLOUR detail: 7 request lines shown (draft never shown)');
  eq(own1.filter((r: any) => r.counted).length, 3, 'FLOUR detail: 3 counted');
  ok(own1.some((r: any) => !r.counted && r.qty === 0 && /No quantity asked/.test(r.note)), 'FLOUR detail: the zero line is listed, not counted, says why');
  const d15 = (await call(`${MAR}&dept=${KIT}&material_id=${M15}`)).body;
  eq([d15.item, d15.requests.length, d15.requests[0]?.counted], [null, 1, false], 'ZERO ONLY detail: no row, its one line listed as not counted');
  const gLine = own1.find((r: any) => r.line_unit === 'g');
  eq([gLine.qty, gLine.qty_purchase], [2000, 2], 'FLOUR detail: 2,000 g shown as asked and as 2 kg');
  ok(own1.some((r: any) => !r.counted && /rejected by the HOD/.test(r.note)), 'FLOUR detail: HOD-rejected line not counted, says why');
  ok(own1.some((r: any) => !r.counted && /cancelled/.test(r.note)), 'FLOUR detail: cancelled requisition not counted, says why');
  ok(own1.some((r: any) => r.counted && /could not supply/.test(r.note)), 'FLOUR detail: store-rejected line counted, says so');
  eq(own1[0].raised_by, 'ZZRR Raiser', 'raised by = the user’s NAME');
  eq(own1[0].main_department, 'Kitchen', 'main department named');
  eq(own1[0].department, KSEC.name, 'section named');
  eq(d1.purchase_orders.length, 1, 'FLOUR detail: one PO line');
  eq([d1.purchase_orders[0].received_on_line, d1.purchase_orders[0].counted], [6, true], 'FLOUR detail: 6 accepted against the PO line');
  eq(d1.receipts.length, 1, 'FLOUR detail: one receipt line');
  ok(d1.receipts[0].grn_number.startsWith('ZZRR-GRN-') && d1.receipts[0].po_number.startsWith('ZZRR-PO-'), 'FLOUR detail: receipt names its GRN and PO');
  const d12 = (await call(`${MAR}&dept=${KIT}&material_id=${M12}`)).body;
  eq(d12.requests[0].raised_by, 'Unknown user', 'an email login with no user prints "Unknown user", never the email');
  const d2 = (await call(`${MAR}&dept=${KIT}&material_id=${M2}`)).body;
  eq(d2.purchase_orders.map((p: any) => [p.status_label, p.counted]), [['Cancelled', false], ['Awaiting approval', true]], 'OIL detail: cancelled shown not counted; pending counted');
  const d3 = (await call(`${MAR}&dept=${KIT}&material_id=${M3}`)).body;
  ok(d3.purchase_orders[0].counted === false && /Vendor closed/.test(d3.purchase_orders[0].note), 'SALT detail: closed line says so');
  ok(!JSON.stringify(d3).includes('9876543210'), 'SALT detail: the closure reason (could hold a phone number) is not printed');
  const d4 = (await call(`${MAR}&dept=${KIT}&material_id=${M4}`)).body;
  eq(d4.receipts.map((r: any) => [r.kind, r.counted, r.qty]), [['void', false, 5]], 'SUGAR detail: voided receipt listed, not counted');
  const d5 = (await call(`${MAR}&dept=${KIT}&material_id=${M5}`)).body;
  eq(d5.receipts.map((r: any) => [r.kind, r.counted, r.qty, r.value]), [['held', false, 3, 300]], 'TOMATO detail: held line listed with its value, not counted');
  const d6 = (await call(`${MAR}&dept=${KIT}&material_id=${M6}`)).body;
  ok(d6.receipts.some((r: any) => r.kind === 'booked' && r.grn_number === '' && /direct purchase entry/.test(r.status_label)), 'PAPER detail: a direct purchase entry');
  const d7 = (await call(`${MAR}&dept=${KIT}&material_id=${M7}`)).body;
  eq(d7.requests.filter((r: any) => !r.in_view).map((r: any) => [r.main_department, r.counted]), [['Bar', false]], 'LIME detail: the Bar’s request shown, not counted here');
  ok(d7.purchase_orders[0].raised_for.includes(rk7.number) && d7.purchase_orders[0].raised_for.includes(rb7.number), 'LIME detail: the merged PO line names both requisitions');
  const d13 = (await call(`${MAR}&dept=${KIT}&material_id=${M13}`)).body;
  eq(d13.receipts.map((r: any) => [r.kind, r.qty, r.rejected_qty]), [['booked', 8, 2]], 'REJECT PART detail: 8 booked, 2 rejected on the same receipt');
  const d14 = (await call(`${MAR}&dept=${KIT}&material_id=${M14}`)).body;
  eq(d14.receipts.map((r: any) => [r.kind, r.counted, r.qty, r.rejected_qty]), [['rejected', false, 0, 4]], 'TURNED AWAY detail: the delivery listed with 4 rejected');

  /* ══════════ C — windows ══════════ */
  console.log('C  windows');
  const empty = await call(`from=2031-05-01&to=2031-05-31&dept=${KIT}`);
  eq([empty.status, empty.body.items.length, empty.body.totals.received_value, empty.body.counts.request_lines], [200, 0, 0, 0], 'empty window: no rows, ₹0');
  const emptyAll = await call(`from=2031-05-01&to=2031-05-31&dept=all`);
  eq([emptyAll.body.items.length, emptyAll.body.matches_purchase_report], [0, true], 'empty window, All: 0 rows and still matches (₹0 = ₹0)');
  const one = await call(`from=2031-04-01&to=2031-04-01&dept=${KIT}`);
  eq(one.body.items.map((i: any) => [i.item, i.requested_qty]), [['ZZRR BOUNDARY', 9]], 'one-item window: only BOUNDARY, 9 kg');
  eq(T.plural(one.body.items.length, 'item', 'items'), '1 item', 'singular for one');
  eq([T.plural(0, 'item', 'items'), T.plural(2, 'item', 'items')], ['0 items', '2 items'], 'plural for 0 and many');
  const lastDay = await call(`from=2031-03-31&to=2031-03-31&dept=${KIT}`);
  eq(lastDay.body.items.map((i: any) => i.item), ['ZZRR BOUNDARY'], 'a document dated on the last day is inside the window');
  eq(T.periodWords('2031-03-01', '2031-03-31'), '1–31 Mar 2031', 'period words');

  /* ══════════ D — access ══════════ */
  console.log('D  access');
  as(null);
  eq((await call(MAR)).status, 401, 'signed out → 401');
  const tokFor = (userId: string) => {
    const tok = `tok-h-${userId}`;
    db.prepare(`INSERT OR IGNORE INTO sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01 00:00:00')`).run(tok, userId);
    return { tok };
  };
  const harnessUsers: Record<string, [string, number]> = {
    admin: ['5568741c0c5a8bb3686ec83cd99ed807', 200],
    storemgr: ['478b5015795854e77b19cefe1fd0d32d', 200],
    headchef_manager_tier: ['8dc583da35ff0ade5fbc6c2ac298b199', 200],
    bar_staff: ['2b1b68485c69bca06aeaff2aa8a02263', 403],
    tandoor_staff: ['ed8def10a15faa83d16a55f47bbd36ea', 403],
    continental_staff: ['1f5fe869c18554fbd36d95785ea2909c', 403],
  };
  for (const [label, [id, want]] of Object.entries(harnessUsers)) {
    if (!db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(id)) { console.log(`    (skip ${label}: not in this copy)`); continue; }
    as(tokFor(id));
    eq((await call(MAR)).status, want, `${label} → ${want}`);
  }
  as(mkUser('ZZRR Staff HOD', 'staff', { hod: 1 }));
  const refused = await call(MAR);
  eq([refused.status, refused.body.error], [403, 'This report is for management and the store manager only.'],
    'an HOD on the staff tier → 403 with a plain sentence (owner named admin, manager, store manager)');
  eq((await call(`${MAR}&format=xlsx`)).status, 403, 'the same user cannot download the file either');
  as(mkUser('ZZRR Staff Store', 'staff', { store: 1 }));
  eq((await call(MAR)).status, 200, 'a store manager on the staff tier → 200');
  as(mkUser('ZZRR Manager', 'manager'));
  eq((await call(MAR)).status, 200, 'manager tier → 200');
  as(ADMIN);
  eq((await call('from=2031-03-31&to=2031-03-01')).status, 400, 'from after to → 400');
  eq((await call('from=2031-3-1&to=2031-03-31')).status, 400, 'bad date → 400');
  eq((await call(`${MAR}&dept=nope`)).status, 400, 'unknown department → 400');
  eq((await call(`${MAR}&format=csv`)).status, 400, 'unknown format → 400');
  eq((await call(`${MAR}&format=xlsx&material_id=${M1}`)).status, 400, 'xlsx with material_id → 400');
  const P = '/reports/requested-vs-received';
  eq(T.REQ_RECON_PAGE, P, 'page path constant');
  ok(catalog.PAGE_CATALOG.some((s: any) => s.pages.some((p: any) => p.path === P && p.mgmtOnly === true && !p.financeCap)), 'catalog row: mgmtOnly, no financeCap');
  ok(fs.readFileSync(path.join(WT, 'src/components/Sidebar.tsx'), 'utf8').includes(`href: "${P}"`), 'Sidebar twin row present');
  eq(catalog.canAccessPage(P, { role: 'staff', page_access: null }), false, 'catalog: staff with "all pages" cannot open it');
  eq(catalog.canAccessPage(P, { role: 'staff', page_access: JSON.stringify(['/reports']) }), false, 'catalog: staff with a /reports prefix grant (e.g. Accounts) cannot');
  eq(catalog.canAccessPage(P, { role: 'staff', page_access: JSON.stringify(['/reports']), can_view_finance_reports: true }), false, 'catalog: the finance capability does not open it');
  eq(catalog.canAccessPage(P, { role: 'manager', page_access: null }), true, 'catalog: a manager with "all pages" can');
  eq(catalog.canAccessPage(P, { role: 'manager', page_access: JSON.stringify(['/store-dashboard']) }), false, 'catalog: a manager whose role map lacks it cannot until it is ticked');
  eq(catalog.canAccessPage(P, { role: 'admin', page_access: null }), true, 'catalog: admin can');

  /* ══════════ E — the Excel file ══════════ */
  console.log('E  Excel');
  const x = await call(`${MAR}&dept=${KIT}&format=xlsx`);
  eq(x.status, 200, 'xlsx answers');
  ok(String(x.headers.get('Content-Type')).includes('spreadsheetml'), 'xlsx content type');
  ok(/filename="requested-vs-received_kitchen_2031-03-01_2031-03-31\.xlsx"/.test(String(x.headers.get('Content-Disposition'))), 'xlsx file name');
  const wb = XLSX.read(x.body, { type: 'buffer' });
  eq(wb.SheetNames, ['Items', 'Requests', 'Purchase orders', 'Receipts', 'Summary'], 'five sheets');
  const items = XLSX.utils.sheet_to_json(wb.Sheets.Items, { defval: null }) as any[];
  eq(items.length, 13, 'Items sheet: 13 rows');
  const xf = items.find(r => r.Item === 'ZZRR FLOUR');
  eq([xf['Requested qty'], xf['Ordered qty'], xf['Received qty'], xf['₹ Requested (estimate)'], xf['₹ Ordered'], xf['₹ Received (booked into stock)']],
    [8, 7, 6, 400, 350, 300], 'Items sheet: FLOUR figures = the screen');
  eq(paise(items.reduce((s, r) => s + (Number(r['₹ Received (booked into stock)']) || 0), 0)), paise(K_.totals.received_value), 'Items sheet ₹ Received adds up to the screen');
  const reqs = XLSX.utils.sheet_to_json(wb.Sheets.Requests, { defval: null }) as any[];
  ok(reqs.some(r => r['Counted in Requested'] === 'No' && /rejected by the HOD/.test(r.Note || '')), 'Requests sheet: not-counted lines carry the reason');
  ok(reqs.some(r => r['Main department'] === 'Bar' && r['Counted in Requested'] === 'No'), 'Requests sheet: the Bar’s LIME line, not counted');
  ok(!reqs.some(r => /ZZRR-REQ-005\b/.test(r['Req No'] || '')), 'Requests sheet: the draft requisition is absent');
  const pos = XLSX.utils.sheet_to_json(wb.Sheets['Purchase orders'], { defval: null }) as any[];
  ok(pos.some(r => r.Status === 'Cancelled' && r['Counted in Ordered'] === 'No'), 'PO sheet: cancelled line not counted');
  const recs = XLSX.utils.sheet_to_json(wb.Sheets.Receipts, { defval: null }) as any[];
  ok(recs.some(r => /Held for the kitchen/.test(r.Status) && r['Counted in Received'] === 'No'), 'Receipts sheet: held line not counted');
  const allText = wb.SheetNames.map((s: string) => XLSX.utils.sheet_to_csv(wb.Sheets[s])).join('\n');
  ok(!allText.includes('@'), 'no email anywhere in the file');
  ok(!allText.includes('9876543210'), 'no phone number from a closure reason in the file');
  ok(allText.includes('ESTIMATE'), 'the Summary sheet says ₹ Requested is an estimate');
  const xa = await call(`${MAR}&dept=all&format=xlsx`);
  const wbAll = XLSX.read(xa.body, { type: 'buffer' });
  const sumAll = XLSX.utils.sheet_to_csv(wbAll.Sheets.Summary);
  ok(/Received total matches the Purchase Report,Yes/.test(sumAll), 'All-departments file states the Purchase Report match');
  const allItems = XLSX.utils.sheet_to_json(wbAll.Sheets.Items, { defval: null }) as any[];
  const summaryRows = XLSX.utils.sheet_to_json(wbAll.Sheets.Summary, { header: 1, defval: null }) as any[][];
  const recRow = summaryRows.find(r => r[0] === '₹ Received (booked into stock)');
  near(allItems.reduce((s, r) => s + (Number(r['₹ Received (booked into stock)']) || 0), 0), Number(recRow?.[1]),
    'All file: the Items column adds up to the Summary’s ₹ Received exactly (sub-paisa kept)', 1e-6);

  /* ══════════ F — round-2 fixes (June 2031, clear of every window above) ══════════ */
  console.log('F  round-2 fixes');
  as(ADMIN);
  // (1) ₹ Requested to the paisa per item: three items asked 1 kg each, bought at ₹10.005.
  const SR = [mat('ZZRR SUBREQ A', 'kg', 'kg', 1), mat('ZZRR SUBREQ B', 'kg', 'kg', 1), mat('ZZRR SUBREQ C', 'kg', 'kg', 1)];
  for (const m of SR) { req(K, '2031-06-02', 'fulfilled', [{ m, q: 1, unit: 'kg' }]); direct(m, '2031-06-03', 1, 10.005); }
  // (2) An id with no item record (as a "(material not linked)" row) asked 2, last bought in January at ₹7.
  // foreign_keys is OFF only around these two inserts on the harness copy, to make the orphan.
  const GHOST = uid('ghost');
  db.pragma('foreign_keys = OFF');
  req(K, '2031-06-04', 'fulfilled', [{ m: GHOST, q: 2, unit: 'kg' }]);
  direct(GHOST, '2031-01-20', 1, 7);
  db.pragma('foreign_keys = ON');
  const JUN = 'from=2031-06-01&to=2031-06-30';
  const jun = (await call(`${JUN}&dept=${KIT}`)).body;
  eq(jun.items.filter((i: any) => i.item.startsWith('ZZRR SUBREQ')).map((i: any) => [i.rate, i.rate_basis, i.requested_value]),
    [[10.005, 'received', 10.01], [10.005, 'received', 10.01], [10.005, 'received', 10.01]],
    'SUBREQ: rate ₹10.005 (received); each ₹ Requested rounded to the paisa, ₹10.01 — what the row prints');
  const gh = jun.items.find((i: any) => i.material_id === GHOST);
  eq([gh?.unlinked, gh?.requested_qty, gh?.rate_basis, gh?.rate, gh?.rate_as_of, gh?.requested_value], [true, 2, 'last_purchase', 7, '2031-01-20', 14],
    'an id with no item record still gets its latest purchase rate, so a blank rate always means no priced purchase on record');
  eq(paise(jun.totals.requested_value), 3 * 1001 + 1400, 'June Kitchen: ₹ Requested total = the rows as printed (3 × ₹10.01 + ₹14 = ₹44.03), not ₹44.015');
  eq(jun.totals.items_without_rate, 0, 'June Kitchen: no item without a rate');
  const junAll = (await call(`${JUN}&dept=all`)).body;
  const prJun = await purchaseReport('2031-06-01', '2031-06-30');
  near(junAll.totals.received_value, prJun.body.summary.total_spend, 'June All: ₹ Received keeps the sub-paisa and still = the Purchase Report (₹30.015)', 1e-9);
  near(prJun.body.summary.total_spend, 30.015, 'the Purchase Report books ₹30.015 for June 2031', 1e-9);
  eq(junAll.matches_purchase_report, true, 'June All: matches the Purchase Report');
  // (3) The no-rate words say what the code does.
  ok(!/never bought or ordered/.test(T.RULE_VALUES) && /never give a rate/.test(T.RULE_VALUES) && /whatever its date/.test(T.RULE_VALUES),
    'RULE_VALUES: names the lines that give no rate and that the latest purchase can be of any date');
  for (const name of ['ZZRR SALT', 'ZZRR TOMATO', 'ZZRR TURNED AWAY']) {
    eq(items.find(r => r.Item === name)?.Notes, T.NO_RATE_WORDS_SHORT, `Excel Notes, ${name}: the new no-rate words`);
  }
  ok(!allText.includes('No rate anywhere'), 'the old "No rate anywhere" words are gone from the file');
  const junX = await call(`${JUN}&dept=${KIT}&format=xlsx`);
  const junItems = XLSX.utils.sheet_to_json(XLSX.read(junX.body, { type: 'buffer' }).Sheets.Items, { defval: null }) as any[];
  const junSum = XLSX.utils.sheet_to_json(XLSX.read(junX.body, { type: 'buffer' }).Sheets.Summary, { header: 1, defval: null }) as any[][];
  eq(paise(junItems.reduce((s, r) => s + (Number(r['₹ Requested (estimate)']) || 0), 0)),
    paise(junSum.find(r => String(r[0]).startsWith('₹ Requested (estimate)'))?.[1]), 'June file: the Items ₹ Requested column adds up to the Summary');

  /* ══════════ G — round-3 fixes (August 2031, clear of every window above) ══════════ */
  console.log('G  round-3 fixes: a requisition line counts for ITS OWN department; whole quantities in the file print without a trailing "."');
  as(ADMIN);
  const PFLOUR = mat('ZZRR PARTY FLOUR', 'kg', 'kg', 1);
  const PVODKA = mat('ZZRR PARTY VODKA', 'ml', 'btl', 750);
  const PICE = mat('ZZRR PARTY ICE', 'kg', 'kg', 1);
  const PLEMON = mat('ZZRR PARTY LEMON', 'kg', 'kg', 1);
  // (1) A party requisition raised with "Multiple departments": the header takes the FIRST line's
  // department (requisitions/route.ts — here the Kitchen section); its second line is the Bar section's.
  const PR = req(K, '2031-08-02', 'fulfilled', [{ m: PFLOUR, q: 4, unit: 'kg' }, { m: PVODKA, q: 6, unit: 'btl', dept: BSEC.id }]);
  db.prepare(`UPDATE requisitions SET purpose = 'party', event_name = 'ZZRR Party', event_date = '2031-08-03' WHERE id = ?`).run(PR.id);
  // Lines with no department of their own (NULL; whitespace only) take the header's — here the Bar.
  const PRn = req(BAR, '2031-08-02', 'fulfilled', [{ m: PICE, q: 2, unit: 'kg', dept: null }, { m: PLEMON, q: 1.0004, unit: 'kg' }]);
  const PRw = req(BAR, '2031-08-03', 'fulfilled', [{ m: PICE, q: 3, unit: 'kg', dept: '  ' }]);
  // POs raised for the party lines, through each link the report reads:
  //  (a) the older one-requisition PO header (purchase_orders.requisition_id), no req_item_id;
  const pa = po('2031-08-04', 'approved', [{ m: PFLOUR, q: 4, rate: 50 }, { m: PVODKA, q: 6, rate: 900 }]);
  db.prepare(`UPDATE purchase_orders SET requisition_id = ? WHERE id = ?`).run(PR.id, pa.id);
  //  (b) the store's "also raise a PO" tick (purchase_order_items.req_item_id) on the Bar line;
  const pb = po('2031-08-05', 'approved', [{ m: PVODKA, q: 1, rate: 900 }]);
  db.prepare(`UPDATE purchase_order_items SET req_item_id = ? WHERE id = ?`).run(PR.itemIds[1], pb.itemIds[0]);
  //  (c) a merged PO's link row, its department written from the LINE as po-helpers.ts writes it.
  const pc = po('2031-08-06', 'approved', [{ m: PVODKA, q: 2, rate: 900 }], 1);
  db.prepare(`INSERT INTO po_requisition_lines (id, po_id, po_item_id, requisition_id, req_item_id, department_id, qty_purchase, qty_line, line_unit, is_party)
              VALUES (?, ?, ?, ?, ?, ?, 2, 2, 'btl', 1)`).run(uid('l'), pc.id, pc.itemIds[0], PR.id, PR.itemIds[1], BSEC.id);
  // LEMON asked 1.0004 kg, ordered 1 kg: Ordered − Requested = −0.0004 (too small for 3 decimals).
  po('2031-08-07', 'approved', [{ m: PLEMON, q: 1, rate: 80 }]);
  const AUG = 'from=2031-08-01&to=2031-08-31';
  const gK = (await call(`${AUG}&dept=${KIT}`)).body;
  const gB = (await call(`${AUG}&dept=${BAR}`)).body;
  const gA = (await call(`${AUG}&dept=all`)).body;
  eq(gK.items.map((i: any) => [i.item, i.requested_qty, i.requested_lines, i.others]), [['ZZRR PARTY FLOUR', 4, 1, []]],
    'Kitchen, Aug: only the party requisition’s Kitchen line — its Bar line under the Kitchen header is NOT a Kitchen request');
  eq([gK.counts.requisitions, gK.counts.request_lines, gK.counts.shared_items], [1, 1, 0], 'Kitchen, Aug: 1 requisition, 1 line, nothing shared');
  eq(gB.items.map((i: any) => [i.item, i.requested_qty, i.requested_lines, i.others]),
    [['ZZRR PARTY ICE', 5, 2, []], ['ZZRR PARTY LEMON', 1.0004, 1, []], ['ZZRR PARTY VODKA', 6, 1, []]],
    'Bar, Aug: the party’s Bar line (6 btl) counts for the Bar; NULL / blank line departments take the header’s (Bar): ICE 2 + 3 kg');
  eq([gB.counts.requisitions, gB.counts.request_lines], [3, 4], 'Bar, Aug: 3 requisitions (the party one included), 4 lines');
  eq([gA.items.length, gA.counts.requisitions, gA.counts.request_lines], [4, 3, 5], 'All, Aug: 4 items, each requisition once, 5 lines');
  const dvB = (await call(`${AUG}&dept=${BAR}&material_id=${PVODKA}`)).body;
  eq(dvB.requests.map((r: any) => [r.req_number, r.main_department, r.department, r.in_view, r.counted, r.party, r.qty, r.line_unit]),
    [[PR.number, 'Bar', BSEC.name, true, true, true, 6, 'btl']], 'VODKA detail, Bar view: the party line names the Bar section, counted here, marked party');
  const dvK = (await call(`${AUG}&dept=${KIT}&material_id=${PVODKA}`)).body;
  eq([dvK.item, dvK.requests.map((r: any) => [r.main_department, r.department, r.in_view, r.counted, r.note])],
    [null, [['Bar', BSEC.name, false, false, 'Another department’s request']]], 'VODKA detail, Kitchen view: no Kitchen row; the line is shown as the Bar’s request');
  const raisedFor = (d: any) => d.purchase_orders.map((p: any) => [p.po_number, p.raised_for]);
  eq(raisedFor(dvB), [[pa.number, `${PR.number} (${BSEC.name})`], [pb.number, `${PR.number} (${BSEC.name})`], [pc.number, `${PR.number} (${BSEC.name})`]],
    'VODKA detail: every PO link (the PO header, the store tick, a merged PO) names the Bar line’s section, never the Kitchen header');
  const dfK = (await call(`${AUG}&dept=${KIT}&material_id=${PFLOUR}`)).body;
  eq(raisedFor(dfK), [[pa.number, `${PR.number} (${KSEC.name})`]], 'FLOUR detail: the same PO header names the Kitchen line’s section');
  eq(dfK.requests.map((r: any) => [r.main_department, r.department, r.counted]), [['Kitchen', KSEC.name, true]], 'FLOUR detail: the Kitchen line names the Kitchen section');
  const diB = (await call(`${AUG}&dept=${BAR}&material_id=${PICE}`)).body;
  eq(diB.requests.map((r: any) => [r.req_number, r.main_department, r.department, r.counted]), [[PRn.number, 'Bar', 'Bar', true], [PRw.number, 'Bar', 'Bar', true]],
    'ICE detail: lines with no department of their own name the header’s (Bar)');
  const gxB = XLSX.read((await call(`${AUG}&dept=${BAR}&format=xlsx`)).body, { type: 'buffer', cellNF: true });
  eq((XLSX.utils.sheet_to_json(gxB.Sheets.Requests, { defval: null }) as any[]).filter(r => r.Item === 'ZZRR PARTY VODKA')
    .map(r => [r['Req No'], r['Main department'], r['Department / section'], r.Party, r['Counted in Requested']]),
    [[PR.number, 'Bar', BSEC.name, 'Party', 'Yes']], 'Bar file, Requests: the party’s Bar line, named Bar, counted');
  const gxBpo = (XLSX.utils.sheet_to_json(gxB.Sheets['Purchase orders'], { defval: null }) as any[]).filter(r => r.Item === 'ZZRR PARTY VODKA');
  eq(gxBpo.map(r => r['Raised for']), [1, 2, 3].map(() => `${PR.number} (${BSEC.name})`), 'Bar file, Purchase orders: Raised for names the Bar section on all three');
  const gxK = XLSX.read((await call(`${AUG}&dept=${KIT}&format=xlsx`)).body, { type: 'buffer' });
  eq((XLSX.utils.sheet_to_json(gxK.Sheets.Items, { defval: null }) as any[]).map(r => r.Item), ['ZZRR PARTY FLOUR'], 'Kitchen file, Items: FLOUR only');
  eq((XLSX.utils.sheet_to_json(gxK.Sheets.Requests, { defval: null }) as any[]).map(r => [r.Item, r['Main department'], r['Department / section']]),
    [['ZZRR PARTY FLOUR', 'Kitchen', KSEC.name]], 'Kitchen file, Requests: the Kitchen line only, named the Kitchen section');

  // (2) The file's quantities, read back WITH their number formats (cellNF): a whole number
  // prints with no trailing "." ("8", "-1", "2,000", not "8.", "-1.", "2,000."); 1.0004 prints
  // "1", as the screen's 3-decimal figure does. A real fraction keeps '#,##0.###' (Excel prints
  // 0.5 as "0.5"); SheetJS's own previewer cannot render that format for a fraction (w comes
  // back empty), so those cells are held to the rule that makes the "." impossible instead:
  // the value is NOT whole at 3 decimals, so a decimal digit is always left to print.
  const cellOf = (ws: any, header: string, pick: (row: Record<string, unknown>) => boolean) => {
    const rg = XLSX.utils.decode_range(ws['!ref']);
    const heads: unknown[] = [];
    for (let c = rg.s.c; c <= rg.e.c; c++) heads.push(ws[XLSX.utils.encode_cell({ r: 0, c })]?.v);
    for (let r = 1; r <= rg.e.r; r++) {
      const row: Record<string, unknown> = {};
      heads.forEach((h, c) => { row[String(h)] = ws[XLSX.utils.encode_cell({ r, c })]?.v; });
      if (pick(row)) { const c = ws[XLSX.utils.encode_cell({ r, c: heads.indexOf(header) })]; return c ? [c.v, c.w ?? null, c.z] : null; }
    }
    return null;
  };
  const wbNF = XLSX.read(x.body, { type: 'buffer', cellNF: true });   // the Kitchen March file
  eq(cellOf(wbNF.Sheets.Items, 'Requested qty', r => r.Item === 'ZZRR FLOUR'), [8, '8', '#,##0'], 'file: FLOUR Requested qty 8 prints "8"');
  eq(cellOf(wbNF.Sheets.Items, 'Ordered − Requested (qty)', r => r.Item === 'ZZRR FLOUR'), [-1, '-1', '#,##0'], 'file: FLOUR Ordered − Requested −1 prints "-1"');
  eq(cellOf(wbNF.Sheets.Items, 'Received − Ordered (qty)', r => r.Item === 'ZZRR SUGAR'), [-5, '-5', '#,##0'], 'file: SUGAR Received − Ordered −5 prints "-5"');
  eq(cellOf(wbNF.Sheets.Items, 'Received qty', r => r.Item === 'ZZRR SUGAR'), [0, '0', '#,##0'], 'file: a zero prints "0"');
  eq(cellOf(wbNF.Sheets.Items, 'Requested qty', r => r.Item === 'ZZRR SAFFRON'), [0.5, null, '#,##0.###'], 'file: SAFFRON 0.5 keeps the 3-decimal format');
  eq(cellOf(wbNF.Sheets.Requests, 'Qty asked', r => r.Item === 'ZZRR FLOUR' && r['Unit asked in'] === 'g'), [2000, '2,000', '#,##0'], 'file: 2,000 g asked prints "2,000"');
  eq(cellOf(gxB.Sheets.Items, 'Requested qty', r => r.Item === 'ZZRR PARTY LEMON'), [1.0004, '1', '#,##0'], 'file: 1.0004 prints "1" (3 decimals, as the screen), never "1."');
  eq(cellOf(gxB.Sheets.Requests, 'Qty asked', r => r.Item === 'ZZRR PARTY LEMON'), [1.0004, '1', '#,##0'], 'file: 1.0004 asked prints "1"');
  eq(cellOf(gxB.Sheets.Items, 'Ordered − Requested (qty)', r => r.Item === 'ZZRR PARTY LEMON'), [-0.0004, '-0.0004', 'General'],
    'file: −0.0004 (too small for 3 decimals) prints as itself, never "-0" or "-0."');
  const wholeAt3 = (v: number) => Math.round(Math.abs(v) * 1000) % 1000 === 0;
  for (const [label, book] of [['Kitchen March', wbNF], ['Bar August', gxB]] as const) {
    const dotted: string[] = []; const wholeFraction: string[] = []; const unchecked: string[] = []; let numeric = 0; let fractions = 0;
    for (const s of book.SheetNames) {
      const ws = book.Sheets[s];
      for (const addr of Object.keys(ws)) {
        const c = ws[addr];
        if (addr[0] === '!' || c.t !== 'n') continue;
        numeric++;
        if (c.z === '#,##0.###') { fractions++; if (wholeAt3(c.v)) wholeFraction.push(`${s}!${addr}=${c.v}`); continue; }
        if (c.w == null) { if (c.z !== '#,##0.00##') unchecked.push(`${s}!${addr} (${c.z})`); continue; }   // the rate format always prints 2 decimals
        if (/\.$/.test(String(c.w))) dotted.push(`${s}!${addr}="${c.w}"`);
      }
    }
    ok(numeric > 0, `${label} file has numbers to check`);
    eq(dotted, [], `${label} file: no number on any sheet prints with a trailing "." (${numeric} numeric cells)`);
    eq(wholeFraction, [], `${label} file: every '#,##0.###' cell (${fractions}) is a real fraction at 3 decimals`);
    eq(unchecked, [], `${label} file: every number was checked`);
  }

  /* ══════════ H — round-2 fixer (November 2031): an HOD-approved requisition's status words ══════════ */
  // data-r1: every chef_approved requisition printed "With Mgmt". An internal one never had a
  // Mgmt gate, and a party one has it only while require_mgmt_approval is '1' — otherwise it is
  // with the store, and the store's desk says "With Store". The words must follow the store
  // inbox (GET /api/requisitions?inbox=store, the REAL route), on screen and in the file alike.
  console.log('H  status words: an HOD-approved requisition says where it really sits (the store inbox), screen = Excel');
  as(ADMIN);
  const reqRoute = require(path.join(WT, 'src/app/api/requisitions/route.ts'));
  const storeInbox = async (from: string, to: string) => {
    const res = await reqRoute.GET(new Request(`http://t/api/requisitions?inbox=store&from=${from}&to=${to}`));
    const j = await res.json();
    ok(res.status === 200 && Array.isArray(j.requisitions), `store inbox ${from}–${to} answers (HTTP ${res.status})`);
    return new Set<string>((j.requisitions || []).map((r: any) => String(r.req_number)));
  };
  const settingRow = db.prepare(`SELECT value FROM settings WHERE key = 'require_mgmt_approval'`);
  const setGate = (v: string) => db.prepare(`INSERT INTO settings (key, value) VALUES ('require_mgmt_approval', ?)
                                              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(v);
  const prevGate = settingRow.get() as { value?: string } | undefined;
  // (1) The REAL chef_approved requisitions on the copy (REQ-WATEST-0002 among them), before any
  // setting is touched: each line's words = what the store inbox says of that requisition.
  const realCa = db.prepare(`
    SELECT r.req_number, r.date, COALESCE(r.purpose, '') AS purpose, ri.material_id
      FROM requisition_items ri JOIN requisitions r ON r.id = ri.req_id
     WHERE r.status = 'chef_approved' AND r.date < '2031' ORDER BY r.date, r.req_number LIMIT 6`).all() as any[];
  console.log(`    ${realCa.length} real chef_approved line(s) on the copy; require_mgmt_approval = ${prevGate ? JSON.stringify(prevGate.value) : '(no row)'}`);
  for (const rc of realCa) {
    const inbox = await storeInbox(rc.date, rc.date);
    const d = (await call(`from=${rc.date}&to=${rc.date}&dept=all&material_id=${rc.material_id}`)).body;
    const row = (d.requests as any[]).find(r => r.req_number === rc.req_number);
    eq(row?.status_label, inbox.has(rc.req_number) ? 'With Store' : 'With Mgmt',
      `real ${rc.req_number} (${rc.purpose}, ${rc.date}): the drill-down's words follow the store inbox`);
    if (!prevGate || prevGate.value !== '1') eq(row?.status_label, 'With Store', `real ${rc.req_number}: gate off → "With Store", never "With Mgmt"`);
  }
  // (2) Seeded, November 2031: internal and party at chef_approved, plus mgmt_approved and submitted.
  const HM = mat('ZZRR STATUS WORDS', 'kg', 'kg', 1);
  const hInt = req(K, '2031-11-02', 'chef_approved', [{ m: HM, q: 1, unit: 'kg' }]);          // purpose: the column default, 'internal'
  const hParty = req(K, '2031-11-03', 'chef_approved', [{ m: HM, q: 2, unit: 'kg' }]);
  const hPartyMg = req(K, '2031-11-04', 'mgmt_approved', [{ m: HM, q: 3, unit: 'kg' }]);
  for (const r of [hParty, hPartyMg]) {
    db.prepare(`UPDATE requisitions SET purpose = 'party', event_name = 'ZZRR Status Party', event_date = '2031-11-07' WHERE id = ?`).run(r.id);
  }
  const hSub = req(K, '2031-11-05', 'submitted', [{ m: HM, q: 4, unit: 'kg' }]);
  eq((db.prepare(`SELECT purpose FROM requisitions WHERE id = ?`).get(hInt.id) as any)?.purpose, 'internal', 'seeded internal requisition carries purpose internal');
  const NOV = 'from=2031-11-01&to=2031-11-30';
  const statusWords = async () => {
    const d = (await call(`${NOV}&dept=${KIT}&material_id=${HM}`)).body;
    const screen = (d.requests as any[]).map(r => [r.req_number, r.status_label]).sort();
    const wbH = XLSX.read((await call(`${NOV}&dept=${KIT}&format=xlsx`)).body, { type: 'buffer' });
    const file = (XLSX.utils.sheet_to_json(wbH.Sheets.Requests, { defval: null }) as any[])
      .filter(r => r.Item === 'ZZRR STATUS WORDS').map(r => [r['Req No'], r.Status]).sort();
    return { screen, file };
  };
  const gateStates: Array<[string, string | null, boolean]> = [];
  if (!prevGate) gateStates.push(['no require_mgmt_approval row (gate off, the default)', null, false]);
  gateStates.push(["require_mgmt_approval '0' (gate off)", '0', false], ["require_mgmt_approval '1' (gate on)", '1', true], ["back to '0'", '0', false]);
  for (const [label, v, on] of gateStates) {
    if (v != null) setGate(v);
    const inbox = await storeInbox('2031-11-01', '2031-11-30');
    const want = [
      [hInt.number, 'With Store'], [hParty.number, on ? 'With Mgmt' : 'With Store'],
      [hPartyMg.number, 'With Store'], [hSub.number, 'With HOD'],
    ].sort();
    const { screen, file } = await statusWords();
    eq(screen, want, `${label}: drill-down status words (internal chef_approved "With Store" under either setting)`);
    eq(file, want, `${label}: the Excel Requests sheet's Status = the drill-down`);
    eq([inbox.has(hInt.number), inbox.has(hParty.number), inbox.has(hPartyMg.number), inbox.has(hSub.number)], [true, !on, true, false],
      `${label}: the store inbox holds what the words say is "With Store", and only that`);
  }
  // The copy is left as it was found: its old value, or '0' — which every reader treats exactly as no row.
  setGate(prevGate?.value != null ? String(prevGate.value) : '0');
  ok(!/With Mgmt/.test(JSON.stringify((await call(`${NOV}&dept=${KIT}&material_id=${HM}`)).body)) || (prevGate?.value === '1'),
    'gate restored off: no "With Mgmt" left on the seeded lines');

  /* ══════════ I — wording fixes (September 2031, clear of every window above) ══════════ */
  console.log('I  wording: the Held-for-QC card names its scope; the file says held goods were delivered; "PO" stays "PO"; "with its sections" only where there are sections');
  as(ADMIN);
  const pageSrc = fs.readFileSync(path.join(WT, 'src/app/reports/requested-vs-received/page.tsx'), 'utf8');
  const libSrc = fs.readFileSync(path.join(WT, 'src/lib/req-recon.ts'), 'utf8');
  const SEP = 'from=2031-09-01&to=2031-09-30';

  // (1) The Held-for-QC card. A Kitchen section asks for HELD MINE; the Bar asks for HELD OTHER, whose
  // delivery dated in September is held for the kitchen's check. HELD MINE has a delivery dated 31 August
  // that is still held — before the period, so not counted in September.
  const HMINE = mat('ZZRR HELD MINE', 'kg', 'kg', 1);
  const HOTHER = mat('ZZRR HELD OTHER', 'kg', 'kg', 1);
  req(K, '2031-09-02', 'fulfilled', [{ m: HMINE, q: 2, unit: 'kg' }]);
  req(BAR, '2031-09-02', 'fulfilled', [{ m: HOTHER, q: 4, unit: 'kg' }]);
  grn('2031-09-05', 'awaiting_qc', null, [{ m: HOTHER, recv: 4, acc: 0, rate: 25, book: false }]);
  grn('2031-08-31', 'awaiting_qc', null, [{ m: HMINE, recv: 2, acc: 0, rate: 30, book: false }]);
  const iK = (await call(`${SEP}&dept=${KIT}`)).body;
  const iB = (await call(`${SEP}&dept=${BAR}`)).body;
  const iA = (await call(`${SEP}&dept=all`)).body;
  eq([iK.items.map((i: any) => i.item), iK.counts.held_lines, iK.totals.held_value], [['ZZRR HELD MINE'], 0, 0],
    'Kitchen, Sep: its one item, nothing held for it in the period (its 31 Aug delivery is before it)');
  eq([iA.counts.held_lines, iA.totals.held_value], [1, 100], 'All, Sep: the outlet DOES have a delivery held for QC (HELD OTHER, 4 × ₹25)');
  eq([iB.counts.held_lines, iB.totals.held_value], [1, 100], 'Bar, Sep: that held delivery is for an item the Bar asked for');
  const kWords = T.heldCardWords(iK.counts.held_lines, !!iK.department);
  eq(kWords, 'No delivery of these items in this period is held for QC', 'Kitchen card (zero): scoped to the rows and to the period');
  ok(!/Nothing waiting/.test(kWords), 'Kitchen card no longer says "Nothing waiting for the kitchen’s check" while the outlet has a delivery held');
  eq(T.heldCardWords(iB.counts.held_lines, !!iB.department), '1 receipt line for these items waiting for the kitchen’s check', 'Bar card (non-zero): the same scope');
  eq(T.heldCardWords(3, true), '3 receipt lines for these items waiting for the kitchen’s check', 'department card (non-zero), plural');
  eq(T.heldCardWords(iA.counts.held_lines, !!iA.department), '1 receipt line waiting for the kitchen’s check', 'All card (non-zero): every item, words as before');
  eq(T.heldCardWords(0, false), 'No delivery in this period is held for QC', 'All card (zero): names the period');
  const augAll = (await call('from=2031-08-01&to=2031-08-31&dept=all')).body;
  ok(augAll.items.some((i: any) => i.material_id === HMINE && i.held_qty === 2),
    'the 31 Aug delivery of HELD MINE IS still held (counted in August) — so the zero words must say "in this period"');
  ok(pageSrc.includes('sub={heldCardWords(c.held_lines, !!data.department)}'), 'page: the card prints heldCardWords for the view');
  ok(!pageSrc.includes('Nothing waiting for the kitchen'), 'page: the unscoped "Nothing waiting" words are gone');
  ok(pageSrc.includes('title="Delivered, waiting for the kitchen’s quality check — not in Received yet"'),
    'page: the Held for QC column tooltip (one item per row) says delivered, not in Received yet');

  // (2) The Excel Items header for the held quantity: the goods WERE delivered (GRN quantity_received).
  const heldHead = 'Held for QC (qty, delivered, not in Received yet)';
  const marchHeads = (XLSX.utils.sheet_to_json(wb.Sheets.Items, { header: 1 }) as any[][])[0];
  ok(marchHeads.includes(heldHead) && !marchHeads.includes('Held for QC (qty, not received yet)'), 'Excel Items: the held column says "delivered, not in Received yet"');
  eq(items.find(r => r.Item === 'ZZRR TOMATO')?.[heldHead], 3, 'Excel Items: TOMATO’s 3 kg held for QC sits under that header');
  ok(!allText.includes('not received yet'), 'no sheet says held goods were "not received"');
  const marchSum = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1, defval: null }) as any[][];
  ok(marchSum.some(r => r[0] === '₹ Held for QC (delivered, not booked yet)'), 'Summary: "₹ Held for QC (delivered, not booked yet)" — the same fact as the header');
  const sepBarX = XLSX.read((await call(`${SEP}&dept=${BAR}&format=xlsx`)).body, { type: 'buffer' });
  eq((XLSX.utils.sheet_to_json(sepBarX.Sheets.Items, { defval: null }) as any[]).find(r => r.Item === 'ZZRR HELD OTHER')?.[heldHead], 4,
    'Bar Sep file: HELD OTHER’s 4 kg under the held header');

  // (3) The rate basis mid-sentence keeps "PO" in capitals.
  eq(T.RATE_BASIS_WORDS_MID[f2.rate_basis], 'average PO rate in this period', 'OIL (rate from orders): the dialog says "average PO rate in this period"');
  for (const k of Object.keys(T.RATE_BASIS_WORDS)) {
    const full = String(T.RATE_BASIS_WORDS[k]);
    eq(T.RATE_BASIS_WORDS_MID[k], full.charAt(0).toLowerCase() + full.slice(1), `rate words "${k}" mid-sentence: only the first letter lowered`);
  }
  ok(!/RATE_BASIS_WORDS\[[^\]]+\]\.toLowerCase\(\)/.test(pageSrc) && pageSrc.includes('{RATE_BASIS_WORDS_MID[item.rate_basis]}'),
    'page: the dialog prints the mid-sentence words, never toLowerCase()');

  // (4) "with its sections" only where there are sections — by the report's own subtree rule.
  const mkDept = (name: string, parent: string | null) => {
    const id = uid('d');
    db.prepare(`INSERT INTO departments (id, name, parent_id, is_active) VALUES (?, ?, ?, 1)`).run(id, name, parent);
    return id;
  };
  const DN = mkDept('ZZRR NO SECTIONS', null);
  const DW = mkDept('ZZRR WITH SECTION', null);
  const DWS = mkDept('ZZRR WITH SECTION - Sub', DW);
  const SM1 = mat('ZZRR SECTION ITEM A', 'kg', 'kg', 1);
  const SM2 = mat('ZZRR SECTION ITEM B', 'kg', 'kg', 1);
  req(DN, '2031-09-03', 'fulfilled', [{ m: SM1, q: 1, unit: 'kg' }]);
  req(DWS, '2031-09-03', 'fulfilled', [{ m: SM2, q: 1, unit: 'kg' }]);
  const vN = (await call(`${SEP}&dept=${DN}`)).body;
  const vW = (await call(`${SEP}&dept=${DW}`)).body;
  eq([vN.department?.has_sections, vN.items.map((i: any) => i.item)], [false, ['ZZRR SECTION ITEM A']], 'no sections: has_sections false, its view = its own request');
  eq([vW.department?.has_sections, vW.items.map((i: any) => i.item)], [true, ['ZZRR SECTION ITEM B']],
    'one section: has_sections true, and its view takes in the SECTION’s request — the flag and the data use one rule');
  eq(T.deptViewWords(vN.department), 'ZZRR NO SECTIONS', '"Showing" / dialog words: the plain name when there are no sections');
  eq(T.deptViewWords(vW.department), 'ZZRR WITH SECTION (with its sections)', '"Showing" / dialog words: "(with its sections)" when there is one');
  eq(T.deptViewWords(iK.department), 'Kitchen (with its sections)', '"Showing" words: Kitchen (with its sections)');
  eq(T.deptViewWords(null), 'All departments', '"Showing" words: All departments');
  const pick = new Map<string, any>(vN.departments.map((d: any) => [d.name, d] as [string, any]));
  eq(T.deptOptionWords(pick.get('ZZRR NO SECTIONS')), 'ZZRR NO SECTIONS', 'picker: no "with its sections" for a department without');
  eq(T.deptOptionWords(pick.get('ZZRR WITH SECTION')), 'ZZRR WITH SECTION — with its sections', 'picker: "— with its sections" where there is one');
  eq(T.deptOptionWords(pick.get('Kitchen')), 'Kitchen — with its sections', 'picker: Kitchen — with its sections');
  eq(T.deptOptionWords({ id: 'x', name: 'Old Store', is_active: false, has_sections: false }), 'Old Store (inactive)', 'picker: inactive, no sections');
  ok(!pick.has('ZZRR WITH SECTION - Sub'), 'picker: a section is not offered as a main department');
  const childOf = db.prepare(`SELECT 1 FROM departments WHERE parent_id = ? AND id <> ? LIMIT 1`);
  eq(vN.departments.filter((d: any) => d.has_sections !== !!childOf.get(d.id, d.id)).map((d: any) => d.name), [],
    `every picker department (${vN.departments.length}) says it has sections exactly when a department sits under it`);
  for (const nm of ['ACCOUNTS', 'HR']) {
    const d = pick.get(nm);
    if (!d) { console.log(`    (skip ${nm}: not in this copy)`); continue; }
    eq([d.has_sections, T.deptOptionWords(d)], [false, nm], `${nm}: no sections, so the picker shows just "${nm}"`);
    eq(T.deptViewWords((await call(`${SEP}&dept=${d.id}`)).body.department), nm, `${nm} view: "Showing ${nm}", no "with its sections"`);
  }
  eq((await call(`${SEP}&dept=${K}`)).body.department?.has_sections, false, 'a Kitchen section picked on its own: no sections under it');
  eq((await call(`${SEP}&dept=${DN}&material_id=${SM1}`)).body.department?.has_sections, false, 'drill-down: the same department, no sections');
  const sumDept = async (deptQ: string) => (XLSX.utils.sheet_to_json(
    XLSX.read((await call(`${SEP}&dept=${deptQ}&format=xlsx`)).body, { type: 'buffer' }).Sheets.Summary, { header: 1, defval: null },
  ) as any[][]).find(r => r[0] === 'Department')?.[1];
  eq(await sumDept(DN), 'ZZRR NO SECTIONS', 'Excel Summary: Department = the plain name when it has no sections');
  eq(await sumDept(DW), 'ZZRR WITH SECTION (with its sections)', 'Excel Summary: "(with its sections)" when it has one');
  eq(await sumDept(KIT), 'Kitchen (with its sections)', 'Excel Summary: Kitchen (with its sections)');
  eq(await sumDept('all'), 'All departments', 'Excel Summary: All departments');
  if (pick.get('ACCOUNTS')) eq(await sumDept(pick.get('ACCOUNTS').id), 'ACCOUNTS', 'Excel Summary: ACCOUNTS, no "with its sections"');
  ok(!pageSrc.includes('(with its sections)`') && !pageSrc.includes('— with its sections</option>')
    && pageSrc.includes('deptViewWords(data.department)') && pageSrc.includes('{deptOptionWords(d)}'),
    'page: the "Showing" line and the picker take their words from deptViewWords / deptOptionWords, nothing hard-coded');
  ok(!libSrc.includes('(with its sections)`') && libSrc.includes(`['Department', deptViewWords(b.department)]`), 'Excel: the Summary row takes its words from deptViewWords');

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });

// A module, not a global script: keeps the names above out of the other test
// scripts' scope under `tsc -p .` (same as routed-requisition-tests.ts).
export {};
