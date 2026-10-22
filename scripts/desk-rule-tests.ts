/**
 * THE DESKS' RULE AGAINST THE SERVER'S — npx tsx scripts/desk-rule-tests.ts
 *
 * src/lib/desk-rule.ts is the ONE transcription both issue desks run of the
 * server's completeness rule and shelf take (src/lib/central-debit-clamp.ts,
 * src/lib/issue-stock.ts), because those files import the database and a page
 * cannot bundle them. A transcription is only as good as the proof that it
 * agrees, so this file runs every desk function against the SERVER FUNCTION IT
 * TRANSCRIBES, on every shape, and exits 1 on a single disagreement:
 *
 *   1. deskLineComplete      vs issue-stock.ts lineIssueComplete
 *        units × packs × line bases × approvals × issued × shelf marks
 *   2. planDeskDebit         vs central-debit-clamp.ts planCentralDebit with the
 *                               converter issue-stock.ts checkCentralIssue builds
 *   3. forecastDeskTake      vs the server's take, run for real on an in-memory
 *                               database: checkCentralIssue → the debit →
 *                               centralShelfEmpty → the recorded quantity →
 *                               stampShelfClose → lineIssueComplete
 *   4. deskStockPU           vs the figure the server's shown-figure rule prints
 *   5. forecastDeskPartyTransfer / deskPartyHeadroom vs the party transfer run
 *                               for real — applyPartyFulfillment itself (round
 *                               10), behind store-issue's gate and savepoint —
 *                               on an in-memory database: which way it runs,
 *                               every line it records, every short line it
 *                               names, and that no shelf goes below zero
 *
 * Zero impact on the app database: getDb() is never called; everything that
 * needs SQL runs on a better-sqlite3 :memory: database created here.
 */
import Database from 'better-sqlite3';
import { planCentralDebit, shownWithStep } from '../src/lib/central-debit-clamp';
import {
  lineIssueComplete, checkCentralIssue, stampShelfClose, centralShelfEmpty,
  applyIssueDelta, isCentralStockShort, type CentralStockShort,
} from '../src/lib/issue-stock';
import { applyPartyFulfillment } from '../src/lib/party-fulfillment';
import { packFactor, shownPurchaseQty, toPurchaseQty, type PackMeta } from '../src/lib/pack-units';
import {
  deskLineComplete, planDeskDebit, forecastDeskTake, deskStockPU, deskLineBasis,
  forecastDeskPartyTransfer, deskPartyHeadroom,
} from '../src/lib/desk-rule';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail: () => string) {
  if (ok) { pass++; return; }
  if (fails.length < 40) fails.push(`${name}: ${detail()}`);
  else if (fails.length === 40) fails.push('… (more failures suppressed)');
}

interface Mat { id: string; unit: string; purchase_unit: string; pack_size: number }
const MATS: Mat[] = [
  { id: 'g-kg',     unit: 'g',   purchase_unit: 'kg',  pack_size: 1000 },   // THREE MANGO, GREEN APPLE
  { id: 'kg-kg',    unit: 'kg',  purchase_unit: 'kg',  pack_size: 1 },      // WHOLE DHANIYA, WHITE DAL
  { id: 'kg-kg15',  unit: 'kg',  purchase_unit: 'kg',  pack_size: 1.5 },    // PICKLED GINGER 1.5KG (pf 1)
  { id: 'ml-btl',   unit: 'ml',  purchase_unit: 'BTL', pack_size: 750 },    // a 750 ml bottle
  { id: 'ml-btl1k', unit: 'ml',  purchase_unit: 'BTL', pack_size: 1000 },   // FRESH CREAM 1 LTR
  { id: 'ml-can',   unit: 'ml',  purchase_unit: 'BTL', pack_size: 5000 },   // MALA MANGO CRUSH 5 LTR
  { id: 'ml-keg',   unit: 'ml',  purchase_unit: 'BTL', pack_size: 50000 },  // a 50 L keg
  { id: 'ml-l',     unit: 'ml',  purchase_unit: 'l',   pack_size: 1000 },   // Fresh Cream (l)
  { id: 'g-pkt',    unit: 'g',   purchase_unit: 'PKT', pack_size: 500 },
  { id: 'pcs',      unit: 'pcs', purchase_unit: 'pcs', pack_size: 1 },
];
const metaOf = (m: Mat): PackMeta => ({ unit: m.unit, purchase_unit: m.purchase_unit, pack_size: m.pack_size });
/** The desk payload's spelling of the same material (api/requisitions ?id=). */
const deskUnits = (m: Mat, lineUnit: string) => ({
  unit: lineUnit,
  material_unit: m.unit,
  material_purchase_unit: m.purchase_unit || m.unit,
  material_pack_size: m.pack_size || 1,
});
const lineUnitsOf = (m: Mat) => [...new Set([m.purchase_unit, m.unit, '', 'xyz'])];
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const fmt = (o: unknown) => JSON.stringify(o);

