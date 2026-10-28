/**
 * ROUTED REQUISITION LINES — owner rulings #45 + #74 — THE PROOF.
 *
 *   npx tsx scripts/routed-requisition-tests.ts <dir holding a COPY of fnb-controller.db>
 *
 * RUNS ON A HARNESS COPY ONLY. The directory must sit under a `harness/`
 * directory, must not be this worktree, and must hold fnb-controller.db; the
 * script chdirs there BEFORE the app's db module loads (db.ts reads
 * process.cwd()), so getDb() — and every real route handler called below —
 * opens the copy and nothing else. Never point it at the worktree or prod DB.
 *
 * The real route handlers run (chef-approve, store-issue, store-process,
 * cancel); next/headers is replaced by a stub whose session cookie is the
 * test user's token. The department transfer is driven through dept-ledger's
 * own sendDeptTransfer / flagDeptTransferDispute / reverseDeptTransfer and
 * routed-requisitions' applyRoutedSend / applyRoutedSendBack — the calls the
 * transfer routes make — inside one IMMEDIATE transaction, as those routes do.
 *
 * Seeds (on the copy only): a MATERIAL rule CHICKEN BREAST BONELESS → Akan
 * Main Kitchen and a CATEGORY rule dairy → Akan Main Kitchen; Kitchen's books
 * get the goods by a 'direct_receipt' (what a Direct Issue delivery posts).
 *
 * Exits 1 on the first failed assertion block's summary (every check is
 * counted; the failures are printed).
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

const dir = path.resolve(String(process.argv[2] || process.env.ROUTED_TEST_DIR || ''));
const WT = path.resolve(__dirname, '..');
if (!dir || !fs.existsSync(path.join(dir, 'fnb-controller.db'))) {
  console.error('usage: npx tsx scripts/routed-requisition-tests.ts <dir holding a COPY of fnb-controller.db>');
  process.exit(2);
}
if (!dir.split(path.sep).includes('harness') || path.resolve(dir) === WT) {
  console.error(`refusing: ${dir} is not a harness copy (it must sit under a harness/ directory, never the worktree).`);
  process.exit(2);
}

// next/headers stub: cookies() returns the current test user's session token.
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
function ok(cond: unknown, what: string, detail?: unknown) {
  if (cond) { pass++; return; }
  fails.push(`${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;

async function main() {
  const { getDb } = require(path.join(WT, 'src/lib/db.ts'));
  const db = getDb();
  const RR = require(path.join(WT, 'src/lib/routed-requisitions.ts'));
  const DL = require(path.join(WT, 'src/lib/dept-ledger.ts'));
  const { evaluateRequisitionLines } = require(path.join(WT, 'src/lib/po-helpers.ts'));
  const { partyReqSplit } = require(path.join(WT, 'src/lib/party-liquor.ts'));
  const { fulfilRequisitionFromPo } = require(path.join(WT, 'src/lib/po-requisition-fulfil.ts'));
  const chefApprove = require(path.join(WT, 'src/app/api/requisitions/[id]/chef-approve/route.ts'));
  const storeIssue = require(path.join(WT, 'src/app/api/requisitions/[id]/store-issue/route.ts'));
  const storeProcess = require(path.join(WT, 'src/app/api/requisitions/[id]/store-process/route.ts'));
  const cancelRoute = require(path.join(WT, 'src/app/api/requisitions/[id]/cancel/route.ts'));

  const one = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as any;
  const all = (sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as any[];
  const id = () => nodeCrypto.randomUUID();

  // ── fixtures ────────────────────────────────────────────────────────────
  const dept = (name: string) => one(`SELECT id, name FROM departments WHERE name = ?`, name);
  const mat = (name: string) => one(`SELECT id, name, unit, purchase_unit, pack_size, current_stock, average_price, category FROM raw_materials WHERE name = ?`, name);
  const KITCHEN = dept('Akan Main Kitchen');
  const INDIAN = dept('Akan  Indian');
  const BANQUET = dept('Party Bulk');
  const CHICKEN = mat('CHICKEN BREAST BONELESS');
  const ONION = mat('Onion');
  const RICE = mat('BASMATI RICE 30 KG');
  const BUTTER = mat('UNSALTED BUTTER 500 GM');
  for (const [k, v] of Object.entries({ KITCHEN, INDIAN, BANQUET, CHICKEN, ONION, RICE, BUTTER })) {
    if (!v) { console.error(`fixture missing: ${k}`); process.exit(2); }
  }
  const rmStock = (m: any) => Number(one(`SELECT current_stock FROM raw_materials WHERE id = ?`, m.id).current_stock) || 0;

  // The deploy stamp ran at boot (no rules yet on this copy ⇒ 0 routed).
  const marker0 = one(`SELECT value FROM settings WHERE key = ?`, RR.ROUTED_BACKFILL_KEY);
  ok(!!marker0, 'boot wrote the deploy-stamp marker');
  ok(marker0 && JSON.parse(marker0.value).stamped === 0, 'deploy stamp routed nothing without rules', marker0?.value);

  // Rules (harness copy only).
  db.prepare(`DELETE FROM direct_issue_rules`).run();
  db.prepare(`INSERT INTO direct_issue_rules (id, rule_type, material_id, department_id, created_by) VALUES (?, 'material', ?, ?, 'test')`)
    .run('rule-chicken', CHICKEN.id, KITCHEN.id);
  db.prepare(`INSERT INTO direct_issue_rules (id, rule_type, category_key, category_label, department_id, created_by) VALUES (?, 'category', 'dairy', 'Dairy', ?, 'test')`)
    .run('rule-dairy', KITCHEN.id);
  // Kitchen's books: what Direct Issue deliveries put there.
  DL.postDeptLedger(db, { departmentId: KITCHEN.id, materialId: CHICKEN.id, type: 'direct_receipt', quantity: 10, referenceId: 'test-di-1', source: 'test', notes: 'test DI', user: 'test' });
  DL.postDeptLedger(db, { departmentId: KITCHEN.id, materialId: BUTTER.id, type: 'direct_receipt', quantity: 4000, referenceId: 'test-di-2', source: 'test', notes: 'test DI', user: 'test' });

  // Users + sessions.
  const user = (email: string, flags: { role: string; head?: number; store?: number }) => {
    const uid = id();
    db.prepare(`INSERT INTO users (id, email, password_hash, name, role, is_active, is_head_chef, is_store_manager, can_approve_requisitions)
                VALUES (?, ?, 'x', ?, ?, 1, ?, ?, 0)`).run(uid, email, email.split('@')[0], flags.role, flags.head || 0, flags.store || 0);
    const tok = `tok-${uid}`;
    db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01 00:00:00')`).run(tok, uid);
    return { uid, email, tok };
  };
  const ADMIN = user('rt-admin@test.local', { role: 'admin', head: 1 });
  const STORE = user('rt-store@test.local', { role: 'manager', store: 1 });
  const KCHEF = 'rt-kitchen@test.local';
  const as = (u: { tok: string }) => { (globalThis as any).__TOKEN = u.tok; };
  const post = async (mod: any, reqId: string, body: unknown) => {
    const res: Response = await mod.POST(
      new Request(`http://test/api/requisitions/${reqId}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: reqId }) },
    );
    return { status: res.status, body: await res.json() as any };
  };

  let reqSeq = 0;
  const mkReq = (deptId: string, lines: Array<{ m: any; qty: number; unit?: string }>, o?: { purpose?: string; status?: string; event?: string; fp?: string }) => {
    const rid = id();
    reqSeq++;
    db.prepare(`INSERT INTO requisitions (id, req_number, department_id, date, status, purpose, event_name, event_date, fp_id)
                VALUES (?, ?, ?, date('now'), ?, ?, ?, ?, ?)`)
      .run(rid, `REQ-RT-${reqSeq}`, deptId, o?.status || 'submitted', o?.purpose || 'internal',
        o?.event || '', o?.event ? '2026-11-01' : null, o?.fp || null);
    const ids: string[] = [];
    for (const l of lines) {
      const lid = id();
      db.prepare(`INSERT INTO requisition_items (id, req_id, material_id, quantity_requested, unit, department_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(lid, rid, l.m.id, l.qty, l.unit || l.m.purchase_unit || l.m.unit, deptId);
      ids.push(lid);
    }
    return { rid, ids, number: `REQ-RT-${reqSeq}` };
  };
  const line = (lid: string) => one(`SELECT * FROM requisition_items WHERE id = ?`, lid);
  const reqRow = (rid: string) => one(`SELECT * FROM requisitions WHERE id = ?`, rid);
  const ledgerRows = (lid: string) => all(`SELECT * FROM requisition_issue_ledger WHERE req_item_id = ? ORDER BY rowid`, lid);
  let keySeq = 0;
  const send = (from: any, to: any, reqId: string, items: Array<{ lid: string; m: any; qty: number }>) =>
    db.transaction(() => {
      const res = DL.sendDeptTransfer(db, {
        fromDepartmentId: from.id, toDepartmentId: to.id, user: KCHEF, clientKey: `rt-key-${++keySeq}-xyz`,
        requisitionId: reqId,
        lines: items.map((i) => ({ materialId: i.m.id, quantity: i.qty, unit: 'purchase', reqItemId: i.lid, reqLineQty: i.qty })),
      });
      const sync = RR.applyRoutedSend(db, res.transfer, KCHEF);
      return { res, sync };
    }).immediate();

  // ═══ A. THE STAMP at chef-approve ═══════════════════════════════════════
  console.log('A. stamp at chef-approve');
  const A = mkReq(INDIAN.id, [{ m: CHICKEN, qty: 1 }, { m: ONION, qty: 2 }, { m: BUTTER, qty: 0.5, unit: 'kg' }]);
  as(ADMIN);
  let r = await post(chefApprove, A.rid, {});
  ok(r.status === 200, 'chef-approve 200', r);
  ok(line(A.ids[0]).routed_department_id === KITCHEN.id && line(A.ids[0]).routed_via === 'material', 'chicken (material rule) routed to Kitchen', line(A.ids[0]));
  ok(line(A.ids[1]).routed_department_id == null, 'onion not routed');
  ok(line(A.ids[2]).routed_department_id === KITCHEN.id && line(A.ids[2]).routed_via === 'category', 'butter (category rule) routed to Kitchen');
  ok(all(`SELECT 1 FROM audit_events WHERE event_type = 'req_item.routed' AND entity_id IN (?, ?)`, A.ids[0], A.ids[2]).length === 2, 'two req_item.routed audit rows');
  const B = mkReq(KITCHEN.id, [{ m: CHICKEN, qty: 1 }]);
  r = await post(chefApprove, B.rid, {});
  ok(r.status === 200 && line(B.ids[0]).routed_department_id == null, "Kitchen's own chicken line goes to the store (not routed)");

  // ═══ C. STORE-ISSUE refuses routed lines ═════════════════════════════════
  console.log('C. store-issue');
  as(STORE);
  const chickenC0 = rmStock(CHICKEN);
  r = await post(storeIssue, A.rid, { lines: [{ id: A.ids[0], action: 'issue', quantity: 1 }] });
  ok(r.status === 400 && r.body.code === 'routed' && r.body.applied === 0, 'store issue on routed line → 400 routed', r.body);
  ok(/Akan Main Kitchen sends this — Direct Issue routes CHICKEN BREAST BONELESS to Akan Main Kitchen, so the central store never holds it\./.test(r.body.error || ''), 'refusal names the sending department truthfully', r.body.error);
  ok(near(rmStock(CHICKEN), chickenC0) && near(line(A.ids[0]).quantity_issued, 0) && ledgerRows(A.ids[0]).length === 0, 'nothing written');
  r = await post(storeIssue, A.rid, { lines: [{ id: A.ids[0], action: 'defer', defer_until: '2026-12-01T10:00', reason: 'x' }] });
  ok(r.status === 400 && r.body.code === 'routed' && !line(A.ids[0]).deferred_until, 'defer on routed line refused');
  r = await post(storeIssue, A.rid, { lines: [{ id: A.ids[0], action: 'undo' }] });
  ok(r.status === 400 && r.body.code === 'routed', 'undo on routed line refused');
  const onionC0 = rmStock(ONION);
  r = await post(storeIssue, A.rid, { lines: [{ id: A.ids[1], action: 'issue', quantity: 2 }, { id: A.ids[0], action: 'issue', quantity: 1 }] });
  ok(r.status === 400 && near(line(A.ids[1]).quantity_issued, 0) && near(rmStock(ONION), onionC0), 'a mixed gesture is refused WHOLE (onion not issued)');
  r = await post(storeIssue, A.rid, { lines: [{ id: A.ids[1], action: 'issue', quantity: 2 }] });
  ok(r.status === 200 && near(line(A.ids[1]).quantity_issued, 2) && near(rmStock(ONION), onionC0 - 2), 'onion issued from central as before', r.body);
  ok(reqRow(A.rid).status === 'store_processed', 'requisition store_processed (chicken + butter with Kitchen)', reqRow(A.rid).status);
  ok(near(rmStock(CHICKEN), chickenC0), 'central chicken untouched by the store desk');

  // ═══ D. STORE-PROCESS skips routed lines; the tick is refused ══════════
  console.log('D. store-process');
  as(ADMIN);
  const D = mkReq(INDIAN.id, [{ m: CHICKEN, qty: 1 }, { m: ONION, qty: 1 }]);
  await post(chefApprove, D.rid, {});
  as(STORE);
  r = await post(storeProcess, D.rid, { lines: [{ id: D.ids[0], quantity_issued: 1 }, { id: D.ids[1], quantity_issued: 1 }] });
  ok(r.status === 400 && r.body.code === 'routed' && reqRow(D.rid).status === 'chef_approved', 'store-process posting a routed issue → 400 routed, nothing written', r.body);
  const vend = one(`SELECT v.id, v.name FROM vendor_materials vm JOIN vendors v ON v.id = vm.vendor_id WHERE vm.material_id = ? AND v.is_active = 1 LIMIT 1`, ONION.id);
  r = await post(storeProcess, D.rid, {
    auto_create_po: true,
    lines: [{ id: D.ids[1], quantity_issued: 0, quantity_to_purchase: 5, vendor: vend?.name, vendor_id: vend?.id, unit_price: 20, po_entry_unit: 'kg' }],
  });
  ok(r.status === 409 && r.body.code === 'routed_open' && /Akan Main Kitchen still has to send/.test(r.body.error || ''), 'tick PO while a routed line is owed → 409 routed_open', r.body);
  ok(reqRow(D.rid).status === 'chef_approved' && !reqRow(D.rid).linked_po_id, 'no PO raised, nothing written');
  r = await post(storeProcess, D.rid, { lines: [{ id: D.ids[1], quantity_issued: 1 }] });
  ok(r.status === 200, 'store-process onion only → 200', r.body);
  ok(near(line(D.ids[0]).quantity_issued, 0) && ledgerRows(D.ids[0]).length === 0, 'routed line untouched by the absolute write loop');
  ok(reqRow(D.rid).status === 'store_processed', 'status store_processed (chicken owed by Kitchen)', reqRow(D.rid).status);
  const cand = evaluateRequisitionLines(db, { ids: [D.ids[0]], outletId: null })[0];
  ok(cand?.blocked?.code === 'routed' && /Akan Main Kitchen's To send list/.test(cand.blocked.reason), 'merged-PO candidate refuses the routed line', cand?.blocked);

  // ═══ E. SEND fulfils the line ═══════════════════════════════════════════
  console.log('E. send');
  const q0 = RR.toSendQueue(db, KITCHEN.id, null);
  const qa = q0.groups.find((g: any) => g.requisition_id === A.rid);
  ok(qa && qa.lines.length === 2 && qa.to_department_id === INDIAN.id, "A's chicken + butter on Kitchen's To send queue", qa);
  const qChicken = qa?.lines.find((l: any) => l.req_item_id === A.ids[0]);
  ok(qChicken && near(qChicken.owed_purchase, 1) && near(qChicken.sendable_purchase, 10) && qChicken.can_send === true, 'queue figures lead with purchase units: owes 1 kg, Kitchen holds 10 kg', qChicken);
  ok(q0.explain.length >= 5 && /^Direct Issue sends (CHICKEN BREAST BONELESS and Dairy|Dairy and CHICKEN BREAST BONELESS) deliveries straight to Akan Main Kitchen, so the central store never holds them\./.test(q0.explain[0]), 'explain[0] states the rules', q0.explain[0]);
  ok(!q0.groups.some((g: any) => g.requisition_id === B.rid), "Kitchen's own requisition is not on its queue");

  const kitChicken0 = DL.deptSendableFor(db, KITCHEN.id, CHICKEN.id).available;
  const s1 = send(KITCHEN, INDIAN, A.rid, [{ lid: A.ids[0], m: CHICKEN, qty: 0.6 }]);
  ok(near(line(A.ids[0]).quantity_issued, 0.6), 'send 0.6 kg → quantity_issued 0.6', line(A.ids[0]).quantity_issued);
  ok(near(rmStock(CHICKEN), chickenC0), 'central chicken unchanged by the send');
  ok(near(DL.deptSendableFor(db, KITCHEN.id, CHICKEN.id).available, kitChicken0 - 0.6), "Kitchen's books −0.6 kg");
  const tl = s1.res.transfer.lines[0];
  const legs = all(`SELECT department_id, type, quantity FROM department_material_transactions WHERE reference_id = ? ORDER BY type`, tl.id);
  ok(legs.length === 2 && legs.some((x) => x.type === 'transfer_out' && x.department_id === KITCHEN.id && near(x.quantity, -0.6))
    && legs.some((x) => x.type === 'transfer_in' && x.department_id === INDIAN.id && near(x.quantity, 0.6)), 'transfer legs: Kitchen −0.6, Indian +0.6', legs);
  const lr = ledgerRows(A.ids[0]);
  ok(lr.length === 1 && lr[0].reason === 'routed_send' && lr[0].skip_reason === 'routed' && near(lr[0].delta_recipe_qty, 0)
    && near(lr[0].recorded_recipe_qty, 0.6) && Number(lr[0].stock_applied) === 0 && lr[0].client_token === `dtl:${tl.id}`,
    'issue ledger row: routed_send, skip routed, delta 0, recorded 0.6', lr);
  ok(all(`SELECT 1 FROM inventory_transactions WHERE material_id = ? AND reference_id = ?`, CHICKEN.id, A.rid).length === 0, 'no central movement row for the routed line');
  ok(reqRow(A.rid).status === 'store_processed' && !s1.sync.requisitions[0].fulfilled, 'part sent → still open');
  // Idempotent replay of the sync.
  const replay = db.transaction(() => RR.applyRoutedSend(db, { id: s1.res.transfer.id }, KCHEF)).immediate();
  ok(replay.lines[0] && near(replay.lines[0].delta_line, 0) && ledgerRows(A.ids[0]).length === 1, 'replayed sync changes nothing, writes no row');
  send(KITCHEN, INDIAN, A.rid, [{ lid: A.ids[0], m: CHICKEN, qty: 0.4 }]);
  ok(near(line(A.ids[0]).quantity_issued, 1) && RR.routedLineState(db, [A.ids[0]]).get(A.ids[0]).complete, 'second send 0.4 → line complete by THE RULE');
  ok(reqRow(A.rid).status === 'store_processed', 'butter still owed → requisition open');
  const sb = send(KITCHEN, INDIAN, A.rid, [{ lid: A.ids[2], m: BUTTER, qty: 0.5 }]);
  ok(near(line(A.ids[2]).quantity_issued, 0.5) && near(ledgerRows(A.ids[2])[0]?.recorded_recipe_qty, 500), 'butter 0.5 kg (= 500 g) sent, recorded 500 g', ledgerRows(A.ids[2]));
  ok(reqRow(A.rid).status === 'fulfilled' && reqRow(A.rid).fulfilled_by === KCHEF && sb.sync.requisitions[0].fulfilled, 'every line done → fulfilled by the sender', reqRow(A.rid));
  ok(!RR.toSendQueue(db, KITCHEN.id, null).groups.some((g: any) => g.requisition_id === A.rid), 'A left the queue');

  // Sender holds none → refused by the transfer guard.
  let refused = '';
  try { send(KITCHEN, INDIAN, D.rid, [{ lid: D.ids[0], m: ONION, qty: 1 }]); } catch (e: any) { refused = String(e?.code || e?.reason || e?.message || ''); }
  ok(!!refused, 'a send the sender cannot cover (or a wrong material for the line) is refused', refused);
  ok(near(line(D.ids[0]).quantity_issued, 0), 'nothing written on the refused send');

  // ═══ F. DISPUTE, SEND BACK, RE-SEND ═════════════════════════════════════
  console.log('F. dispute / send-back');
  DL.flagDeptTransferDispute(db, { transferId: s1.res.transfer.id, user: 'rt-indian@test.local', kind: 'short', reason: 'only 0.4 arrived', lines: [{ lineId: tl.id, quantityReceived: 0.4 }] });
  ok(near(line(A.ids[0]).quantity_issued, 1) && reqRow(A.rid).status === 'fulfilled', 'a dispute flag changes nothing');
  const rev = db.transaction(() => {
    const res = DL.reverseDeptTransfer(db, { transferId: s1.res.transfer.id, user: KCHEF, clientKey: `rt-rev-${++keySeq}-xyz`, authority: 'disputed_only' });
    return { res, sync: res.duplicate ? null : RR.applyRoutedSendBack(db, res.transfer, KCHEF) };
  }).immediate();
  ok(near(line(A.ids[0]).quantity_issued, 0.8), 'send-back 0.2 kg → line holds 0.8', line(A.ids[0]).quantity_issued);
  ok(reqRow(A.rid).status === 'store_processed' && reqRow(A.rid).fulfilled_at == null, 'requisition re-opened, fulfilled_* cleared', reqRow(A.rid));
  ok(rev.sync && rev.sync.lines[0]?.reopened === true && near(rev.sync.lines[0].owed_purchase, 0.2), 'sync reports 0.2 kg owed again', rev.sync?.lines);
  const qBack = RR.toSendQueue(db, KITCHEN.id, null).groups.find((g: any) => g.requisition_id === A.rid);
  ok(qBack && qBack.lines.length === 1 && near(qBack.lines[0].owed_purchase, 0.2), 'the 0.2 kg is back on Kitchen\'s queue', qBack);
  ok(near(rmStock(CHICKEN), chickenC0), 'central chicken still untouched');
  const rerev = db.transaction(() => {
    const res = DL.reverseDeptTransfer(db, { transferId: rev.res.transfer.id, user: KCHEF, clientKey: `rt-rerev-${++keySeq}-xyz`, authority: 'receiver', lines: [{ lineId: rev.res.transfer.lines[0].id, quantity: 0.2 }] });
    return RR.applyRoutedSendBack(db, res.transfer, KCHEF);
  }).immediate();
  ok(near(line(A.ids[0]).quantity_issued, 1) && reqRow(A.rid).status === 'fulfilled', 'a re-reverse re-fulfils the line and the requisition', { q: line(A.ids[0]).quantity_issued, s: reqRow(A.rid).status, rerev: rerev.lines });

  // ═══ G. PARTY ═══════════════════════════════════════════════════════════
  console.log('G. party');
  as(ADMIN);
  const P = mkReq(BANQUET.id, [{ m: CHICKEN, qty: 3 }, { m: RICE, qty: 2 }], { purpose: 'party', event: 'RT Wedding', fp: 'FP-RT-1' });
  await post(chefApprove, P.rid, {});
  ok(line(P.ids[0]).routed_department_id === KITCHEN.id && line(P.ids[1]).routed_department_id == null, 'party: chicken → Kitchen, rice → store');
  as(STORE);
  const rice0 = rmStock(RICE);
  r = await post(storeIssue, P.rid, { lines: [{ id: P.ids[1], action: 'issue', quantity: 2 }] });
  ok(r.status === 200, 'store issues the rice', r.body);
  const pRows = all(`SELECT material_id, quantity FROM inventory_transactions WHERE reference_id = ? AND type IN ('party_issue','party_consumption')`, P.rid);
  ok(pRows.length === 1 && pRows[0].material_id === RICE.id && near(pRows[0].quantity, -2) && near(rmStock(RICE), rice0 - 2), 'party transfer moved the rice only, once the store part was done', pRows);
  ok(reqRow(P.rid).status === 'store_processed', 'party open while Kitchen owes chicken');
  const pq = RR.toSendQueue(db, KITCHEN.id, null).groups.find((g: any) => g.requisition_id === P.rid);
  ok(pq && pq.purpose === 'party' && pq.fp_id === 'FP-RT-1' && pq.event_name === 'RT Wedding', 'party group on the queue carries its F&P', pq);
  send(KITCHEN, BANQUET, P.rid, [{ lid: P.ids[0], m: CHICKEN, qty: 3 }]);
  ok(reqRow(P.rid).status === 'fulfilled' && near(line(P.ids[0]).quantity_issued, 3), 'Kitchen sends 3 kg → party fulfilled');
  ok(near(rmStock(CHICKEN), chickenC0), 'central chicken never debited for the party line');
  ok(all(`SELECT 1 FROM inventory_transactions WHERE reference_id = ? AND material_id = ?`, P.rid, CHICKEN.id).length === 0, 'no party_issue row for the chicken');
  const split = partyReqSplit(db, [P.rid], 'NOT IN');   // 'NOT IN' = FOOD (not a liquor category)
  ok(near(split.cost, 3 * Number(CHICKEN.average_price) + 2 * Number(RICE.average_price), 1e-6) && split.item_count === 2,
    "party P&L costs the 3 kg chicken once, at the material's average price — as a store-issued line", { split, chicken: CHICKEN.average_price, rice: RICE.average_price });
  // Kitchen sends FIRST, then the store.
  as(ADMIN);
  const P2 = mkReq(BANQUET.id, [{ m: CHICKEN, qty: 1 }, { m: RICE, qty: 1 }], { purpose: 'party', event: 'RT Party 2', fp: 'FP-RT-2' });
  await post(chefApprove, P2.rid, {});
  send(KITCHEN, BANQUET, P2.rid, [{ lid: P2.ids[0], m: CHICKEN, qty: 1 }]);
  ok(reqRow(P2.rid).status === 'store_processed' && reqRow(P2.rid).store_processed_at == null, 'Kitchen first → store_processed with no store stamps');
  as(STORE);
  r = await post(storeIssue, P2.rid, { lines: [{ id: P2.ids[1], action: 'issue', quantity: 1 }] });
  ok(r.status === 200 && reqRow(P2.rid).status === 'fulfilled', 'store issues the rice → party fulfilled', { s: r.status, st: reqRow(P2.rid).status });
  // Reject keeps what Kitchen sent (party included).
  as(ADMIN);
  const P3 = mkReq(BANQUET.id, [{ m: CHICKEN, qty: 2 }], { purpose: 'party', event: 'RT Party 3', fp: 'FP-RT-3' });
  await post(chefApprove, P3.rid, {});
  send(KITCHEN, BANQUET, P3.rid, [{ lid: P3.ids[0], m: CHICKEN, qty: 1 }]);
  as(STORE);
  r = await post(storeIssue, P3.rid, { lines: [{ id: P3.ids[0], action: 'reject', reason: 'party scaled down' }] });
  ok(r.status === 200 && near(line(P3.ids[0]).quantity_issued, 1) && Number(line(P3.ids[0]).store_rejected) === 1 && reqRow(P3.rid).status === 'fulfilled',
    'store reject on a routed party line keeps the 1 kg sent and closes it', { st: r.status, l: line(P3.ids[0]), s: reqRow(P3.rid).status });
  // PO cascade never debits a routed line.
  const P4 = mkReq(BANQUET.id, [{ m: CHICKEN, qty: 1 }, { m: ONION, qty: 1 }], { purpose: 'party', event: 'RT Party 4', status: 'store_processed' });
  db.prepare(`UPDATE requisition_items SET routed_department_id = ?, routed_via = 'material', routed_rule_id = 'rule-chicken' WHERE id = ?`).run(KITCHEN.id, P4.ids[0]);
  db.prepare(`UPDATE requisition_items SET quantity_issued = 1 WHERE id = ?`).run(P4.ids[1]);
  const ch4 = rmStock(CHICKEN); const on4 = rmStock(ONION);
  db.transaction(() => fulfilRequisitionFromPo(db, { requisitionId: P4.rid, poOutletId: null, actorEmail: 'test' }))();
  ok(near(rmStock(CHICKEN), ch4) && near(rmStock(ONION), on4 - 1), 'PO cascade debits the store line only, never the routed chicken', { ch: rmStock(CHICKEN), ch4, on: rmStock(ONION), on4 });

  // ═══ H. DESTRUCTIVE EDITS ═══════════════════════════════════════════════
  console.log('H. destructive edits');
  as(ADMIN);
  const H = mkReq(INDIAN.id, [{ m: CHICKEN, qty: 1 }]);
  await post(chefApprove, H.rid, {});
  send(KITCHEN, INDIAN, H.rid, [{ lid: H.ids[0], m: CHICKEN, qty: 0.5 }]);
  r = await post(cancelRoute, H.rid, {});
  ok(r.status === 400 && r.body.code === 'routed_sent' && /Akan Main Kitchen sent 0\.5 kg of CHICKEN BREAST BONELESS on DTR-/.test(r.body.error || ''), 'cancel refused while Kitchen\'s send stands', r.body);
  ok(reqRow(H.rid).status === 'store_processed', 'not cancelled');

  // ═══ I. THE DEPLOY STAMP ════════════════════════════════════════════════
  console.log('I. backfill');
  const I1 = mkReq(INDIAN.id, [{ m: CHICKEN, qty: 2 }, { m: BUTTER, qty: 1, unit: 'kg' }, { m: ONION, qty: 1 }], { status: 'chef_approved' });
  db.prepare(`UPDATE requisition_items SET deferred_until = '2026-12-01T09:00', defer_reason = 'cold room' WHERE id = ?`).run(I1.ids[0]);
  db.prepare(`UPDATE requisition_items SET quantity_issued = 0.2 WHERE id = ?`).run(I1.ids[1]);   // part-issued by the store
  const I2 = mkReq(INDIAN.id, [{ m: CHICKEN, qty: 1 }], { status: 'store_processed', purpose: 'party', event: 'RT Old Party' });
  const I3 = mkReq(INDIAN.id, [{ m: CHICKEN, qty: 1 }], { status: 'fulfilled' });
  // Expected census, computed independently from the data.
  const expect = all(`
    SELECT ri.id, ri.quantity_issued FROM requisition_items ri JOIN requisitions r ON r.id = ri.req_id
     WHERE r.status IN ('chef_approved','mgmt_approved','store_processed') AND ri.routed_department_id IS NULL
       AND COALESCE(ri.is_rejected,0) = 0 AND COALESCE(ri.store_rejected,0) = 0
       AND COALESCE(ri.department_id, r.department_id) <> ?
       AND (ri.material_id = ? OR ri.material_id IN (SELECT id FROM raw_materials WHERE LOWER(REPLACE(category,' ','')) = 'dairy'))
       AND r.linked_po_id IS NULL`, KITCHEN.id, CHICKEN.id);
  const expStamped = expect.filter((x) => !(Number(x.quantity_issued) > 0)).length;
  const expIssued = expect.filter((x) => Number(x.quantity_issued) > 0).length;
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(RR.ROUTED_BACKFILL_KEY);
  const census = RR.backfillRoutedLines(db);
  ok(census && census.stamped === expStamped && census.skipped_issued === expIssued, 'census matches the data', { census, expStamped, expIssued });
  ok(line(I1.ids[0]).routed_department_id === KITCHEN.id && line(I1.ids[0]).deferred_until == null, 'open chicken line routed, its defer cleared');
  const aud = one(`SELECT before_json FROM audit_events WHERE event_type = 'req_item.routed' AND entity_id = ?`, I1.ids[0]);
  ok(aud && /cold room/.test(aud.before_json), 'the cleared defer is kept in the audit before_json', aud);
  ok(line(I1.ids[1]).routed_department_id == null, 'part-issued butter stays with the store');
  ok(line(I2.ids[0]).routed_department_id === KITCHEN.id, 'store_processed party line with nothing issued routed');
  ok(line(I3.ids[0]).routed_department_id == null, 'fulfilled requisition untouched');
  ok(RR.backfillRoutedLines(db) === null, 'the deploy stamp runs once (marker)');

  // ═══ J. FAIL-TO-STORE ═══════════════════════════════════════════════════
  console.log('J. no rule → no routing');
  db.prepare(`DELETE FROM direct_issue_rules`).run();
  as(ADMIN);
  const J = mkReq(INDIAN.id, [{ m: CHICKEN, qty: 1 }]);
  await post(chefApprove, J.rid, {});
  ok(line(J.ids[0]).routed_department_id == null, 'with no Direct Issue rule nothing routes');
  as(STORE);
  const chJ = rmStock(CHICKEN);
  r = await post(storeIssue, J.rid, { lines: [{ id: J.ids[0], action: 'issue', quantity: 1 }] });
  ok(r.status === 200 && near(rmStock(CHICKEN), chJ - 1) && ledgerRows(J.ids[0])[0]?.skip_reason === '', 'the store issues it exactly as before', { s: r.status, l: ledgerRows(J.ids[0]) });

  console.log(`\nrouted-requisition: ${pass} checks passed, ${fails.length} failed`);
  if (fails.length) { for (const f of fails) console.log(' - ' + f); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });

// A module, so its names never collide with another script's in `tsc --noEmit`.
export {};
