import { getDb } from '@/lib/db';
import { getCurrentUser, requireRole } from '@/lib/auth';
import { upsertUnitLock, nameKey } from '@/lib/unit-audit-lock';

/**
 * Re-apply a unit-audit CSV (downloaded from /api/unit-audit/export, edited or
 * not) back into both:
 *   1) unit_audit_locks  — the persistent snapshot, survives data wipes
 *   2) raw_materials     — actual live units for recipes / requisitions
 *
 * Match priority: sku (exact) → name (case-insensitive trimmed). Rows with no
 * matching raw_material still create a lock (so the next purchases import that
 * auto-creates that material picks up the curated units).
 *
 * Accepts CSV body (text/csv or multipart with a `file` field).
 */
export const dynamic = 'force-dynamic';

type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  // Tiny CSV parser handling quoted fields + escaped quotes + CRLF.
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (field !== '' || cur.length > 0) { cur.push(field); rows.push(cur); cur = []; field = ''; }
        if (c === '\r' && text[i + 1] === '\n') i++;
      } else field += c;
    }
  }
  if (field !== '' || cur.length > 0) { cur.push(field); rows.push(cur); }
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).filter(r => r.some(c => c !== '')).map(r => {
    const obj: Row = {};
    headers.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
    return obj;
  });
}

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  try {
    let csvText = '';
    const ct = req.headers.get('content-type') || '';
    if (ct.includes('multipart/form-data')) {
      const fd = await req.formData();
      const file = fd.get('file');
      if (!file || !(file instanceof Blob)) {
        return Response.json({ error: 'file field missing' }, { status: 400 });
      }
      csvText = await file.text();
    } else {
      csvText = await req.text();
    }
    if (!csvText.trim()) return Response.json({ error: 'Empty CSV' }, { status: 400 });

    const rows = parseCsv(csvText);
    if (rows.length === 0) return Response.json({ error: 'No data rows' }, { status: 400 });

    const db = getDb();
    const me = await getCurrentUser();
    const findBySku  = db.prepare('SELECT id, sku, name FROM raw_materials WHERE sku = ?');
    const findByName = db.prepare('SELECT id, sku, name FROM raw_materials WHERE LOWER(TRIM(name)) = ?');
    const hasRecipeUnitCol = (db.prepare("PRAGMA table_info(raw_materials)").all() as any[])
      .some((c: any) => c.name === 'recipe_unit');
    const upd = db.prepare(`
      UPDATE raw_materials SET
        unit          = COALESCE(?, unit),
        ${hasRecipeUnitCol ? 'recipe_unit  = COALESCE(?, recipe_unit),' : ''}
        purchase_unit = COALESCE(?, purchase_unit),
        pack_size     = COALESCE(?, pack_size),
        case_size     = COALESCE(?, case_size),
        category      = COALESCE(?, category),
        updated_at    = datetime('now')
      WHERE id = ?
    `);

    let lockedRows = 0;
    let appliedToMaterials = 0;
    let unmatched = 0;
    const unmatchedSample: string[] = [];

    const txn = db.transaction(() => {
      for (const r of rows) {
        const sku  = (r.sku || '').trim();
        const name = (r.name || '').trim();
        if (!name) continue;
        const recipeUnit   = r.recipe_unit   || null;
        const purchaseUnit = r.purchase_unit || null;
        const packSize     = r.pack_size     ? Number(r.pack_size) : null;
        const caseSize     = r.case_size     ? Number(r.case_size) : null;
        const category     = r.category      || null;

        // Always upsert the lock (persists even when no material exists yet).
        upsertUnitLock(db, { sku, name, recipe_unit: recipeUnit, purchase_unit: purchaseUnit,
                             pack_size: packSize, case_size: caseSize, category }, me?.email);
        lockedRows += 1;

        let mat: any = null;
        if (sku) mat = findBySku.get(sku);
        if (!mat) mat = findByName.get(nameKey(name));
        if (!mat) {
          unmatched += 1;
          if (unmatchedSample.length < 5) unmatchedSample.push(name);
          continue;
        }
        if (hasRecipeUnitCol) {
          upd.run(recipeUnit, recipeUnit, purchaseUnit, packSize, caseSize, category, mat.id);
        } else {
          upd.run(recipeUnit, purchaseUnit, packSize, caseSize, category, mat.id);
        }
        appliedToMaterials += 1;
      }
    });
    txn();

    return Response.json({
      success: true,
      rows_processed: rows.length,
      locks_upserted: lockedRows,
      applied_to_materials: appliedToMaterials,
      unmatched_materials: unmatched,
      unmatched_sample: unmatchedSample,
    });
  } catch (e: any) {
    console.error('[unit-audit/import]', e);
    return Response.json({ error: e.message || 'Failed to import' }, { status: 500 });
  }
}
