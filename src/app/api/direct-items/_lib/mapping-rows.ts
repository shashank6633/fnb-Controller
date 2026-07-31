/**
 * The full sold-item → menu-item → raw-material chain, resolved once and shared
 * by the Direct Items GET (screen) and export (CSV) routes. (Private `_lib`
 * folder — not a route.)
 *
 * THE CHAIN, and why both ends matter
 * ───────────────────────────────────
 * A row on this report is a sold ITEM NAME. It has two independent links:
 *
 *   item name ──► MENU ITEM(S)   menu_items.pos_id = sales.pos_item_id  (strong)
 *                                LOWER(menu_items.name) = LOWER(item_name)
 *   item name ──► RAW MATERIAL   direct_item_links.material_id
 *                                menu_items.material_id (fallback)
 *
 * The POS id is the stronger signal because it survives a menu rename; the name
 * match is what catches POS-only variants that were never renamed. Either link
 * can be MISSING, and a missing link is the actionable state — a mapping with no
 * material costs nothing on paper, and a mapping with no menu item will never be
 * reached by the POS.
 *
 * UNIT BASIS: every quantity that leaves here is the STORED RECIPE figure, and
 * is labelled as such (`*_recipe`), carried alongside the material's pack meta
 * (unit / purchase_unit / pack_size / case_size) so the display layer can lead
 * with the PURCHASE unit via '@/lib/pack-units'. Nothing is pre-converted here:
 * a rounded purchase figure must never be the number anything else computes on.
 *
 * NEVER reads raw_materials.last_purchase_price — it is stored in mixed bases
 * and is wrong on 105 rows. average_price (₹ per RECIPE unit) is the honest one.
 */
import type { Database } from 'better-sqlite3';

/** A raw material, with everything the pack-unit display layer needs. */
export interface MaterialRef {
  material_id: string;
  material_name: string;
  sku: string;
  /** RECIPE unit (the stored basis for current_stock / average_price). */
  unit: string;
  purchase_unit: string;
  pack_size: number;
  case_size: number;
  /** ₹ per RECIPE unit. */
  average_price: number;
  /** RECIPE units. */
  current_stock: number;
}

export interface MenuItemRef {
  id: string;
  name: string;
  category: string;
  pos_id: string;
  material_id: string | null;
  is_active: boolean;
  /** Which signal found it. 'pos_id' is the stronger one. */
  matched_by: 'pos_id' | 'name';
}

export const nameKey = (s: unknown) => String(s ?? '').trim().toLowerCase();

/* ── materials ───────────────────────────────────────────────────────────── */

export interface MaterialIndex {
  byId: Map<string, MaterialRef>;
  /** Lower-cased trimmed name → ids. A list, because a duplicate name must be
   *  reported as ambiguous on import rather than resolved by picking one. */
  byName: Map<string, string[]>;
  /** Exact SKU → id. */
  bySku: Map<string, string>;
}

export function loadMaterialIndex(db: Database): MaterialIndex {
  const rows = db.prepare(`
    SELECT id, name, COALESCE(sku, '') AS sku, unit,
           COALESCE(purchase_unit, '') AS purchase_unit,
           COALESCE(pack_size, 1) AS pack_size,
           COALESCE(case_size, 1) AS case_size,
           COALESCE(average_price, 0) AS average_price,
           COALESCE(current_stock, 0) AS current_stock
      FROM raw_materials
  `).all() as any[];
  const byId = new Map<string, MaterialRef>();
  const byName = new Map<string, string[]>();
  const bySku = new Map<string, string>();
  for (const r of rows) {
    const ref: MaterialRef = {
      material_id: r.id,
      material_name: r.name,
      sku: String(r.sku || ''),
      unit: String(r.unit || ''),
      purchase_unit: String(r.purchase_unit || ''),
      pack_size: Number(r.pack_size) || 1,
      case_size: Number(r.case_size) || 1,
      average_price: Number(r.average_price) || 0,
      current_stock: Number(r.current_stock) || 0,
    };
    byId.set(ref.material_id, ref);
    const k = nameKey(ref.material_name);
    if (k) byName.set(k, [...(byName.get(k) || []), ref.material_id]);
    const s = ref.sku.trim();
    if (s) bySku.set(s, ref.material_id);
  }
  return { byId, byName, bySku };
}

/* ── menu items ──────────────────────────────────────────────────────────── */

export interface MenuIndex {
  byName: Map<string, MenuItemRef[]>;
  byPosId: Map<string, MenuItemRef[]>;
}

export function loadMenuIndex(db: Database): MenuIndex {
  const rows = db.prepare(`
    SELECT id, name, COALESCE(category, '') AS category, COALESCE(pos_id, '') AS pos_id,
           material_id, COALESCE(is_active, 1) AS is_active
      FROM menu_items
  `).all() as any[];
  const byName = new Map<string, MenuItemRef[]>();
  const byPosId = new Map<string, MenuItemRef[]>();
  for (const r of rows) {
    const base = {
      id: r.id, name: r.name, category: String(r.category || ''),
      pos_id: String(r.pos_id || ''), material_id: r.material_id || null,
      is_active: !!r.is_active,
    };
    const k = nameKey(r.name);
    if (k) byName.set(k, [...(byName.get(k) || []), { ...base, matched_by: 'name' }]);
    const p = String(r.pos_id || '').trim();
    if (p) byPosId.set(p, [...(byPosId.get(p) || []), { ...base, matched_by: 'pos_id' }]);
  }
  return { byName, byPosId };
}

/**
 * Menu items for one sold item name. POS id first (it survives a rename), then
 * the name match; the two are merged by menu-item id so an item found both ways
 * appears once, credited to the stronger signal.
 */
