import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Bulk rate correction + price-basis audit.
 *
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
 *   OR (basis-corruption repair — from the "Audit price bases" tool):
 *   body: { repair: [{ material_id: string, new_avg: number }] }
 *
 *   average_price is stored per RECIPE unit; a 'purchase'-basis rate is converted
 *   with the material's own pack_size (avg = rate / pack_size). 'recipe' basis is
 *   stored as-is.
 *
 *   Every matched row also carries purchase_unit + latest_ppu (the basis-safe
 *   latest purchase price PER PURCHASE UNIT) so the client can render dual-unit
 *   previews and detect a wrong basis toggle before apply.
 *
 *   → { applied, matched:[{sku,name,unit,purchase_unit,pack_size,old,new,latest_ppu}],
 *       unmatched:[key], ambiguous:[{key,count}] }
 *
 * GET /api/inventory/update-rates?audit=1
 *   Basis-corruption scanner: flags materials with pack_size > 1 whose stored
 *   average_price looks like a PER-PURCHASE-UNIT price (i.e. ~pack× too big vs
 *   the latest real purchase). Rule: avg × pack > 5 × latest_ppu.
 *   → { rows: [{ id, sku, name, unit, purchase_unit, pack, stored_avg,
 *                expected_avg (= latest_ppu / pack), latest_ppu, ratio }] }
 *
 * Admin / store manager only (mirrors the round-trip import gate).
 */

/** Basis-safe latest purchase price per PURCHASE unit (same rule as /api/inventory):
 *  a qty that's a clean multiple of pack_size (and >= one pack) was recorded in
 *  recipe units, so scale total/qty back up by pack. */
const LATEST_PPU_SQL = `
  SELECT CASE
      WHEN COALESCE(?, 1) > 1 AND p.quantity >= ? AND (p.quantity % ?) = 0
        THEN (p.total_price / p.quantity) * ?
      ELSE (p.total_price / p.quantity)
    END AS lp
  FROM purchases p
  WHERE p.material_id = ? AND p.quantity > 0 AND COALESCE(p.total_price, 0) > 0
  ORDER BY p.date DESC, p.created_at DESC LIMIT 1`;

async function requireRateAdmin() {
  const me = await getCurrentUser();
  if (!me) return { error: Response.json({ error: 'Sign in required' }, { status: 401 }) };
  if (me.role !== 'admin' && !me.is_store_manager) {
    return { error: Response.json({ error: 'Admin / store manager only' }, { status: 403 }) };
  }
  return { me };
}

