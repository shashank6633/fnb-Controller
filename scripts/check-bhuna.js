const Database = require('better-sqlite3');
const db = new Database('./fnb-controller.db');
const r = db.prepare(`SELECT id, name, selling_price, total_cost, food_cost_percent FROM recipes WHERE LOWER(name) LIKE '%bhuna%'`).get();
console.log('Stored recipe row:', r);
if (!r) process.exit(0);
const ings = db.prepare(`
  SELECT ri.quantity, ri.unit, rm.name AS material, rm.unit AS m_unit, rm.pack_size, rm.purchase_unit, rm.average_price
  FROM recipe_ingredients ri JOIN raw_materials rm ON rm.id = ri.material_id
  WHERE ri.recipe_id = ? ORDER BY (ri.quantity * rm.average_price) DESC
`).all(r.id);
console.log('Ingredients:');
let manualTotal = 0;
for (const i of ings) {
  let qInMat = i.quantity;
  const ru = (i.unit||'').toLowerCase(); const mu = (i.m_unit||'').toLowerCase();
  if (ru !== mu) {
    if (ru === 'g' && mu === 'kg') qInMat = i.quantity / 1000;
    else if (ru === 'ml' && mu === 'l') qInMat = i.quantity / 1000;
    else if (ru === 'ml' && mu === 'kg') qInMat = i.quantity / 1000;
    else if (ru === 'g' && mu === 'l')  qInMat = i.quantity / 1000;
    else if (ru === 'ml' && mu === 'g') qInMat = i.quantity;
    else if (ru === 'g' && mu === 'ml') qInMat = i.quantity;
    else if (ru === 'l' && mu === 'kg') qInMat = i.quantity;
    else if (ru === 'kg' && mu === 'l') qInMat = i.quantity;
  }
  const cost = qInMat * (i.average_price || 0);
  manualTotal += cost;
  console.log('  ' + i.material.padEnd(38) + ' ' + i.quantity + ' ' + ru + ' → ' + qInMat + ' ' + mu + ' × ₹' + i.average_price + ' = ₹' + cost.toFixed(2));
}
console.log('Manual total:', manualTotal.toFixed(2));
console.log('Stored total_cost:', r.total_cost);
console.log('Stored fc%:', r.food_cost_percent);