// ── 1. completeness ──────────────────────────────────────────────────────────
for (const m of MATS) {
  const pf = packFactor(metaOf(m));
  for (const lu of lineUnitsOf(m)) {
    const factor = pf > 1 && lu.toLowerCase() === m.purchase_unit.toLowerCase() ? pf : 1;
    const step = 0.001 * pf / factor;
    for (const aPU of [14.843, 0.201, 3.218, 5.001, 1, 0.0008, 130.126, 2.5]) {
      const approvedSet = [r6(aPU * pf / factor), r6(aPU * pf / factor) + step * 0.4, r6(aPU * pf / factor) - step * 0.7];
      for (const approved of approvedSet) {
        const issuedSet = [0, approved, approved + 1e-10, approved - 1e-10, approved - step * 0.4,
          approved - step * 0.5, approved - step * 0.6, approved - step * 0.999, approved - step,
          approved - step * 1.2, approved * 0.3, approved + step, approved - 4e-16, -step];
        for (const issued of issuedSet) {
          for (const mark of [null, issued, issued + 1e-6, issued - 2e-10, 0, -1]) {
            const row = {
              quantity_issued: issued, chef_approved_qty: approved, quantity_requested: approved * 2,
              line_unit: lu, unit: m.unit, purchase_unit: m.purchase_unit, pack_size: m.pack_size,
              shelf_emptied_qty: mark,
            };
            const server = lineIssueComplete(row);
            const desk = deskLineComplete(issued, approved, { ...deskUnits(m, lu), shelf_emptied_qty: mark });
            check('complete', server === desk, () => fmt({ m: m.id, lu, approved, issued, mark, server, desk }));
          }
        }
      }
    }
  }
}

// ── 2. the shown-figure rule (planCentralDebit) ─────────────────────────────
const serverPlan = (stock: number, ask: number, meta: PackMeta) => planCentralDebit(stock, ask, shownWithStep(
  r => shownPurchaseQty(r, meta), 0.001 * packFactor(meta), [r => toPurchaseQty(r, meta)],
));
for (const m of MATS) {
  const meta = metaOf(m);
  const pf = packFactor(meta);
  const half = 0.0005 * pf;   // half a printed step, recipe units
  for (const b of [14842.5, 14843, 3.1505, 5.0005, 130125.5, 1004, 1, 0.5, 2999.7, 50000, 4.0005, 9.3505, 0]) {
    const stocks = [b, b - 4e-16, b + 4e-16, b - 3e-13, b + half, b - half, b + half * 0.8, b - half * 0.8,
      b - half - 4e-16, 0, -5, 4e-7, 6e-7, b * 3 + 7];
    for (const stock of stocks) {
      const shown = shownPurchaseQty(stock, meta);
      const asks = [b, r6(b), r6(shown * pf), r6(toPurchaseQty(stock, meta) * pf), r6(shown * pf) + 0.001 * pf,
        r6(shown * pf) - 0.001 * pf, r6(b) - 1e-6, r6(b) + 1e-6, 0.4 * pf, 1e-6, 0, -1, r6(stock * 0.5)];
      for (const ask of asks) {
        const s = serverPlan(stock, ask, meta);
        const d = planDeskDebit(stock, ask, meta);
        const same = s.fits === d.fits && s.takesAll === d.takesAll && s.debit === d.debit
          && s.byShownFigure === d.byShownFigure && s.debitIsAsk === d.debitIsAsk
          && (Number(s.shownAvailable) || 0) === d.shownAvailable;
        check('plan', same, () => fmt({ m: m.id, stock, ask, server: s, desk: d }));
        // 4. the printed balance: U.stockPU on the desk is deskStockPU of the
        // raw stored balance; the server prints shownAvailable (its grid point).
        if (stock > 0) {
          check('stockPU', deskStockPU(stock, meta) === (Number(s.shownAvailable) || 0),
            () => fmt({ m: m.id, stock, desk: deskStockPU(stock, meta), server: s.shownAvailable }));
        }
      }
    }
  }
}