export function resolveMenuItems(idx: MenuIndex, itemName: string, posItemId?: string | null): MenuItemRef[] {
  const out = new Map<string, MenuItemRef>();
  const pos = String(posItemId || '').trim();
  if (pos) for (const m of idx.byPosId.get(pos) || []) out.set(m.id, m);
  for (const m of idx.byName.get(nameKey(itemName)) || []) if (!out.has(m.id)) out.set(m.id, m);
  return [...out.values()];
}

/* ── the full mapping list (export) ──────────────────────────────────────── */

export interface MappingRow {
  item_name: string;
  /** true when direct_item_links has a row for this name. */
  has_saved_mapping: boolean;
  /** Where the raw-material link came from. */
  link_source: 'direct_item_links' | 'menu_items' | null;
  material: MaterialRef | null;
  qty_per_unit: number;
  dismissed: boolean;
  reviewed: boolean;
  updated_at: string | null;
  menu_items: MenuItemRef[];
  /** Sales in the whole table (not windowed) — context only, ignored on import. */
  qty_sold: number;
  revenue: number;
  sales_rows: number;
  pos_category: string;
  pos_item_id: string;
  /** No sales rows at all for this name. */
  no_sales: boolean;
}

export interface BuildOptions {
  /** Sold items below this are not added as *unmapped candidates*. Saved
   *  mappings are ALWAYS included whatever they sold — that is the whole bug. */
  minSold?: number;
  /** Only rows that already have a saved mapping. */
  mappedOnly?: boolean;
}

/**
 * EVERY mapping, plus (unless mappedOnly) the sold items still waiting for one.
 *
 * Built from the UNION of three sources rather than from `sales` alone. The
 * screen's discovery query starts FROM sales and then narrows by min_sold and by
 * POS category, which is right for "what still needs mapping?" and catastrophic
 * as an export: on this database 210 of 415 saved links have no sales rows at
 * all and another 32 sold fewer than five, so a sales-driven export would hand
 * the owner a file that silently drops over half of their own work — and
 * re-uploading it would look like nothing was ever saved.
 */
export function buildMappingRows(db: Database, opts: BuildOptions = {}): MappingRow[] {
  const minSold = Number.isFinite(Number(opts.minSold)) ? Number(opts.minSold) : 5;
  const mats = loadMaterialIndex(db);
  const menu = loadMenuIndex(db);

  const sales = db.prepare(`
    SELECT item_name,
           SUM(quantity_sold) AS qty_sold,
           SUM(total_revenue) AS revenue,
           COUNT(*)           AS sales_rows,
           MAX(category)      AS category,
           MAX(pos_item_id)   AS pos_item_id
      FROM sales
     WHERE item_name IS NOT NULL AND TRIM(item_name) != '' AND TRIM(item_name) != '-'
     GROUP BY item_name
  `).all() as any[];
  const salesByName = new Map<string, any>();
  for (const s of sales) salesByName.set(nameKey(s.item_name), s);

  const links = db.prepare(`
    SELECT item_name, material_id, COALESCE(qty_per_unit, 1) AS qty_per_unit,
           COALESCE(dismissed, 0) AS dismissed, COALESCE(reviewed, 0) AS reviewed, updated_at
      FROM direct_item_links
  `).all() as any[];
  const linkByName = new Map<string, any>();
  for (const l of links) linkByName.set(nameKey(l.item_name), l);

  // Display name per key — prefer the saved mapping's spelling (it is what the
  // PRIMARY KEY holds), then the POS spelling, then the menu spelling.
  const names = new Map<string, string>();
  const remember = (raw: string, strong: boolean) => {
    const k = nameKey(raw);
    if (!k) return;
    if (strong || !names.has(k)) names.set(k, String(raw).trim());
  };
  for (const l of links) remember(l.item_name, true);
  for (const s of sales) {
    const k = nameKey(s.item_name);
    if (linkByName.has(k) || Number(s.qty_sold) >= minSold) remember(s.item_name, false);
  }
  // Menu items already carrying a material_id are mappings too, even when no
  // direct_item_links row was ever written for them.
  for (const list of menu.byName.values()) {
    for (const m of list) if (m.material_id) remember(m.name, false);
  }

  const out: MappingRow[] = [];
  for (const [k, displayName] of names) {
    const link = linkByName.get(k) || null;
    if (opts.mappedOnly && !link) continue;
    const s = salesByName.get(k) || null;
    const menuItems = resolveMenuItems(menu, displayName, s?.pos_item_id);

    let materialId: string | null = link?.material_id || null;
    let linkSource: MappingRow['link_source'] = materialId ? 'direct_item_links' : null;
    if (!materialId) {
      const fromMenu = menuItems.find(m => m.material_id)?.material_id || null;
      if (fromMenu) { materialId = fromMenu; linkSource = 'menu_items'; }
    }

    out.push({
      item_name: displayName,
      has_saved_mapping: !!link,
      link_source: linkSource,
      material: materialId ? (mats.byId.get(materialId) || null) : null,
      qty_per_unit: Number(link?.qty_per_unit) > 0 ? Number(link.qty_per_unit) : 1,
      dismissed: !!link?.dismissed,
      reviewed: !!link?.reviewed,
      updated_at: link?.updated_at || null,
      menu_items: menuItems,
      qty_sold: Number(s?.qty_sold) || 0,
      revenue: Number(s?.revenue) || 0,
      sales_rows: Number(s?.sales_rows) || 0,
      pos_category: String(s?.category || ''),
      pos_item_id: String(s?.pos_item_id || ''),
      no_sales: !s,
    });
  }

  out.sort((a, b) => a.item_name.localeCompare(b.item_name, 'en', { sensitivity: 'base' }));
  return out;
}
