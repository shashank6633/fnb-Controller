#!/usr/bin/env node
/**
 * Import a Recaho "STORE CLOSING" workbook into the closing_stock table.
 *
 *   node scripts/import-closing-stock.js <xlsx-path> <YYYY-MM-DD> [--write] [--confirm-zeros]
 *
 * Sheet expected columns:
 *   CATEGORY NAME | ITEM NAME | STOCK UNIT | CLOSING RATE (LAST INWARD RATE) |
 *   SYSTEM CLOSING QTY | SYSTEM CLOSING AMT
 *
 * For closing stock we record the *physical* qty == the system closing qty
 * from the file (the count the store reports). variance = physical - system_stock.
 *
 * Matching rules — name first, then SKU/aliases. Reports unmatched at the end
 * so the operator can fix material masters before re-running.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE SIXTH COUNT PATH, AND IT CARRIED THE ORIGINAL DEFECT (2026-08)
 * ═══════════════════════════════════════════════════════════════════════════
 * The five API routes now read every physical-count cell through ONE function
 * (readPhysicalCount, src/lib/variance-approval.ts) whose whole subject is:
 *
 *        BLANK = NOT COUNTED.   0 = COUNTED AND FOUND EMPTY.
 *
 * This script is CommonJS and cannot import that TypeScript module, so the rule
 * is restated below in `readCount()` — kept deliberately short and in the same
 * order as the original so the two can be diffed by eye. If the rule changes
 * there, change it here; that duplication is the price of a plain-node script
 * touching the same table.
 *
 * What was wrong, all of it measured on this file:
 *   · `sheet_to_json(..., { defval: '' })` (below) fills every empty cell with
 *     '', and `Number('') === 0` is FINITE — so `if (!Number.isFinite(qty))`
 *     passed it and EVERY BLANK CELL IN THE WORKBOOK was imported as a real
 *     counted zero. That is exactly the 793-row incident, in a tool.
 *   · a negative quantity was imported as a count.
 *   · `DELETE FROM closing_stock WHERE date = ?` wiped THE WHOLE DAY across
 *     EVERY department before re-inserting central rows — the API routes delete
 *     per (date, material, department) precisely so a department's count is
 *     never collateral damage of another sheet.
 *   · it wrote to the live DB the moment it was run, with no dry run.
 *
 * WHAT IT STILL DOES NOT DO, deliberately: it does not raise variance
 * approvals and it never moves stock. It writes count RECORDS. Reproducing
 * upsertVarianceApproval() here would be a second implementation of the rule
 * that decides what reaches the books, and that rule has one home. Counts
 * imported here are visible on the closing-stock screens; anything needing a
 * decision should go through the app.
 */
const path = require('path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const positional = argv.filter(a => !a.startsWith('--'));
const file = positional[0];
const dateArg = positional[1];
const WRITE = flags.has('--write');
const CONFIRM_ZEROS = flags.has('--confirm-zeros');

if (!file || !dateArg) {
  console.error('Usage: node scripts/import-closing-stock.js <xlsx> <YYYY-MM-DD> [--write] [--confirm-zeros]');
  console.error('       Without --write this is a DRY RUN and touches nothing.');
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  console.error('Date must be YYYY-MM-DD');
  process.exit(2);
}

const dbPath = path.join(__dirname, '..', 'fnb-controller.db');
// DRY RUN BY DEFAULT. This opens the LIVE database; a mis-typed date or a
// mis-mapped workbook used to land in it on the first run with nothing to
// review first. Read-only unless --write is given explicitly.
const db = new Database(dbPath, WRITE ? {} : { readonly: true });
db.pragma('foreign_keys = ON');

/**
 * The blank/zero rule, restated from readPhysicalCount() — see the header.
 * Returns { kind: 'blank' } | { kind: 'count', qty } | { kind: 'error', reason }.
 * A 0 is a COUNT. '' / '   ' / null / undefined are NOT.
 */
function readCount(raw) {
  if (raw === undefined || raw === null) return { kind: 'blank' };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { kind: 'error', reason: 'not a number' };
    if (raw < 0) return { kind: 'error', reason: 'negative' };
    return { kind: 'count', qty: raw };
  }
  if (typeof raw !== 'string') return { kind: 'error', reason: 'not a number' };
  let s = raw.trim();
  if (s === '') return { kind: 'blank' };
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) {
    return { kind: 'error', reason: s.startsWith('-') ? 'negative' : `not a plain number ("${raw.trim()}")` };
  }
  return { kind: 'count', qty: Number(s) };
}

const wb = XLSX.readFile(file);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

const headerRow = rows[0].map(s => String(s || '').toUpperCase().trim());
const idx = {
  category: headerRow.findIndex(h => h.includes('CATEGORY')),
  item:     headerRow.findIndex(h => h.includes('ITEM')),
  unit:     headerRow.findIndex(h => h.includes('STOCK UNIT')),
  rate:     headerRow.findIndex(h => h.includes('CLOSING RATE')),
  qty:      headerRow.findIndex(h => h.includes('CLOSING QTY')),
  amt:      headerRow.findIndex(h => h.includes('CLOSING AMT')),
};
if (idx.item < 0 || idx.qty < 0) {
  console.error('Could not locate ITEM NAME / CLOSING QTY columns. Got header:', headerRow);
  process.exit(2);
}

