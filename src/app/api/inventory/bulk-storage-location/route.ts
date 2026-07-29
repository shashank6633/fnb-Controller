import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Bulk storage-location fill for raw materials (the physical area an item lives
 * in — Grocery Store / Chiller / Beverage Store — which closing stock is
 * grouped by). `raw_materials.storage_location` is free text and starts blank on
 * every row, so it has to be filled by CATEGORY (~20 decisions) rather than by
 * hand (928 rows).
 *
 * POST /api/inventory/bulk-storage-location   (admin / store manager; CSRF via the /api/inventory prefix)
 *   { category: string,        storage_location: string }   → every material in that category
 *   { material_ids: string[],  storage_location: string }   → exactly those materials
 *   storage_location is trimmed, max 60 chars, and may be '' to CLEAR.
 *   → { updated, skipped, storage_location, store_mapped, remaining_blank, scope, category }
 *
 * Store-mapped (liquor) materials are NOT skipped: where an item physically sits
 * is orthogonal to which store's ledger owns it. They're counted in
 * `store_mapped` so the caller can say so.
 *
 * This route writes storage_location + updated_at and NOTHING else — two literal
 * UPDATE statements, no SELECT-then-write round-trip and no shared upsert
 * helper, so no other column can ride along on a bulk run.
 */
export const dynamic = 'force-dynamic';

const MAX_LEN = 60;
const MAX_IDS = 5000;

/** Same category normalisation /api/inventory uses for exclude_store_mapped —
 *  spacing/dash/underscore-insensitive, so 'red-wine' matches 'red wine'. */
const STORE_MAPPED_SQL = `EXISTS (
  SELECT 1 FROM store_category_map scm
  JOIN store_locations sl ON sl.id = scm.store_id
  WHERE sl.is_active = 1
    AND REPLACE(REPLACE(REPLACE(LOWER(TRIM(scm.category)),' ',''),'-',''),'_','')
      = REPLACE(REPLACE(REPLACE(LOWER(TRIM(rm.category)),' ',''),'-',''),'_','')
)`;

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && !me.is_store_manager) {
      return Response.json({ error: 'Admin / store manager only' }, { status: 403 });
    }
    const db = getDb();
    const body = await request.json().catch(() => ({}));

    // '' is a legitimate value (it CLEARS the location), so only a missing /
    // non-string field is an error — never a falsy one.
    if (typeof body?.storage_location !== 'string') {
      return Response.json({ error: 'storage_location is required (send "" to clear)' }, { status: 400 });
    }
    const storageLocation = body.storage_location.trim();
    if (storageLocation.length > MAX_LEN) {
      return Response.json({ error: `storage_location must be ${MAX_LEN} characters or fewer` }, { status: 400 });
    }

    const category = typeof body?.category === 'string' ? body.category.trim() : '';
    const ids: string[] = Array.isArray(body?.material_ids)
      ? [...new Set(body.material_ids.map((x: unknown) => String(x).trim()).filter(Boolean))] as string[]
      : [];
    if (!category && ids.length === 0) {
      return Response.json({ error: 'Send either category or material_ids' }, { status: 400 });
    }
    if (category && ids.length > 0) {
      return Response.json({ error: 'Send category OR material_ids, not both' }, { status: 400 });
    }
    if (ids.length > MAX_IDS) {
      return Response.json({ error: `material_ids is capped at ${MAX_IDS}` }, { status: 400 });
    }

    // The ONLY two writes this route can make.
    const updByCategory = db.prepare(
      `UPDATE raw_materials SET storage_location = ?, updated_at = datetime('now') WHERE category COLLATE NOCASE = ?`,
    );
    const updById = db.prepare(
      `UPDATE raw_materials SET storage_location = ?, updated_at = datetime('now') WHERE id = ?`,
    );
    const countBlank = db.prepare(
      `SELECT COUNT(*) AS n FROM raw_materials WHERE TRIM(COALESCE(storage_location, '')) = ''`,
    );

    let targeted = 0;
    let storeMapped = 0;

    if (category) {
      // COLLATE NOCASE mirrors /api/inventory/priority's category matching, and
      // the count below uses the IDENTICAL WHERE as the UPDATE so a category
      // that matches nothing is a clear 400, never a silent 0-row success.
      targeted = Number((db.prepare(
        `SELECT COUNT(*) AS n FROM raw_materials WHERE category COLLATE NOCASE = ?`,
      ).get(category) as any)?.n || 0);
      if (targeted === 0) {
        return Response.json({ error: `No materials in category "${category}"` }, { status: 400 });
      }
      storeMapped = Number((db.prepare(
        `SELECT COUNT(*) AS n FROM raw_materials rm WHERE rm.category COLLATE NOCASE = ? AND ${STORE_MAPPED_SQL}`,
      ).get(category) as any)?.n || 0);
    } else {
      const placeholders = ids.map(() => '?').join(',');
      storeMapped = Number((db.prepare(
        `SELECT COUNT(*) AS n FROM raw_materials rm WHERE rm.id IN (${placeholders}) AND ${STORE_MAPPED_SQL}`,
      ).get(...ids) as any)?.n || 0);
    }

    let updated = 0;
    let remainingBlank = 0;
    // Snapshot BEFORE the write, inside the same transaction, so the audit row
    // records exactly what each material held. Capped so a whole-category apply
    // can't bloat the event; the count tells you if it was truncated.
    let beforeImage: Array<{ id: string; storage_location: string }> = [];
    db.transaction(() => {
      beforeImage = (category
        ? db.prepare(`SELECT id, COALESCE(storage_location,'') AS storage_location
                      FROM raw_materials WHERE category COLLATE NOCASE = ? LIMIT 500`).all(category)
        : db.prepare(`SELECT id, COALESCE(storage_location,'') AS storage_location
                      FROM raw_materials WHERE id IN (${ids.map(() => '?').join(',') || "''"}) LIMIT 500`).all(...ids)
      ) as Array<{ id: string; storage_location: string }>;
      if (category) {
        updated = updByCategory.run(storageLocation, category).changes;
      } else {
        for (const id of ids) updated += updById.run(storageLocation, id).changes;
      }
      remainingBlank = Number((countBlank.get() as any)?.n || 0);
      logAuditEvent(db, {
        event_type: 'storage_location.bulk_set',
        entity_type: 'raw_material',
        entity_id: 'bulk',
        actor_email: me.email,
        // BEFORE image — a bulk apply can rewrite hundreds of rows in one click
        // and there is no undo button. Recording each material's prior value
        // makes the change reversible from the audit log alone.
        before: { previous: beforeImage },
        after: {
          storage_location: storageLocation,
          category: category || null,
          material_ids: category ? null : ids.slice(0, 100),
          material_id_count: category ? null : ids.length,
          updated,
          store_mapped: storeMapped,
        },
        note: `Bulk storage location ${storageLocation ? `→ "${storageLocation}"` : 'cleared'} for `
          + (category ? `category "${category}"` : `${ids.length} material id(s)`)
          + `: ${updated} material(s)`,
      });
    })();

    return Response.json({
      updated,
      // ids that matched no row (category mode targets rows that exist by
      // definition, so nothing can be skipped there).
      skipped: category ? 0 : ids.length - updated,
      storage_location: storageLocation,
      store_mapped: storeMapped,
      remaining_blank: remainingBlank,
      scope: category ? 'category' : 'ids',
      category: category || null,
    });
  } catch (e: any) {
    console.error('[/api/inventory/bulk-storage-location]', e);
    return Response.json({ error: e?.message || 'Failed to set storage locations' }, { status: 500 });
  }
}
