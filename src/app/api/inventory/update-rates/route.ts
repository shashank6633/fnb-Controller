import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * POST /api/inventory/update-rates
 *   Bulk-correct raw-material rates in place (fixes wrong avg rates). Matches
 *   EXISTING materials by SKU (exact, case-insensitive) or name (NOCASE) and
 *   updates average_price only — no deletes, no new IDs — so every past
 *   requisition / party-events cost (which reads average_price LIVE) recomputes
 *   at the corrected rate. Nothing else (stock, purchases, units) is touched.
 *
 *   body: {
 *     rows: [{ key: string, rate: number }],   // key = SKU or exact name
 *     basis?: 'purchase' | 'recipe',           // default 'purchase' (₹ per purchase unit, e.g. ₹/kg)
 *     dryRun?: boolean,                          // preview without writing
 *   }
 *
 *   average_price is stored per RECIPE unit; a 'purchase'-basis rate is converted
 *   with the material's own pack_size (avg = rate / pack_size). 'recipe' basis is
 *   stored as-is.
 *
 *   → { applied, matched:[{sku,name,unit,pack_size,old,new}], unmatched:[key], ambiguous:[{key,count}] }
 *
 * Admin / store manager only (mirrors the round-trip import gate).
 */
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && !me.is_store_manager) {
      return Response.json({ error: 'Admin / store manager only' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
    const basis: 'purchase' | 'recipe' = body?.basis === 'recipe' ? 'recipe' : 'purchase';
    const dryRun = !!body?.dryRun;
    if (!rows.length) return Response.json({ error: 'rows is required' }, { status: 400 });

    const db = getDb();
    const bySku = db.prepare(`SELECT id, sku, name, unit, pack_size, average_price FROM raw_materials WHERE LOWER(TRIM(sku)) = LOWER(TRIM(?))`);
    const byName = db.prepare(`SELECT id, sku, name, unit, pack_size, average_price FROM raw_materials WHERE name = ? COLLATE NOCASE`);

    const matched: any[] = [];
    const unmatched: string[] = [];
    const ambiguous: { key: string; count: number }[] = [];
    const invalid: { key: string; reason: string }[] = [];
    const updates: { id: string; newAvg: number }[] = [];

    for (const r of rows) {
      const key = String(r?.key ?? '').trim();
      const rate = Number(r?.rate);
      if (!key) continue;
      if (!Number.isFinite(rate) || rate < 0) { invalid.push({ key, reason: 'rate must be a number ≥ 0' }); continue; }

      // SKU match first (unique), then name (NOCASE).
      let hit = bySku.get(key) as any;
      if (!hit) {
        const named = byName.all(key) as any[];
        if (named.length === 0) { unmatched.push(key); continue; }
        if (named.length > 1) { ambiguous.push({ key, count: named.length }); continue; }
        hit = named[0];
      }

      const pack = Number(hit.pack_size) || 1;
      const newAvg = basis === 'recipe' ? rate : (pack > 0 ? rate / pack : rate);
      matched.push({ sku: hit.sku, name: hit.name, unit: hit.unit, pack_size: pack, old: hit.average_price, new: Math.round(newAvg * 1e6) / 1e6 });
      updates.push({ id: hit.id, newAvg });
    }

    let applied = 0;
    if (!dryRun && updates.length) {
      const upd = db.prepare(`UPDATE raw_materials SET average_price = ?, updated_at = datetime('now') WHERE id = ?`);
      db.transaction(() => { for (const u of updates) { upd.run(u.newAvg, u.id); applied++; } })();
    }

    return Response.json({
      dryRun,
      basis,
      applied,
      matchedCount: matched.length,
      matched: matched.slice(0, 500),
      unmatched,
      ambiguous,
      invalid,
    });
  } catch (e: any) {
    console.error('POST /api/inventory/update-rates failed:', e);
    return Response.json({ error: e?.message || 'Failed to update rates' }, { status: 500 });
  }
}
