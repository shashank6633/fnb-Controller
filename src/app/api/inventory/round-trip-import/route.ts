import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Round-trip inventory import. Designed to receive a CSV exported from
 * /api/inventory/export (possibly with edits in Excel).
 *
 * For each row:
 *   - `id` non-empty → UPDATE that raw_material (per-field merge; only
 *     fields present in the payload get written)
 *   - `id` blank     → INSERT a new raw_material (SKU auto-generated if blank)
 *
 * Body shape:
 *   {
 *     rows: Array<{ id?, sku?, name, category?, unit?, purchase_unit?,
 *                   pack_size?, case_size?, reorder_level?, costing_method?,
 *                   average_price?, super_category?, brand?, yield_percent?,
 *                   tax_percent?, cess_percent?, standard_purchase_rate?,
 *                   closing_cadence?, is_recipe_item?, is_direct_sell?,
 *                   is_semifinished?, storage_location?, shelf_life_days? }>,
 *     deactivateMissing?: boolean,   // "Remove old inventory details" option
 *   }
 *
 * When deactivateMissing=true: any active material whose id is NOT in the
 * payload gets `is_active = 0` (soft delete). We do NOT hard-delete because
 * purchases / recipes / requisitions reference these rows by FK and would
 * cascade-break. Deactivated rows can be re-activated by editing the row
 * in a future export → upload.
 *
 * Admin / store manager only.
 */
export const dynamic = 'force-dynamic';

const FIELD_TYPES: Record<string, 'string' | 'number' | 'bool'> = {
  name: 'string', sku: 'string', category: 'string', unit: 'string',
  purchase_unit: 'string', pack_size: 'number', case_size: 'number',
  reorder_level: 'number', priority: 'number',
  costing_method: 'string', average_price: 'number',
  super_category: 'string', brand: 'string',
  yield_percent: 'number', tax_percent: 'number', cess_percent: 'number',
  standard_purchase_rate: 'number',
  closing_cadence: 'string', storage_location: 'string',
  shelf_life_days: 'number',
  is_recipe_item: 'bool', is_direct_sell: 'bool', is_semifinished: 'bool',
};
const WRITABLE_FIELDS = Object.keys(FIELD_TYPES);

