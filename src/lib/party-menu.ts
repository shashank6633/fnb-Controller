import type { Database } from 'better-sqlite3';

/**
 * Party Menu — a manager-enabled LIMITED à-la-carte menu locked to specific
 * tables. See db.ts (party_menus / party_menu_items / party_menu_tables).
 *
 * The single source of truth for "what is a table restricted to right now" is
 * activePartyMenuForTable(): the latest ENABLED party menu that includes the
 * table, plus its allowed menu_item ids. Both the customer menu (what's shown)
 * AND the customer order API (what can be ordered) call this so the limit is
 * real, not cosmetic.
 */
export interface ActivePartyMenu {
  id: string;
  name: string;
  note: string;
  /** Allowed menu_item ids. Only non-empty menus can be enabled (API-enforced). */
  itemIds: Set<string>;
}

/** The enabled party menu governing this table, or null. If two enabled menus
 *  somehow share a table, the most recently updated one wins (deterministic). */
export function activePartyMenuForTable(db: Database, tableId: string): ActivePartyMenu | null {
  const id = String(tableId || '').trim();
  if (!id) return null;
  const pm = db.prepare(`
    SELECT pm.id, pm.name, COALESCE(pm.note,'') AS note
    FROM party_menus pm
    JOIN party_menu_tables pmt ON pmt.party_menu_id = pm.id
    WHERE pmt.table_id = ? AND pm.enabled = 1
    ORDER BY pm.updated_at DESC, pm.rowid DESC
    LIMIT 1
  `).get(id) as any;
  if (!pm) return null;
  // Only ORDERABLE items count — a picked item that's since been 86'd
  // (is_active=0 or selling_price=0) is excluded from the customer menu, so it
  // must be excluded here too. If NONE of the picked items are orderable, return
  // null (full menu) rather than serving the guest a blank menu.
  const ids = (db.prepare(`
    SELECT pmi.menu_item_id
    FROM party_menu_items pmi
    JOIN menu_items mi ON mi.id = pmi.menu_item_id
    WHERE pmi.party_menu_id = ? AND mi.is_active = 1 AND mi.selling_price > 0
  `).all(pm.id) as any[]).map(r => String(r.menu_item_id));
  if (ids.length === 0) return null;
  return { id: pm.id, name: pm.name, note: pm.note, itemIds: new Set(ids) };
}