// Build a name lookup for raw_materials
const materials = db.prepare('SELECT id, name, sku, current_stock, average_price, unit FROM raw_materials').all();
const byNorm = new Map();
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
for (const m of materials) byNorm.set(norm(m.name), m);

const items = [];
const unmatched = [];
let blankCells = 0;
const badCells = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const name = String(r[idx.item] || '').trim();
  if (!name) continue;
  // BLANK = NOT COUNTED. Nothing is written for this row — not a zero, and not
  // a delete of whatever is already stored for it.
  const pc = readCount(r[idx.qty]);
  if (pc.kind === 'blank') { blankCells++; continue; }
  if (pc.kind === 'error') { badCells.push(`line ${i + 1}: ${name} — ${pc.reason}`); continue; }
  const qty = pc.qty;
  const m = byNorm.get(norm(name));
  if (!m) {
    unmatched.push({ name, category: r[idx.category], unit: r[idx.unit], qty });
    continue;
  }
  items.push({
    material_id: m.id,
    name: m.name,
    physical_stock: qty,
    system_stock: m.current_stock,
    avg_price: m.average_price,
  });
}

console.log(
  `Parsed ${rows.length - 1} rows → ${items.length} matched, ${unmatched.length} unmatched, ` +
  `${blankCells} blank (NOT counted), ${badCells.length} unreadable`,
);
if (badCells.length) {
  console.log('\n⚠ Unreadable quantities (skipped, nothing written for them):');
  for (const b of badCells.slice(0, 20)) console.log(`  ${b}`);
  if (badCells.length > 20) console.log(`  …and ${badCells.length - 20} more`);
}

/* THE UPLOAD PATTERN GUARD, same rule as the five API paths (zeroPatternGuard,
 * src/lib/variance-approval.ts) and the same floors: ≥25 counted lines, ≥15 of
 * them zero, and ≥60% zeros. It judges the PATTERN, never the value — a 0 is a
 * legitimate count and stays one — and it refuses BEFORE anything is written,
 * naming the number. A genuine all-empty stocktake goes through with
 * --confirm-zeros. */
const countedQtys = items.map(it => it.physical_stock);
const zeros = countedQtys.filter(q => q === 0).length;
const share = countedQtys.length > 0 ? zeros / countedQtys.length : 0;
const suspicious = countedQtys.length >= 25 && zeros >= 15 && share >= 0.6;
if (suspicious) {
  console.log(
    `\n⚠ MOSTLY ZEROS: ${zeros} of ${countedQtys.length} counted lines (${Math.round(share * 100)}%) are 0.\n` +
    `  A 0 is recorded as "counted and found empty"; a BLANK cell is what means "not counted".\n` +
    `  If those cells were meant to be blank, fix the workbook and re-run.\n` +
    `  If the shelves really were empty, re-run with --confirm-zeros.`,
  );
  if (!CONFIRM_ZEROS) process.exit(1);
}

if (!WRITE) {
  console.log(
    `\nDRY RUN — nothing was written. ${items.length} rows would be recorded for ${dateArg}.\n` +
    `Re-run with --write once the numbers above look right.`,
  );
} else {
  const insert = db.prepare(`
    INSERT INTO closing_stock (id, material_id, date, system_stock, physical_stock,
                               variance, variance_value, notes, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  /* PER (date, material, department), NEVER THE WHOLE DAY. `DELETE FROM
   * closing_stock WHERE date = ?` deleted every department's count of every
   * material for that date before inserting this workbook's central rows — a
   * store import silently destroying the kitchens' counts. Every API writer
   * scopes its delete exactly like this; so does this one now. These rows carry
   * no department, hence the COALESCE(department_id,'') = '' arm. */
  const del = db.prepare(
    "DELETE FROM closing_stock WHERE date = ? AND material_id = ? AND COALESCE(department_id,'') = ''",
  );

  const txn = db.transaction(() => {
    for (const it of items) {
      del.run(dateArg, it.material_id);
      const variance = it.physical_stock - it.system_stock;
      const variance_value = variance * (it.avg_price || 0);
      insert.run(
        crypto.randomBytes(16).toString('hex'),
        it.material_id, dateArg,
        it.system_stock, it.physical_stock,
        variance, variance_value,
        'Imported from APR.Closing.2026.xlsx',
        'import-script',
      );
    }
  });
  txn();

  console.log(`\n✓ Wrote ${items.length} closing-stock rows for ${dateArg}`);
}

if (unmatched.length) {
  console.log(`\n⚠ ${unmatched.length} unmatched items (need raw_material masters or alias):`);
  for (const u of unmatched.slice(0, 50)) {
    console.log(`  [${u.category}] ${u.name} — ${u.qty} ${u.unit}`);
  }
  if (unmatched.length > 50) console.log(`  …and ${unmatched.length - 50} more`);
}

// Quick variance summary
const totalVar = items.reduce((s, it) => s + (it.physical_stock - it.system_stock) * (it.avg_price || 0), 0);
const shortages = items.filter(it => it.physical_stock < it.system_stock).length;
const excesses  = items.filter(it => it.physical_stock > it.system_stock).length;
const matches   = items.filter(it => it.physical_stock === it.system_stock).length;
console.log(`\nVariance summary:`);
console.log(`  Net variance value : ₹${totalVar.toFixed(2)}`);
console.log(`  Shortages          : ${shortages}`);
console.log(`  Excesses           : ${excesses}`);
console.log(`  Exact matches      : ${matches}`);
