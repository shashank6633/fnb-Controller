import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  postDeptLedger,
  deptOnHand,
  assertReversible,
  isDeptReversalBlocked,
} from '@/lib/dept-ledger';

/**
 * Post-party reconciliation of a department's on-hand materials.
 *
 * After a party the department reports how much of each transferred material is
 * LEFT OVER. Whatever is missing between what they HELD and what is left is
 * treated as CONSUMED. Optionally the leftover is RETURNED to the main store
 * instead of staying on the department's books.
 *
 * POST /api/department-materials/reconcile
 *   body: {
 *     department_id: string,
 *     event_name?: string,
 *     event_date?: string,
 *     items: [{ material_id, leftover_qty, return_to_store?: boolean }]
 *   }
 *
 * Per item (all quantities RECIPE units — the basis the whole dept rail speaks):
 *   held     = deptOnHand()  ← THE LEDGER, not department_materials.on_hand
 *   consumed = held − leftover
 *   • dept ledger 'consumed'  (−consumed)                    via postDeptLedger
 *   If return_to_store:
 *   • dept ledger 'returned'  (−leftover)                    via postDeptLedger
 *   • raw_materials.current_stock += leftover
 *   • store inventory_transactions row (+leftover, 'adjustment')
 *
 * ── WHY THIS ROUTE NO LONGER TOUCHES department_materials DIRECTLY ─────────
 * It used to UPDATE department_materials.on_hand itself and INSERT the ledger
 * row beside it, which made it a second writer of department stock. Since the
 * department-inventory cutover the ledger is the truth and the cache is a
 * derivative, so both go through postDeptLedger() — one writer, one pair of
 * writes, no way for the two to disagree.
 *
 * That also kills a quiet re-basing: the old code SET on_hand = leftover
 * (absolute). If the cache had drifted away from the ledger, the next reconcile
 * silently snapped it to whatever the operator typed and the drift vanished
 * without ever being seen. Posting DELTAS leaves any drift in place where
 * /api/department-ledger/check can name it.
 *
 * ── WHY AN OVER-RETURN IS REFUSED AND NOT CLAMPED ─────────────────────────
 * `consumed` was already floored at 0, but the central credit was not bounded
 * by anything the ledger knew: the only bound was `leftover` clamped against
 * the CACHE. A department holding 2 kg could therefore hand 3 kg back to
 * central — grams that never existed — and the clamp did it silently. A
 * reconcile that claims more leftover than the department holds is a broken
 * count or a stale screen, and both need a human, so the whole request is
 * refused (409) and the transaction rolls back. Do not "improve" this back
 * into a clamp: a clamp manufactures central stock and writes a line that
 * reads as if it balanced.
 *
 * ── PARTY MATERIALS ARE NOT CARVED OUT FOR LIQUOR, DELIBERATELY ───────────
 * The requisition rail skips store-mapped (TGBCL) materials on both legs.
 * The PARTY rail does not: applyPartyFulfillment() debits raw_materials for
 * every material it transfers, liquor included. The return credit must mirror
 * whatever the transfer debited, so if party-fulfillment.ts ever gains the
 * store-mapped carve-out, this route must gain it in the SAME commit —
 * otherwise a party takes liquor out of central and never gives it back.
 *
 * All writes run inside a single db.transaction.
 */
export const dynamic = 'force-dynamic';

/** Same tolerance and same 6-dp rounding as dept-ledger.ts, so a figure that
 *  passes the guard here cannot fail it there in the 15th decimal. */
const EPS = 1e-9;
const r6 = (n: number) => Math.round((Number(n) || 0) * 1e6) / 1e6;

type Db = ReturnType<typeof getDb>;

interface Held {
  /** RECIPE units. What the department can actually give up right now. */
  held: number;
  basis: 'count' | 'opening' | 'ledger';
  /** department_materials.on_hand. Reported so a drift can be NAMED in the
   *  refusal message. Never used to decide anything. */
  cache: number;
}

/**
 * What the department holds, by the ledger.
 *
 * The never-counted fallback (raw signed ledger sum) MUST stay identical to
 * assertReversible()'s fallback in dept-ledger.ts — two guards deciding the
 * same question by two rules is how a return gets refused here and allowed
 * there. Handoff filed to export one shared helper; until then, change both or
 * neither.
 */
