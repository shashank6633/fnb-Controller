'use client';

/**
 * Client menu cache — the Captain order screen's biggest fetch is /api/menu-items
 * (the full dish list, which changes rarely). Caching it in localStorage lets the
 * order page paint the menu INSTANTLY on repeat opens (stale-while-revalidate:
 * show the cached copy, then refresh in the background). Best-effort; never throws.
 */
export interface CachedMenu { items: any[]; categories: string[] }

const KEY = 'akan_menu_cache_v1';

export function readMenuCache(): CachedMenu | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !Array.isArray(o.items)) return null;
    return { items: o.items, categories: Array.isArray(o.categories) ? o.categories : [] };
  } catch { return null; }
}

export function writeMenuCache(items: any[], categories: any[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      items: Array.isArray(items) ? items : [],
      categories: Array.isArray(categories) ? categories : [],
      at: Date.now(),
    }));
  } catch { /* quota/unavailable — fine, we just re-fetch next time */ }
}
