/**
 * PURCHASE INWARD (EXCEL) — owner ruling 127 (2026-11-10) — THE PROOF.
 *
 *   npx tsx scripts/purchase-inward-tests.ts <dir holding a COPY of fnb-controller.db>
 *
 * RUNS ON A HARNESS COPY ONLY: the directory must sit under a `harness/`
 * directory and must not be this worktree; the script chdirs there BEFORE
 * db.ts loads, so getDb() and every real route handler below open the copy and
 * nothing else. The copy must NOT have purchases.invoice_number (production
 * does not): drop it on the copy first, or the script refuses.
 * It SEEDS that copy, through the app's real routes, on TODAY's date (IST).
 *
 *   A  REAL DATA (before any seeding), whole months + a one-day window: through
 *      the REAL GET /api/reports/purchase-inward — the file's rows are exactly
 *      the Purchase Report's rows (count, and row by row against the Item-wise
 *      list), every money column adds up to the Purchase Report's own Summary
 *      figure (REAL GET /api/reports/purchases) to the paisa, and every column
 *      rule of ruling 127 holds on every row, traced back to its purchases row.
 *   B  SEEDED CASES (today): a cash GRN paid from petty cash (PAID / BALANCE),
 *      a credit GRN (both empty), a GRN keyed by a login that no longer matches
 *      (CREATED BY empty, no email), a kitchen-held GRN released later (CREATED
 *      = the GRN entry, not the release), a bill photo (INVOICE URL, sign-in
 *      only), rows through the REAL Inward Import commit route (INWARD ID from
 *      its note), CSV rows with a PO qty (PO QTY / VARIANCE), a CSV row whose
 *      note is prose (INWARD ID empty), and a row shaped like production's July
 *      2026 Recaho rows (importer's note + a recorded PO qty: PO QTY / VARIANCE
 *      filled, PO ID / PO DATE empty — About note 5, file-r2). On every window:
 *      no liquor sentence says liquor is never on the main sheet (liquor booked
 *      as an ordinary purchase line is a Purchase Report line — data-r2).
 *   C  THE FILE: sheet names and order, the owner's 38 headers + PINV in order
 *      (read from his own sample), formats (numbers are numbers, dates text),
 *      empty columns empty, no totals row, the About sheet's totals, no email
 *      or phone anywhere, an empty window, bad dates → 400.
 *   D  ACCESS: 401 signed out; for every user, the same status as
 *      GET /api/reports/purchase-itemwise (admin / manager / Accounts 200,
 *      staff 403).
 *   E  RE-IMPORT GUARD: the exported file through parseInwardWorkbook AND the
 *      REAL Inward Import preview route → 0 rows; the REAL commit route → 400,
 *      nothing written. Control: the owner's sample DOES parse (6 rows).
 *   L  THE "Liquor Inward" SHEET: TGBCL bills through the REAL Goods Receipt
 *      liquor door (and bills shaped as the retired Liquor Store New Bill / CSV
 *      left them), on days before today: the sheet = the REAL Liquor Store
 *      Inward Register route row for row; its total = the bills' Net Indent to
 *      the paisa, or the difference explained part by part; every column rule
 *      traced to its ledger line; never on the main sheet or in its total; the
 *      per-store view gate (no access widened); a failed liquor section leaves
 *      the main sheet whole; the re-import guard still holds.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
export {}; // a module, not a global script: its top-level names must not collide with sibling test scripts

const dir = path.resolve(String(process.argv[2] || ''));
const WT = path.resolve(__dirname, '..');
const SAMPLE = process.env.INWARD_SAMPLE || '';
if (!process.argv[2] || !fs.existsSync(path.join(dir, 'fnb-controller.db'))) {
  console.error('usage: npx tsx scripts/purchase-inward-tests.ts <dir holding a COPY of fnb-controller.db>');
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

/** "YYYY-MM-DD HH:MM:SS" (UTC, as datetime('now') writes) → IST date and time, computed in JS. */
function ist(utc: unknown): { d: string; t: string } {
  const s = String(utc || '').trim();
  if (!s) return { d: '', t: '' };
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { d: '', t: '' };
  const x = new Date(ms + 330 * 60_000).toISOString();
  return { d: x.slice(0, 10), t: x.slice(11, 16) };
}