function coerce(field: string, raw: any): any {
  if (raw == null || raw === '') return undefined;
  const t = FIELD_TYPES[field];
  if (t === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (t === 'bool') {
    const s = String(raw).trim().toLowerCase();
    if (['1','true','yes','y'].includes(s)) return 1;
    if (['0','false','no','n'].includes(s)) return 0;
    return undefined;
  }
  return String(raw).trim();
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && !me.is_store_manager) {
      return Response.json({ error: 'Admin / store manager only' }, { status: 403 });
    }
    const db = getDb();
    const body = await request.json();
    const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
    const deactivateMissing: boolean = !!body?.deactivateMissing;
    if (rows.length === 0) {
      return Response.json({ error: 'rows array required' }, { status: 400 });
    }

    const created: any[] = [];
    const updated: any[] = [];
    const skipped: any[] = [];
    const seenIds = new Set<string>();
    let deactivated = 0;

    // Pre-flight: detect duplicate SKUs within the uploaded file BEFORE writing
    // anything. Better to fail the whole import than to half-apply with conflicts.
    const skuSeen = new Map<string, number>(); // sku → first row index
    const fileDupes: { row: number; sku: string; conflicts_with_row: number }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const s = String(rows[i].sku || '').trim().toLowerCase();
      if (!s) continue;
      if (skuSeen.has(s)) {
        fileDupes.push({ row: i + 1, sku: s, conflicts_with_row: (skuSeen.get(s) || 0) + 1 });
      } else {
        skuSeen.set(s, i);
      }
    }
    if (fileDupes.length > 0) {
      return Response.json({
        error: `Aborted — ${fileDupes.length} duplicate SKU${fileDupes.length === 1 ? '' : 's'} within the file. Fix and re-upload.`,
        duplicate_skus_in_file: fileDupes,
      }, { status: 400 });
    }

    const txn = db.transaction(() => {
      for (let idx = 0; idx < rows.length; idx++) {
        const r = rows[idx];
        const name = String(r.name || '').trim();
        if (!name) { skipped.push({ row: idx + 1, reason: 'name is empty' }); continue; }

        // Priority stars are strictly 1-3 (3★ critical / 2★ standard / 1★ low).
        // A wrong value (e.g. 5) rejects the ROW so Excel typos never silently
        // land as bogus star levels. Blank = leave existing / default 2.
        if (r.priority != null && String(r.priority).trim() !== '') {
          const p = Number(r.priority);
          if (!Number.isInteger(p) || p < 1 || p > 3) {
            skipped.push({ row: idx + 1, name, reason: `priority must be 1, 2 or 3 (got "${r.priority}")` });
            continue;
          }
        }

        const id = String(r.id || '').trim();
        // Per-row SKU uniqueness vs DB (excluding the same id we're updating)
        const newSku = String(r.sku || '').trim();
        if (newSku) {
          const dup = db.prepare(`SELECT id FROM raw_materials WHERE LOWER(sku) = LOWER(?) ${id ? 'AND id != ?' : ''}`)
            .get(...(id ? [newSku, id] : [newSku])) as any;
          if (dup) {
            skipped.push({ row: idx + 1, name, reason: `SKU "${newSku}" already used by another material (id=${dup.id})` });
            continue;
          }
        }
        if (id) {
          seenIds.add(id);
          const existing = db.prepare(`SELECT id FROM raw_materials WHERE id = ?`).get(id);
          if (!existing) {
            skipped.push({ row: idx + 1, name, reason: `id "${id}" not found — keep blank to create new` });
            continue;
          }
          // Build dynamic UPDATE from present fields
          const sets: string[] = [];
          const params: any[] = [];
          for (const f of WRITABLE_FIELDS) {
            if (!(f in r)) continue;
            const v = coerce(f, r[f]);
            if (v === undefined) continue;
            sets.push(`${f} = ?`); params.push(v);
          }
          // Always re-activate if user is round-tripping (they kept the row)
          sets.push(`is_active = 1`);
          sets.push(`updated_at = datetime('now')`);
          db.prepare(`UPDATE raw_materials SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
          updated.push({ id, name });
        } else {
          // Insert path
          const newId = generateId();
          // Auto-generate SKU if blank
          let sku = String(r.sku || '').trim();
          if (!sku) {
            const last = db.prepare(`SELECT sku FROM raw_materials WHERE sku LIKE 'MAT-%' AND sku GLOB 'MAT-[0-9]*' ORDER BY sku DESC LIMIT 1`).get() as any;
            const n = last?.sku ? parseInt(last.sku.split('-')[1], 10) : 0;
            sku = `MAT-${String(n + 1).padStart(5, '0')}`;
          }
          db.prepare(`
            INSERT INTO raw_materials (id, sku, name, category, unit, purchase_unit, pack_size, case_size,
              reorder_level, priority, costing_method, average_price, super_category, brand,
              yield_percent, tax_percent, cess_percent, standard_purchase_rate,
              closing_cadence, is_recipe_item, is_direct_sell, is_semifinished,
              storage_location, shelf_life_days, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
          `).run(
            newId, sku, name,
            coerce('category', r.category) ?? 'other',
            coerce('unit', r.unit) ?? 'kg',
            coerce('purchase_unit', r.purchase_unit) ?? 'kg',
            coerce('pack_size', r.pack_size) ?? 1,
            coerce('case_size', r.case_size) ?? 1,
            coerce('reorder_level', r.reorder_level) ?? 0,
            coerce('priority', r.priority) ?? 2,
            coerce('costing_method', r.costing_method) ?? 'average',
            coerce('average_price', r.average_price) ?? 0,
            coerce('super_category', r.super_category) ?? '',
            coerce('brand', r.brand) ?? '',
            coerce('yield_percent', r.yield_percent) ?? 100,
            coerce('tax_percent', r.tax_percent) ?? 0,
            coerce('cess_percent', r.cess_percent) ?? 0,
            coerce('standard_purchase_rate', r.standard_purchase_rate) ?? 0,
            coerce('closing_cadence', r.closing_cadence) ?? 'none',
            coerce('is_recipe_item', r.is_recipe_item) ?? 0,
            coerce('is_direct_sell', r.is_direct_sell) ?? 0,
            coerce('is_semifinished', r.is_semifinished) ?? 0,
            coerce('storage_location', r.storage_location) ?? '',
            coerce('shelf_life_days', r.shelf_life_days) ?? 0,
          );
          seenIds.add(newId);
          created.push({ id: newId, sku, name });
        }
      }

      // Soft-delete materials not in the payload
      if (deactivateMissing) {
        const active = db.prepare(`SELECT id, name FROM raw_materials WHERE is_active = 1`).all() as any[];
        const upd = db.prepare(`UPDATE raw_materials SET is_active = 0, updated_at = datetime('now') WHERE id = ?`);
        for (const a of active) {
          if (!seenIds.has(a.id)) { upd.run(a.id); deactivated++; }
        }
      }
    });
    txn();

    return Response.json({
      created, updated, skipped, deactivated,
      summary: `Updated ${updated.length} · Created ${created.length} · Skipped ${skipped.length}` +
               (deactivateMissing ? ` · Deactivated ${deactivated} not in file` : ''),
    });
  } catch (e: any) {
    console.error('[/api/inventory/round-trip-import]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
