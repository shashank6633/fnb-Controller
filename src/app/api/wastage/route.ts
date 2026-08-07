import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { isStoreMappedMaterial } from '@/lib/store-engine';
import { postDeptLedger, deptOnHand } from '@/lib/dept-ledger';

/**
 * Wastages — Phase 1 §6 consumption channel.
 *
 * GET    /api/wastage?from=&to=&material_id=  → list with material name + recipe context
 * POST   /api/wastage                         → record a wastage entry
 *        body: { date, material_id, quantity (in recipe units), reason,
 *                recipe_id?, notes?, department_id? }
 * DELETE /api/wastage?id=X                    → admin only — reverses the rail + deletes tx + row
 *
 * Reasons: 'spoilage' | 'expiry' | 'damage' | 'overcooked' | 'spillage' | 'other'
 *
 * ── TWO RAILS, CHOSEN BY department_id ─────────────────────────────────────
 * Since the department-inventory cutover (2026-08) a gram leaves central
 * exactly once (at requisition issue) and leaves the department exactly once
 * (at consumption). Wastage is a consumption channel, so it has to answer
 * WHOSE shelf the spoiled goods were sitting on:
 *
 *   department_id SET   → the department already holds these grams, so the
 *                         DEPARTMENT ledger is debited and current_stock is
 *                         NOT touched. Debiting central here would remove the
 *                         same gram a SECOND time (it left central at issue)
 *                         and would inflate that department's apparent
 *                         variance by exactly the wasted quantity — the chef
 *                         would be blamed for goods he correctly binned.
 *
 *   department_id NULL  → the store found it rotten on its OWN shelf. Central
 *                         still holds it, so this is byte-for-byte today's
 *                         behaviour: current_stock − qty. The NULL branch is
 *                         deliberately preserved, not a legacy leftover.
 *
 * The inventory_transactions(type='wastage', −qty) row is written on BOTH
 * rails, unconditionally. That row is what the central Variance Report reads;
 * gating it on the rail would make wastage vanish from variance the day a chef
 * first tags a department. Do not fold it into either branch.
 *
 * Reasons this file is stricter than it looks — each of these is a rule a
 * future "simplification" would quietly delete:
 *   · THE NEGATIVE GUARD refuses; it never clamps. A clamp writes a wastage
 *     line for goods the department never held, which is stock invented out of
 *     nothing on a report whose entire job is to find missing stock.
 *   · THE LIQUOR CARVE-OUT. Store-mapped materials live on the TGBCL rail
 *     (store_stock_ledger / store_locations) and are skipped by both the
 *     central debit and the department credit at issue, so they never produce
 *     a department ledger row and can never have a department balance. A
 *     department wastage for one is refused rather than posted against a
 *     balance that structurally does not exist.
 *   · DELETE READS THE RAIL OFF THE STORED ROW, never off the request.
 */

const VALID_REASONS = new Set(['spoilage','expiry','damage','overcooked','spillage','other']);

/** Float slack for the on-hand comparison. Recipe units are grams/millilitres
 *  carried as REAL and the balance is a SUM of signed ledger rows, so a bare
 *  `qty > onHand` refuses "bin all 2 kg you hold" whenever the sum lands on
 *  1.9999999999999998. Same epsilon the issue clamps use. */
const EPS = 1e-9;

/** Trailing-zero-free quantity for an operator-facing message. */
const fmtQty = (n: number) => String(Math.round(n * 10000) / 10000);

/** A refusal the operator can act on — mapped to 400, not 500.
 *  Thrown from INSIDE the transaction so better-sqlite3 unwinds every write
 *  the handler had already made. Checking before the transaction instead would
 *  leave the guard and the insert in two different atomic units. */
class WastageBlocked extends Error {
  constructor(message: string) { super(message); this.name = 'WastageBlocked'; }
}

