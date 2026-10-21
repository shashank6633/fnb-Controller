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
 *                               for real (store-issue's gate, the savepoint, the
 *                               transfer's loop) on an in-memory database
 *
 * Zero impact on the app database: getDb() is never called; everything that
 * needs SQL runs on a better-sqlite3 :memory: database created here.
 */
import Database from 'better-sqlite3';
import { planCentralDebit, shownWithStep } from '../src/lib/central-debit-clamp';
import {
  lineIssueComplete, checkCentralIssue, stampShelfClose, centralShelfEmpty, lineFactor,
} from '../src/lib/issue-stock';
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

// ── 5. the party transfer (round 8b) ────────────────────────────────────────
// forecastDeskPartyTransfer vs the transfer run for real on the server's own
// functions: the gesture's issue entries (no stock moves, the shelf mark is
// re-decided with nothing emptied), store-issue's gate (every line complete →
// the transfer must run and a short line refuses the whole POST; otherwise it
// is tried in a savepoint and kept only when every line is then complete,
// a defer on a touched line it completed dropped), and the transfer's loop as
// applyPartyFulfillment runs it (checkCentralIssue rail 'party' → the line
// records recordAfterLineQty → the debit → centralShelfEmpty → stampShelfClose).
const pdb = new Database(':memory:');
for (const ddl of [
  `CREATE TABLE raw_materials (id TEXT PRIMARY KEY, name TEXT, category TEXT, unit TEXT,
                               purchase_unit TEXT, pack_size REAL, current_stock REAL)`,
  `CREATE TABLE requisitions (id TEXT PRIMARY KEY, purpose TEXT)`,
  `CREATE TABLE requisition_items (id TEXT PRIMARY KEY, req_id TEXT, material_id TEXT, unit TEXT,
                                   quantity_requested REAL, chef_approved_qty REAL,
                                   quantity_issued REAL, shelf_emptied_qty REAL, deferred_until TEXT)`,
]) pdb.prepare(ddl).run();
const pSelRow = pdb.prepare(`
  SELECT ri.id, ri.quantity_issued, ri.chef_approved_qty, ri.quantity_requested, ri.shelf_emptied_qty,
         ri.deferred_until, ri.unit AS line_unit, rm.unit, rm.purchase_unit, rm.pack_size, ri.material_id
    FROM requisition_items ri JOIN raw_materials rm ON rm.id = ri.material_id WHERE ri.req_id = ? ORDER BY ri.rowid`);
let partyCases = 0, partyCertain = 0, partyCloses = 0, partyRefused = 0, partyTopUps = 0;
const pMats = MATS.filter(m => ['g-kg', 'kg-kg', 'ml-btl', 'ml-can', 'pcs'].includes(m.id));
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
        for (const before of [0, r6(approved * 0.4), shownLine]) {
          for (const delta of [approved - before, shownLine - before, r6(shelf / factor) - before, step, r6((approved - before) * 0.5)]) {
            if (!(delta > 0)) continue;
            // ROUND 9 — THE TOP-UP: 'moved' = a short /store-process submit
            // already transferred what line A held (`before`) off the shelf
            // (the shelf here is what is LEFT after it); the transfer then moves
            // only what A holds above that. 'none' = nothing moved yet.
            for (const movedKind of (before > 0 ? ['none', 'moved'] : ['none']) as Array<'none' | 'moved'>) {
            const movedRecipeA = movedKind === 'moved' ? r6(before * factor) : 0;
            for (const second of ['none', 'done', 'open', 'sameMat'] as const) {
              for (const deferred of [false, true]) {
                partyCases++;
                if (movedKind === 'moved') partyTopUps++;
                const rid = `P|${m.id}|${lu}|${aPU}|${shelf}|${before}|${delta}|${movedKind}|${second}|${deferred}`;
                pdb.prepare('DELETE FROM requisition_items').run();
                pdb.prepare('DELETE FROM raw_materials').run();
                pdb.prepare('DELETE FROM requisitions').run();
                pdb.prepare('INSERT INTO requisitions VALUES (?,?)').run(rid, 'party');
                pdb.prepare('INSERT INTO raw_materials VALUES (?,?,?,?,?,?,?)').run(m.id, m.id, 'c', m.unit, m.purchase_unit, m.pack_size, shelf);
                pdb.prepare('INSERT INTO raw_materials VALUES (?,?,?,?,?,?,?)').run('other', 'other', 'c', 'kg', 'kg', 1, 50);
                const ins = pdb.prepare('INSERT INTO requisition_items VALUES (?,?,?,?,?,?,?,?,?)');
                ins.run('A', rid, m.id, lu, approved, approved, before, null, deferred ? '2026-10-20T10:00' : null);
                if (second === 'done') ins.run('B', rid, 'other', 'kg', 2, 2, 2, null, null);
                if (second === 'open') ins.run('B', rid, 'other', 'kg', 2, 2, 0, null, null);
                if (second === 'sameMat') ins.run('B', rid, m.id, lu, approved, approved, approved, null, null);
                // THE DESK, before the gesture.
                // The party rows' per-material sum, as api/requisitions ships it
                // (party_moved_recipe) and as the transfer reads it.
                const movedPool = new Map<string, number>(movedRecipeA > 0 ? [[m.id, movedRecipeA]] : []);
                const deskLines = (pSelRow.all(rid) as any[]).map(r => ({
                  id: r.id, material_id: r.material_id, quantity_issued: r.quantity_issued,
                  current_stock: (pdb.prepare('SELECT current_stock c FROM raw_materials WHERE id=?').get(r.material_id) as any).c,
                  shelf_emptied_qty: r.shelf_emptied_qty, deferred_until: r.deferred_until,
                  unit: r.line_unit, material_unit: r.unit, material_purchase_unit: r.purchase_unit, material_pack_size: r.pack_size,
                  approved: Number(r.chef_approved_qty),
                  party_moved_recipe: movedPool.get(String(r.material_id)) || 0,
                }));
                const desk = forecastDeskPartyTransfer({
                  lines: deskLines, approvedOf: l => (l as any).approved, rejectedOf: () => false,
                  after: new Map([['A', before + delta]]),
                  transferred: movedPool.size > 0,
                });
                // THE SERVER: the issue entry (party: no stock), then the gate.
                pdb.prepare('UPDATE requisition_items SET quantity_issued = ? WHERE id = ?').run(before + delta, 'A');
                stampShelfClose(pdb, 'A', false);
                const rows = () => pSelRow.all(rid) as any[];
                const done = () => rows().every(r => lineIssueComplete(r) && !r.deferred_until);
                // An issue that completes its line clears its defer (the defer rule).
                if (lineIssueComplete(rows().find(r => r.id === 'A'))) {
                  pdb.prepare('UPDATE requisition_items SET deferred_until = NULL WHERE id = ?').run('A');
                }
                // applyPartyFulfillment's loop, top-up included (round 9): the
                // per-material moved pool handed to lines in walk order, a line
                // with nothing above it skipped, the floor asked from it.
                const movedLineOf = new Map<string, number>();
                const transfer = () => {
                  const left = new Map(movedPool);
                  for (const r of rows()) {
                    const qty = Number(r.quantity_issued) || 0;
                    if (!(qty > 0)) continue;
                    let movedLine = 0;
                    if (left.size > 0) {
                      const { factor: f } = lineFactor(r.line_unit, r);
                      const pool = left.get(String(r.material_id)) || 0;
                      const lineRecipe = Math.round(qty * (f || 1) * 1e6) / 1e6;
                      const mv = Math.min(pool, lineRecipe);
                      left.set(String(r.material_id), Math.max(0, pool - mv));
                      if (Math.round((lineRecipe - mv) * 1e6) <= 0) continue;
                      movedLine = mv / (f || 1);
                    }
                    movedLineOf.set(r.id, movedLine);
                    const c = checkCentralIssue(pdb, { reqItemId: r.id, beforeLineQty: movedLine, afterLineQty: qty, rail: 'party' });
                    if (!c.debits) continue;
                    if (!c.ok) throw new Error('short:' + r.id);
                    if (c.recordAfterLineQty !== qty) {
                      pdb.prepare('UPDATE requisition_items SET quantity_issued = ? WHERE id = ?').run(c.recordAfterLineQty, r.id);
                    }
                    pdb.prepare('UPDATE raw_materials SET current_stock = current_stock - ? WHERE id = ?').run(c.debitRecipe, r.material_id);
                    stampShelfClose(pdb, r.id, centralShelfEmpty(pdb, r.material_id));
                  }
                };
                let server: 'certain' | 'refused' | 'closes' | 'none';
                if (done()) {
                  try { pdb.transaction(transfer)(); server = 'certain'; } catch { server = 'refused'; }
                } else {
                  const open = rows().filter(r => !(lineIssueComplete(r) && !r.deferred_until));
                  const could = open.every(r => (Number(r.quantity_issued) || 0) > 0 && (!r.deferred_until || r.id === 'A'));
                  server = 'none';
                  if (could) {
                    try {
                      pdb.transaction(() => {
                        transfer();
                        const a = rows().find(r => r.id === 'A');
                        if (a?.deferred_until && lineIssueComplete(a)) {
                          pdb.prepare('UPDATE requisition_items SET deferred_until = NULL WHERE id = ?').run('A');
                        }
                        if (!done()) throw new Error('unwind');
                      })();
                      server = 'closes';
                    } catch { server = 'none'; }
                  }
                }
                const deskRuns = desk.runs === 'certain' && desk.short.length > 0 ? 'refused' : desk.runs;
                if (server === 'certain') partyCertain++;
                if (server === 'closes') partyCloses++;
                if (server === 'refused') partyRefused++;
                check('party-runs', deskRuns === server, () => fmt({ rid, server, desk: deskRuns, short: desk.short }));
                if (server === 'certain' || server === 'closes') {
                  for (const r of rows()) {
                    const tk = desk.takes[r.id];
                    const complete = lineIssueComplete(r);
                    const same = !!tk && Math.abs(tk.recordedLine - Number(r.quantity_issued)) <= 1e-9 && tk.complete === complete;
                    check('party-take', same, () => fmt({ rid, line: r.id, server: { q: r.quantity_issued, complete },
                      desk: tk && { q: tk.recordedLine, complete: tk.complete } }));
                  }
                }
                // The headroom a short line is offered is a figure the transfer
                // then takes in full (the shelf left on exactly 0 for that line).
                if (server === 'refused') {
                  const s = desk.short.find(x => x.id === 'A');
                  if (s) {
                    const h = deskPartyHeadroom(before, s.capTotalLine, s.exactLeftLine);
                    if (h > 0) {
                      const c = checkCentralIssue(pdb, {
                        reqItemId: 'A', beforeLineQty: movedRecipeA / factor, afterLineQty: before + h, rail: 'party',
                      });
                      check('party-headroom', c.ok && c.debits, () => fmt({ rid, h, c: { ok: c.ok, debit: c.debitRecipe } }));
                    }
                    // The server's own cap on the refusal (its maxIssueLineQty,
                    // from the part already moved) is the desk's capTotalLine.
                    const sc = checkCentralIssue(pdb, {
                      reqItemId: 'A', beforeLineQty: movedLineOf.get('A') ?? movedRecipeA / factor,
                      afterLineQty: before + delta, rail: 'party',
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

console.log(`desk-rule: ${pass} checks passed, ${fails.length} failed`
  + ` (takes run on the server: ${takes}; the shelf rule changed the record on ${takesChanged};`
  + ` closed by the shelf arm ${takesShelf}; carve-outs / holds ${nulls};`
  + ` party gestures ${partyCases} (top-ups ${partyTopUps}): transfer certain ${partyCertain}, closes ${partyCloses}, refused ${partyRefused})`);
if (fails.length) {
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(1);
}
process.exit(0);