(async () => {
  const { getDb } = require(path.join(WT, 'src/lib/db.ts'));
  const PI = require(path.join(WT, 'src/lib/purchase-inward.ts'));
  const { parseInwardWorkbook } = require(path.join(WT, 'src/lib/recaho-inward.ts'));
  const { todayIST } = require(path.join(WT, 'src/lib/format-date.ts'));
  const inwardRoute = require(path.join(WT, 'src/app/api/reports/purchase-inward/route.ts'));
  const itemwiseRoute = require(path.join(WT, 'src/app/api/reports/purchase-itemwise/route.ts'));
  const purchasesRoute = require(path.join(WT, 'src/app/api/reports/purchases/route.ts'));
  const previewRoute = require(path.join(WT, 'src/app/api/inward-import/preview/route.ts'));
  const commitRoute = require(path.join(WT, 'src/app/api/inward-import/commit/route.ts'));
  const grnRoute = require(path.join(WT, 'src/app/api/grn/route.ts'));
  const qcRoute = require(path.join(WT, 'src/app/api/grn/[id]/qc/route.ts'));
  const bulkRoute = require(path.join(WT, 'src/app/api/purchases/bulk/route.ts'));
  const bhRoute = require(path.join(WT, 'src/app/api/bill-submissions/route.ts'));
  const bhAttach = require(path.join(WT, 'src/app/api/bill-submissions/[id]/attachment/route.ts'));
  const XLSX = require('xlsx');
  const db = getDb();
  if (path.resolve(db.name) !== path.join(dir, 'fnb-controller.db')) {
    console.error(`refusing: getDb() opened ${db.name}, not the copy.`); process.exit(2);
  }
  const hasInvNo = (db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('purchases') WHERE name = 'invoice_number'`).get() as any).n;
  if (hasInvNo) {
    console.error('refusing: this copy has purchases.invoice_number, which production does not. Run on the copy first: ALTER TABLE purchases DROP COLUMN invoice_number');
    process.exit(2);
  }
  console.log(`copy: ${db.name}`);

  // ── sessions for REAL (prod-mirrored) users, plus one Accounts user and a ghost ──
  const session = (userId: string) => {
    const tok = nodeCrypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01T00:00:00.000Z')`).run(tok, userId);
    return tok;
  };
  const userRow = (id: string) => db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(id) as any;
  const U: Record<string, { id: string; tok: string; name: string; email: string }> = {};
  for (const [label, id] of Object.entries({
    admin: '5568741c0c5a8bb3686ec83cd99ed807', storemgr: '478b5015795854e77b19cefe1fd0d32d',
    headchef: '8dc583da35ff0ade5fbc6c2ac298b199', bar_staff: '2b1b68485c69bca06aeaff2aa8a02263',
  })) {
    const u = userRow(id);
    if (!u) { console.error(`refusing: user ${label} (${id}) is not in this copy`); process.exit(2); }
    U[label] = { id, tok: session(id), name: u.name, email: u.email };
  }
  {
    const role = db.prepare(`SELECT id, base_role FROM roles WHERE can_view_finance_reports = 1 AND is_active = 1 AND base_role = 'staff' LIMIT 1`).get() as any;
    if (role) {
      const id = 'zzpi-accounts-' + nodeCrypto.randomBytes(4).toString('hex');
      db.prepare(`INSERT INTO users (id, email, password_hash, name, role, is_active, role_id) VALUES (?, ?, 'x', 'ZZ Accounts Tester', 'staff', 1, ?)`)
        .run(id, `${id}@test.local`, role.id);
      U.accounts = { id, tok: session(id), name: 'ZZ Accounts Tester', email: `${id}@test.local` };
    }
  }
  const as = (label: string | null) => { (globalThis as any).__TOKEN = label ? U[label].tok : null; };

  const getInward = async (qs: string, headers: Record<string, string> = {}) => {
    const res = await inwardRoute.GET(new Request(`http://t/api/reports/purchase-inward?${qs}`, { headers }));
    const ct = res.headers.get('Content-Type') || '';
    const body = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body, headers: res.headers };
  };
  const report = async (from: string, to: string) => {
    const res = await purchasesRoute.GET(new Request(`http://t/api/reports/purchases?from=${from}&to=${to}`));
    return { status: res.status, body: await res.json() };
  };
  const itemwise = async (from: string, to: string) => {
    const res = await itemwiseRoute.GET(new Request(`http://t/api/reports/purchase-itemwise?from=${from}&to=${to}&format=json`));
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };

  // The owner's 38 headers, read off HIS sample when it is given, else the ruling's list.
  let sampleHeaders: string[] = [];
  if (SAMPLE && fs.existsSync(SAMPLE)) {
    const swb = XLSX.read(fs.readFileSync(SAMPLE), { type: 'buffer' });
    sampleHeaders = (XLSX.utils.sheet_to_json(swb.Sheets['Purchase Inward Data'], { header: 1, defval: '' })[0] as string[]).map(String);
  }

  const COLS: { header: string; key: string | null }[] = PI.INWARD_COLUMNS;
  const ci = (key: string) => COLS.findIndex(c => c.key === key);
  const EMPTY_COLS = ['TO ID', 'TO DATE', 'VENDOR CODE', 'GL CODE', 'SUB CATEGORY', 'EXTERNAL ITEM ID', 'TO QTY', 'VAT', 'EXCISE'];
  // data-r2: the liquor sentences, written out here (not imported) so the test pins the exact words.
  const LIQ_AS_PURCHASE = 'Liquor that was booked as an ordinary purchase line instead (for example by an earlier inward import) is a purchase line on the Purchase Report, so it is in "Purchase Inward Data" and its total, like any other purchase line.';
  const LIQ_NONE_SHEET = 'No liquor (TGBCL) bills on the Liquor Store Inward Register for these inward dates. Any liquor booked as an ordinary purchase line is on "Purchase Inward Data", as on the Purchase Report.';
  const LIQ_NONE_ABOUT = 'No liquor (TGBCL) bills on the Liquor Store Inward Register for these inward dates — the sheet says so in one line. Any liquor booked as an ordinary purchase line is a purchase line, so it is in "Purchase Inward Data" and the total above, as on the Purchase Report.';
  // file-r2: About note 5, worded by what the row holds (production's July Recaho rows carry a PO QTY).
  const NOTE5 = 'PO ID / PO DATE / PO QTY: from the purchase order the goods were received against, through the GRN. A row with no GRN shows PO ID and PO DATE only where the app has linked it to a purchase order, and PO QTY only where the purchase line itself recorded a PO quantity: nearly all of the July 2026 rows brought in from Recaho carry one, and a Purchases → Generic CSV Upload row carries the PO QTY its file gave, where it gave one (Recaho Inward Upload as it works today records none). No upload keeps the PO number, so such a row can show PO QTY and INWARD QUANTITY VARIANCE with PO ID and PO DATE empty. INWARD QUANTITY VARIANCE = INWARD QTY − PO QTY (minus = short), empty where there is no PO QTY.';

  /** Read a downloaded file: sheets, the data rows as raw cells (undefined = no cell). */
  const readFile = (buf: Buffer) => {
    const wb = XLSX.read(buf, { type: 'buffer', cellNF: true });
    const ws = wb.Sheets[PI.INWARD_SHEET_NAME];
    const ref = ws && ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    const header: string[] = [];
    const cells: any[][] = [];
    if (ref) {
      for (let c = 0; c < COLS.length; c++) header.push(ws[XLSX.utils.encode_cell({ r: 0, c })]?.v);
      for (let r = 1; r <= ref.e.r; r++) {
        const row: any[] = [];
        for (let c = 0; c < COLS.length; c++) row.push(ws[XLSX.utils.encode_cell({ r, c })]);
        cells.push(row);
      }
    }
    return { wb, ws, ref, header, cells };
  };
  const v = (cell: any) => (cell === undefined ? null : cell.v);

  /** Every string in every sheet: no email, no phone. */
  const scanPersonal = (wb: any, label: string) => {
    const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/;
    const PHONE = /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)/;
    let bad = 0;
    for (const n of wb.SheetNames) {
      const ws = wb.Sheets[n];
      for (const k of Object.keys(ws)) {
        if (k[0] === '!') continue;
        const c = ws[k];
        const s = String(c.v ?? '') + (c.l?.Target ? ` ${c.l.Target}` : '');
        if (EMAIL.test(s) || PHONE.test(s)) { bad++; if (bad < 4) console.log(`    personal data? ${n}!${k}: ${s.slice(0, 80)}`); }
      }
    }
    eq(bad, 0, `${label}: no email or phone number in any cell of any sheet`);
  };

  /**
   * THE ROW-BY-ROW CHECK for one window: the route's file against (1) the
   * Purchase Report's own Summary, (2) the Item-wise list, (3) each row's own
   * purchases row, traced by id, with every ruling-127 rule worked out here
   * independently of src/lib/purchase-inward.ts.
   */
  const checkWindow = async (from: string, to: string, label: string, opts: { origin?: string } = {}) => {
    as('admin');
    const r = await getInward(`from=${from}&to=${to}`, opts.origin ? { 'x-forwarded-host': opts.origin, 'x-forwarded-proto': 'https' } : {});
    eq(r.status, 200, `${label}: the route answers 200`);
    if (r.status !== 200) { console.log(r.body); return null; }
    eq(r.headers.get('Content-Disposition'), `attachment; filename="purchase-inward_${from}_${to}.xlsx"`, `${label}: file name`);
    const f = readFile(r.body);
    const p = await report(from, to);
    const s = p.body.summary;
    const n = f.cells.length;
    eq(n, Number(s.purchase_count), `${label}: rows = the Purchase Report's purchase count (${s.purchase_count})`);

    // ── money columns vs the Summary ──
    const col = (key: string) => f.cells.reduce((t, row) => t + (Number(v(row[ci(key)])) || 0), 0);
    eq(paise(col('total_inward')), paise(s.total_amount), `${label}: Σ TOTAL INWARD AMOUNT = Purchase Report Grand Total ₹${s.total_amount}`);
    eq(paise(col('subtotal')), paise(s.bill_value), `${label}: Σ SUBTOTAL = Summary Subtotal`);
    eq(paise(col('discount')), paise(s.discount), `${label}: Σ DISCOUNT = Summary Discount`);
    eq(paise(col('cgst')), paise(s.cgst), `${label}: Σ CGST = Summary CGST`);
    eq(paise(col('sgst')), paise(s.sgst), `${label}: Σ SGST = Summary SGST`);
    eq(paise(col('cess')), paise(s.compensation_cess), `${label}: Σ CESS = Summary GST compensation cess`);
    eq(paise(col('delivery')), paise(s.delivery_charges), `${label}: Σ DELIVERY CHARGES = Summary delivery`);
    eq(paise(col('tcs_spl')), paise(Number(s.tcs) + Number(s.special_excise_cess)), `${label}: Σ TCS + SPECIAL EXCISE CESS = Summary TCS + special excise cess`);
    eq(paise(col('mrp_round_off')), paise(s.mrp_round_off), `${label}: Σ MRP ROUND OFF = Summary round-off`);

    // ── row by row against the Item-wise list (same rows, same money) ──
    const iw = await itemwise(from, to);
    eq(iw.status, 200, `${label}: item-wise list answers`);
    if (iw.body) {
      const k = (date: string, pinv: string, item: string, sku: string, m: number[]) => [date, pinv, item, sku, ...m.map(paise)].join('|');
      const theirs = new Map<string, number>();
      for (const x of iw.body.rows) {
        const key = k(x.date, x.invoice_id, x.item, x.sku, [x.subtotal, x.discount, x.cgst, x.sgst, x.compensation_cess,
          Number(x.tcs) + Number(x.special_excise_cess), x.delivery_charges, x.mrp_round_off, x.grand_total]);
        theirs.set(key, (theirs.get(key) || 0) + 1);
      }
      let unmatched = 0;
      for (const row of f.cells) {
        const g = (key: string) => v(row[ci(key)]);
        const key = k(String(g('inward_date') ?? ''), String(g('pinv') ?? ''), String(g('item_name') ?? ''), String(g('item_id') ?? ''),
          ['subtotal', 'discount', 'cgst', 'sgst', 'cess', 'tcs_spl', 'delivery', 'mrp_round_off', 'total_inward'].map(c => Number(g(c)) || 0));
        const left = theirs.get(key) || 0;
        if (left > 0) theirs.set(key, left - 1); else unmatched++;
      }
      eq(unmatched, 0, `${label}: every row matches an Item-wise line (date, PINV, item, SKU and all nine money figures)`);
      eq([...theirs.values()].reduce((a, b) => a + b, 0), 0, `${label}: every Item-wise line is in the file`);
    }

    // ── the file = the library's rows, cell by cell; then each row traced to its purchases row ──
    const lib = PI.getPurchaseInward({ from, to, origin: opts.origin ? `https://${opts.origin}` : 'http://t' }, db);
    eq(lib.rows.length, n, `${label}: library rows = file rows`);
    let cellDiff = 0;
    lib.rows.forEach((row: any, i: number) => {
      const want = PI.inwardRowCells(row);
      want.forEach((w: any, c: number) => { if ((w ?? null) !== v(f.cells[i]?.[c])) cellDiff++; });
    });
    eq(cellDiff, 0, `${label}: the route's file and the library agree cell for cell`);

    const P = db.prepare(`SELECT p.*, rm.name AS rm_name, rm.sku AS rm_sku, rm.category AS rm_category,
                                 rm.purchase_unit AS rm_pu, rm.unit AS rm_unit
                            FROM purchases p LEFT JOIN raw_materials rm ON rm.id = p.material_id WHERE p.id = ?`);
    const G = db.prepare(`SELECT * FROM goods_receipt_notes WHERE id = ?`);
    const GI = db.prepare(`SELECT * FROM goods_receipt_note_items WHERE grn_id = ? AND material_id = ? ORDER BY created_at, id`);
    const PO = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`);
    const CASH = db.prepare(`SELECT COUNT(*) AS n FROM petty_cash_ledger WHERE grn_id = ? AND direction = 'out'`);
    const NAME = db.prepare(`SELECT name FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) OR id = TRIM(?)`);
    const bad: Record<string, number> = {};
    const miss = (rule: string) => { bad[rule] = (bad[rule] || 0) + 1; };
    let storedQtyRateOdd = 0;
    let createdFromGrnDiffers = 0;
    const stats = { grn: 0, mirror: 0, po: 0, poQtyImport: 0, imported: 0, cash: 0, named: 0, photo: 0 };
    lib.ids.forEach((id: string, i: number) => {
      const row = f.cells[i];
      const g = (key: string) => v(row[ci(key)]);
      const pr = P.get(id) as any;
      const grnId = String(pr.grn_id || '').trim();
      const grn = grnId ? (G.get(grnId) as any) : null;
      if (grn) stats.grn++;
      // A, B
      const want = ist(grn ? grn.created_at : pr.created_at);
      if ((g('created_date') ?? '') !== want.d) miss('CREATED DATE = GRN entry (else purchase saved), IST');
      if ((g('created_time') ?? '') !== want.t) miss('CREATED TIME = GRN entry (else purchase saved), IST');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(g('created_date')))) miss('CREATED DATE is YYYY-MM-DD text');
      if (!/^\d{2}:\d{2}$/.test(String(g('created_time')))) miss('CREATED TIME is HH:MM text');
      if (grn) {
        const pi = ist(pr.created_at);
        if (pi.d + pi.t !== want.d + want.t) createdFromGrnDiffers++;
      }
      // C, D — PO via the GRN; purchases.po_id only without a GRN.
      const poId = grn ? String(grn.po_id || '').trim() : (grnId ? '' : String(pr.po_id || '').trim());
      const po = poId ? (PO.get(poId) as any) : null;
      if (po) stats.po++;
      if ((g('po_id') ?? '') !== (po ? String(po.po_number).trim() : '')) miss('PO ID');
      if ((g('po_date') ?? '') !== (po ? String(po.date).slice(0, 10) : '')) miss('PO DATE');
      // G
      let wantInward = '';
      if (grn) wantInward = String(grn.grn_number).trim();
      else if (!grnId) {
        const m = /^(?:Invoice: .+? · )?Inward: ([A-Za-z0-9][A-Za-z0-9\-/]*)\s*(?:$| · GST ₹| · TGBCL TCS \+ Special Excise Cess ₹)/.exec(String(pr.notes || ''));
        wantInward = m ? m[1] : '';
        if (wantInward) stats.imported++;
      }
      if ((g('inward_id') ?? '') !== wantInward) miss('INWARD ID');
      // H
      const wantInv = String(pr.bill_no || '').trim() || (grn ? String(grn.invoice_number || '').trim() : '');
      if ((g('invoice_id') ?? '') !== wantInv) miss('INVOICE ID = bill_no, else the GRN invoice number');
      // I, J, M, O, Q, V
      if (g('inward_date') !== pr.date) miss('INWARD DATE = purchases.date');
      if ((g('supplier') ?? '') !== String(pr.vendor || '').trim()) miss('SUPPLIER NAME');
      if ((g('category') ?? '') !== String(pr.rm_category || '').trim().toUpperCase()) miss('CATEGORY NAME = category in capitals');
      if ((g('item_id') ?? '') !== String(pr.rm_sku || '').trim()) miss('ITEM ID = sku');
      if ((g('item_name') ?? '') !== String(pr.rm_name || '').trim()) miss('ITEM NAME');
      if ((g('purchase_unit') ?? '') !== (String(pr.rm_pu || '').trim() || String(pr.rm_unit || '').trim())) miss('PURCHASE UNIT');
      // T, W — the pair that makes SUBTOTAL.
      const lines = grnId ? (GI.all(grnId, pr.material_id) as any[]) : [];
      const mirror = !String(pr.invoice_id || '').trim() && !!grnId && lines.length > 0;
      if (mirror) stats.mirror++;
      const wantQty = mirror ? Number(lines[0].quantity_received) : Number(pr.quantity);
      const wantRate = mirror ? Number(lines[0].unit_price) : Number(pr.unit_price);
      if (Math.abs(Number(g('inward_qty')) - wantQty) > 1e-6) miss('INWARD QTY');
      if (Math.abs(Number(g('rate')) - wantRate) > 1e-6) miss('RATE');
      const qr = Number(g('inward_qty')) * Number(g('rate'));
      if (Math.abs(qr - Number(g('subtotal'))) > 0.005 + 1e-6) {
        // Allowed ONLY where the stored purchases row itself is not qty × rate.
        if (!mirror && Math.abs(Number(pr.quantity) * Number(pr.unit_price) - Number(pr.total_price)) > 0.005 + 1e-6) storedQtyRateOdd++;
        else miss('INWARD QTY × RATE = SUBTOTAL');
      }
      // R, U
      let wantPoQty: number | null = null;
      if (grn && po && lines.length > 0 && Number(lines[0].quantity_ordered) > 0) wantPoQty = Number(lines[0].quantity_ordered);
      else if (Number(pr.po_qty) > 0) { wantPoQty = Number(pr.po_qty); stats.poQtyImport++; }
      if (g('po_qty') !== wantPoQty) miss('PO QTY');
      const wantVar = wantPoQty == null ? null : Math.round((Number(g('inward_qty')) - wantPoQty) * 1e6) / 1e6;
      if (g('variance') !== wantVar) miss('INWARD QUANTITY VARIANCE = INWARD QTY − PO QTY');
      // AJ, AK
      const cash = grn ? (CASH.get(grn.id) as any).n > 0 : false;
      if (cash) stats.cash++;
      if (cash ? g('paid') !== g('total_inward') : g('paid') !== null) miss('PAID AMOUNT only for petty-cash bills, = TOTAL INWARD');
      if (cash ? g('balance') !== 0 : g('balance') !== null) miss('BALANCE AMOUNT 0 for petty-cash bills, else empty');
      // AL — a name, never an email.
      let wantBy = '';
      if (grn && String(grn.received_by || '').trim()) {
        const names = NAME.all(grn.received_by, grn.received_by) as any[];
        if (names.length === 1 && !String(names[0].name).includes('@')) wantBy = String(names[0].name).trim();
      }
      if (wantBy) stats.named++;
      if ((g('created_by') ?? '') !== wantBy) miss('CREATED BY = the GRN keyer\'s name (empty when unmatched)');
      // AM
      if ((g('pinv') ?? '') !== String(pr.invoice_id || '').trim()) miss('OUR PURCHASE INVOICE ID (PINV)');
      // AI
      if (g('invoice_url')) stats.photo++;
      // empty columns, every row
      for (const h of EMPTY_COLS) {
        const c = COLS.findIndex(x => x.header === h);
        if (row[c] !== undefined) miss(`${h} empty`);
      }
      // numbers are numbers
      for (const key of ['inward_qty', 'rate', 'subtotal', 'discount', 'cgst', 'sgst', 'cess', 'delivery', 'tcs_spl', 'mrp_round_off', 'total_inward']) {
        const cell = row[ci(key)];
        if (!cell || cell.t !== 'n') miss(`${key} is a number cell`);
      }
    });
    eq(bad, {}, `${label}: every ruling-127 column rule holds on all ${n} rows`);
    eq(lib.qty_rate_pairing_misses, 0, `${label}: on every row read off a GRN line, INWARD QTY × RATE = SUBTOTAL (the display pairing picks the money rail's line)`);
    eq(lib.qty_rate_misses, storedQtyRateOdd,`${label}: INWARD QTY × RATE misses SUBTOTAL only where the stored row is not qty × rate (${storedQtyRateOdd}), and the file counts exactly those`);
    // The About sheet
    const about = f.wb.Sheets[PI.ABOUT_SHEET_NAME];
    const aboutText = XLSX.utils.sheet_to_json(about, { header: 1, defval: '' }).map((r: any[]) => r.join(' | ')).join('\n');
    const gt = Number(s.total_amount);
    const gtWords = '₹' + Math.abs(gt).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    ok(aboutText.includes(`= Purchase Report Grand Total for the same dates, ${gtWords}`), `${label}: About sheet says TOTAL INWARD = Purchase Report Grand Total ${gtWords}`);
    ok(!aboutText.includes('DOES NOT MATCH'), `${label}: About sheet shows no mismatch`);
    ok(aboutText.includes('Do not upload it into Inward Import'), `${label}: About sheet says it is a report, not for Inward Import`);
    if (storedQtyRateOdd > 0) ok(aboutText.includes(`except ${storedQtyRateOdd.toLocaleString('en-IN')} row`), `${label}: About sheet names the ${storedQtyRateOdd} stored-odd rows`);

    // data-r2 — LIQUOR BOOKED AS AN ORDINARY PURCHASE LINE (e.g. an older Recaho
    // inward import: supplier GOVERNMENT OF TELANGANA, or an item in a store-mapped
    // category) IS a Purchase Report line, so it is on this sheet and in its total.
    // No liquor sentence may say liquor is never here; each is worded by the door used.
    const hasScm = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'store_category_map'`).get();
    const LIQ_P = db.prepare(`SELECT CASE WHEN UPPER(COALESCE(p.vendor, '')) LIKE '%TELANGANA%'${hasScm
      ? ` OR LOWER(TRIM(COALESCE(rm.category, ''))) IN (SELECT LOWER(TRIM(category)) FROM store_category_map)` : ''}
      THEN 1 ELSE 0 END AS liq FROM purchases p LEFT JOIN raw_materials rm ON rm.id = p.material_id WHERE p.id = ?`);
    let liqRows = 0;
    let liqTotal = 0;
    lib.ids.forEach((id: string, i: number) => {
      if ((LIQ_P.get(id) as any)?.liq) { liqRows++; liqTotal += Number(v(f.cells[i][ci('total_inward')])) || 0; }
    });
    ok(!aboutText.includes('sheet only, never in') && !aboutText.includes('No liquor (TGBCL) bills for these inward dates')
      && !aboutText.includes('Liquor bills are not purchases in the Purchase Report')
      && !aboutText.includes('Liquor (TGBCL) bills are not in this file: they are not in the Purchase Report'),
    `${label}: no About sentence says liquor is never on this sheet (data-r2)`);
    ok(aboutText.includes(LIQ_AS_PURCHASE), `${label}: About note 12 says liquor booked as an ordinary purchase line is on this sheet and in its total`);
    ok(aboutText.includes('Liquor (TGBCL) bills recorded in the Liquor Store — entered on Goods Receipt (GRN) → TGBCL Liquor Bill, or on the Liquor Store page before that — are never in "Purchase Inward Data" or its total'),
      `${label}: About note 12 words the "never on this sheet" rule by the door used`);
    {
      const laoa = XLSX.utils.sheet_to_json(f.wb.Sheets[PI.LIQUOR_SHEET_NAME], { header: 1, defval: '' }) as any[][];
      const oneLiner = laoa.length === 2 ? laoa[1].filter((x: any) => x !== '').map(String) : [];
      if (oneLiner.length === 1 && !oneLiner[0].startsWith('Left out') && !oneLiner[0].startsWith('This sheet could not')) {
        eq(oneLiner, [LIQ_NONE_SHEET], `${label}: the empty liquor sheet's line is worded by the register, and points to liquor booked as purchases`);
        ok(aboutText.includes(LIQ_NONE_ABOUT), `${label}: About's liquor line (no liquor bills) is worded by the register and says liquor booked as purchases is in the total above`);
      }
    }
    if (liqRows > 0) {
      ok(aboutText.includes(LIQ_AS_PURCHASE) && !aboutText.includes('sheet only, never in'),
        `${label}: ${liqRows} liquor line(s) booked as ordinary purchases (₹${liqTotal.toFixed(2)}) are on this sheet and in its total, and the About sheet says such lines are`);
    }
    // file-r2 — About note 5 is the sentence the cells bear out.
    ok(aboutText.includes(`5. ${NOTE5}`), `${label}: About note 5 words PO QTY by what the row holds`);
    ok(!aboutText.includes('so on its rows PO QTY is empty even when the Recaho file had one'), `${label}: About note 5's old claim (Recaho rows never show PO QTY) is gone`);
    {
      let poQtyNoPoId = 0;
      let withGrn = 0;
      lib.ids.forEach((id: string, i: number) => {
        const row = f.cells[i];
        if (v(row[ci('po_qty')]) != null && v(row[ci('po_id')]) == null) {
          poQtyNoPoId++;
          if (String((P.get(id) as any)?.grn_id || '').trim()) withGrn++;
        }
      });
      eq(withGrn, 0, `${label}: every row showing PO QTY with PO ID empty (${poQtyNoPoId}) is a row with no GRN, as note 5 says`);
    }
    scanPersonal(f.wb, label);
    console.log(`    ${label}: ${n} rows · GT ₹${s.total_amount} · GRN ${stats.grn} (mirror ${stats.mirror}, PO ${stats.po}) · imported ${stats.imported} · PO qty from import ${stats.poQtyImport} · cash ${stats.cash} · named ${stats.named} · photo ${stats.photo} · created≠booked ${createdFromGrnDiffers} · stored qty×rate odd ${storedQtyRateOdd} · liquor booked as purchases ${liqRows} (₹${liqTotal.toFixed(2)})`);
    return { f, lib, s, stats };
  };

  /* ══════════ A — real data, before any seeding ══════════ */
  console.log('A  real data: the file = the Purchase Report, row by row and column by column');
  const months = (db.prepare(`SELECT substr(date,1,7) AS m, COUNT(*) AS n FROM purchases GROUP BY m ORDER BY n DESC LIMIT 4`).all() as any[]).map(r => r.m);
  ok(months.length > 0, 'the copy has real purchases to prove against');
  for (const m of months) {
    const last = String(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate()).padStart(2, '0');
    await checkWindow(`${m}-01`, `${m}-${last}`, m);
  }
  {
    const span = db.prepare(`SELECT MIN(date) AS a, MAX(date) AS b FROM purchases`).get() as any;
    await checkWindow(span.a, span.b, `whole book ${span.a}…${span.b}`);
    await checkWindow(span.b, span.b, `one day ${span.b}`);
  }

  /* ══════════ C — the file itself ══════════ */
  console.log('C  the file: sheets, headers, formats, empty window, bad dates');
  {
    as('admin');
    const span = db.prepare(`SELECT MAX(date) AS b FROM purchases`).get() as any;
    const r = await getInward(`from=${span.b.slice(0, 8)}01&to=${span.b}`);
    const f = readFile(r.body);
    eq(f.wb.SheetNames, ['About this file', 'Purchase Inward Data', 'Liquor Inward'], 'sheets: About first, then the inward data, then the liquor sheet');
    const prefer = ['Item Wise', 'Supplier Wise', 'Category Wise', 'inward report detail'];
    ok(!f.wb.SheetNames.some((nm: string) => prefer.includes(nm)), 'no sheet carries a name the Inward Import prefers');
    if (sampleHeaders.length) {
      eq(sampleHeaders.length, 38, 'the owner\'s sample has 38 headers');
      eq(f.header.slice(0, 38), sampleHeaders, 'columns A–AL = the owner\'s 38 headers, same text, same order');
    } else console.log('    (INWARD_SAMPLE not set: header text checked against the ruling list only)');
    eq(f.header.length, 39, '39 columns');
    eq(f.header[38], 'OUR PURCHASE INVOICE ID (PINV)', 'column AM = our PINV, after CREATED BY');
    eq(f.header[37], 'CREATED BY', 'column AL = CREATED BY');
    // formats on the first data row
    const row = f.cells[0];
    if (row) {
      eq(row[ci('total_inward')].z, '#,##0.00', 'money cells carry a 2-decimal number format');
      eq(row[ci('inward_qty')].z ?? 'General', 'General', 'quantity cells are General (no trailing ".")');
      eq(row[ci('rate')].z, '#,##0.00##', 'rate cells: 2 to 4 decimals');
      eq(row[ci('inward_date')].t, 's', 'INWARD DATE is text YYYY-MM-DD');
    }
    // no totals row: the last row is a real purchase line with an item and a date
    const lastRow = f.cells[f.cells.length - 1];
    ok(lastRow && v(lastRow[ci('item_name')]) && /^\d{4}-\d{2}-\d{2}$/.test(String(v(lastRow[ci('inward_date')]))), 'no totals row inside the data sheet');
    // frozen header
    const zip = XLSX.CFB.read(r.body, { type: 'buffer' });
    const s2 = Buffer.from(XLSX.CFB.find(zip, '/xl/worksheets/sheet2.xml').content).toString('utf8');
    ok(s2.includes('state="frozen"'), 'the data sheet\'s header row is frozen');
    const s3 = Buffer.from(XLSX.CFB.find(zip, '/xl/worksheets/sheet3.xml').content).toString('utf8');
    ok(s3.includes('state="frozen"'), 'the liquor sheet\'s header row is frozen');

    // empty window
    const e = await getInward('from=2031-01-01&to=2031-01-31');
    eq(e.status, 200, 'an empty window still downloads');
    const ef = readFile(e.body);
    eq(ef.cells.length, 0, 'empty window: header row only');
    const eAbout = XLSX.utils.sheet_to_json(ef.wb.Sheets['About this file'], { header: 1, defval: '' }).map((x: any[]) => x.join(' | ')).join('\n');
    ok(eAbout.includes('0 rows') && eAbout.includes('₹0.00'), 'empty window: About says 0 rows and ₹0.00');
    // The liquor sheet on an empty window: present, its header row, ONE plain line, nothing else.
    {
      const lws = ef.wb.Sheets['Liquor Inward'];
      const aoa = XLSX.utils.sheet_to_json(lws, { header: 1, defval: '' }) as any[][];
      eq(aoa.length, 2, 'empty window: the Liquor Inward sheet holds its header and ONE line');
      eq(aoa[0].slice(0, 39).map(String), COLS.map(c => c.header), 'empty window: the liquor sheet keeps the same 39 headers');
      eq(aoa[1].filter((x: any) => x !== '').map(String), [LIQ_NONE_SHEET], 'empty window: the liquor sheet says so in one line of plain text (worded by the register, data-r2)');
      ok(eAbout.includes(LIQ_NONE_ABOUT), 'empty window: About says there are no liquor bills on the register and that the sheet says so (data-r2)');
      ok(!eAbout.includes('No liquor (TGBCL) bills for these inward dates') && !aoa[1].join(' ').includes('were entered for these inward dates'),
        'empty window: the old absolute "no liquor (TGBCL) bills" wording is gone (data-r2)');
      ok(eAbout.includes('If no liquor bill falls on these dates, the "Liquor Inward" sheet is still there, with its header row and one line saying so.'), 'About states the empty-range choice (sheet present, one line)');
    }
    // bad dates
    for (const [qs, why] of [['to=2026-10-31', 'no from'], ['from=2026-10-01', 'no to'], ['from=2026-02-30&to=2026-03-01', 'not a real day'],
      ['from=2026-1-01&to=2026-10-31', 'not YYYY-MM-DD'], ['from=2026-11-01&to=2026-10-01', 'from after to']]) {
      const b = await getInward(qs);
      eq(b.status, 400, `bad dates (${why}) → 400`);
      ok(typeof b.body?.error === 'string' && b.body.error.length > 10, `bad dates (${why}): a plain message — "${b.body?.error}"`);
    }
  }

  /* ══════════ D — access ══════════ */
  console.log('D  access: the same gate as the Item-wise list');
  {
    as(null);
    const anon = await getInward('from=2026-10-01&to=2026-10-31');
    eq(anon.status, 401, 'signed out → 401');
    const want: Record<string, number> = { admin: 200, storemgr: 200, headchef: 200, bar_staff: 403, accounts: 200 };
    for (const label of Object.keys(U)) {
      as(label);
      const a = await getInward('from=2026-10-01&to=2026-10-31');
      const b = await itemwiseRoute.GET(new Request('http://t/api/reports/purchase-itemwise?from=2026-10-01&to=2026-10-31&format=json'));
      eq(a.status, b.status, `${label}: same status as purchase-itemwise (${b.status})`);
      if (want[label] != null) eq(a.status, want[label], `${label} → ${want[label]}`);
    }
    if (!U.accounts) console.log('    (no active staff-tier role with the finance-reports tick in this copy — Accounts case skipped)');
  }

  /* ══════════ E — re-import guard ══════════ */
  console.log('E  re-import guard');
  {
    as('admin');
    const r = await getInward('from=2026-01-01&to=2026-12-31');
    const wb = XLSX.read(r.body, { type: 'buffer' });
    eq(parseInwardWorkbook(XLSX, wb).length, 0, 'parseInwardWorkbook reads 0 rows from the exported file');
    // Control 1: the data sheet ALONE would parse — the About sheet is what blocks it.
    const alone = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(alone, wb.Sheets['Purchase Inward Data'], 'Purchase Inward Data');
    ok(parseInwardWorkbook(XLSX, alone).length > 0, 'control: the data sheet on its own WOULD parse — the first sheet is what guards it');
    // Control 2: the owner's sample parses.
    if (SAMPLE && fs.existsSync(SAMPLE)) {
      eq(parseInwardWorkbook(XLSX, XLSX.read(fs.readFileSync(SAMPLE), { type: 'buffer' })).length, 6, 'control: the owner\'s sample parses to its 6 rows');
    }
    const before = (db.prepare('SELECT COUNT(*) AS n FROM purchases').get() as any).n;
    const fd = () => { const x = new FormData(); x.append('file', new Blob([r.body]), 'purchase-inward.xlsx'); return x; };
    const pv = await previewRoute.POST(new Request('http://t/api/inward-import/preview', { method: 'POST', body: fd() }));
    const pj = await pv.json();
    eq([pv.status, pj.rows], [200, 0], 'REAL preview route: 0 importable rows');
    const cm = await commitRoute.POST(new Request('http://t/api/inward-import/commit', { method: 'POST', body: fd() }));
    eq(cm.status, 400, 'REAL commit route refuses the file (400)');
    eq((db.prepare('SELECT COUNT(*) AS n FROM purchases').get() as any).n, before, 'nothing was written');
  }

  /* ══════════ B — seeded cases, today, through the real routes ══════════ */
  const today = todayIST();
  console.log(`B  seeded cases on ${today}`);
  {
    const pick = (cat: string, n: number, notIds: string[] = []) => {
      const rows = db.prepare(`
        SELECT rm.id, rm.name, rm.sku, COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS pu FROM raw_materials rm
         WHERE LOWER(TRIM(rm.category)) = ? AND TRIM(COALESCE(rm.sku,'')) <> '' AND COALESCE(rm.is_active, 1) = 1
           AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.material_id = rm.id AND p.date = ?)
         ORDER BY rm.name LIMIT 60`).all(cat, today) as any[];
      return rows.filter(x => !notIds.includes(x.id)).slice(0, n);
    };
    const groc = pick('grocery', 8);
    const veg = pick('veg', 1);
    ok(groc.length >= 6 && veg.length === 1, 'materials to seed with (grocery ×6, veg ×1)');
    const post = async (route: any, url: string, body: unknown) => {
      const res = await route.POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      let j: any = null; try { j = await res.json(); } catch { j = null; }
      return { status: res.status, body: j };
    };
    const vendor = (db.prepare(`SELECT id, name FROM vendors WHERE COALESCE(is_active,1) = 1 ORDER BY name LIMIT 1`).get() as any);

    // B1 — a cash GRN paid from the petty-cash box, keyed by the store manager.
    as('storemgr');
    const g1 = await post(grnRoute, 'http://t/api/grn', {
      date: today, vendor: vendor.name, vendor_id: vendor.id, invoice_number: 'ZZPI-CASH-1', invoice_date: today,
      cash_purchase: true, confirm_duplicate_bill: true, confirm_duplicate_cash: true,
      items: [
        { material_id: groc[0].id, quantity_received: 4, unit_price: 25, cgst: 2.5, sgst: 2.5 },
        { material_id: groc[1].id, quantity_received: 2, unit_price: 110 },
      ],
    });
    ok(g1.status >= 200 && g1.status < 300, `B1 cash GRN saved (${g1.status} ${g1.body?.error || ''})`);
    // B2 — a credit GRN (no cash), keyed by the admin.
    as('admin');
    const g2 = await post(grnRoute, 'http://t/api/grn', {
      date: today, vendor: vendor.name, vendor_id: vendor.id, invoice_number: 'ZZPI-CREDIT-2', invoice_date: today,
      cash_purchase: false, confirm_duplicate_bill: true,
      items: [{ material_id: groc[2].id, quantity_received: 3, unit_price: 40, delivery_charges: 12 }],
    });
    ok(g2.status >= 200 && g2.status < 300, `B2 credit GRN saved (${g2.status} ${g2.body?.error || ''})`);
    // B3 — a GRN whose keyer's login no longer matches a user.
    const g3 = await post(grnRoute, 'http://t/api/grn', {
      date: today, vendor: vendor.name, vendor_id: vendor.id, invoice_number: 'ZZPI-GHOST-3', invoice_date: today,
      cash_purchase: false, confirm_duplicate_bill: true,
      items: [{ material_id: groc[3].id, quantity_received: 1, unit_price: 99 }],
    });
    ok(g3.status >= 200 && g3.status < 300, `B3 GRN saved (${g3.status} ${g3.body?.error || ''})`);
    const grnOf = (inv: string) => db.prepare(`SELECT * FROM goods_receipt_notes WHERE invoice_number = ? ORDER BY created_at DESC LIMIT 1`).get(inv) as any;
    const G1 = grnOf('ZZPI-CASH-1'), G2 = grnOf('ZZPI-CREDIT-2'), G3 = grnOf('ZZPI-GHOST-3');
    if (G3) db.prepare(`UPDATE goods_receipt_notes SET received_by = 'left.the.company@example.com' WHERE id = ?`).run(G3.id);
    // B4 — a kitchen-held GRN (veg), released later by the head chef.
    as('storemgr');
    const g4 = await post(grnRoute, 'http://t/api/grn', {
      date: today, vendor: vendor.name, vendor_id: vendor.id, invoice_number: 'ZZPI-QC-4', invoice_date: today,
      cash_purchase: false, confirm_duplicate_bill: true,
      items: [{ material_id: veg[0].id, quantity_received: 5, unit_price: 30 }],
    });
    ok(g4.status >= 200 && g4.status < 300, `B4 kitchen-held GRN saved (${g4.status} ${g4.body?.error || ''})`);
    const G4 = grnOf('ZZPI-QC-4');
    eq(G4?.status, 'awaiting_qc', 'B4 is waiting for the kitchen check (no purchases row yet)');
    {
      as('admin');
      const held = await getInward(`from=${today}&to=${today}`);
      const hf = readFile(held.body);
      ok(!hf.cells.some(row => v(row[ci('invoice_id')]) === 'ZZPI-QC-4'), 'B4: not in the file while held (not a purchase yet)');
    }
    // The GRN was keyed YESTERDAY 09:15 IST; the kitchen releases it now.
    if (G4) {
      const y = new Date(Date.parse(`${today}T03:45:00Z`) - 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(`UPDATE goods_receipt_notes SET created_at = ? WHERE id = ?`).run(y, G4.id);
      as('headchef');
      const res = await qcRoute.POST(new Request(`http://t/api/grn/${G4.id}/qc`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'override', reason: 'ZZPI test release after the kitchen check' }) }), { params: Promise.resolve({ id: G4.id }) });
      const j = await res.json().catch(() => ({}));
      ok(res.status === 200, `B4 released by the head chef (${res.status} ${j?.error || ''})`);
    }
    // B5 — a bill photo on B1's GRN, through Bill Submission.
    let handoverId = '';
    if (G1) {
      as('admin');
      const h = await post(bhRoute, 'http://t/api/bill-submissions', { grn_id: G1.id });
      handoverId = String(h.body?.handover?.id || h.body?.row?.id || h.body?.id || '');
      if (!handoverId) handoverId = String((db.prepare(`SELECT id FROM bill_handovers WHERE grn_id = ? AND status <> 'void'`).get(G1.id) as any)?.id || '');
      ok(!!handoverId, `B5 bill handover recorded for ${G1.grn_number} (${h.status} ${h.body?.error || ''})`);
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const a = await bhAttach.POST(new Request(`http://t/api/bill-submissions/${handoverId}/attachment`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: `data:image/png;base64,${png}`, filename: 'bill.png' }) }), { params: Promise.resolve({ id: handoverId }) });
      const aj = await a.json().catch(() => ({}));
      ok(a.status >= 200 && a.status < 300, `B5 bill photo attached (${a.status} ${aj?.error || ''})`);
    }
    // B6 — Recaho inward rows through the REAL Inward Import commit route.
    as('admin');
    {
      const H38 = PI.INWARD_COLUMNS.slice(0, 38).map((c: any) => c.header);
      const mk = (o: Record<string, unknown>) => H38.map((h: string) => (o[h] ?? ''));
      const aoa = [H38,
        mk({ 'CREATED DATE': today, 'INWARD ID': '9001', 'INVOICE ID': 'RCH-INV-77', 'INWARD DATE': today, 'SUPPLIER NAME': 'ZZPI RECAHO VENDOR',
          'CATEGORY NAME': 'GROCERY', 'ITEM NAME': groc[4].name, 'PO QTY': 6, 'INWARD QTY': 5, 'PURCHASE UNIT': groc[4].pu, 'RATE': 10,
          'SUBTOTAL': 50, 'TOTAL INWARD AMOUNT': 50 }),
        mk({ 'CREATED DATE': today, 'INWARD ID': '9002', 'INVOICE ID': 'RCH-INV-78', 'INWARD DATE': today, 'SUPPLIER NAME': 'ZZPI RECAHO VENDOR',
          'CATEGORY NAME': 'GROCERY', 'ITEM NAME': groc[5].name, 'INWARD QTY': 2, 'PURCHASE UNIT': groc[5].pu, 'RATE': 100,
          'SUBTOTAL': 200, 'CGST': 5, 'SGST': 5, 'TOTAL INWARD AMOUNT': 210 }),
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'inward report detail');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      const x = new FormData(); x.append('file', new Blob([buf]), 'recaho.xlsx');
      const cm = await commitRoute.POST(new Request('http://t/api/inward-import/commit', { method: 'POST', body: x }));
      const cj = await cm.json();
      eq([cm.status, cj.purchases], [200, 2], `B6 Recaho rows imported through the real commit route (${cj.error || ''})`);

      // B11 (file-r2) — shaped like production's July 2026 Recaho rows: brought in
      // through the REAL commit route (so the note is the importer's own), then
      // purchases.po_qty set on the copy as those rows hold it (owner's console:
      // filled on 99.9% of them; today's commit route writes none — B6).
      const aoa11 = [H38, mk({ 'CREATED DATE': today, 'INWARD ID': '9901', 'INVOICE ID': 'RCH-INV-5501', 'INWARD DATE': today,
        'SUPPLIER NAME': 'ZZPI RECAHO JULY VENDOR', 'CATEGORY NAME': 'GROCERY', 'ITEM NAME': groc[3].name, 'PO QTY': 6, 'INWARD QTY': 5,
        'PURCHASE UNIT': groc[3].pu, 'RATE': 12, 'SUBTOTAL': 60, 'TOTAL INWARD AMOUNT': 60 })];
      const wb11 = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb11, XLSX.utils.aoa_to_sheet(aoa11), 'inward report detail');
      const x11 = new FormData(); x11.append('file', new Blob([XLSX.write(wb11, { type: 'buffer', bookType: 'xlsx' })]), 'recaho-july.xlsx');
      const cm11 = await commitRoute.POST(new Request('http://t/api/inward-import/commit', { method: 'POST', body: x11 }));
      const cj11 = await cm11.json();
      eq([cm11.status, cj11.purchases], [200, 1], `B11 production-shaped Recaho row imported through the real commit route (${cj11.error || ''})`);
      const r11 = db.prepare(`SELECT id, notes, bill_no, grn_id, po_id, po_qty FROM purchases WHERE vendor = 'ZZPI RECAHO JULY VENDOR' AND date = ?`).all(today) as any[];
      eq(r11.map(x => [x.notes, x.bill_no, String(x.grn_id || ''), String(x.po_id || ''), Number(x.po_qty) || 0]),
        [['Invoice: RCH-INV-5501 · Inward: 9901', 'RCH-INV-5501', '', '', 0]], 'B11: stored as the importer writes it — its own note, the vendor invoice in bill_no, no GRN, no PO, no PO qty');
      db.prepare(`UPDATE purchases SET po_qty = 6 WHERE vendor = 'ZZPI RECAHO JULY VENDOR' AND date = ?`).run(today);
    }
    // B7 — CSV upload (Generic CSV) with a PO qty and Recaho's note; B8 — a prose note.
    {
      const b = await post(bulkRoute, 'http://t/api/purchases/bulk', { purchases: [
        { sku: groc[6].sku, vendor: 'ZZPI CSV VENDOR', quantity: 10, unit_price: 7.5, date: today, bill_no: 'CSV-B-77',
          po_qty: 12, notes: 'Invoice: CSV-B-77 · Inward: 7001' },
        { sku: groc[7].sku, vendor: 'ZZPI CSV VENDOR', quantity: 3, unit_price: 20, date: today, bill_no: 'CSV-B-78',
          notes: 'Inward: 55 pending' },
      ] });
      eq([b.status, b.body?.success], [200, 2], `B7/B8 CSV rows saved through the real bulk route (${JSON.stringify(b.body?.errors || b.body?.error || '')})`);
    }
    // B9 — a purchase with NO GRN whose purchases.po_id is set (production's July
    // "direct / PO" rows: receives that predate grn_id, linked by the boot
    // migration's notes pass). Shaped on the copy exactly as that pass leaves it.
    const anyPo = db.prepare(`SELECT id, po_number, date FROM purchase_orders ORDER BY created_at LIMIT 1`).get() as any;
    {
      const b = await post(bulkRoute, 'http://t/api/purchases/bulk', { purchases: [
        { sku: groc[0].sku, vendor: 'ZZPI OLD PO VENDOR', quantity: 2, unit_price: 15, date: today, bill_no: 'OLD-PO-9' },
      ] });
      eq([b.status, b.body?.success], [200, 1], 'B9 row saved through the real bulk route');
      if (anyPo) db.prepare(`UPDATE purchases SET po_id = ? WHERE bill_no = 'OLD-PO-9' AND date = ?`).run(anyPo.id, today);
    }
    // B10 — a bill photo on a purchase with NO GRN: a manual Bill Submission
    // record carrying that row's PINV.
    let manualHandoverId = '';
    {
      const pinv = String((db.prepare(`SELECT invoice_id FROM purchases WHERE bill_no = 'CSV-B-78' AND date = ?`).get(today) as any)?.invoice_id || '');
      ok(/^PINV-/.test(pinv), 'B10: the CSV row carries a PINV');
      const h = await post(bhRoute, 'http://t/api/bill-submissions', {
        bill_no: 'CSV-B-78', vendor_name: 'ZZPI CSV VENDOR', invoice_id: pinv, received_date: today, bill_date: today, bill_value: 60,
      });
      manualHandoverId = String(h.body?.handover?.id || '');
      ok(!!manualHandoverId, `B10 manual bill handover recorded (${h.status} ${h.body?.error || ''})`);
      if (manualHandoverId) {
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const a = await bhAttach.POST(new Request(`http://t/api/bill-submissions/${manualHandoverId}/attachment`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: `data:image/png;base64,${png}`, filename: 'bill-78.png' }) }), { params: Promise.resolve({ id: manualHandoverId }) });
        ok(a.status >= 200 && a.status < 300, `B10 bill photo attached (${a.status})`);
      }
    }

    // ── the file for today, through the route, with a real origin ──
    const w = await checkWindow(today, today, `seeded day ${today}`, { origin: 'fnb.example.test' });
    if (w) {
      const rowBy = (pred: (g: (k: string) => any) => boolean) => w.f.cells.filter(row => pred((k: string) => v(row[ci(k)])));
      const val = (row: any[], k: string) => v(row[ci(k)]);
      // B1
      const b1 = rowBy(g => g('invoice_id') === 'ZZPI-CASH-1');
      eq(b1.length, 2, 'B1: both lines of the cash GRN are in the file');
      for (const row of b1) {
        eq(val(row, 'paid'), val(row, 'total_inward'), 'B1: PAID AMOUNT = the line\'s TOTAL INWARD AMOUNT');
        eq(val(row, 'balance'), 0, 'B1: BALANCE AMOUNT = 0');
        eq(val(row, 'created_by'), U.storemgr.name, `B1: CREATED BY = the store manager's name (${U.storemgr.name})`);
        eq(val(row, 'inward_id'), G1?.grn_number, 'B1: INWARD ID = our GRN number');
        ok(/^PINV-/.test(String(val(row, 'pinv'))), 'B1: our PINV in column AM');
        eq(val(row, 'invoice_url'), `https://fnb.example.test/api/bill-submissions/${handoverId}/attachment`, 'B5: INVOICE URL = the sign-in-only link to the uploaded bill photo');
        eq(val(row, 'po_id'), null, 'B1: no PO → PO ID empty');
        eq(val(row, 'po_qty'), null, 'B1: no PO → PO QTY empty');
        eq(val(row, 'variance'), null, 'B1: no PO → VARIANCE empty');
      }
      const cashTot = b1.reduce((t, row) => t + Number(val(row, 'total_inward')), 0);
      const ledger = (db.prepare(`SELECT amount FROM petty_cash_ledger WHERE grn_id = ? AND direction = 'out'`).get(G1?.id) as any)?.amount;
      eq(paise(cashTot), paise(ledger), `B1: the two PAID lines add up to the petty-cash payment (₹${ledger})`);
      // the URL is sign-in-only and serves the photo
      if (handoverId) {
        as(null);
        const anon = await bhAttach.GET(new Request(`http://t/api/bill-submissions/${handoverId}/attachment`), { params: Promise.resolve({ id: handoverId }) });
        eq(anon.status, 401, 'B5: the INVOICE URL refuses a signed-out visitor (401)');
        as('admin');
        const got = await bhAttach.GET(new Request(`http://t/api/bill-submissions/${handoverId}/attachment`), { params: Promise.resolve({ id: handoverId }) });
        eq([got.status, got.headers.get('Content-Type')], [200, 'image/png'], 'B5: signed in, it serves the bill photo');
      }
      // B2
      const b2 = rowBy(g => g('invoice_id') === 'ZZPI-CREDIT-2');
      eq(b2.length, 1, 'B2: the credit GRN line is in the file');
      if (b2[0]) {
        eq([val(b2[0], 'paid'), val(b2[0], 'balance')], [null, null], 'B2: credit bill → PAID and BALANCE empty (never "unpaid")');
        eq(val(b2[0], 'created_by'), U.admin.name, 'B2: CREATED BY = the admin\'s name');
        eq(val(b2[0], 'invoice_url'), null, 'B2: no photo → INVOICE URL empty');
        eq(val(b2[0], 'delivery'), 12, 'B2: DELIVERY CHARGES carried');
      }
      // B3
      const b3 = rowBy(g => g('invoice_id') === 'ZZPI-GHOST-3');
      eq(b3.length, 1, 'B3: the GRN line is in the file');
      if (b3[0]) eq(val(b3[0], 'created_by'), null, 'B3: CREATED BY empty when the login matches no user (never the email)');
      // B4
      const b4 = rowBy(g => g('invoice_id') === 'ZZPI-QC-4');
      eq(b4.length, 1, 'B4: released → now in the file');
      if (b4[0] && G4) {
        const pr = db.prepare(`SELECT created_at, invoice_id FROM purchases WHERE grn_id = ?`).get(G4.id) as any;
        const keyed = ist((db.prepare(`SELECT created_at FROM goods_receipt_notes WHERE id = ?`).get(G4.id) as any).created_at);
        const booked = ist(pr.created_at);
        eq([val(b4[0], 'created_date'), val(b4[0], 'created_time')], [keyed.d, keyed.t], `B4: CREATED = when the GRN was keyed (${keyed.d} ${keyed.t})`);
        ok(booked.d !== keyed.d, `B4: …not the kitchen release (${booked.d} ${booked.t})`);
        eq(val(b4[0], 'created_by'), U.storemgr.name, 'B4: CREATED BY = who keyed the GRN, not who released it');
        eq(val(b4[0], 'pinv'), pr.invoice_id, 'B4: the release\'s PINV in column AM');
      }
      // B6
      const b6 = rowBy(g => g('supplier') === 'ZZPI RECAHO VENDOR');
      eq(b6.map(row => val(row, 'inward_id')).sort(), ['9001', '9002'], 'B6: INWARD ID = Recaho\'s inward id, read from the import\'s note');
      eq(b6.map(row => val(row, 'invoice_id')).sort(), ['RCH-INV-77', 'RCH-INV-78'], 'B6: INVOICE ID = the imported invoice number');
      eq(b6.map(row => [val(row, 'po_id'), val(row, 'po_date'), val(row, 'created_by')]), [[null, null, null], [null, null, null]], 'B6: PO ID, PO DATE, CREATED BY empty on imported rows');
      // The Recaho file gave PO QTY 6 on RCH-INV-77, but the Inward Import
      // (commit route) stores no PO quantity — so PO QTY / VARIANCE are empty,
      // and the About sheet must say exactly that (data-r1 / file-r1).
      const b6Stored = (db.prepare(`SELECT bill_no, po_qty FROM purchases WHERE vendor = 'ZZPI RECAHO VENDOR' AND date = ? ORDER BY bill_no`).all(today) as any[])
        .map(x => [x.bill_no, Number(x.po_qty) || 0]);
      eq(b6Stored, [['RCH-INV-77', 0], ['RCH-INV-78', 0]], 'B6: the Inward Import stored no PO quantity (purchases.po_qty = 0), though the file gave 6');
      eq(b6.map(row => [val(row, 'invoice_id'), val(row, 'po_qty'), val(row, 'variance')]).sort(),
        [['RCH-INV-77', null, null], ['RCH-INV-78', null, null]], 'B6: PO QTY and VARIANCE empty on Recaho Inward Upload rows, even where the Recaho file had a PO QTY');
      const seededAbout: string = XLSX.utils.sheet_to_json(w.f.wb.Sheets[PI.ABOUT_SHEET_NAME], { header: 1, defval: '' }).map((x: any[]) => x.join(' | ')).join('\n');
      ok(seededAbout.includes('(Recaho Inward Upload as it works today records none)'), 'About note 5: says today\'s Recaho Inward Upload records no PO QTY (B6 bears it out)');
      ok(seededAbout.includes('a Purchases → Generic CSV Upload row carries the PO QTY its file gave, where it gave one'), 'About note 5: says a Generic CSV Upload row carries the file\'s PO QTY (B7 bears it out)');
      ok(!seededAbout.includes('Recaho inward data or CSV'), 'About note 5: the old claim (Recaho rows show the file\'s PO QTY) is gone');
      // B11 (file-r2) — production's July Recaho row: PO QTY and VARIANCE beside Recaho's own INWARD ID, PO ID / PO DATE empty.
      const b11 = rowBy(g => g('invoice_id') === 'RCH-INV-5501');
      eq(b11.length, 1, 'B11: the production-shaped Recaho row is in the file');
      if (b11[0]) {
        eq([val(b11[0], 'inward_id'), val(b11[0], 'po_qty'), val(b11[0], 'inward_qty'), val(b11[0], 'variance')], ['9901', 6, 5, -1],
          'B11: INWARD ID 9901 read from the importer\'s note, PO QTY 6 as recorded, VARIANCE = 5 − 6 = −1');
        eq([val(b11[0], 'po_id'), val(b11[0], 'po_date'), val(b11[0], 'created_by')], [null, null, null], 'B11: PO ID / PO DATE empty (no upload keeps the PO number), CREATED BY empty');
        ok(seededAbout.includes('No upload keeps the PO number, so such a row can show PO QTY and INWARD QUANTITY VARIANCE with PO ID and PO DATE empty.'),
          'B11: About note 5 says exactly what this row shows (PO QTY and VARIANCE, PO ID and PO DATE empty)');
        ok(seededAbout.includes('nearly all of the July 2026 rows brought in from Recaho carry one'), 'B11: About note 5 says the July 2026 Recaho rows carry a PO QTY');
        ok(!seededAbout.includes('so on its rows PO QTY is empty even when the Recaho file had one'), 'B11: the old note-5 sentence (Recaho rows never show PO QTY) is gone');
      }
      // B7 / B8
      const b7 = rowBy(g => g('invoice_id') === 'CSV-B-77');
      eq(b7.length, 1, 'B7: the CSV row is in the file');
      if (b7[0]) {
        eq([val(b7[0], 'po_qty'), val(b7[0], 'inward_qty'), val(b7[0], 'variance')], [12, 10, -2], 'B7: PO QTY = the recorded PO qty, VARIANCE = 10 − 12 = −2');
        eq(val(b7[0], 'inward_id'), '7001', 'B7: INWARD ID from the note in the import\'s own words');
        eq([val(b7[0], 'po_id'), val(b7[0], 'po_date')], [null, null], 'B7: no PO number kept → PO ID / PO DATE empty');
      }
      const b8 = rowBy(g => g('invoice_id') === 'CSV-B-78');
      eq(b8.length, 1, 'B8: the CSV row is in the file');
      if (b8[0]) {
        eq(val(b8[0], 'inward_id'), null, 'B8: a prose note ("Inward: 55 pending") gives no INWARD ID');
        eq([val(b8[0], 'po_qty'), val(b8[0], 'variance')], [null, null], 'B8: no PO qty → PO QTY / VARIANCE empty');
        eq(val(b8[0], 'invoice_url'), manualHandoverId ? `https://fnb.example.test/api/bill-submissions/${manualHandoverId}/attachment` : null,
          'B10: a purchase with no GRN links its photo through the manual record carrying its PINV');
      }
      const b9 = rowBy(g => g('invoice_id') === 'OLD-PO-9');
      eq(b9.length, 1, 'B9: the row is in the file');
      if (b9[0] && anyPo) {
        eq([val(b9[0], 'po_id'), val(b9[0], 'po_date')], [anyPo.po_number, String(anyPo.date).slice(0, 10)], 'B9: no GRN → PO ID / PO DATE from purchases.po_id');
        eq([val(b9[0], 'po_qty'), val(b9[0], 'variance'), val(b9[0], 'inward_id')], [null, null, null], 'B9: no GRN line and no recorded PO qty → PO QTY, VARIANCE, INWARD ID empty');
      }
    }
  }

  /* ══════════ L — the "Liquor Inward" sheet ══════════
   * TGBCL bills seeded through the REAL door (POST /api/grn, liquor: true —
   * the only live one; Liquor Store New Bill / Upload CSV answer 410), plus
   * bills shaped exactly as the retired Liquor Store New Bill / CSV routes left
   * them (their own store-engine calls, git 0d32f2b), which are 62% of
   * production's liquor lines. Every ledger line keeps txn_date / recorded_at
   * EMPTY, as on production. Then: sheet = the Liquor Store Inward Register
   * (its REAL route) row for row; total = Net Indent (store_bill_charges, read
   * here independently) to the paisa, or the difference explained part by
   * part; never in the main sheet or its total; per-store view gate. */
  console.log('L  liquor (TGBCL) bills: the "Liquor Inward" sheet = the Liquor Store Inward Register = Net Indent');
  {
    const SE = require(path.join(WT, 'src/lib/store-engine.ts'));
    const PU = require(path.join(WT, 'src/lib/pack-units.ts'));
    const LG = require(path.join(WT, 'src/lib/purchase-inward-liquor.ts'));
    const regRoute = require(path.join(WT, 'src/app/api/stores/[id]/inward-register/route.ts'));
    const accessRoute = require(path.join(WT, 'src/app/api/stores/[id]/access/route.ts'));
    const today = todayIST();
    const LIQ = String((db.prepare(`SELECT id FROM store_locations WHERE name = 'LIQUOR STORE'`).get() as any)?.id || '');
    ok(!!LIQ, 'the copy has the LIQUOR STORE');
    const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    const D1 = day(2), D2 = day(1), D3 = day(6), D4 = day(5);
    const mat = (name: string) => db.prepare('SELECT * FROM raw_materials WHERE name = ?').get(name) as any;
    const M = {
      pipers: mat('100 PIPERS (750ML)'), absolut: mat('ABSOLUT (750ML)'), bacardi: mat('BACARDI CARTA BLANCA (750ML)'),
      aperol: mat('APEROL APERITIF (750ML)'), bud: mat('BUDWEISER MAGNUM 330 ML'), shiraz: mat('AG 47 SHIRAZ (750ML)'),
      limon: mat('BACARDI LIMON (750ML)'), cuatro: mat('BACARDI CUATRO (750ML)'), chard: mat('AG 47 CHARDONNAY (750ML)'),
      aberfeldy: mat('ABERFELDY 12Y.O (70ML)'),
    };
    ok(Object.values(M).every(Boolean), 'liquor items to seed with are on the copy');
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
    const purchasesBefore = count('purchases');
    const SUPPLIER = 'TELANGANA STATE BEVERAGES CORPORATION LTD';
    const post = async (route: any, url: string, body: unknown) => {
      const res = await route.POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      let j: any = null; try { j = await res.json(); } catch { j = null; }
      return { status: res.status, body: j };
    };
    const liquorGrn = async (who: string, b: Record<string, unknown>) => {
      as(who);
      return post(grnRoute, 'http://t/api/grn', { liquor: true, store_id: LIQ, vendor: SUPPLIER, cash_purchase: false, ...b });
    };

    // L1 — keyed by the store manager: cases, bottles, all four TGBCL charges, a NEGATIVE round-off.
    const L1 = await liquorGrn('storemgr', {
      date: D1, invoice_number: 'TGBCL/ZZ/1001', invoice_date: D1,
      items: [
        { material_id: M.pipers.id, cases: 2, bottles: 0, loose: 0, unit_price: 1069.2 },
        { material_id: M.absolut.id, cases: 0, bottles: 6, loose: 0, unit_price: 1520.83 },
        { material_id: M.bacardi.id, cases: 0, bottles: 12, loose: 0, unit_price: 712.5 },
      ],
      liquor_charges: { mrp_rounding: -0.37, excise_turnover_tax: 512.25, special_excise_cess: 1234, tcs: 98.76 },
    });
    eq([L1.status, L1.body?.bill_charges?.net_indent_value], [201, 45180.42], `L1 TGBCL bill saved on Goods Receipt, Net Indent ₹45,180.42 (${L1.body?.error || ''})`);
    // L2 — keyed by the admin: a loose measure, a line AMOUNT (odd rate), a piece item, a POSITIVE round-off.
    const L2 = await liquorGrn('admin', {
      date: D1, invoice_number: 'TGBCL/ZZ/1002', invoice_date: D1,
      items: [
        { material_id: M.aperol.id, cases: 0, bottles: 5, loose: 250, amount: 4799.99 },
        { material_id: M.bud.id, cases: 0, bottles: 24, loose: 0, unit_price: 98.35 },
      ],
      liquor_charges: { mrp_rounding: 0.43, special_excise_cess: 777.77 },
    });
    eq([L2.status, L2.body?.bill_charges?.net_indent_value], [201, 7938.59], `L2 TGBCL bill saved, Net Indent ₹7,938.59 (${L2.body?.error || ''})`);
    // L3 — the next day: a discount and a delivery charge typed on a line.
    const L3 = await liquorGrn('admin', {
      date: D2, invoice_number: 'TGBCL/ZZ/1003', invoice_date: D2,
      items: [
        { material_id: M.shiraz.id, cases: 0, bottles: 3, loose: 0, unit_price: 845.25, discount: 50, delivery_charges: 20 },
        { material_id: M.limon.id, cases: 0, bottles: 2, loose: 0, unit_price: 699.99 },
      ],
      liquor_charges: { mrp_rounding: -0.2, special_excise_cess: 300, tcs: 15.45 },
    });
    eq([L3.status, L3.body?.bill_charges?.net_indent_value], [201, 4250.98], `L3 TGBCL bill saved, Net Indent ₹4,250.98 (${L3.body?.error || ''})`);
    const again = await liquorGrn('admin', { date: D1, invoice_number: 'TGBCL/ZZ/1001', invoice_date: D1,
      items: [{ material_id: M.pipers.id, cases: 0, bottles: 1, loose: 0, unit_price: 1 }] });
    eq(again.status, 409, 'the same indent cannot be entered twice (one door per indent)');

    // The retired Liquor Store New Bill / CSV shape (git 0d32f2b): ledger rows
    // with an empty note, backdated to their own date, and (when charges were
    // sent) one store_bill_charges row — through the same store-engine calls.
    const oldBill = (ref: string, header: string, lines: { m: any; bottles: number; rate: number; date: string }[],
      charges: Record<string, number> | null, by: string) => {
      db.transaction(() => {
        let inv = 0;
        for (const l of lines) {
          const pf = PU.packFactor(l.m);
          const recipeQty = l.bottles * pf;
          const unitCost = pf > 1 ? l.rate / pf : l.rate;
          inv += Math.round(recipeQty * unitCost * 100) / 100;
          const id = SE.postLedger(db, { store_id: LIQ, material_id: l.m.id, txn_type: 'purchase', quantity: recipeQty, unit_cost: unitCost,
            supplier: SUPPLIER, ref, notes: '', created_by: by });
          db.prepare(`UPDATE store_stock_ledger SET created_at = ? || ' ' || strftime('%H:%M:%S', 'now') WHERE id = ?`).run(l.date, id);
        }
        if (charges) {
          SE.upsertBillCharges(db, { store_id: LIQ, invoice_ref: ref, supplier: SUPPLIER, date: header,
            invoice_value: Math.round(inv * 100) / 100, charges, created_by: by });
        }
      })();
    };
    // L4 — an old New Bill (store manager), same day as L1/L2, with charges.
    oldBill('TGBCL-OLD-4004', D1, [
      { m: M.cuatro, bottles: 4, rate: 1210, date: D1 }, { m: M.chard, bottles: 2, rate: 790.5, date: D1 },
    ], { mrp_rounding: 0.11, special_excise_cess: 456.78, tcs: 12.34 }, U.storemgr.email);
    // L5 — an old New Bill sent with NO charges (no Net Indent record).
    oldBill('TGBCL-OLD-5005', '', [{ m: M.aberfeldy, bottles: 10, rate: 145, date: D3 }], null, U.admin.email);
    // L6 — an old CSV bill whose two rows carried different dates.
    oldBill('TGBCL-OLD-6006', D3, [
      { m: M.pipers, bottles: 6, rate: 1069.2, date: D3 }, { m: M.absolut, bottles: 3, rate: 1520.83, date: D4 },
    ], { mrp_rounding: -0.05, excise_turnover_tax: 33.33, special_excise_cess: 210.5, tcs: 4.44 }, U.admin.email);

    eq(count('purchases'), purchasesBefore, 'liquor bills wrote NO purchases rows');
    const seeded = db.prepare(`SELECT COUNT(*) AS n, SUM(txn_date <> '') AS td, SUM(recorded_at <> '') AS ra,
                                      SUM(purchase_uom <> '') AS pu, SUM(pack_size <> 0) AS ps FROM store_stock_ledger
                                WHERE store_id = ? AND txn_type = 'purchase'`).get(LIQ) as any;
    eq([seeded.n, seeded.td, seeded.ra, seeded.pu, seeded.ps], [12, 0, 0, 0, 0],
      '12 liquor lines seeded; txn_date, recorded_at, purchase_uom and pack_size EMPTY on every one (as on production)');
    const railAfterSeed = [count('store_stock_ledger'), count('store_bill_charges')];
    eq((db.prepare(`SELECT GROUP_CONCAT(invoice_ref, ',') AS refs FROM (SELECT invoice_ref FROM store_bill_charges WHERE store_id = ? ORDER BY invoice_ref)`).get(LIQ) as any).refs,
      'TGBCL-OLD-4004,TGBCL-OLD-6006,TGBCL/ZZ/1001,TGBCL/ZZ/1002,TGBCL/ZZ/1003', 'five bills carry a Net Indent record (L1–L4, L6); L5 has none');

    const NAME = db.prepare(`SELECT name FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) OR id = TRIM(?)`);
    const nameOf = (login: string) => {
      const n = NAME.all(login, login) as any[];
      return n.length === 1 && !String(n[0].name).includes('@') ? String(n[0].name).trim() : '';
    };
    const rupeeWords = (x: number) => '₹' + Math.abs(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const adminViewer = { id: U.admin.id, role: 'admin', is_head_chef: false, is_store_manager: false, position: '', role_name: '' };

    /** One window: the file's liquor sheet against the REAL register route, Net Indent, and each ledger line. */
    const checkLiquor = async (from: string, to: string, label: string,
      want: { rows: number; total: number; ni: number; state: 'equal' | 'explained'; parts?: [string, number][] }) => {
      as('admin');
      const r = await getInward(`from=${from}&to=${to}`);
      eq(r.status, 200, `${label}: the route answers 200`);
      if (r.status !== 200) return;
      const wb = XLSX.read(r.body, { type: 'buffer', cellNF: true });
      eq(wb.SheetNames, ['About this file', 'Purchase Inward Data', 'Liquor Inward'], `${label}: three sheets, liquor last`);
      const ws = wb.Sheets['Liquor Inward'];
      const ref = XLSX.utils.decode_range(ws['!ref']);
      const header: string[] = [];
      for (let c = 0; c < COLS.length; c++) header.push(ws[XLSX.utils.encode_cell({ r: 0, c })]?.v);
      eq(header, COLS.map(c => c.header), `${label}: the liquor sheet has the same 39 headers as the main sheet`);
      const cells: any[][] = [];
      for (let rr = 1; rr <= ref.e.r; rr++) {
        const row: any[] = [];
        for (let c = 0; c < COLS.length; c++) row.push(ws[XLSX.utils.encode_cell({ r: rr, c })]);
        cells.push(row);
      }
      eq(cells.length, want.rows, `${label}: ${want.rows} liquor rows`);
      const col = (key: string) => cells.reduce((t, row) => t + paise(v(row[ci(key)])), 0);
      eq(col('total_inward'), paise(want.total), `${label}: Σ TOTAL INWARD AMOUNT = ${rupeeWords(want.total)}`);

      // ── the Liquor Store Inward Register, through its REAL route ──
      const rg = await regRoute.GET(new Request(`http://t/api/stores/${LIQ}/inward-register?from=${from}&to=${to}`), { params: Promise.resolve({ id: LIQ }) });
      const rj = await rg.json();
      eq(rg.status, 200, `${label}: the Liquor Store Inward Register answers`);
      const regRows: any[] = rj.rows || [];
      eq(regRows.length, cells.length, `${label}: rows = the register's rows (${regRows.length})`);
      eq(col('total_inward'), regRows.reduce((t, x) => t + paise(x.total_inward_amount), 0), `${label}: Σ TOTAL INWARD AMOUNT = the Liquor Store Inward Register's total`);
      {
        const k = (a: unknown[]) => a.map(x => (typeof x === 'number' ? String(paise(x)) : String(x ?? ''))).join('|');
        const theirs = new Map<string, number>();
        for (const x of regRows) {
          const key = k([x.invoice_ref, x.inward_date, x.item, x.subtotal, x.discount, x.cgst, x.sgst, x.excise_turnover_tax,
            Number(x.tcs) + Number(x.special_excise_cess), x.delivery_charges, x.mrp_round_off, x.total_inward_amount]);
          theirs.set(key, (theirs.get(key) || 0) + 1);
        }
        let unmatched = 0;
        for (const row of cells) {
          const g = (key: string) => v(row[ci(key)]);
          const key = k([g('invoice_id'), g('inward_date'), g('item_name'), Number(g('subtotal')), Number(g('discount')), Number(g('cgst')),
            Number(g('sgst')), Number(g('excise')), Number(g('tcs_spl')), Number(g('delivery')), Number(g('mrp_round_off')), Number(g('total_inward'))]);
          const left = theirs.get(key) || 0;
          if (left > 0) theirs.set(key, left - 1); else unmatched++;
        }
        eq(unmatched, 0, `${label}: every liquor row = a register line (invoice, date, item and all nine money figures)`);
      }

      // ── Net Indent, read straight from store_bill_charges ──
      const keys = (db.prepare(`SELECT DISTINCT LOWER(TRIM(ref)) AS k FROM store_stock_ledger
                                 WHERE store_id = ? AND txn_type = 'purchase' AND date(created_at) BETWEEN ? AND ?`).all(LIQ, from, to) as any[]).map(x => x.k);
      const ni = keys.length ? Number((db.prepare(`SELECT COALESCE(SUM(net_indent_value), 0) AS s FROM store_bill_charges
                                                   WHERE store_id = ? AND LOWER(TRIM(invoice_ref)) IN (${keys.map(() => '?').join(',')})`).get(LIQ, ...keys) as any).s) : 0;
      eq(paise(ni), paise(want.ni), `${label}: Net Indent of those bills = ${rupeeWords(want.ni)}`);
      if (want.state === 'equal') eq(col('total_inward'), paise(ni), `${label}: Σ TOTAL INWARD AMOUNT = Net Indent, to the paisa`);

      // ── the About sheet ──
      const aboutText: string = XLSX.utils.sheet_to_json(wb.Sheets['About this file'], { header: 1, defval: '' }).map((x: any[]) => x.join(' | ')).join('\n');
      ok(!aboutText.includes('DOES NOT MATCH') && !aboutText.includes('not explained'), `${label}: About shows no mismatch`);
      ok(aboutText.includes('Not included in the total above.'), `${label}: About says the liquor total is not in the main total`);
      // liquor-r1: a line discount is SUBTRACTED (store-engine total = subtotal − disc + …), so the note must say "less".
      ok(aboutText.includes('add up to its Net Indent (invoice value + the four charges), less any discount and plus any delivery charge or CGST/SGST typed on a line (Net Indent leaves those out).')
        && !aboutText.includes('plus any discount'), `${label}: About liquor note gives the discount the right sign (less), delivery and GST plus`);
      if (want.state === 'equal') {
        ok(aboutText.includes(`= Net Indent of those bills, ${rupeeWords(ni)}.`), `${label}: About says the liquor sheet = Net Indent ${rupeeWords(ni)}`);
        ok(!aboutText.includes('Why these liquor totals differ'), `${label}: no difference to explain`);
      } else {
        ok(aboutText.includes(`Net Indent of those bills is ${rupeeWords(ni)}; the difference is explained below.`), `${label}: About gives Net Indent and says the difference is explained`);
        ok(aboutText.includes('Why these liquor totals differ from the bills\' own figures:'), `${label}: About explains the difference`);
        for (const [text, amt] of want.parts || []) {
          const line = aboutText.split('\n').find(l => l.startsWith(`• ${text}`));
          ok(!!line && line.split(' | ')[1] === String(amt), `${label}: explained — ${text}: ${amt} (${line || 'missing'})`);
        }
        const partLines = aboutText.split('\n').filter(l => l.startsWith('• ') && /^• (discount|delivery|CGST|lines)/.test(l));
        eq(partLines.length, (want.parts || []).length, `${label}: exactly the expected explanation lines, no others`);
        const partsSum = (want.parts || []).reduce((t, [, a]) => t + paise(a), 0);
        eq(col('total_inward'), paise(ni) + partsSum, `${label}: Net Indent + the explained parts = Σ TOTAL INWARD AMOUNT, to the paisa`);
      }
      const liqLine = aboutText.split('\n').find(l => l.startsWith('Sheet "Liquor Inward"')) || '';
      ok(liqLine.includes(` | ${Math.round(want.total * 100) / 100} | `), `${label}: About's liquor line carries the sheet total (${liqLine.slice(0, 80)})`);
      ok(liqLine.includes('LIQUOR STORE'), `${label}: About names the store`);

      // ── every row traced back to its ledger line, rules worked out here ──
      const lib = LG.getLiquorInward({ from, to }, adminViewer, db);
      eq(lib.ids.length, cells.length, `${label}: library rows = file rows`);
      let cellDiff = 0;
      lib.rows.forEach((row: any, i: number) => {
        PI.inwardRowCells(row).forEach((w: any, c: number) => { if ((w ?? null) !== v(cells[i]?.[c])) cellDiff++; });
      });
      eq(cellDiff, 0, `${label}: the route's liquor sheet and the library agree cell for cell`);
      const LL = db.prepare(`SELECT l.*, rm.name AS rm_name, rm.sku AS rm_sku, rm.category AS rm_category, rm.unit AS rm_unit,
                                    rm.purchase_unit AS rm_pu, rm.pack_size AS rm_pack
                               FROM store_stock_ledger l JOIN raw_materials rm ON rm.id = l.material_id WHERE l.id = ?`);
      const GR = db.prepare(`SELECT * FROM goods_receipt_notes WHERE grn_number = ? AND store_dest_id = ?`);
      const CH = db.prepare(`SELECT * FROM store_bill_charges WHERE store_id = ? AND LOWER(TRIM(invoice_ref)) = LOWER(TRIM(?))`);
      const EMPTY_LIQ = ['PO ID', 'PO DATE', 'TO ID', 'TO DATE', 'VENDOR CODE', 'GL CODE', 'SUB CATEGORY', 'EXTERNAL ITEM ID',
        'PO QTY', 'TO QTY', 'INWARD QUANTITY VARIANCE', 'VAT', 'CESS', 'INVOICE URL', 'PAID AMOUNT', 'BALANCE AMOUNT'];
      const bad: Record<string, number> = {};
      const miss = (rule: string) => { bad[rule] = (bad[rule] || 0) + 1; };
      const perBill = new Map<string, { ett: number; ts: number; mrp: number; sub: number; tot: number; disc: number; del: number }>();
      lib.ids.forEach((id: string, i: number) => {
        const row = cells[i];
        const g = (key: string) => v(row[ci(key)]);
        const l = LL.get(id) as any;
        if (!l) { miss('ledger line exists'); return; }
        if (l.txn_date !== '' || l.recorded_at !== '') miss('txn_date / recorded_at empty');
        if ((g('invoice_id') ?? '') !== String(l.ref || '').trim()) miss('INVOICE ID = the indent number (ledger ref)');
        if (g('inward_date') !== String(l.created_at).slice(0, 10)) miss('INWARD DATE = the date the Liquor Store files the line under');
        if ((g('supplier') ?? '') !== String(l.supplier || '').trim()) miss('SUPPLIER NAME');
        if ((g('category') ?? '') !== String(l.rm_category || '').trim().toUpperCase()) miss('CATEGORY NAME in capitals');
        if ((g('item_id') ?? '') !== String(l.rm_sku || '').trim()) miss('ITEM ID = sku');
        if ((g('item_name') ?? '') !== String(l.rm_name || '').trim()) miss('ITEM NAME');
        if ((g('purchase_unit') ?? '') !== (String(l.rm_pu || '').trim() || String(l.rm_unit || '').trim())) miss('PURCHASE UNIT');
        const pf = PU.packFactor({ pack_size: l.rm_pack, unit: l.rm_unit, purchase_unit: l.rm_pu });
        if (Math.abs(Number(g('inward_qty')) - Number(l.quantity) / pf) > 1e-6) miss('INWARD QTY = recipe qty ÷ pack (bottles)');
        if (Math.abs(Number(g('rate')) - Number(l.unit_cost) * pf) > 1e-6) miss('RATE = ₹ per bottle');
        if (paise(g('subtotal')) !== paise(Number(l.quantity) * Number(l.unit_cost))) miss('SUBTOTAL = qty × unit cost');
        if (Math.abs(Number(g('inward_qty')) * Number(g('rate')) - Number(g('subtotal'))) > 0.005 + 1e-6) miss('INWARD QTY × RATE = SUBTOTAL');
        if (paise(g('discount')) !== paise(l.discount) || paise(g('delivery')) !== paise(l.delivery_charges)
          || paise(g('cgst')) !== paise(l.cgst) || paise(g('sgst')) !== paise(l.sgst)) miss('line DISCOUNT / DELIVERY / CGST / SGST = the ledger line\'s');
        const total = paise(g('subtotal')) - paise(g('discount')) + paise(g('cgst')) + paise(g('sgst')) + paise(g('excise'))
          + paise(g('delivery')) + paise(g('tcs_spl')) + paise(g('mrp_round_off'));
        if (total !== paise(g('total_inward'))) miss('TOTAL INWARD AMOUNT = the formula, line by line');
        // GRN, PINV, CREATED
        const m = /^Goods Receipt (GRN-\d{4}-\d+) · (PINV-\d{4}-L\d+)$/.exec(String(l.notes || ''));
        const grn = m ? (GR.get(m[1], LIQ) as any) : null;
        const ch = CH.get(LIQ, l.ref) as any;
        if (grn && grn.store_invoice_id !== m![2]) miss('the note\'s PINV is the GRN\'s');
        if ((g('inward_id') ?? '') !== (grn ? grn.grn_number : '')) miss('INWARD ID = our GRN number (Goods Receipt bills only)');
        if ((g('pinv') ?? '') !== (grn ? grn.store_invoice_id : '')) miss('PINV = our liquor PINV (Goods Receipt bills only)');
        const when = ist(grn ? grn.created_at : (ch ? ch.created_at : ''));
        if ((g('created_date') ?? '') !== when.d || (g('created_time') ?? '') !== when.t) miss('CREATED DATE / TIME = GRN entry, else the charges first saved (IST)');
        const by = grn ? nameOf(grn.received_by) : (ch ? nameOf(ch.created_by) : '');
        if ((g('created_by') ?? '') !== by) miss('CREATED BY = the keyer\'s name');
        if (String(g('created_by') ?? '').includes('@')) miss('CREATED BY never an email');
        for (const h of EMPTY_LIQ) {
          const c = COLS.findIndex(x => x.header === h);
          if (row[c] !== undefined) miss(`${h} empty`);
        }
        for (const key of ['inward_qty', 'rate', 'subtotal', 'discount', 'cgst', 'sgst', 'excise', 'delivery', 'tcs_spl', 'mrp_round_off', 'total_inward']) {
          const cell = row[ci(key)];
          if (!cell || cell.t !== 'n') miss(`${key} is a number cell`);
        }
        const bk = String(l.ref || '').trim().toLowerCase();
        const b = perBill.get(bk) || { ett: 0, ts: 0, mrp: 0, sub: 0, tot: 0, disc: 0, del: 0 };
        b.ett += paise(g('excise')); b.ts += paise(g('tcs_spl')); b.mrp += paise(g('mrp_round_off'));
        b.sub += paise(g('subtotal')); b.tot += paise(g('total_inward')); b.disc += paise(g('discount')); b.del += paise(g('delivery'));
        perBill.set(bk, b);
      });
      eq(bad, {}, `${label}: every liquor column rule holds on all ${cells.length} rows`);
      // Each bill whose lines are ALL in the window: its parts add up to its own charges and Net Indent.
      for (const [bk, b] of perBill) {
        const ch = CH.get(LIQ, bk) as any;
        if (!ch) continue;
        const outside = (db.prepare(`SELECT COUNT(*) AS n FROM store_stock_ledger WHERE store_id = ? AND txn_type = 'purchase'
                                      AND LOWER(TRIM(ref)) = ? AND date(created_at) NOT BETWEEN ? AND ?`).get(LIQ, bk, from, to) as any).n;
        eq([b.ett, b.ts, b.mrp], [paise(ch.excise_turnover_tax), paise(ch.tcs) + paise(ch.special_excise_cess), paise(ch.mrp_rounding)],
          `${label}: bill ${ch.invoice_ref}: its lines' EXCISE, TCS + SPECIAL EXCISE CESS and MRP ROUND OFF add up to the bill's own charges`);
        if (outside === 0) {
          eq(b.sub, paise(ch.invoice_value), `${label}: bill ${ch.invoice_ref}: Σ SUBTOTAL = its invoice value`);
          eq(b.tot, paise(ch.net_indent_value) - b.disc + b.del, `${label}: bill ${ch.invoice_ref}: Σ TOTAL INWARD = its Net Indent${b.disc || b.del ? ' − line discount + line delivery' : ''}`);
        }
      }
      scanPersonal(wb, `${label} (liquor)`);
      return { wb, cells, lib };
    };

    // W1 — L1, L2 and the old New Bill L4 on D1: a clean day, = Net Indent exactly.
    const w1 = await checkLiquor(D1, D1, `liquor day ${D1}`, { rows: 7, total: 60009.24, ni: 60009.24, state: 'equal' });
    if (w1) {
      const rowsOf = (inv: string) => w1.cells.filter(row => v(row[ci('invoice_id')]) === inv);
      const l1 = rowsOf('TGBCL/ZZ/1001');
      eq(l1.length, 3, 'L1: three lines');
      eq(paise(l1.reduce((t, row) => t + Number(v(row[ci('total_inward')])), 0)), paise(45180.42), 'L1: its lines add up to its Net Indent ₹45,180.42');
      eq(l1.map(row => v(row[ci('excise')])).reduce((a: number, b: number) => a + b, 0).toFixed(2), '512.25', 'L1: EXCISE = the Bar Excise Turnover Tax ₹512.25, spread over the lines');
      const pip = l1.find(row => v(row[ci('item_name')]) === '100 PIPERS (750ML)');
      eq([v(pip?.[ci('inward_qty')]), v(pip?.[ci('rate')]), v(pip?.[ci('subtotal')]), v(pip?.[ci('purchase_unit')])], [24, 1069.2, 25660.8, 'BTL'],
        'L1: 2 cases of 12 → INWARD QTY 24 bottles at ₹1,069.20 = ₹25,660.80');
      const g1 = db.prepare(`SELECT * FROM goods_receipt_notes WHERE id = ?`).get(L1.body.grn_id) as any;
      eq([v(l1[0][ci('inward_id')]), v(l1[0][ci('pinv')]), v(l1[0][ci('created_by')])], [g1.grn_number, g1.store_invoice_id, U.storemgr.name],
        `L1: INWARD ID = ${g1.grn_number}, PINV = ${g1.store_invoice_id}, CREATED BY = ${U.storemgr.name}`);
      eq([v(l1[0][ci('created_date')]), v(l1[0][ci('inward_date')])], [today, D1], 'L1: CREATED DATE = when it was keyed in (today), not the backdated bill date');
      const ap = rowsOf('TGBCL/ZZ/1002').find(row => v(row[ci('item_name')]) === 'APEROL APERITIF (750ML)');
      ok(ap && Math.abs(v(ap[ci('inward_qty')]) - 16 / 3) < 1e-6 && v(ap[ci('subtotal')]) === 4799.99,
        'L2: 5 bottles + 250 ml loose → INWARD QTY 5.333333 bottles, SUBTOTAL ₹4,799.99 (the line amount)');
      eq(rowsOf('TGBCL/ZZ/1002')[0] && v(rowsOf('TGBCL/ZZ/1002')[0][ci('created_by')]), U.admin.name, 'L2: CREATED BY = the admin\'s name');
      const l4 = rowsOf('TGBCL-OLD-4004');
      eq(l4.length, 2, 'L4 (old New Bill): two lines');
      eq(l4.map(row => [v(row[ci('inward_id')]), v(row[ci('pinv')])]), [[null, null], [null, null]], 'L4: no GRN → INWARD ID and PINV empty');
      const ch4 = db.prepare(`SELECT created_at FROM store_bill_charges WHERE invoice_ref = 'TGBCL-OLD-4004'`).get() as any;
      eq([v(l4[0][ci('created_date')]), v(l4[0][ci('created_time')]), v(l4[0][ci('created_by')])], [ist(ch4.created_at).d, ist(ch4.created_at).t, U.storemgr.name],
        'L4: CREATED = when its charges were first saved, BY = the store manager (never the backdated ledger stamp, never an email)');
      // the main sheet is untouched by liquor
      const f = readFile(XLSX.write(w1.wb, { type: 'buffer', bookType: 'xlsx' }));
      ok(!f.cells.some(row => /^TGBCL/.test(String(v(row[ci('invoice_id')]) ?? ''))), 'no liquor line on the main sheet');
    }
    await checkWindow(D1, D1, `main sheet on liquor day ${D1}`);

    // W2 — L3 alone: a discount and a delivery typed on a line, explained.
    await checkLiquor(D2, D2, `liquor day ${D2}`, { rows: 2, total: 4220.98, ni: 4250.98, state: 'explained', parts: [
      ['discount typed on the lines (Net Indent leaves it out)', -50],
      ['delivery charges typed on the lines (Net Indent leaves them out)', 20],
    ] });
    // W12 — both days.
    await checkLiquor(D1, D2, `liquor ${D1}…${D2}`, { rows: 9, total: 64230.22, ni: 64260.22, state: 'explained', parts: [
      ['discount typed on the lines (Net Indent leaves it out)', -50],
      ['delivery charges typed on the lines (Net Indent leaves them out)', 20],
    ] });
    // W3 — the old CSV bill split across two dates, and the old bill with no charges.
    await checkLiquor(D3, D3, `liquor day ${D3}`, { rows: 2, total: 8113.42, ni: 11225.91, state: 'explained', parts: [
      ['lines whose bill number has no Net Indent record (their SUBTOTAL)', 1450],
      ['lines of these bills dated outside these dates', -4562.49],
    ] });
    // W34 — both dates of the split bill: only the no-charges bill differs.
    await checkLiquor(D3, D4, `liquor ${D3}…${D4}`, { rows: 3, total: 12675.91, ni: 11225.91, state: 'explained', parts: [
      ['lines whose bill number has no Net Indent record (their SUBTOTAL)', 1450],
    ] });
    // The whole span.
    await checkLiquor(D3, D2, `liquor ${D3}…${D2}`, { rows: 12, total: 76906.13, ni: 75486.13, state: 'explained', parts: [
      ['discount typed on the lines (Net Indent leaves it out)', -50],
      ['delivery charges typed on the lines (Net Indent leaves them out)', 20],
      ['lines whose bill number has no Net Indent record (their SUBTOTAL)', 1450],
    ] });
    await checkWindow(D3, D2, `main sheet over the liquor span ${D3}…${D2}`);

    // ── access: a store's liquor bills only for a login that may view that store ──
    if (U.accounts) {
      as('accounts');
      const a = await getInward(`from=${D1}&to=${D1}`);
      eq(a.status, 200, 'Accounts (finance tick, no Liquor Store access): the file downloads');
      const awb = XLSX.read(a.body, { type: 'buffer' });
      const aoa = XLSX.utils.sheet_to_json(awb.Sheets['Liquor Inward'], { header: 1, defval: '' }) as any[][];
      eq(aoa.length, 2, 'Accounts without store access: no liquor rows, one line');
      eq(aoa[1].filter((x: any) => x !== '').map(String), ['Left out: your login cannot view LIQUOR STORE (Inventory → Liquor Store), so its liquor bills are not in this file.'],
        'Accounts without store access: the liquor sheet says the store is left out and why');
      const aAbout = XLSX.utils.sheet_to_json(awb.Sheets['About this file'], { header: 1, defval: '' }).map((x: any[]) => x.join(' | ')).join('\n');
      ok(aAbout.includes('Left out: LIQUOR STORE — your login cannot view that store (Inventory → Liquor Store), so its liquor bills are not in this file.'), 'Accounts: About names the store left out');
      ok(!aAbout.includes('60,009.24') && !aAbout.includes('60009.24'), 'Accounts: no liquor figure leaks onto the About sheet');
      // The register itself refuses this login (the gate reused here).
      const rg = await regRoute.GET(new Request(`http://t/api/stores/${LIQ}/inward-register?from=${D1}&to=${D1}`), { params: Promise.resolve({ id: LIQ }) });
      eq(rg.status, 403, 'Accounts: the Liquor Store Inward Register refuses the same login (403) — no access was widened');
      // Granted view on Liquor Store (admin, the REAL access route) → included.
      as('admin');
      const gr = await accessRoute.POST(new Request(`http://t/api/stores/${LIQ}/access`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: U.accounts.id, can_view: true }) }), { params: Promise.resolve({ id: LIQ }) });
      eq(gr.status, 200, 'admin grants Accounts view on LIQUOR STORE');
      as('accounts');
      const b = await getInward(`from=${D1}&to=${D1}`);
      const bwb = XLSX.read(b.body, { type: 'buffer' });
      const brows = (XLSX.utils.sheet_to_json(bwb.Sheets['Liquor Inward'], { header: 1, defval: '' }) as any[][]).length - 1;
      eq(brows, 7, 'Accounts with view on LIQUOR STORE: the 7 liquor rows are included');
    } else console.log('    (no Accounts user on this copy — the per-store gate case skipped)');

    // ── the mismatch alarm FIRES: one bill's stored Net Indent off by ₹0.01 (on this test copy only) ──
    {
      db.prepare(`UPDATE store_bill_charges SET net_indent_value = net_indent_value + 0.01 WHERE store_id = ? AND invoice_ref = 'TGBCL-OLD-4004'`).run(LIQ);
      as('admin');
      const r = await getInward(`from=${D1}&to=${D1}`);
      const wb = XLSX.read(r.body, { type: 'buffer' });
      const about: string = XLSX.utils.sheet_to_json(wb.Sheets['About this file'], { header: 1, defval: '' }).map((x: any[]) => x.join(' | ')).join('\n');
      ok(about.includes('✗ DOES NOT MATCH the Net Indent of those bills (₹60,009.25) — report it.'), 'tampered Net Indent: the About line raises the mismatch');
      const lines = about.split('\n');
      ok(lines.some(l => l.startsWith('TOTAL INWARD AMOUNT — Net Indent | 60009.24 | 60009.25 | ✗ DOES NOT MATCH — report it')), 'tampered Net Indent: the check table shows ✗ on TOTAL vs Net Indent');
      ok(lines.some(l => l.startsWith('• ✗ not explained by anything above — report it | -0.01')), 'tampered Net Indent: the unexplained ₹0.01 is named');
      db.prepare(`UPDATE store_bill_charges SET net_indent_value = net_indent_value - 0.01 WHERE store_id = ? AND invoice_ref = 'TGBCL-OLD-4004'`).run(LIQ);
      const back = await getInward(`from=${D1}&to=${D1}`);
      const bAbout: string = XLSX.utils.sheet_to_json(XLSX.read(back.body, { type: 'buffer' }).Sheets['About this file'], { header: 1, defval: '' }).map((x: any[]) => x.join(' | ')).join('\n');
      ok(bAbout.includes('= Net Indent of those bills, ₹60,009.24.') && !bAbout.includes('DOES NOT MATCH'), 'restored: equal again');
    }

    // ── a failed liquor section never takes the main sheet down ──
    {
      const res = PI.getPurchaseInward({ from: D1, to: D1, origin: 'http://t' }, db);
      const buf = PI.buildPurchaseInwardWorkbook(res, { liquor: LG.liquorInwardFailed('test failure') });
      const wb = XLSX.read(buf, { type: 'buffer' });
      const about = XLSX.utils.sheet_to_json(wb.Sheets['About this file'], { header: 1, defval: '' }).map((x: any[]) => x.join(' | ')).join('\n');
      ok(about.includes('✗ Could not be built (test failure). Report it.'), 'a failed liquor section: About says so');
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets['Liquor Inward'], { header: 1, defval: '' }) as any[][];
      eq(aoa[1].filter((x: any) => x !== '').map(String), ['This sheet could not be built (test failure). See "About this file".'], 'a failed liquor section: the sheet says so in one line');
      eq(readFile(buf).cells.length, res.rows.length, 'a failed liquor section: the main sheet is complete');
    }

    // ── the re-import guard with liquor rows in the file ──
    {
      as('admin');
      const r = await getInward(`from=${D3}&to=${D2}`);
      const wb = XLSX.read(r.body, { type: 'buffer' });
      eq(parseInwardWorkbook(XLSX, wb).length, 0, 'with liquor rows: parseInwardWorkbook reads 0 rows');
      const before = count('purchases');
      const fd = new FormData(); fd.append('file', new Blob([r.body]), 'purchase-inward.xlsx');
      const pv = await previewRoute.POST(new Request('http://t/api/inward-import/preview', { method: 'POST', body: fd }));
      const pj = await pv.json();
      eq([pv.status, pj.rows], [200, 0], 'with liquor rows: the REAL preview route finds 0 importable rows');
      eq(count('purchases'), before, 'with liquor rows: nothing was written');
    }
    // ── downloading changed nothing on the liquor rail ──
    eq([count('store_stock_ledger'), count('store_bill_charges')], railAfterSeed, 'the downloads wrote nothing to the liquor ledger or its bill charges');
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
