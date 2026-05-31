import { getDb, generateId, parseMaterialVolumeMl } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { parseRecahoTransferReport, ParsedTransferGroup } from '@/lib/recaho-transfer';
import * as XLSX from 'xlsx';

/**
 * Recaho "Transfer sales report-detail" importer.
 *
 * Two-step:
 *   1. Upload file with `commit=false` (default) → returns a preview:
 *        { date_min, date_max, departments[], group_count, line_count,
 *          unmatched_items[], missing_departments[], existing_transfer_ids[],
 *          sample_groups[] }
 *      — does not persist anything.
 *
 *   2. Re-upload (or repost) with `commit=true` → atomically:
 *        - creates any missing departments
 *        - creates one Requisition per Recaho TRANSFER/SALE ID, status='fulfilled'
 *          (these are historical transfers — already issued)
 *        - links items by case-insensitive name to raw_materials; unmatched items
 *          are skipped (reported back so user can add masters)
 *        - skips transfer IDs that already exist (idempotent re-upload)
 *
 * The recorded inventory_transactions(type='issue') keep stock-on-hand calculations
 * consistent with anything imported here.
 *
 * Form data:
 *   file              (required) — the .xlsx
 *   commit            'true' | 'false' (default false) — full transfer import
 *   departments_only  'true'  → ONLY create missing departments (no requisitions).
 *   materials_only    'true'  → ONLY create raw_materials for the unmatched items, with
 *                                price/unit/category inferred from the file. Each new row is
 *                                flagged is_auto_discovered=1 so it stands out in inventory
 *                                until an operator reviews it.
 *   sheet             optional sheet name override
 *
 * IMPORTANT: imported transfers NEVER touch raw_materials.current_stock and never
 * write inventory_transactions. Internal transfers are an audit/analytics record of
 * who got what; consumption is computed exclusively from recipe-deduction on sales,
 * parties, staff-meals, and closing-stock variance. Mixing the two would double-count.
 */

/**
 * Infer a stock unit from an item name. Looks for explicit units in parentheses,
 * pack notation, common abbreviations. Falls back to 'pcs'.
 *   "BUDWEISER (330ML)"     → 'pcs'    (we treat ml-on-bottle as per-piece)
 *   "SUNFLOWER OIL 1 LTR"   → 'pcs'    (bottled)
 *   "WHOLE GARLIC"          → 'kg'
 *   "CURD"                  → 'kg'
 *   "PARMESON CHEESE BLOCK" → 'kg'
 *   "BMS WONTON SKIN 300 GM"→ 'pcs'
 */
function inferUnit(name: string, recahoUnit?: string): string {
  const u = String(recahoUnit || '').toUpperCase();
  if (u.includes('PKT') || u.includes('BTL') || u.includes('TIN') || u.includes('CAN')) return 'pcs';
  if (u === 'PC' || u === 'PCS') return 'pcs';
  if (u === 'KG') return 'kg';
  if (u === 'L'  || u === 'LTR') return 'L';
  if (u === 'GM' || u === 'GRM') return 'g';
  const n = String(name || '').toUpperCase();
  if (/\(\s*\d+\s*ML\s*\)/.test(n) || /\d+\s*ML\b/.test(n))   return 'pcs';
  if (/\d+\s*L(?:TR)?\b/.test(n))                             return 'pcs';
  if (/\d+\s*GM?S?\b/.test(n) || /\d+\s*KG\b/.test(n))        return 'pcs';
  if (/\bBOTTLE|BTL|CAN|TIN|PKT|PACK\b/.test(n))              return 'pcs';
  return 'kg';
}

