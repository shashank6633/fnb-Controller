/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Upsell suggestions — "often ordered with" for the Captain order screen.
 *
 * GET /api/dine-in/upsell?item_ids=a,b,c   (signed-in)
 *   → { items: [{ menu_item_id, name, price, times_together }] }  (top 4)
 *
 * Co-occurrence is mined from order history: for the menu_item_ids in the cart,
 * find OTHER menu items that most frequently appear in the same orders
 * (order_items self-join, min 3 shared orders per pair). Items already in the
 * cart are excluded; only active, priced menu items are returned so a tapped
 * chip adds exactly like the menu grid does.
 *
 * The pair matrix can be heavy on a big history, so it is cached in-process
 * for 10 minutes (module-level — resets on redeploy, which is fine).
 */
export const dynamic = 'force-dynamic';

const MIN_CO_OCCURRENCES = 3;
const CACHE_TTL_MS = 10 * 60 * 1000;

type PairList = { other: string; n: number }[];
let pairCache: { at: number; pairs: Map<string, PairList> } | null = null;

function getPairMatrix(db: any): Map<string, PairList> {
  if (pairCache && Date.now() - pairCache.at < CACHE_TTL_MS) return pairCache.pairs;

  // One row per unordered item pair (x < y) with the number of DISTINCT orders
  // both appeared in. DISTINCT guards against the same item on multiple lines
  // of one order (different notes) inflating the count.
  const rows = db.prepare(`
    SELECT a.menu_item_id AS x, b.menu_item_id AS y, COUNT(DISTINCT a.order_id) AS n
    FROM order_items a
    JOIN order_items b
      ON b.order_id = a.order_id
     AND b.menu_item_id > a.menu_item_id
    WHERE a.menu_item_id IS NOT NULL AND a.menu_item_id != ''
      AND b.menu_item_id IS NOT NULL AND b.menu_item_id != ''
    GROUP BY a.menu_item_id, b.menu_item_id
    HAVING COUNT(DISTINCT a.order_id) >= ${MIN_CO_OCCURRENCES}
  `).all() as { x: string; y: string; n: number }[];

  const pairs = new Map<string, PairList>();
  const push = (k: string, other: string, n: number) => {
    const list = pairs.get(k);
    if (list) list.push({ other, n }); else pairs.set(k, [{ other, n }]);
  };
  for (const r of rows) { push(r.x, r.y, r.n); push(r.y, r.x, r.n); }

  pairCache = { at: Date.now(), pairs };
  return pairs;
}

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const raw = new URL(request.url).searchParams.get('item_ids') || '';
    const cartIds = Array.from(new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)));
    if (cartIds.length === 0) return Response.json({ items: [] });

    const db = getDb();
    const pairs = getPairMatrix(db);
    const inCart = new Set(cartIds);

    // Sum co-occurrence counts across every cart item, excluding the cart itself.
    const scores = new Map<string, number>();
    for (const idInCart of cartIds) {
      for (const { other, n } of pairs.get(idInCart) || []) {
        if (inCart.has(other)) continue;
        scores.set(other, (scores.get(other) || 0) + n);
      }
    }
    if (scores.size === 0) return Response.json({ items: [] });

    // Resolve against the LIVE menu (not the cached matrix) so deactivated or
    // unpriced items never surface; keep the top 4.
    const miStmt = db.prepare('SELECT id, name, selling_price, is_active FROM menu_items WHERE id = ?');
    const items: { menu_item_id: string; name: string; price: number; times_together: number }[] = [];
    for (const [mid, n] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
      const mi = miStmt.get(mid) as any;
      if (!mi || !mi.is_active || !(mi.selling_price > 0)) continue;
      items.push({ menu_item_id: mid, name: mi.name, price: mi.selling_price, times_together: n });
      if (items.length >= 4) break;
    }
    return Response.json({ items });
  } catch (e: any) {
    console.error('[/api/dine-in/upsell]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
