#!/usr/bin/env node
/**
 * Import POS Materials CSV into the F&B Controller database.
 * Usage: node scripts/import-pos-csv.js /path/to/materials.csv
 */

const fs = require('fs');
const path = require('path');

const CSV_PATH = process.argv[2];
if (!CSV_PATH) {
  console.error('Usage: node scripts/import-pos-csv.js <csv-file-path>');
  process.exit(1);
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCSVLine(lines[0]);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (values[idx] || '').trim();
    });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

async function main() {
  const csvText = fs.readFileSync(path.resolve(CSV_PATH), 'utf-8');
  const rows = parseCSV(csvText);

  console.log(`Parsed ${rows.length} rows from CSV`);

  const materials = rows
    .map(row => ({
      id: row['Id'] || undefined,
      name: row['Name'] || '',
      category: row['Category Name'] || 'other',
      purchaseUnit: row['Purchase Unit'] || 'pcs',
      stockUnit: row['Stock Unit'] || '',
      consumptionUnit: row['Consumption Unit'] || '',
      usableInventory: parseFloat(row['Usable Inventory']) || 0,
      minimumStockLevel: parseFloat(row['Minimum Stock Level']) || 0,
      defaultPurchaseRate: parseFloat(row['Default Purchase Rate']) || 0,
    }))
    .filter(m => m.name.trim() !== '');

  console.log(`Sending ${materials.length} materials to API...`);

  const res = await fetch(`${BASE_URL}/api/import-materials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ materials, clearExisting: true }),
  });

  const result = await res.json();

  if (res.ok) {
    console.log(`SUCCESS: ${result.message}`);
  } else {
    console.error(`ERROR: ${result.error}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