/**
 * NOTE ON READING THE BALANCE. The guard below calls deptOnHand() from
 * dept-ledger.ts — the ONE derivation of a department balance in this
 * codebase (anchor = latest closing count or cutover opening row, plus the
 * signed ledger movements since, floored at the cutover). Do NOT replace it
 * with a local SUM(quantity) or with department_materials.on_hand: the first
 * is a second derivation that drifts away from the Department Stock screen
 * the moment an anchor rule moves, and the second is an explicitly demoted
 * cache that no guard may decide on.
 *
 * onHand === null means NEVER COUNTED — no count and no opening row. That is
 * not zero, it is "unknown", and an unknown balance cannot prove a deduction
 * stays positive, so the guard refuses rather than assuming a base.
 */

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to');
    const matId = url.searchParams.get('material_id');
    const where: string[] = ['1=1']; const params: any[] = [];
    if (from)  { where.push('w.date >= ?'); params.push(from); }
    if (to)    { where.push('w.date <= ?'); params.push(to); }
    if (matId) { where.push('w.material_id = ?'); params.push(matId); }
    const outletId = await getCurrentOutletId();
    if (outletId) { where.push('(w.outlet_id = ? OR w.outlet_id IS NULL)'); params.push(outletId); }
    const rows = db.prepare(`
      SELECT w.*, rm.name AS material_name, rm.sku AS material_sku, rm.unit AS material_unit,
             COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS material_purchase_unit,
             COALESCE(rm.pack_size, 1) AS material_pack_size,
             rm.average_price, r.name AS recipe_name,
             d.name AS department_name,
             -- wastages.quantity is STORED in recipe units. The entry screen takes
             -- the number in the purchase unit (owner display rule) and does the
             -- pack conversion ONCE, client-side, before POST; POST is documented
             -- "quantity (in recipe units)" and hands that same number straight to
             -- raw_materials.current_stock on the central branch and to the
             -- department ledger on the other — both recipe-unit stores, so the
             -- ledger itself certifies the basis. rm.average_price is Rs per recipe
             -- unit by the house canon. Rs/g x g = the real rupee loss. Do NOT
             -- convert again here: the display columns selected above exist so the
             -- CLIENT can render the purchase-unit view off this recipe quantity.
             -- rate-basis: recipe (recipe-unit qty x Rs per recipe unit)
             (w.quantity * rm.average_price) AS value
      FROM wastages w
      JOIN raw_materials rm ON rm.id = w.material_id
      LEFT JOIN recipes r ON r.id = w.recipe_id
      LEFT JOIN departments d ON d.id = w.department_id
      WHERE ${where.join(' AND ')}
      ORDER BY w.date DESC, w.created_at DESC
    `).all(...params);
    return Response.json({ wastages: rows });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();
    const { date, material_id, quantity, reason, recipe_id, notes } = b;
    if (!date || !material_id || !quantity) {
      return Response.json({ error: 'date, material_id, quantity required' }, { status: 400 });
    }
    // Absent / blank / whitespace all mean the SAME thing — central rail. An
    // empty <select> posting '' must not be read as a department id.
    const deptId = String(b.department_id ?? '').trim() || null;
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return Response.json({ error: 'quantity must be > 0' }, { status: 400 });
    }
    const r = String(reason || 'spoilage').toLowerCase();
    if (!VALID_REASONS.has(r)) {
      return Response.json({ error: `reason must be one of ${[...VALID_REASONS].join(', ')}` }, { status: 400 });
    }
    // ── DEPARTMENT-RAIL PRE-FLIGHT ────────────────────────────────────────
    // Only reached when a department was named. The NULL path must stay
    // byte-for-byte what it was, so nothing here may run for it — including
    // the material lookup, which would newly 400 a material that today fails
    // on the foreign key instead.
    let deptName = '';
    let matUnit = '';
    if (deptId) {
      const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(deptId) as { id: string; name: string } | undefined;
      if (!dept) return Response.json({ error: 'Unknown department' }, { status: 400 });
      deptName = dept.name;

      const mat = db.prepare('SELECT name, unit FROM raw_materials WHERE id = ?').get(material_id) as { name: string; unit: string } | undefined;
      if (!mat) return Response.json({ error: 'Unknown material' }, { status: 400 });
      matUnit = mat.unit || '';

      // THE LIQUOR CARVE-OUT. Store-mapped materials never produce a
      // department ledger row (issue-stock skips both the central debit and
      // the department credit for them), so there is no department balance to
      // debit and never will be. Refuse loudly instead of posting against a
      // balance that structurally cannot exist. Do not "generalise" this away.
      if (isStoreMappedMaterial(db, material_id)) {
        return Response.json({
          error: `"${mat.name}" is a store-mapped (liquor) material — it is not held on the department raw-material rail. Record the loss on the Liquor Store, or leave the department blank to write it against Central Store.`,
        }, { status: 400 });
      }
    }

    const id = generateId();
    const outletId = await getCurrentOutletId();
    const txn = db.transaction(() => {
      if (deptId) {
        // GUARD FIRST, so a refusal costs nothing. It is inside the
        // transaction anyway: a throw unwinds every write below it.
        const { onHand } = deptOnHand(db, deptId, String(material_id));
        if (onHand === null) {
          throw new WastageBlocked(
            `${deptName} has no counted balance for this item yet, so its holding is unknown and a deduction cannot be proved valid. Take a closing count (or run the department cutover) first, or leave the department blank to record this against Central Store.`
          );
        }
        if (qty - onHand > EPS) {
          // REFUSE, never clamp. Clamping would write a wastage line for
          // goods the department never held — stock invented out of nothing,
          // on the exact report whose job is to find stock that went missing.
          throw new WastageBlocked(
            `${deptName} holds only ${fmtQty(onHand)} ${matUnit} of this item; cannot record ${fmtQty(qty)} ${matUnit} of wastage against it.`
          );
        }
      }

      db.prepare(`
        INSERT INTO wastages (id, date, material_id, quantity, reason, recipe_id, recorded_by, notes, outlet_id, department_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, date, material_id, qty, r, recipe_id || null, me.email, notes || '', outletId, deptId);

      if (deptId) {
        // The department already took this gram off central at issue. Debit
        // the DEPARTMENT and leave current_stock alone — touching it here is
        // the double-removal this whole cutover exists to prevent.
        postDeptLedger(db, {
          outletId: outletId ?? null,
          departmentId: deptId,
          materialId: String(material_id),
          type: 'wastage',
          quantity: -qty,
          referenceId: id,
          source: 'wastage',
          notes: `Wastage: ${r}${notes ? ' — ' + notes : ''}`,
          user: me.email,
        });
      } else {
        // Central still holds it — the store found it rotten on its own shelf.
        db.prepare(`UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now') WHERE id = ?`).run(qty, material_id);
      }

      // BOTH RAILS. The central Variance Report reads wastage out of
      // inventory_transactions; gating this on the rail would make wastage
      // disappear from variance the day a chef first tags a department.
      db.prepare(`
        INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at, outlet_id)
        VALUES (?, ?, 'wastage', ?, ?, ?, datetime('now'), ?)
      `).run(generateId(), material_id, -qty, id, `Wastage: ${r}${notes ? ' — ' + notes : ''}`, outletId);
    });
    try {
      txn();
    } catch (e: unknown) {
      // Only OUR refusal becomes a 400. Anything else is a genuine fault and
      // must keep falling through to the 500 handler — swallowing it here
      // would report a failed write as a successful one.
      if (e instanceof WastageBlocked) return Response.json({ error: e.message }, { status: 400 });
      throw e;
    }
    const wastage = db.prepare(`
      SELECT w.*, rm.name AS material_name, rm.unit AS material_unit, rm.average_price,
             -- Read-back of the row this handler just INSERTed with qty — the
             -- recipe-unit quantity POST validated above and handed to
             -- current_stock / postDeptLedger unchanged. Same pair, same proof as
             -- the GET projection; the two projections are kept identical on
             -- purpose so a refetched row matches the one just returned.
             -- rate-basis: recipe (recipe-unit qty x Rs per recipe unit)
             (w.quantity * rm.average_price) AS value
      FROM wastages w JOIN raw_materials rm ON rm.id = w.material_id
      WHERE w.id = ?
    `).get(id);
    return Response.json({ wastage }, { status: 201 });
  } catch (e: any) {
    console.error('[wastage POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    const db = getDb();
    const w = db.prepare('SELECT * FROM wastages WHERE id = ?').get(id) as any;
    if (!w) return Response.json({ error: 'Not found' }, { status: 404 });
    // WHICH RAIL IS READ OFF THE STORED ROW, NEVER OFF THE REQUEST. A caller
    // who could name the department here would have central's deduction
    // reversed into a department's ledger — grams appearing on a shelf that
    // never lost them. The row records where they actually went.
    const rowDeptId = String(w.department_id ?? '').trim() || null;
    const qty = Number(w.quantity) || 0;
    const txn = db.transaction(() => {
      // qty > 0 is enforced on POST, so the guard only catches a hand-edited
      // row; postDeptLedger refuses a zero movement outright and would 500.
      if (rowDeptId && Math.abs(qty) > EPS) {
        // Compensating row, not a deletion: the department ledger is
        // append-only so every issue, consumption and reversal stays
        // auditable. Typed 'adjustment' (+qty) rather than 'wastage' on
        // purpose — 'wastage' is a sign:'-' type that postDeptLedger refuses
        // to write positive, and for good reason: the sign is what the
        // balance sums but the TYPE is what the audit groups by, so a
        // positive 'wastage' row would read as more spoilage to anything
        // summing ABS(quantity). Same trap that split 'issued' from
        // 'issue_reversal'.
        postDeptLedger(db, {
          outletId: w.outlet_id ?? null,
          departmentId: rowDeptId,
          materialId: String(w.material_id),
          type: 'adjustment',
          quantity: qty,
          referenceId: id,
          source: 'wastage_delete',
          notes: `Deleted wastage (${w.reason}) — returned to department`,
          user: me.email,
        });
      } else {
        // Reverse the central stock deduction.
        db.prepare(`UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?`).run(qty, w.material_id);
      }
      // Deleted, not compensated — unlike the department ledger above. This
      // asymmetry is intentional: it is today's behaviour and the central
      // Variance Report nets on these rows, so leaving a +qty row behind
      // would double the correction. Do not "harmonise" the two.
      db.prepare(`DELETE FROM inventory_transactions WHERE type = 'wastage' AND reference_id = ?`).run(id);
      db.prepare(`DELETE FROM wastages WHERE id = ?`).run(id);
    });
    txn();
    return Response.json({ success: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