export async function GET(request: Request) {
  try {
    const gate = await requireRateAdmin();
    if (gate.error) return gate.error;

    const url = new URL(request.url);
    if (url.searchParams.get('audit') !== '1') {
      return Response.json({ error: 'Use ?audit=1' }, { status: 400 });
    }

    const db = getDb();
    // Every active material with a real pack (pack_size > 1), a stored avg and
    // at least one purchase. Flag when the stored avg is implausibly PER-PURCHASE:
    // avg × pack > 5 × latest real purchase price per purchase unit.
    const candidates = db.prepare(`
      SELECT rm.id, rm.sku, rm.name, rm.unit, rm.purchase_unit, rm.pack_size, rm.average_price,
        (SELECT CASE
             WHEN rm.pack_size > 1 AND p.quantity >= rm.pack_size AND (p.quantity % rm.pack_size) = 0
               THEN (p.total_price / p.quantity) * rm.pack_size
             ELSE (p.total_price / p.quantity)
           END
           FROM purchases p
           WHERE p.material_id = rm.id AND p.quantity > 0 AND COALESCE(p.total_price, 0) > 0
           ORDER BY p.date DESC, p.created_at DESC LIMIT 1) AS latest_ppu
      FROM raw_materials rm
      WHERE COALESCE(rm.is_active, 1) = 1
        AND COALESCE(rm.pack_size, 1) > 1
        AND COALESCE(rm.average_price, 0) > 0
    `).all() as any[];

    const rows = [];
    for (const c of candidates) {
      const pack = Number(c.pack_size) || 1;
      const avg = Number(c.average_price) || 0;
      const lp = Number(c.latest_ppu) || 0;
      if (lp <= 0) continue; // no purchase history → nothing to compare against
      const expected = lp / pack;
      // Stored avg looks ~pack× too big vs reality (both forms of the same rule,
      // kept explicit for clarity).
      if (avg * pack > 5 * lp && avg > expected * 5) {
        rows.push({
          id: c.id,
          sku: c.sku || '',
          name: c.name,
          unit: c.unit,
          purchase_unit: c.purchase_unit || c.unit,
          pack,
          stored_avg: Math.round(avg * 1e6) / 1e6,
          expected_avg: Math.round(expected * 1e6) / 1e6,
          latest_ppu: Math.round(lp * 1e6) / 1e6,
          ratio: expected > 0 ? Math.round((avg / expected) * 10) / 10 : 0,
        });
      }
    }
    rows.sort((a, b) => b.ratio - a.ratio);

    return Response.json({ scanned: candidates.length, flagged: rows.length, rows });
  } catch (e: any) {
    console.error('GET /api/inventory/update-rates?audit=1 failed:', e);
    return Response.json({ error: e?.message || 'Audit failed' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const gate = await requireRateAdmin();
    if (gate.error) return gate.error;
    const me = gate.me!;

    const body = await request.json().catch(() => ({}));
    const db = getDb();

    // ── Repair branch (from the basis-corruption audit) ────────────────────
    if (Array.isArray(body?.repair)) {
      const repair: any[] = body.repair;
      if (!repair.length) return Response.json({ error: 'repair is empty' }, { status: 400 });
      const byId = db.prepare(`SELECT id, sku, name, unit, pack_size, average_price FROM raw_materials WHERE id = ?`);
      const upd = db.prepare(`UPDATE raw_materials SET average_price = ?, updated_at = datetime('now') WHERE id = ?`);
      const repaired: any[] = [];
      const skipped: { material_id: string; reason: string }[] = [];
      db.transaction(() => {
        for (const r of repair) {
          const id = String(r?.material_id ?? '').trim();
          const newAvg = Number(r?.new_avg);
          if (!id || !Number.isFinite(newAvg) || newAvg < 0) {
            skipped.push({ material_id: id || '?', reason: 'invalid material_id / new_avg' });
            continue;
          }
          const hit = byId.get(id) as any;
          if (!hit) { skipped.push({ material_id: id, reason: 'not found' }); continue; }
          upd.run(newAvg, id);
          logAuditEvent(db, {
            event_type: 'rates.repair',
            entity_type: 'raw_material',
            entity_id: id,
            actor_email: me.email,
            before: { average_price: hit.average_price },
            after: { average_price: newAvg },
            note: `Basis-corruption repair: ${hit.name} avg ₹${hit.average_price}/${hit.unit} → ₹${newAvg}/${hit.unit}`,
          });
          repaired.push({ sku: hit.sku, name: hit.name, old: hit.average_price, new: newAvg });
        }
      })();
      return Response.json({ repaired: repaired.length, rows: repaired, skipped });
    }

    // ── Bulk rate-update branch ─────────────────────────────────────────────
    const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
    const basis: 'purchase' | 'recipe' = body?.basis === 'recipe' ? 'recipe' : 'purchase';
    const dryRun = !!body?.dryRun;
    if (!rows.length) return Response.json({ error: 'rows is required' }, { status: 400 });

    const bySku = db.prepare(`SELECT id, sku, name, unit, purchase_unit, pack_size, average_price FROM raw_materials WHERE LOWER(TRIM(sku)) = LOWER(TRIM(?))`);
    const byName = db.prepare(`SELECT id, sku, name, unit, purchase_unit, pack_size, average_price FROM raw_materials WHERE name = ? COLLATE NOCASE`);
    const lpStmt = db.prepare(LATEST_PPU_SQL);

    const matched: any[] = [];
    const unmatched: string[] = [];
    const ambiguous: { key: string; count: number }[] = [];
    const invalid: { key: string; reason: string }[] = [];
    const updates: { id: string; newAvg: number; name: string; old: number }[] = [];

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
      const lpRow = lpStmt.get(pack, pack, pack, pack, hit.id) as any;
      matched.push({
        sku: hit.sku,
        name: hit.name,
        unit: hit.unit,
        purchase_unit: hit.purchase_unit || hit.unit,
        pack_size: pack,
        old: hit.average_price,
        new: Math.round(newAvg * 1e6) / 1e6,
        latest_ppu: lpRow ? Math.round(Number(lpRow.lp) * 1e6) / 1e6 : 0,
      });
      updates.push({ id: hit.id, newAvg, name: hit.name, old: hit.average_price });
    }

    let applied = 0;
    if (!dryRun && updates.length) {
      const upd = db.prepare(`UPDATE raw_materials SET average_price = ?, updated_at = datetime('now') WHERE id = ?`);
      db.transaction(() => { for (const u of updates) { upd.run(u.newAvg, u.id); applied++; } })();
      logAuditEvent(db, {
        event_type: 'rates.bulk_update',
        entity_type: 'raw_material',
        entity_id: 'bulk',
        actor_email: me.email,
        after: { basis, applied, changes: updates.slice(0, 100).map(u => ({ id: u.id, name: u.name, old: u.old, new: Math.round(u.newAvg * 1e6) / 1e6 })) },
        note: `Bulk rate update (${basis} basis): ${applied} material(s)`,
      });
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