function heldNow(db: Db, deptId: string, matId: string): Held {
  const bal = deptOnHand(db, deptId, matId);
  if (!bal.neverCounted) {
    return {
      held: r6(bal.onHand ?? 0),
      basis: bal.anchorSource === 'count' ? 'count' : 'opening',
      cache: bal.cacheOnHand,
    };
  }
  // No closing count and no cutover opening row — the ordinary state for a
  // party department. The defensible figure is what this rail put in minus
  // what it took out; NOT 0 (that would block every legitimate same-day
  // reconcile) and NOT the cache.
  const row = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS s
      FROM department_material_transactions
     WHERE department_id = ? AND material_id = ?
  `).get(deptId, matId) as { s: number } | undefined;
  return { held: r6(Number(row?.s) || 0), basis: 'ledger', cache: bal.cacheOnHand };
}

interface BlockedError extends Error { status: number; code: string; details: Record<string, unknown>; }
function blocked(message: string, details: Record<string, unknown>): BlockedError {
  const e = new Error(message) as BlockedError;
  e.status = 409;
  e.code = 'DEPT_HOLDING_EXCEEDED';
  e.details = details;
  return e;
}

/** Recipe units, trimmed of float noise, for an operator-facing message. */
const fmt = (n: number) => {
  const v = r6(n);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
};

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const departmentId: string = body?.department_id;
    const eventName: string = body?.event_name || '';
    const eventDate: string = body?.event_date || '';
    const items: Array<{ material_id: string; leftover_qty: number; return_to_store?: boolean }> =
      Array.isArray(body?.items) ? body.items : [];

    if (!departmentId) return Response.json({ error: 'department_id required' }, { status: 400 });
    if (items.length === 0) return Response.json({ error: 'No items to reconcile' }, { status: 400 });

    const db = getDb();

    // The outlet the department's holding was booked under. Read from the cache
    // row only because departments carries no outlet_id — it is a stamp on the
    // new rows, never an input to the balance.
    const selOutlet = db.prepare(`
      SELECT outlet_id FROM department_materials WHERE department_id = ? AND material_id = ?
    `);
    const incStock = db.prepare(`
      UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    const insStoreTx = db.prepare(`
      INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
      VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
    `);

    const note = `Party: ${eventName || '(unnamed)'} @ ${eventDate || ''}`.trim();
    const deptName = (db.prepare('SELECT name FROM departments WHERE id = ?').get(departmentId) as
      { name?: string } | undefined)?.name || 'This department';
    const results: Array<Record<string, unknown>> = [];

    const txn = db.transaction(() => {
      for (const it of items) {
        const materialId = it.material_id;
        if (!materialId) continue;

        const { held, basis, cache } = heldNow(db, departmentId, materialId);
        // 6 dp BEFORE the arithmetic: postDeptLedger stores r6, so an input
        // carrying more precision than that would leave the balance a hair off
        // the leftover it just recorded.
        const leftover = r6(Math.max(0, Number(it.leftover_qty) || 0));

        if (leftover > held + EPS) {
          const matName = (db.prepare('SELECT name FROM raw_materials WHERE id = ?').get(materialId) as
            { name?: string } | undefined)?.name || materialId;
          throw blocked(
            `Cannot record ${fmt(leftover)} leftover of ${matName}: ${deptName} holds only ` +
            `${fmt(held)}. Reload the page — the figure on screen may have changed — or record ` +
            `a department count first.`,
            {
              material_id: materialId, material_name: matName,
              department_id: departmentId, department_name: deptName,
              leftover, held, basis, cache_on_hand: cache,
            },
          );
        }

        const consumed = r6(Math.max(0, held - leftover));
        const returned = it.return_to_store ? leftover : 0;

        // The authority on grams leaving a department toward central lives in
        // dept-ledger, not here — so the actual return is put to it BEFORE
        // anything is written. It is checked against the same `held` this loop
        // read (nothing has been posted yet), so it cannot disagree with the
        // refusal above; it is kept because it is the shared rule, and a
        // future tightening of it must reach the party return too.
        if (returned > EPS) {
          assertReversible(db, { departmentId, materialId, qty: returned });
        }

        const outletId = (selOutlet.get(departmentId, materialId) as { outlet_id?: string } | undefined)
          ?.outlet_id || null;

        // 1) Consumption. Skipped when nothing was consumed: postDeptLedger
        //    refuses a zero movement, and a 0 g 'consumed' row teaches the
        //    audit that a department used nothing — noise the owner's log
        //    cannot act on.
        if (consumed > EPS) {
          postDeptLedger(db, {
            departmentId, materialId, type: 'consumed', quantity: -consumed,
            outletId, referenceId: null, source: 'party-reconcile',
            eventName, eventDate, notes: note, user: me.email,
          });
        }

        // 2) Return leftover to store — department down, central up, by the
        //    SAME number. Two movements, never one: the department ledger row
        //    and the central credit are what /api/department-ledger/check
        //    reconciles against each other.
        if (returned > EPS) {
          postDeptLedger(db, {
            departmentId, materialId, type: 'returned', quantity: -returned,
            outletId, referenceId: null, source: 'party-reconcile',
            eventName, eventDate, notes: 'party leftover return', user: me.email,
          });
          incStock.run(returned, materialId);
          insStoreTx.run(generateId(), materialId, returned, null, 'party leftover return');
        }

        results.push({
          material_id: materialId,
          on_hand_before: held,          // kept: the old key the screen may read
          held_before: held,
          held_basis: basis,
          cache_on_hand_before: cache,
          consumed,
          leftover: it.return_to_store ? 0 : leftover,
          returned,
        });
      }
    });
    txn();

    return Response.json({ ok: true, reconciled: results, count: results.length });
  } catch (e: unknown) {
    // A blocked reconcile is an operator-answerable 409, not a 500: nothing was
    // written (better-sqlite3 rolled the transaction back on the throw) and the
    // message names the quantity the department actually holds.
    if (isDeptReversalBlocked(e)) {
      console.warn('[department-materials reconcile] blocked:', e.message);
      return Response.json({
        error: e.message, code: e.code,
        details: {
          material_id: e.materialId, material_name: e.materialName,
          department_id: e.departmentId, department_name: e.departmentName,
          requested: e.requested, available: e.available, consumed_since: e.consumedSince,
        },
      }, { status: 409 });
    }
    const err = e as Partial<BlockedError> | undefined;
    if (err?.status === 409) {
      console.warn('[department-materials reconcile] blocked:', err.message);
      return Response.json({ error: err.message, code: err.code, details: err.details }, { status: 409 });
    }
    console.error('[department-materials reconcile]', e);
    return Response.json({ error: err?.message || 'Failed' }, { status: 500 });
  }
}
