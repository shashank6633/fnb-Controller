import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { resolveDirectIssueBulk } from '@/lib/direct-issue';
import type { DirectIssueTarget } from '@/lib/direct-issue';
import { deptKey, deptOnHandBulk, type DeptOnHandResult } from '@/lib/dept-ledger';
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
 * Transfers add one read of the transfer legs and, only when there are any,
 * one more deptOnHandBulk for the receiving departments plus one name lookup.
 *
 * TRANSFERS (2026-10-14). A target whose material has moved between
 * departments carries `transfers`: what the destination handed on and every
 * other department now holding it by transfer, each with its own balance — see
 * TransfersOut. Display-only, never summed; absent when nothing was transferred.
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
  /** WHERE THE ROUTED KILOS WENT (2026-10-14). Present ONLY when this material
   *  has moved between departments — absent otherwise, so a building that has
   *  never transferred gets this payload key for key as before. */
  transfers?: TransfersOut;
}

/**
 * After Direct Issue books a delivery onto the destination (Kitchen), a
 * department → department transfer moves some of it on (Kitchen → Akan
 * Tandoori). The destination's own figure above then drops, and without this
 * block the kilos it handed on appeared nowhere on /inventory. Every figure is
 * RECIPE units and DISPLAY-ONLY — the same no-double-count law as the rest of
 * this route: the destination's balance already excludes what it handed on,
 * and each holder's balance is its own pool; none of them is ever added to
 * central or to each other.
 *
 * WINDOWED LIKE THE BALANCE. "Handed on" and each holder's "by transfer" are
 * summed over the window the ledger itself reads transfer legs in — since that
 * department's last count or opening row, or all of them when it was never
 * counted (never cut by the cutover floor; see windowOf below) — so they
 * describe the same stretch of time as the balance printed beside them, not an
 * all-time total that keeps growing after every count.
 */
interface TransfersOut {
  /** RECIPE units the destination handed to other departments, net of any
   *  handed back to it, inside its balance window. Positive = passed on. */
  passed_on: number;
  /** Every OTHER department that has received this material by transfer
   *  (visible to this user), largest first. */
  holders: Array<{
    department_id: string;
    department_name: string;
    /** RECIPE units. NULL — never 0 — when that department never counted it. */
    on_hand: number | null;
    never_counted: boolean;
    movements_since: number;
    /** RECIPE units received by transfer net of any handed on, inside that
     *  department's balance window. */
    by_transfer: number;
  }>;
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

        // ── WHERE THE ROUTED KILOS WENT ─────────────────────────────────────
        // One read of the transfer legs for the visible flagged materials (the
        // WHERE repeats the partial idx_dmt_transfer_ref predicate verbatim, so
        // SQLite can walk that index of transfer rows only). No transfer for a
        // material → no `transfers` key on it, and the loop below never runs.
        const legs = db.prepare(`
          SELECT department_id, material_id, quantity,
                 REPLACE(SUBSTR(created_at, 1, 19), 'T', ' ') AS at
            FROM department_material_transactions
           WHERE type IN ('transfer_out', 'transfer_in')
             AND material_id IN (SELECT value FROM json_each(?))
        `).all(JSON.stringify([...visible.keys()])) as Array<{
          department_id: string; material_id: string; quantity: number; at: string;
        }>;
        if (legs.length > 0) {
          const legsByMat = new Map<string, typeof legs>();
          const holderDepts = new Set<string>();
          for (const l of legs) {
            const matId = String(l.material_id);
            const list = legsByMat.get(matId);
            if (list) list.push(l); else legsByMat.set(matId, [l]);
            const t = visible.get(matId);
            if (!t || String(l.department_id) === t.departmentId) continue;
            // A holder this user may not see is LEFT OUT — fail closed, the same
            // visibility model the destination itself is held to above.
            if (mode === 'partial' && !(allowed && allowed.has(String(l.department_id)))) continue;
            holderDepts.add(String(l.department_id));
          }
          const holderBal = holderDepts.size > 0
            ? deptOnHandBulk(db, [...holderDepts], [...legsByMat.keys()])
            : new Map<string, DeptOnHandResult>();
          const names = new Map<string, string>();
          if (holderDepts.size > 0) {
            for (const d of db.prepare(`SELECT id, name FROM departments WHERE id IN (SELECT value FROM json_each(?))`)
              .all(JSON.stringify([...holderDepts])) as Array<{ id: string; name: string }>) {
              names.set(String(d.id), String(d.name || ''));
            }
          }
          // Signed transfer movement per (department, material) inside that
          // pair's TRANSFER-LEG window, which is the ledger's own rule
          // (dept-ledger.ts deptOnHand, "A TRANSFER PAIR IS NEVER SPLIT"): a
          // leg is bounded by its department's ANCHOR alone — the last count or
          // opening row — and never by the cutover floor; a never-counted pair
          // counts every leg. Strict `>` like the ledger. Every pair here has
          // at least one leg, so it always has a balance entry to read.
          const windowOf = (k: string): string => {
            const b = balances.get(k) || holderBal.get(k);
            return b && b.anchorAt ? String(b.anchorAt) : '';
          };
          const net = new Map<string, number>();
          for (const l of legs) {
            const k = deptKey(String(l.department_id), String(l.material_id));
            if (!(String(l.at) > windowOf(k))) continue;
            net.set(k, (net.get(k) || 0) + (Number(l.quantity) || 0));
          }
          const r6 = (n: number) => { const v = Math.round(n * 1e6) / 1e6; return v === 0 ? 0 : v; };
          for (const [materialId, matLegs] of legsByMat) {
            const t = visible.get(materialId);
            if (!t || !targets[materialId]) continue;
            const holders: TransfersOut['holders'] = [];
            const seen = new Set<string>();
            for (const l of matLegs) {
              const d = String(l.department_id);
              if (d === t.departmentId || seen.has(d) || !holderDepts.has(d)) continue;
              seen.add(d);
              const b = holderBal.get(deptKey(d, materialId));
              holders.push({
                department_id: d,
                department_name: names.get(d) || '',
                on_hand: b && !b.neverCounted ? b.onHand : null,
                never_counted: b ? b.neverCounted : true,
                movements_since: b ? b.movementsSince : 0,
                by_transfer: r6(net.get(deptKey(d, materialId)) || 0),
              });
            }
            holders.sort((a, b2) =>
              (Number(b2.on_hand ?? b2.by_transfer) || 0) - (Number(a.on_hand ?? a.by_transfer) || 0)
              || a.department_name.localeCompare(b2.department_name));
            targets[materialId].transfers = {
              // Out-legs are negative and in-legs positive, so −net is what
              // left the destination (net of anything handed back to it).
              passed_on: r6(-(net.get(deptKey(t.departmentId, materialId)) || 0)),
              holders,
            };
          }
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