// ── 3. the take, run for real on the server's own functions ─────────────────
const db = new Database(':memory:');
for (const ddl of [
  `CREATE TABLE raw_materials (id TEXT PRIMARY KEY, name TEXT, category TEXT, unit TEXT,
                               purchase_unit TEXT, pack_size REAL, current_stock REAL)`,
  `CREATE TABLE requisitions (id TEXT PRIMARY KEY, purpose TEXT)`,
  `CREATE TABLE requisition_items (id TEXT PRIMARY KEY, req_id TEXT, material_id TEXT, unit TEXT,
                                   quantity_requested REAL, chef_approved_qty REAL,
                                   quantity_issued REAL, shelf_emptied_qty REAL)`,
]) db.prepare(ddl).run();
const insMat = db.prepare(`INSERT OR REPLACE INTO raw_materials VALUES (?,?,?,?,?,?,?)`);
const insReq = db.prepare(`INSERT OR REPLACE INTO requisitions VALUES (?,?)`);
const insLine = db.prepare(`INSERT OR REPLACE INTO requisition_items VALUES (?,?,?,?,?,?,?,?)`);
const selRow = db.prepare(`
  SELECT ri.quantity_issued, ri.chef_approved_qty, ri.quantity_requested, ri.shelf_emptied_qty,
         ri.unit AS line_unit, rm.unit, rm.purchase_unit, rm.pack_size
    FROM requisition_items ri JOIN raw_materials rm ON rm.id = ri.material_id WHERE ri.id = ?`);
const debit = db.prepare(`UPDATE raw_materials SET current_stock = current_stock - ? WHERE id = ?`);
const record = db.prepare(`UPDATE requisition_items SET quantity_issued = ? WHERE id = ?`);
let takes = 0, takesChanged = 0, takesShelf = 0, nulls = 0;
for (const purpose of ['internal', 'party']) {
  for (const m of MATS) {
    const meta = metaOf(m);
    const pf = packFactor(meta);
    for (const lu of lineUnitsOf(m)) {
      const basis = deskLineBasis(deskUnits(m, lu));
      const factor = basis ? basis.factor : 1;
      const step = basis ? basis.step : 0.001;
      for (const aPU of [14.843, 3.218, 0.201, 5.001, 1, 2.5, 130.126]) {
        const approved = r6(aPU * pf / factor);
        const aRecipe = approved * factor;
        const half = 0.0005 * pf;
        const shelves = [aRecipe - half, aRecipe - half * 0.8, aRecipe - half * 1.2, aRecipe - 2 * half,
          aRecipe, aRecipe + half * 0.6, aRecipe * 3, aRecipe - half - 4e-16, aRecipe * 0.5, 0, 4e-7,
          r6(aRecipe * 0.7) + half * 0.8];
        for (const shelf of shelves) {
          for (const before of [0, r6(approved * 0.25)]) {
            const out = approved - before;
            const shownLine = r6(shownPurchaseQty(shelf, meta) * pf / factor);
            const deltas = [out, shownLine, shownLine - before, out - step, out - step * 0.6, r6(out * 0.5),
              r6(out) + step, shownLine + step];
            for (const delta of deltas) {
              if (!(delta > 0)) continue;
              const id = `${purpose}|${m.id}|${lu}|${aPU}|${shelf}|${before}|${delta}`;
              insMat.run(m.id, m.id, 'testcat', m.unit, m.purchase_unit, m.pack_size, shelf);
              insReq.run('R-' + purpose, purpose);
              insLine.run(id, 'R-' + purpose, m.id, lu, approved * 2, approved, before, null);
              const c = checkCentralIssue(db, { reqItemId: id, beforeLineQty: before, afterLineQty: before + delta });
              const desk = forecastDeskTake({
                line: { ...deskUnits(m, lu), quantity_issued: before, current_stock: shelf },
                purpose, approved, deltaLine: delta,
              });
              if (!c.debits || !c.ok) {
                nulls++;
                check('take-null', desk === null,
                  () => fmt({ id, debits: c.debits, ok: c.ok, skip: c.skipReason, desk }));
                continue;
              }
              // The server's take, as applyIssueDelta runs it.
              debit.run(c.debitRecipe, m.id);
              const emptied = c.debitRecipe > 0 ? centralShelfEmpty(db, m.id) : false;
              const recorded = c.recordAfterLineQty;
              record.run(recorded, id);
              stampShelfClose(db, id, emptied);
              const complete = lineIssueComplete(selRow.get(id) as any);
              takes++;
              if (desk && desk.changed) takesChanged++;
              if (desk && desk.byShelf) takesShelf++;
              const same = !!desk && desk.recordedLine === recorded && desk.takeRecipe === c.debitRecipe
                && desk.emptied === emptied && desk.complete === complete;
              check('take', same, () => fmt({
                id, server: { recorded, debit: c.debitRecipe, emptied, complete },
                desk: desk && { recorded: desk.recordedLine, debit: desk.takeRecipe, emptied: desk.emptied, complete: desk.complete },
              }));
              // And the shelf mark the server stamped is read the same way by
              // the desk afterwards (the line as GET /api/requisitions ships it).
              const after = selRow.get(id) as any;
              check('take-after', deskLineComplete(after.quantity_issued, approved,
                { ...deskUnits(m, lu), shelf_emptied_qty: after.shelf_emptied_qty }) === complete,
                () => fmt({ id, after }));
            }
          }
        }
      }
    }
  }
}