const REQ_NUMBER_PREFIX = 'REQ-IMP-';   // imported transfers get a distinct prefix

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') {
      return Response.json({ error: 'Admin only — import affects every department' }, { status: 403 });
    }

    const form = await request.formData();
    const file = form.get('file');
    const commit = String(form.get('commit') || 'false') === 'true';
    const departmentsOnly = String(form.get('departments_only') || 'false') === 'true';
    const materialsOnly   = String(form.get('materials_only')   || 'false') === 'true';
    const sheetOverride = String(form.get('sheet') || '').trim();
    if (!file || typeof file === 'string') {
      return Response.json({ error: 'file required (multipart form-data)' }, { status: 400 });
    }
    const ab = await (file as File).arrayBuffer();
    const wb = XLSX.read(ab, { type: 'array' });

    // Pick the detail sheet — Recaho names it "Transfer sales report-detail".
    let sheetName = sheetOverride;
    if (!sheetName) {
      sheetName = wb.SheetNames.find(n => /transfer.*detail/i.test(n)) || wb.SheetNames[0];
    }
    if (!wb.Sheets[sheetName]) {
      return Response.json({ error: `Sheet "${sheetName}" not found. Available: ${wb.SheetNames.join(', ')}` }, { status: 400 });
    }
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' }) as any[][];
    const parsed = parseRecahoTransferReport(rows);

    if (parsed.groups.length === 0) {
      return Response.json({ error: 'No transfer groups found in this sheet', errors: parsed.errors }, { status: 400 });
    }

    const db = getDb();

    // ----- Triage which materials match and which don't -----
    const allMaterialNames = new Set<string>();
    for (const g of parsed.groups) for (const l of g.lines) allMaterialNames.add(l.item_name);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const matRows = db.prepare('SELECT id, name FROM raw_materials').all() as any[];
    const matByNorm = new Map<string, string>(matRows.map(m => [norm(m.name), m.id]));
    const unmatched: string[] = [];
    const matchedNames = new Map<string, string>();
    for (const n of allMaterialNames) {
      const id = matByNorm.get(norm(n));
      if (id) matchedNames.set(n, id);
      else    unmatched.push(n);
    }

    // ----- Department triage -----
    const existingDeptByName = new Map<string, string>();
    const deptRows = db.prepare('SELECT id, name FROM departments').all() as any[];
    for (const d of deptRows) existingDeptByName.set(norm(d.name), d.id);
    const missingDepartments = parsed.departments.filter(d => !existingDeptByName.has(norm(d)));

    // ----- Already-imported transfer IDs (idempotent re-upload) -----
    const importedTids = new Set<string>(
      (db.prepare(`SELECT req_number FROM requisitions WHERE req_number LIKE '${REQ_NUMBER_PREFIX}%'`).all() as any[])
        .map(r => r.req_number.replace(REQ_NUMBER_PREFIX, ''))
    );
    const newTransfers = parsed.groups.filter(g => !importedTids.has(g.transfer_id));
    const skippedExisting = parsed.groups.length - newTransfers.length;

    // ----- Per-item rollup for unmatched items (used by both preview and materials-only commit) -----
    // We walk the parsed groups once to collect: total qty issued, weighted-avg rate, category mode.
    const itemStats = new Map<string, { qty: number; rateSum: number; rateN: number; categories: Map<string, number>; sample_unit?: string }>();
    for (const g of parsed.groups) {
      for (const ln of g.lines) {
        if (matchedNames.has(ln.item_name)) continue;
        let s = itemStats.get(ln.item_name);
        if (!s) { s = { qty: 0, rateSum: 0, rateN: 0, categories: new Map() }; itemStats.set(ln.item_name, s); }
        s.qty += ln.qty_issued;
        if (ln.rate > 0) { s.rateSum += ln.rate; s.rateN += 1; }
        if (ln.category) s.categories.set(ln.category, (s.categories.get(ln.category) || 0) + 1);
      }
    }

    // ----- Materials-only: create raw_materials for unmatched item names and return -----
    if (materialsOnly) {
      const insMat = db.prepare(`
        INSERT INTO raw_materials (id, name, category, unit, current_stock, average_price,
                                   is_auto_discovered, discovered_source)
        VALUES (?, ?, ?, ?, 0, ?, 1, ?)
      `);
      const created: { id: string; name: string; unit: string; price: number; category: string }[] = [];
      const txn = db.transaction(() => {
        for (const itemName of unmatched) {
          const s = itemStats.get(itemName);
          const avgRate = s && s.rateN > 0 ? Math.round((s.rateSum / s.rateN) * 100) / 100 : 0;
          const topCategory = s && s.categories.size > 0
            ? [...s.categories.entries()].sort((a, b) => b[1] - a[1])[0][0]
            : 'other';
          const unit = inferUnit(itemName);
          const id = generateId();
          insMat.run(id, itemName, topCategory, unit, avgRate, 'recaho-transfer-import');
          created.push({ id, name: itemName, unit, price: avgRate, category: topCategory });
        }
      });
      txn();
      return Response.json({
        success: true,
        materials_only: true,
        created_materials: created,
        created_count: created.length,
      });
    }

    // ----- Departments-only: create the org chart and return -----
    if (departmentsOnly) {
      const ensureDept = db.prepare(`
        INSERT INTO departments (id, name, code, description, is_active)
        VALUES (?, ?, '', 'Auto-created from Recaho transfer import', 1)
      `);
      const created: string[] = [];
      const txn = db.transaction(() => {
        for (const name of missingDepartments) {
          const id = generateId();
          ensureDept.run(id, name);
          created.push(name);
        }
      });
      txn();
      return Response.json({
        success: true,
        departments_only: true,
        created_departments: created,
        already_existed: parsed.departments.filter(d => existingDeptByName.has(norm(d))),
      });
    }

    // ----- Preview only -----
    if (!commit) {
      return Response.json({
        preview: true,
        sheet: sheetName,
        date_min: parsed.date_min, date_max: parsed.date_max,
        departments: parsed.departments,
        missing_departments: missingDepartments,
        group_count: parsed.groups.length,
        line_count: parsed.groups.reduce((s, g) => s + g.line_count, 0),
        new_transfer_count: newTransfers.length,
        skipped_existing_count: skippedExisting,
        unmatched_item_count: unmatched.length,
        unmatched_items: unmatched.slice(0, 50),
        sample_groups: newTransfers.slice(0, 5).map(g => ({
          transfer_id: g.transfer_id, department: g.department_name,
          date: g.created_date_iso, line_count: g.line_count,
          total_amount: Math.round(g.total_amount * 100) / 100,
        })),
        errors: parsed.errors,
      });
    }

    // ----- Commit -----
    const outletId = await getCurrentOutletId();
    const summary = {
      created_departments: 0,
      created_requisitions: 0,
      created_lines: 0,
      skipped_existing: skippedExisting,
      skipped_unmatched_lines: 0,
    };

    const ensureDept = db.prepare(`
      INSERT INTO departments (id, name, code, description, is_active)
      VALUES (?, ?, '', 'Auto-created from Recaho transfer import', 1)
    `);
    const insReq = db.prepare(`
      INSERT INTO requisitions (id, req_number, department_id, date, status, notes,
                                drafted_by, submitted_at, submitted_by,
                                chef_approved_at, chef_approved_by, chef_note,
                                store_processed_at, store_processed_by, store_note,
                                fulfilled_at, fulfilled_by, outlet_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'fulfilled', ?,
              ?, datetime('now'), ?,
              datetime('now'), 'recaho-import', 'Imported from Recaho transfer report',
              datetime('now'), 'recaho-import', 'Imported from Recaho transfer report',
              datetime('now'), 'recaho-import', ?, datetime('now'), datetime('now'))
    `);
    const insReqItem = db.prepare(`
      INSERT INTO requisition_items (id, req_id, material_id, quantity_requested, quantity_issued, quantity_to_purchase, notes)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `);
    // Note: we deliberately do NOT touch raw_materials.current_stock or write
    // inventory_transactions here. Internal transfers and recipe-driven
    // consumption are kept strictly separate.

    const txn = db.transaction((groups: ParsedTransferGroup[]) => {
      // 1) Create missing departments
      for (const name of missingDepartments) {
        const id = generateId();
        ensureDept.run(id, name);
        existingDeptByName.set(norm(name), id);
        summary.created_departments += 1;
      }

      // 2) Create one requisition per group
      for (const g of groups) {
        const deptId = existingDeptByName.get(norm(g.department_name));
        if (!deptId) continue;        // shouldn't happen — we just created any missing
        const reqId = generateId();
        const reqNumber = REQ_NUMBER_PREFIX + g.transfer_id;
        const noteParts: string[] = [
          `Recaho TRANSFER/SALE ID ${g.transfer_id}`,
          g.po_id ? `PO ${g.po_id}` : '',
          g.created_by ? `by ${g.created_by}` : '',
        ].filter(Boolean);

        insReq.run(
          reqId, reqNumber, deptId,
          g.created_date_iso || g.to_date_iso,
          noteParts.join(' · '),
          g.created_by || 'recaho-import',
          g.created_by || 'recaho-import',
          outletId,
        );

        for (const ln of g.lines) {
          const matId = matchedNames.get(ln.item_name);
          if (!matId) { summary.skipped_unmatched_lines += 1; continue; }
          insReqItem.run(
            generateId(), reqId, matId,
            ln.qty_requested, ln.qty_issued,
            ln.category ? `cat: ${ln.category}` : '',
          );
          summary.created_lines += 1;
        }
        summary.created_requisitions += 1;
      }
    });
    txn(newTransfers);

    return Response.json({
      success: true,
      committed: true,
      summary,
      unmatched_item_count: unmatched.length,
      unmatched_items: unmatched.slice(0, 100),
    });
  } catch (e: any) {
    console.error('[requisitions-import]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
