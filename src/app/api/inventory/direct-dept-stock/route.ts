import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { resolveDirectIssueBulk } from '@/lib/direct-issue';
import type { DirectIssueTarget } from '@/lib/direct-issue';
import { deptKey, deptOnHandBulk } from '@/lib/dept-ledger';
import { allowedDeptSetExpanded, canSeeAllDeptStock } from '@/lib/dept-stock';

/**
 * GET /api/inventory/direct-dept-stock
 *
 * For every DIRECT-FLAGGED material (Settings → Direct Issue: item rule or
 * category rule, resolved through src/lib/direct-issue.ts), the destination
 * department and the balance that department currently HOLDS — so the Raw
 * Materials page can print "Central 0 PKT · Main Kitchen 4 PKT".
 *
 * WHY A SEPARATE ROUTE, NOT A FIELD ON /api/inventory. Two reasons, both load-
 * bearing:
 *   1. /api/inventory is read by 22 surfaces and (by design) answers even when
 *      getCurrentUser() is null — embedding department figures there would hand
 *      them to every tier and to cookie-less GETs. This route inherits the
 *      /api/stock-on-hand access model instead: 401 unauthenticated, and the
 *      department rail is scoped by canSeeAllDeptStock / allowedDeptSetExpanded.
 *   2. Keeping /api/inventory byte-identical means its 22 readers cannot be
 *      disturbed, byte-for-byte, by this feature.
 *
 * NO DOUBLE COUNT (the owner's law). Everything here is DISPLAY-ONLY context:
 * the central figure (raw_materials.current_stock) and the department figure
 * are two different pools and are never summed — not here, not on the page.
 * Nothing in this route writes, and nothing reads department_materials.on_hand
 * (the cache is display/drift-only); balances come from deptOnHandBulk, the ONE
 * trusted department-balance derivation (anchor count/opening + ledger window).
 *
 * BASIS. on_hand / movements_since are RECIPE units — the stored basis, same
 * convention as /api/stock-on-hand. The page already holds each material's pack
 * meta and converts ONCE through the pack-units layer to lead with the
 * purchase unit.
 *
 * NULL IS NOT ZERO. on_hand is null (never_counted true) when the department
 * has no closing count and no cutover opening row for the material — the
 * balance is unknown, not zero. movements_since still reports uncounted ledger
 * activity so the UI can hint at it without claiming a balance.
 *
 * SCOPE. mode 'all' → every flagged material; 'partial' → only materials whose
 * destination department the user may see (allowedDeptSetExpanded); 'none' →
 * empty targets. Fail CLOSED: any error is a 500 and the page falls back to
 * rendering exactly what it rendered before this feature existed.
 *
 * COST. Bounded statements regardless of catalogue size (~1,000 materials):
 * one id scan + resolveDirectIssueBulk (1 rules read + chunked category reads)
 * + deptOnHandBulk (4 statements for the whole dept×material matrix). No N+1.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface TargetOut {
  department_id: string;
  department_name: string;
  /** Which rule matched — a material rule beats a category rule. */
  via: 'material' | 'category';
  /** RECIPE units. NULL — never 0 — when the pair was never counted. */
  on_hand: number | null;
  never_counted: boolean;
  /** RECIPE units. Signed ledger movement in the window; informational. */
  movements_since: number;
}

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();

    const t0 = performance.now();

    // Resolve rules over the whole catalogue (never `sub:` rows — those live in
    // sub_recipes, have no raw_materials row and can never be flagged).
    const ids = (db.prepare('SELECT id FROM raw_materials').all() as Array<{ id: string }>)
      .map((r) => String(r.id));
    const resolved = resolveDirectIssueBulk(db, ids);

    // Department visibility — the /api/stock-on-hand model, fail closed.
    let mode: 'all' | 'partial' | 'none';
    let allowed: Set<string> | null = null;
    if (canSeeAllDeptStock(me)) {
      mode = 'all';
    } else {
      const list = allowedDeptSetExpanded(db, me);
      if (list.length === 0) {
        mode = 'none';
      } else {
        mode = 'partial';
        allowed = new Set(list);
      }
    }

    const targets: Record<string, TargetOut> = {};
    if (mode !== 'none' && resolved.size > 0) {
      const visible = new Map<string, DirectIssueTarget>();
      for (const [materialId, t] of resolved) {
        if (mode === 'all' || (allowed && allowed.has(t.departmentId))) visible.set(materialId, t);
      }
      if (visible.size > 0) {
        const deptIds = [...new Set([...visible.values()].map((t) => t.departmentId))];
        const balances = deptOnHandBulk(db, deptIds, [...visible.keys()]);
        for (const [materialId, t] of visible) {
          // A pair with no anchor, no movement and no cache row has no map entry
          // at all — that IS the never-counted case, synthesised here so a
          // flagged material always answers (the flag itself is information).
          const b = balances.get(deptKey(t.departmentId, materialId));
          targets[materialId] = {
            department_id: t.departmentId,
            department_name: t.departmentName,
            via: t.via,
            on_hand: b && !b.neverCounted ? b.onHand : null,
            never_counted: b ? b.neverCounted : true,
            movements_since: b ? b.movementsSince : 0,
          };
        }
      }
    }

    return Response.json({
      as_of: new Date().toISOString(),
      /** on_hand / movements_since are RECIPE units. The client converts once. */
      basis: 'recipe',
      dept_scope: { mode },
      /** Server-side cost of resolve + balances, ms. Diagnostic only. */
      query_ms: Math.round((performance.now() - t0) * 100) / 100,
      targets,
    });
  } catch (e: any) {
    console.error('[direct-dept-stock]', e);
    return Response.json({ error: e?.message || 'Failed to read direct-issue department stock' }, { status: 500 });
  }
}
