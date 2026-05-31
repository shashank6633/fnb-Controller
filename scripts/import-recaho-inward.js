#!/usr/bin/env node
/**
 * Import Recaho "inward report detail" Excel into fnb-controller.
 *
 * Behaviour:
 *  - Each unique ITEM NAME (case-insensitive, trimmed) becomes ONE raw_material row.
 *  - Each data row in the file becomes ONE purchase row referencing that material.
 *  - Existing raw_material with same name is re-used (upsert by lowered name).
 *  - After all purchases inserted, recompute weighted-average price per material
 *    (same as updateMaterialPrice in lib/db.ts) and cascade to recipes.
 *  - current_stock gets += purchase qty.
 *
 * Usage:
 *   node scripts/import-recaho-inward.js '/path/to/inward report detail.xlsx'
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

const filePath = process.argv[2];
if (!filePath || !fs.existsSync(filePath)) {
  console.error('Pass the xlsx file path as the first argument.');
  process.exit(1);
}

const DB_PATH = path.join(__dirname, '..', 'fnb-controller.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Category mapping (mirrors src/app/api/import-materials/route.ts)
function mapCategory(posCategory) {
  const cat = (posCategory || '').trim().toUpperCase();
  const bar = ['VODKA','GIN','RUM','WHISKEY','BOURBON','TEQUILA','BRANDY','BLENDED SCOTCH','BLENDED MALT','SINGLE MALT WHISKEY','IRISH','JAPANESE','TENNESSEE','LIQUER','APERITIF','VERMOUTH','RED WINE','WHITE WINE','SPARKLING WINE','WINES [ROSE]','WINE','BEER','BITTERS'];
  if (bar.includes(cat)) return 'bar';
  const bev = ['SOFT BEVERAGES','JUICES','SYRUPS','PUREE','CRUSH','SAUCES'];
  if (bev.includes(cat)) return 'beverages';
  if (cat === 'DAIRY PRODUCTS' || cat === 'FROZEN & CHEESE') return 'dairy';
  if (['VEGETABLES','LOCAL VEGETABLES','ENGLISH VEGETABLES'].includes(cat)) return 'veg';
  if (cat === 'FRUITS') return 'veg';
  if (['MEAT','POULTRY','POULTY','SEAFOOD'].includes(cat)) return 'non-veg';
  if (cat === 'GROCERY') return 'grocery';
  if (cat === 'SPICES') return 'spices';
  if (cat === 'GAS & CHARCOAL') return 'other';
  if (cat === 'HOUSEKEEPING' || cat === 'STATIONERY') return 'packaging';
  return 'other';
}

function mapUnit(posUnit) {
  const u = (posUnit || '').trim().toUpperCase();
  if (u === 'KG' || u.includes('KG')) return 'kg';
  if (u === 'GMS' || u.includes('GMS') || u.includes('GM')) return 'g';
  if (u === 'LTR' || u.includes('LTR')) return 'l';
  if (u.includes('ML')) return 'ml';
  if (u === 'PC' || u === 'PCS') return 'pcs';
  if (u.includes('BTL')) return 'bottle';
  if (u.includes('PKT')) return 'pcs';
  if (u.includes('TIN')) return 'pcs';
  if (u.includes('BOX')) return 'pcs';
  if (u.includes('CAN')) return 'pcs';
  if (u.includes('BAG')) return 'kg';
  if (u.includes('DOZEN') || u.includes('DZN')) return 'dozen';
  if (u.includes('BUNCH')) return 'bunch';
  if (u.includes('CASE')) return 'pcs';  // case expanded to pcs; see packSize()
  return 'pcs';
}

// Extract pack multiplier from "CASE (12PC)", "CASE(24PC)", "BOX OF 6" etc.
// Returns 1 for units that don't have a pack multiplier.
function packSize(posUnit) {
  const u = (posUnit || '').trim().toUpperCase();
  const m = u.match(/\(\s*(\d+)\s*PC?S?\s*\)/) || u.match(/(\d+)\s*PC?S?\b/) || u.match(/OF\s*(\d+)/);
  if (m) return parseInt(m[1], 10) || 1;
  return 1;
}

// Parse DD/MM/YYYY or "DD MMM YYYY" → ISO
function toISO(raw) {
  if (!raw) return null;
  if (typeof raw === 'number') {
    const d = new Date((raw - 25569) * 86400 * 1000);
    return d.toISOString().split('T')[0];
  }
  const s = String(raw).trim();
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return null;
}

console.log('Reading file:', filePath);
const wb = XLSX.readFile(filePath);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

// Find header row — look for the row containing "ITEM NAME"
let headerIdx = -1;
for (let i = 0; i < Math.min(15, rows.length); i++) {
  if (rows[i].some(c => String(c).trim().toUpperCase() === 'ITEM NAME')) {
    headerIdx = i;
    break;
  }
}
if (headerIdx < 0) {
  console.error('Could not find header row with ITEM NAME');
  process.exit(1);
}
const headers = rows[headerIdx].map(h => String(h).trim().toUpperCase());
const col = (name) => headers.indexOf(name);

const idxItemName   = col('ITEM NAME');
const idxCategory   = col('CATEGORY NAME');
const idxSupplier   = col('SUPPLIER NAME');
const idxInwardDate = col('INWARD DATE');
const idxCreatedDt  = col('CREATED DATE');
const idxQty        = col('INWARD QTY');
const idxUnit       = col('PURCHASE UNIT');
const idxRate       = col('RATE');
const idxSubtotal   = col('SUBTOTAL');
const idxCgst       = col('CGST');
const idxSgst       = col('SGST');
const idxTotal      = col('TOTAL INWARD AMOUNT');
const idxInvoiceId  = col('INVOICE ID');
const idxInwardId   = col('INWARD ID');

console.log('Header row at index', headerIdx, '— parsed column map OK');

const dataRows = rows.slice(headerIdx + 1).filter(r => {
  const name = String(r[idxItemName] || '').trim();
  return name.length > 0;
});
console.log('Data rows to import:', dataRows.length);

// Pre-load existing raw_materials for name-based lookup (include unit + name for volume detection)
const existingMaterials = db.prepare('SELECT id, name, unit FROM raw_materials').all();
const nameToMat = new Map();
for (const m of existingMaterials) {
  nameToMat.set(m.name.toLowerCase().trim(), m);
}
console.log('Existing materials in DB:', existingMaterials.length);

// Extract "NNN ML" / "NNN LTR" from a material name
function parseMaterialVolumeMl(name) {
  const s = (name || '').toUpperCase();
  const mMl = s.match(/(\d+(?:\.\d+)?)\s*ML\b/);
  if (mMl) return parseFloat(mMl[1]);
  const mLtr = s.match(/(\d+(?:\.\d+)?)\s*(?:LTR|LITRE|LITER)\b/);
  if (mLtr) return parseFloat(mLtr[1]) * 1000;
  return null;
}

// Given raw quantity (as counted in purchase unit — e.g. 20 cases), pack size (24 pcs/case),
// and material details, compute (storedQty, storedUnitPrice) in the raw_material's unit.
function convertToMaterialUnit(rawQty, rawRate, pack, material) {
  const pieces = rawQty * pack;                         // total piece/bottle count
  const pricePerPiece = pack > 1 ? rawRate / pack : rawRate;
  if (material.unit === 'ml' || material.unit === 'l') {
    const perPieceMl = parseMaterialVolumeMl(material.name);
    if (perPieceMl && perPieceMl > 0) {
      const factor = material.unit === 'l' ? perPieceMl / 1000 : perPieceMl;
      return { qty: pieces * factor, rate: pricePerPiece / factor };
    }
  }
  return { qty: pieces, rate: pricePerPiece };
}

const insertMaterial = db.prepare(`
  INSERT INTO raw_materials (id, name, category, unit, current_stock, reorder_level, costing_method, average_price, created_at, updated_at)
  VALUES (?, ?, ?, ?, 0, 0, 'average', 0, datetime('now'), datetime('now'))
`);

const insertPurchase = db.prepare(`
  INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

const insertTx = db.prepare(`
  INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
  VALUES (?, ?, 'purchase', ?, ?, ?, datetime('now'))
`);

const bumpStock = db.prepare(`
  UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?
`);

// Touched materials to recompute avg price at end
const touchedMaterials = new Set();
let stats = { purchases: 0, newMaterials: 0, reusedMaterials: 0, skipped: 0, errors: [] };

const txn = db.transaction(() => {
  for (const r of dataRows) {
    try {
      const name = String(r[idxItemName]).trim();
      if (!name) { stats.skipped++; continue; }

      const nameKey = name.toLowerCase();
      let material = nameToMat.get(nameKey);

      if (!material) {
        const materialId = randomUUID();
        const category = mapCategory(r[idxCategory]);
        const unit = mapUnit(r[idxUnit]);
        insertMaterial.run(materialId, name, category, unit);
        material = { id: materialId, name, unit };
        nameToMat.set(nameKey, material);
        stats.newMaterials++;
      } else {
        stats.reusedMaterials++;
      }
      const materialId = material.id;

      const rawQty = parseFloat(r[idxQty]) || 0;
      const rawRate = parseFloat(r[idxRate]) || 0;
      const pack = packSize(r[idxUnit]);
      // Convert to raw_material's unit — expands CASE → pcs and pcs → ml for volume-tracked items
      const { qty, rate } = convertToMaterialUnit(rawQty, rawRate, pack, material);
      const subtotal = parseFloat(r[idxSubtotal]) || (qty * rate);
      const total = parseFloat(r[idxTotal]) || subtotal;
      const date = toISO(r[idxInwardDate]) || toISO(r[idxCreatedDt]) || new Date().toISOString().split('T')[0];
      const supplier = String(r[idxSupplier] || '').trim();
      const invoiceId = String(r[idxInvoiceId] || '').trim();
      const inwardId  = String(r[idxInwardId] || '').trim();

      if (qty <= 0) { stats.skipped++; continue; }

      const purchaseId = randomUUID();
      const notes = [
        invoiceId ? `Invoice: ${invoiceId}` : null,
        inwardId ? `Inward: ${inwardId}` : null,
      ].filter(Boolean).join(' · ');

      insertPurchase.run(purchaseId, materialId, supplier, '', qty, rate, total, date, notes);
      insertTx.run(randomUUID(), materialId, qty, purchaseId, `Purchase from ${supplier || 'unknown'}`);
      bumpStock.run(qty, materialId);

      touchedMaterials.add(materialId);
      stats.purchases++;
    } catch (e) {
      stats.errors.push(`row ${stats.purchases + stats.skipped}: ${e.message}`);
    }
  }
});

console.log('Starting import transaction…');
const t0 = Date.now();
txn();
console.log(`Transaction committed in ${Date.now() - t0}ms`);

// Recompute weighted average price per touched material
console.log(`Recomputing average price for ${touchedMaterials.size} materials…`);
const getAvg = db.prepare(`
  SELECT SUM(quantity * unit_price) AS total_value, SUM(quantity) AS total_qty
  FROM purchases WHERE material_id = ?
`);
const updateAvg = db.prepare(`UPDATE raw_materials SET average_price = ?, updated_at = datetime('now') WHERE id = ?`);

let recomputed = 0;
for (const id of touchedMaterials) {
  const r = getAvg.get(id);
  if (r && r.total_qty > 0) {
    const avg = Math.round((r.total_value / r.total_qty) * 100) / 100;
    updateAvg.run(avg, id);
    recomputed++;
  }
}
console.log(`Avg price recomputed for ${recomputed} materials`);

console.log('\n=== DONE ===');
console.log('Purchases inserted :', stats.purchases);
console.log('New materials      :', stats.newMaterials);
console.log('Re-used materials  :', stats.reusedMaterials);
console.log('Skipped rows       :', stats.skipped);
if (stats.errors.length) {
  console.log('Errors             :', stats.errors.length);
  console.log(stats.errors.slice(0, 5).map(e => '  - ' + e).join('\n'));
}

db.close();
