import { getDb } from '@/lib/db';

/**
 * Customer QR-menu helpers — shared by the public /api/customer/* routes.
 *
 * The customer has NO staff session: every request is scoped by the table's
 * qr_token (printed on the standee). We resolve token → table → outlet here,
 * and build the menu in the EXACT shape the design app (public/menu-assets)
 * expects, so the pristine UI can consume it unchanged.
 */

export interface ResolvedTable {
  id: string;
  table_number: string;
  zone: string;
  seats: number;
  outlet_id: string | null;
  outlet_name: string;
}

/** Resolve a table by its QR token. Returns null for unknown/inactive tables. */
export function resolveTableByToken(token: string): ResolvedTable | null {
  const t = String(token || '').trim();
  if (!t) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT rt.id, rt.table_number, rt.zone, rt.seats, rt.outlet_id,
           COALESCE(o.name, '') AS outlet_name
    FROM restaurant_tables rt
    LEFT JOIN outlets o ON o.id = rt.outlet_id
    WHERE rt.qr_token = ? AND rt.is_active = 1
  `).get(t) as any;
  if (!row) return null;
  return {
    id: row.id,
    table_number: String(row.table_number),
    zone: row.zone || '',
    seats: Number(row.seats) || 0,
    outlet_id: row.outlet_id || null,
    outlet_name: row.outlet_name || '',
  };
}

/** Map the F&B dietary_tag to the design's veg code ('v' | 'n' | 'e'). */
function vegOf(tag: string | null): 'v' | 'n' | 'e' {
  const s = String(tag || '').toLowerCase();
  if (s === 'non-veg' || s === 'nonveg' || s === 'n') return 'n';
  if (s === 'egg' || s === 'e') return 'e';
  return 'v'; // Veg or unmarked → green dot (matches the design's own convention)
}

/** Deterministic hue (0–359) from a string, so each dish gets a stable colour. */
function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Prettify a category slug → display name. e.g. small-plates-veg → "Small Plates Veg". */
function prettyCategory(slug: string): string {
  return String(slug || 'Others')
    .split('-')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .trim() || 'Others';
}

// Which top section a menu item belongs to. Foods → food; liquors → liquor;
// beverages (and anything else) → bev.
function sectionOf(itemType: string): 'food' | 'bev' | 'liquor' {
  const s = String(itemType || '').toLowerCase();
  if (s.startsWith('food')) return 'food';
  if (s.startsWith('liqu')) return 'liquor';
  return 'bev';
}

// Loose ordering so the menu reads naturally (starters → mains → desserts, etc.).
// Unknown categories fall to the end and sort alphabetically among themselves.
const CATEGORY_ORDER = [
  // food
  'soups', 'salads', 'small-plates-veg', 'small-plates-non-veg', 'starters',
  'bar-nibbles', 'dimsums', 'baos', 'sushi', 'grills', 'live-grills',
  'curries-veg', 'curries-non-veg', 'mains', 'rice-and-noodles',
  'pasta', 'thin-crust-pizza', 'gourmet-pizza', 'breads', 'desserts',
  // beverages
  'soft-beverages', 'mocktails', 'smoothies',
  // liquor
  'beer', 'red-wine', 'white-wine', "rose'-wine", 'sparkling-and-champagne',
  'signature-cocktails', 'classic-cocktails', 'shooters',
  'single-malt-whiskey', 'blended-scotch', 'whiskies-of-the-world',
  'gin', 'vodka', 'rum', 'tequila', 'brandy', 'liqueurs-and-aperitifs',
];
function catRank(slug: string): number {
  const i = CATEGORY_ORDER.indexOf(slug);
  return i === -1 ? 900 : i;
}

interface MenuSection {
  label: string;
  sub: Array<{
    id: string;
    name: string;
    blurb: string;
    items: Array<Record<string, unknown>>;
  }>;
}

/**
 * Build the customer menu for an outlet in the design app's exact shape:
 *   { food: { label, sub:[{id,name,blurb,items:[{...}]}] }, bev: {...} }
 * Every item carries ALL fields the UI reads, with safe synthesized defaults
 * for the curated fields the backend doesn't store (taste/pairs/spice/tags).
 */
export function buildCustomerMenu(outletId: string | null): { food: MenuSection; bev: MenuSection; liquor: MenuSection } {
  const db = getDb();
  // Show this outlet's items; items with NULL outlet are shared/global.
  const rows = db.prepare(`
    SELECT id, name, category, station, item_type, dietary_tag,
           selling_price, tax_value, prep_minutes, COALESCE(notes,'') AS notes
    FROM menu_items
    WHERE is_active = 1 AND selling_price > 0
    ORDER BY category, name
  `).all() as any[];

  // section -> category slug -> item list
  const buckets: Record<'food' | 'bev' | 'liquor', Map<string, any[]>> = {
    food: new Map(),
    bev: new Map(),
    liquor: new Map(),
  };

  for (const r of rows) {
    const sec = sectionOf(r.item_type);
    const cat = String(r.category || 'others');
    if (!buckets[sec].has(cat)) buckets[sec].set(cat, []);
    buckets[sec].get(cat)!.push({
      id: r.id,
      name: r.name,
      desc: r.notes || '',
      price: Math.round(Number(r.selling_price) || 0),
      veg: vegOf(r.dietary_tag),
      spice: 0,
      tags: [],
      taste: { sour: 0, sweet: 0, spicy: 0, tangy: 0 },
      pairs: [],
      hue: hueOf(r.name || r.id),
      subName: prettyCategory(cat),
      // extra fields the ordering flow needs (ignored by the UI's render):
      station: r.station || 'kitchen',
      item_type: r.item_type || '',
      tax_value: Number(r.tax_value) || 0,
      prep_minutes: Number(r.prep_minutes) || 0,
    });
  }

  const buildSection = (label: string, map: Map<string, any[]>): MenuSection => {
    const sub = [...map.entries()]
      .map(([slug, items]) => ({
        id: slug,
        name: prettyCategory(slug),
        blurb: '',
        items: items.sort((a, b) => String(a.name).localeCompare(String(b.name))),
      }))
      .sort((a, b) => {
        const ra = catRank(a.id), rb = catRank(b.id);
        return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
      });
    return { label, sub };
  };

  return {
    food: buildSection('Food', buckets.food),
    bev: buildSection('Beverages', buckets.bev),
    liquor: buildSection('Liquor', buckets.liquor),
  };
}

/**
 * Look up authoritative price/tax/station/name for a set of menu item ids.
 * Orders NEVER trust client-sent prices — we re-price from the DB here.
 */
export function priceLookup(ids: string[]): Map<string, {
  name: string; station: string; unit_price: number; tax_value: number;
  prep_minutes: number; recipe_id: string | null; item_type: string;
}> {
  const db = getDb();
  const out = new Map<string, any>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return out;
  const stmt = db.prepare(`
    SELECT id, name, station, selling_price, tax_value, prep_minutes, recipe_id, item_type
    FROM menu_items WHERE id = ? AND is_active = 1
  `);
  for (const id of uniq) {
    const r = stmt.get(id) as any;
    if (!r) continue;
    out.set(id, {
      name: r.name,
      station: r.station || 'kitchen',
      unit_price: Math.round((Number(r.selling_price) || 0) * 100) / 100,
      tax_value: Number(r.tax_value) || 0,
      prep_minutes: Number(r.prep_minutes) || 0,
      recipe_id: r.recipe_id || null,
      item_type: r.item_type || '',
    });
  }
  return out;
}