// ── 5. the party transfer (round 8b; round 10: the REAL transfer) ──────────
// forecastDeskPartyTransfer vs the transfer RUN FOR REAL: applyPartyFulfillment
// (party-fulfillment.ts) itself, on an in-memory database carrying the tables it
// writes, behind store-issue's gate (every line complete → the transfer must
// run and a short line refuses the whole POST; otherwise, only when the gesture
// ISSUED on a line, it is tried in a savepoint and kept only when every line is
// then complete, a defer on a line issued on that it completed dropped). Until
// round 9 this section ran a transcription of the transfer's loop; round 10
// changed what the loop does with a top-up the shelf cannot cover (a remainder
// below one printed step, or a line the gesture did not issue on, takes what the
// shelf holds and records what left) and made it name EVERY short line, so the
// test now runs the function the desks transcribe instead of a second copy.
// Each case also proves the shelf never went below zero.
const pdb = new Database(':memory:');
for (const ddl of [
  `CREATE TABLE raw_materials (id TEXT PRIMARY KEY, name TEXT, category TEXT, unit TEXT,
                               purchase_unit TEXT, pack_size REAL, current_stock REAL, updated_at TEXT)`,
  `CREATE TABLE requisitions (id TEXT PRIMARY KEY, purpose TEXT, event_name TEXT, event_date TEXT,
                              outlet_id TEXT, department_id TEXT, req_number TEXT)`,
  `CREATE TABLE requisition_items (id TEXT PRIMARY KEY, req_id TEXT, material_id TEXT, unit TEXT,
                                   quantity_requested REAL, chef_approved_qty REAL,
                                   quantity_issued REAL, shelf_emptied_qty REAL, deferred_until TEXT,
                                   defer_reason TEXT DEFAULT '', issue_history TEXT DEFAULT '[]',
                                   department_id TEXT)`,
  `CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT)`,
  `CREATE TABLE inventory_transactions (id TEXT PRIMARY KEY, material_id TEXT, type TEXT, quantity REAL,
                                        reference_id TEXT, notes TEXT, created_at TEXT, outlet_id TEXT)`,
  `CREATE TABLE department_materials (id TEXT PRIMARY KEY, outlet_id TEXT, department_id TEXT,
                                      material_id TEXT, on_hand REAL, updated_at TEXT)`,
  `CREATE TABLE department_material_transactions (id TEXT PRIMARY KEY, outlet_id TEXT, department_id TEXT,
                                      material_id TEXT, type TEXT, quantity REAL, balance_after REAL,
                                      reference_id TEXT, event_name TEXT, event_date TEXT, notes TEXT,
                                      user TEXT, created_at TEXT)`,
  `CREATE TABLE requisition_issue_ledger (id TEXT PRIMARY KEY, req_id TEXT NOT NULL, req_item_id TEXT NOT NULL,
                                      material_id TEXT NOT NULL, department_id TEXT, outlet_id TEXT,
                                      reason TEXT NOT NULL, baseline_line_qty REAL, before_line_qty REAL NOT NULL,
                                      after_line_qty REAL NOT NULL, delta_line_qty REAL NOT NULL, line_unit TEXT,
                                      pack_factor REAL NOT NULL, delta_recipe_qty REAL NOT NULL,
                                      store_mapped INTEGER NOT NULL DEFAULT 0,
                                      needs_unit_review INTEGER NOT NULL DEFAULT 0, inv_txn_id TEXT,
                                      client_token TEXT, actor TEXT,
                                      created_at TEXT NOT NULL DEFAULT (datetime('now')),
                                      recorded_recipe_qty REAL NOT NULL DEFAULT 0,
                                      stock_applied INTEGER NOT NULL DEFAULT 0, effective_line_qty REAL,
                                      skip_reason TEXT NOT NULL DEFAULT '', shelf_mark REAL)`,
  `CREATE TABLE audit_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, entity_type TEXT NOT NULL,
                              entity_id TEXT NOT NULL, actor_email TEXT NOT NULL DEFAULT '', outlet_id TEXT,
                              before_json TEXT, after_json TEXT, note TEXT DEFAULT '',
                              created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
]) pdb.prepare(ddl).run();
const ACTOR = 'desk-rule-tests@local';
const pSelRow = pdb.prepare(`
  SELECT ri.id, ri.quantity_issued, ri.chef_approved_qty, ri.quantity_requested, ri.shelf_emptied_qty,
         ri.deferred_until, ri.unit AS line_unit, rm.unit, rm.purchase_unit, rm.pack_size, ri.material_id
    FROM requisition_items ri JOIN raw_materials rm ON rm.id = ri.material_id WHERE ri.req_id = ? ORDER BY ri.rowid`);
const pStock = pdb.prepare('SELECT current_stock c FROM raw_materials WHERE id = ?');
let partyCases = 0, partyCertain = 0, partyCloses = 0, partyRefused = 0, partyTopUps = 0;
let partyShortTakes = 0, partyMultiShort = 0, partyDeferOnly = 0;
const pMats = MATS.filter(m => ['g-kg', 'kg-kg', 'ml-btl', 'ml-can', 'pcs'].includes(m.id));
type Second = 'none' | 'done' | 'open' | 'sameMat' | 'doneTail' | 'doneCrumb' | 'emptyDone';
type Gesture = 'issueA' | 'issueB' | 'deferA';
for (const m of pMats) {
  const meta = metaOf(m);
  const pf = packFactor(meta);
  for (const lu of [...new Set([m.purchase_unit, m.unit])]) {
    const basis = deskLineBasis(deskUnits(m, lu));
    if (!basis) continue;
    const factor = basis.factor;
    const step = basis.step;
    for (const aPU of [14.843, 3.218, 1, 2.5]) {
      const approved = r6(aPU * pf / factor);
      const aRecipe = approved * factor;
      const half = 0.0005 * pf;
      for (const shelf of [aRecipe - half * 0.8, aRecipe - half * 1.2, aRecipe, aRecipe * 3, aRecipe - 2 * half, aRecipe * 0.5, 0]) {
        const shownLine = r6(shownPurchaseQty(shelf, meta) * pf / factor);
        for (const before of [0, r6(approved * 0.4), shownLine, approved]) {
          const deltas = [approved - before, shownLine - before, r6(shelf / factor) - before, step, r6((approved - before) * 0.5)];
          for (let di = 0; di < deltas.length; di++) {
            const delta = deltas[di];
            // ROUND 9 — THE TOP-UP: what an earlier (short /store-process)
            // transfer already moved for line A, the shelf here being what is
            // LEFT after it. ROUND 10 adds a part-moved line (half of what it
            // holds, or all but less than one printed step of it).
            const movedKinds: Array<'none' | 'moved' | 'half' | 'crumb'> = before > 0 ? ['none', 'moved', 'half', 'crumb'] : ['none'];
            for (const movedKind of movedKinds) {
              const movedRecipeA = movedKind === 'moved' ? r6(before * factor)
                : movedKind === 'half' ? r6(before * factor * 0.5)
                : movedKind === 'crumb' ? r6((before - step * 0.4) * factor) : 0;
              if (movedKind === 'crumb' && !(movedRecipeA > 0)) continue;
              for (const second of ['none', 'done', 'open', 'sameMat', 'doneTail', 'doneCrumb', 'emptyDone'] as Second[]) {
                // A second line on another material ('other', kg/kg): 'doneTail' records 2 kg of which 1 kg
                // moved, over a 0.5 kg shelf; 'doneCrumb' records 2 kg of which all but 0.0004 kg moved, over
                // an empty shelf; 'emptyDone' records 1 kg, nothing moved, over an empty shelf.
                const gestures: Gesture[] = ['issueA'];
                if (di === 0 && second === 'open') gestures.push('issueB');
                if (di === 0 && before < approved) gestures.push('deferA');
                for (const gesture of gestures) {
                  if (gesture === 'issueA' && !(delta > 0)) continue;
                  for (const deferred of [false, true]) {
                    // A line complete by its record AND deferred is not a state any
                    // gesture leaves (an issue that completes a line clears its defer,
                    // a defer on a complete line is dropped): the desk and the route
                    // read it differently and neither writes it. Not scored.
                    if (deferred && before + 1e-9 >= approved && gesture !== 'issueA') continue;
                    partyCases++;
                    if (movedRecipeA > 0) partyTopUps++;
                    if (gesture === 'deferA') partyDeferOnly++;
                    const rid = `P|${m.id}|${lu}|${aPU}|${shelf}|${before}|${delta}|${movedKind}|${second}|${gesture}|${deferred}`;
                    for (const t of ['requisition_items', 'raw_materials', 'requisitions', 'inventory_transactions',
                      'department_materials', 'department_material_transactions', 'requisition_issue_ledger', 'audit_events', 'departments']) {
                      pdb.prepare(`DELETE FROM ${t}`).run();
                    }
                    pdb.prepare(`INSERT INTO requisitions (id, purpose, event_name, event_date, outlet_id, department_id, req_number)
                                 VALUES (?, 'party', 'T', '2026-10-22', NULL, 'D1', 'R1')`).run(rid);
                    pdb.prepare(`INSERT INTO departments VALUES ('D1', 'Kitchen')`).run();
                    const shelfB = second === 'doneTail' ? 0.5 : (second === 'doneCrumb' || second === 'emptyDone') ? 0 : 50;
                    pdb.prepare('INSERT INTO raw_materials VALUES (?,?,?,?,?,?,?,NULL)').run(m.id, m.id, 'c', m.unit, m.purchase_unit, m.pack_size, shelf);
                    pdb.prepare('INSERT INTO raw_materials VALUES (?,?,?,?,?,?,?,NULL)').run('other', 'other', 'c', 'kg', 'kg', 1, shelfB);
                    const ins = pdb.prepare(`INSERT INTO requisition_items (id, req_id, material_id, unit, quantity_requested,
                       chef_approved_qty, quantity_issued, shelf_emptied_qty, deferred_until) VALUES (?,?,?,?,?,?,?,?,?)`);
                    ins.run('A', rid, m.id, lu, approved, approved, before, null, deferred ? '2026-10-20T10:00' : null);
                    if (second === 'done') ins.run('B', rid, 'other', 'kg', 2, 2, 2, null, null);
                    if (second === 'open') ins.run('B', rid, 'other', 'kg', 2, 2, 0, null, null);
                    if (second === 'sameMat') ins.run('B', rid, m.id, lu, approved, approved, approved, null, null);
                    if (second === 'doneTail' || second === 'doneCrumb') ins.run('B', rid, 'other', 'kg', 2, 2, 2, null, null);
                    if (second === 'emptyDone') ins.run('B', rid, 'other', 'kg', 1, 1, 1, null, null);
                    const movedB = second === 'doneTail' ? 1 : second === 'doneCrumb' ? 1.9996 : 0;
                    const insTx = pdb.prepare(`INSERT INTO inventory_transactions VALUES (?, ?, 'party_issue', ?, ?, 'earlier', datetime('now'), NULL)`);
                    if (movedRecipeA > 0) insTx.run('TA', m.id, -movedRecipeA, rid);
                    if (movedB > 0) insTx.run('TB', 'other', -movedB, rid);
                    const movedPool = new Map<string, number>();
                    if (movedRecipeA > 0) movedPool.set(m.id, movedRecipeA);
                    if (movedB > 0) movedPool.set('other', movedB);
                    const transferred = movedPool.size > 0;
                    // THE DESK, before the gesture (the payload GET /api/requisitions ships).
                    const deskLines = (pSelRow.all(rid) as any[]).map(r => ({
                      id: r.id, material_id: r.material_id, quantity_issued: r.quantity_issued,
                      current_stock: (pStock.get(r.material_id) as any).c,
                      shelf_emptied_qty: r.shelf_emptied_qty, deferred_until: r.deferred_until,
                      unit: r.line_unit, material_unit: r.unit, material_purchase_unit: r.purchase_unit, material_pack_size: r.pack_size,
                      approved: Number(r.chef_approved_qty),
                      party_moved_recipe: transferred ? (movedPool.get(String(r.material_id)) || 0) : 0,
                    }));
                    const after = new Map<string, number>();
                    if (gesture === 'issueA') after.set('A', before + delta);
                    if (gesture === 'issueB') after.set('B', 2);
                    const deferIds = new Set<string>(gesture === 'deferA' ? ['A'] : []);
                    const desk = forecastDeskPartyTransfer({
                      lines: deskLines, approvedOf: l => (l as any).approved, rejectedOf: () => false,
                      after, deferIds, transferred,
                    });
                    // THE SERVER — store-issue's loop, then its gate.
                    const deskBase = new Map<string, number>((pSelRow.all(rid) as any[]).map(r => [String(r.id), Number(r.quantity_issued) || 0]));
                    const issuedIds = new Set<string>();
                    const rows = () => pSelRow.all(rid) as any[];
                    const done = () => rows().every(r => lineIssueComplete(r) && !r.deferred_until);
                    const shortIds: string[] = [];
                    // Widened, not narrowed: it is assigned inside the transaction callback.
                    let server = 'none' as 'certain' | 'refused' | 'closes' | 'none';
                    pdb.transaction(() => {
                      if (gesture === 'issueA' || gesture === 'issueB') {
                        const lid = gesture === 'issueA' ? 'A' : 'B';
                        const was = deskBase.get(lid) || 0;
                        const now = was + (gesture === 'issueA' ? delta : 2);
                        pdb.prepare('UPDATE requisition_items SET quantity_issued = ? WHERE id = ?').run(now, lid);
                        issuedIds.add(lid);
                        // applyIssueDelta, as the route calls it: a party line moves no
                        // stock, records the hand-over and re-decides its shelf mark.
                        applyIssueDelta(pdb, { reqItemId: lid, beforeLineQty: was, afterLineQty: now, reason: 'issue', actor: ACTOR });
                        // An issue that completes its line clears its defer (the defer rule).
                        if (lineIssueComplete(rows().find(r => r.id === lid))) {
                          pdb.prepare('UPDATE requisition_items SET deferred_until = NULL WHERE id = ?').run(lid);
                        }
                      } else if (gesture === 'deferA') {
                        // A defer on a complete line is dropped; otherwise written. No stock.
                        if (!lineIssueComplete(rows().find(r => r.id === 'A'))) {
                          pdb.prepare('UPDATE requisition_items SET deferred_until = ? WHERE id = ?').run('2026-10-30T10:00', 'A');
                        }
                      }
                      const opts = { deskBeforeLineQty: deskBase, gestureIssuedIds: issuedIds, ledgerSince: 0 };
                      if (done()) {
                        try {
                          pdb.transaction(() => applyPartyFulfillment(pdb, rid, ACTOR, opts))();
                          server = 'certain';
                        } catch (e) {
                          if (!isCentralStockShort(e)) throw e;
                          server = 'refused';
                          for (const x of [e as CentralStockShort, ...((e as CentralStockShort).others || [])]) shortIds.push(x.reqItemId);
                        }
                      } else {
                        const open = rows().filter(r => !(lineIssueComplete(r) && !r.deferred_until));
                        const could = issuedIds.size > 0 && open.every(r =>
                          (Number(r.quantity_issued) || 0) > 0 && (!r.deferred_until || issuedIds.has(r.id)));
                        if (could) {
                          try {
                            pdb.transaction(() => {
                              applyPartyFulfillment(pdb, rid, ACTOR, opts);
                              for (const r of rows()) {
                                if (issuedIds.has(r.id) && r.deferred_until && lineIssueComplete(r)) {
                                  pdb.prepare('UPDATE requisition_items SET deferred_until = NULL WHERE id = ?').run(r.id);
                                }
                              }
                              if (!done()) throw new Error('unwind');
                            })();
                            server = 'closes';
                          } catch (e) {
                            if (!(e instanceof Error && e.message === 'unwind') && !isCentralStockShort(e)) throw e;
                            server = 'none';
                          }
                        }
                      }
                    })();
                    for (const id of [m.id, 'other']) {
                      const st = Number((pStock.get(id) as any).c);
                      check('party-never-negative', st >= 0, () => fmt({ rid, id, st }));
                    }
                    const deskRuns = desk.runs === 'certain' && desk.short.length > 0 ? 'refused' : desk.runs;
                    if (server === 'certain') partyCertain++;
                    if (server === 'closes') partyCloses++;
                    if (server === 'refused') partyRefused++;
                    if (shortIds.length > 1) partyMultiShort++;
                    check('party-runs', deskRuns === server, () => fmt({ rid, server, desk: deskRuns, short: desk.short, shortIds }));
                    if (server === 'refused') {
                      // EVERY short line the server named is a short line the desk forecast, and no other.
                      const d = desk.short.map(x => x.id).sort().join(',');
                      check('party-shorts', d === [...shortIds].sort().join(','), () => fmt({ rid, desk: d, server: shortIds }));
                    }
                    if (server === 'certain' || server === 'closes') {
                      for (const r of rows()) {
                        const tk = desk.takes[r.id];
                        const complete = lineIssueComplete(r);
                        // A line the transfer did not touch (nothing above what moved) keeps its figure.
                        const q = tk ? tk.recordedLine : (after.get(r.id) ?? (deskBase.get(r.id) || 0));
                        const c0 = tk ? tk.complete : null;
                        const same = Math.abs(q - Number(r.quantity_issued)) <= 1e-9 && (c0 === null || c0 === complete);
                        if (tk?.shortTake) partyShortTakes++;
                        check('party-take', same, () => fmt({ rid, line: r.id, server: { q: r.quantity_issued, complete },
                          desk: tk ? { q: tk.recordedLine, complete: tk.complete, shortTake: tk.shortTake } : { q } }));
                      }
                    }
                    // The headroom a short line is offered is a figure the transfer
                    // then takes in full (the shelf left on exactly 0 for that line).
                    if (server === 'refused' && gesture === 'issueA') {
                      const s = desk.short.find(x => x.id === 'A');
                      if (s) {
                        const h = deskPartyHeadroom(before, s.capTotalLine, s.exactLeftLine);
                        if (h > 0) {
                          const c = checkCentralIssue(pdb, {
                            reqItemId: 'A', beforeLineQty: s.movedLine, afterLineQty: before + h, rail: 'party',
                          });
                          check('party-headroom', c.ok && c.debits, () => fmt({ rid, h, c: { ok: c.ok, debit: c.debitRecipe } }));
                        }
                        // The server's own cap on the refusal (its maxIssueLineQty,
                        // from the part already moved) is the desk's capTotalLine.
                        const sc = checkCentralIssue(pdb, {
                          reqItemId: 'A', beforeLineQty: s.movedLine, afterLineQty: before + delta, rail: 'party',
                        });
                        if (!sc.ok) {
                          check('party-cap', Math.abs(sc.maxIssueLineQty - s.capTotalLine) <= 1e-9,
                            () => fmt({ rid, server: sc.maxIssueLineQty, desk: s.capTotalLine }));
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

console.log(`desk-rule: ${pass} checks passed, ${fails.length} failed`
  + ` (takes run on the server: ${takes}; the shelf rule changed the record on ${takesChanged};`
  + ` closed by the shelf arm ${takesShelf}; carve-outs / holds ${nulls};`
  + ` party gestures ${partyCases} (top-ups ${partyTopUps}, defer-only ${partyDeferOnly}): transfer certain ${partyCertain},`
  + ` closes ${partyCloses}, refused ${partyRefused} (several lines named ${partyMultiShort}); short takes ${partyShortTakes})`);
if (fails.length) {
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(1);
}
process.exit(0);
