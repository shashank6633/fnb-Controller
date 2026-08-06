/**
 * Variance approval workflow.
 *
 * A closing physical count that disagrees with the system NEVER changes stock on
 * its own. Instead it creates a PENDING `variance_approvals` row. An admin then
 * reviews it (records the staff's reason) and either:
 *   - APPROVES  → the counted DELTA is posted to the rail the count belongs to,
 *                 and logged (central: inventory_transactions; liquor: a
 *                 store_stock_ledger movement; department: a signed
 *                 department_material_transactions 'adjustment').
 *   - REJECTS   → nothing moves on any rail; the variance stands as an open loss
 *                 to investigate (theft / spillage / miscount).
 *
 * A DELTA, NEVER AN ABSOLUTE SET. This is the whole shape of the file and the
 * one thing not to "simplify" back. An approval is deferred by hours — the count
 * happens at 10am and the admin clears the queue at 4pm — and stock keeps moving
 * in between. `SET current_stock = physical_stock` (what this used to do) writes
 * the 10am shelf over the 4pm book, so a noon issue of 40 kg to a kitchen is
 * silently un-issued: central gets it back on paper while the department still
 * physically holds it, and the same 40 kg then exists twice. Posting
 * (physical − system-at-count-time) instead leaves every movement made after the
 * count standing, which is the only reading under which stock moves exactly once.
 *
 * THREE RAILS, AND A COUNT ONLY EVER TOUCHES ITS OWN:
 *   source='liquor'                  → store_stock_ledger  (TGBCL store rail)
 *   source='central', dept = ''      → raw_materials.current_stock (central store)
 *   source='central', dept = <id>    → department_material_transactions
 * A department count must never reach central and a central count must never
 * reach a department. Crossing them is the "department clobber" that
 * varianceApprovalBlock() has guarded since the queue shipped.
 */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import { postLedger, isStoreMappedMaterial } from '@/lib/store-engine';
import { deptOnHand, postDeptLedger } from '@/lib/dept-ledger';

export type VarianceSource = 'central' | 'liquor';

export interface CreateVarianceInput {
  source: VarianceSource;
  material_id: string;
  store_id?: string;         // liquor only
  department_id?: string;    // central only ('' = Store/Overall)
  date: string;
  system_stock: number;
  physical_stock: number;
  unit?: string;
  counted_by?: string;
  count_note?: string;
  outlet_id?: string | null;
}

const norm = (v?: string | null): string => (v == null ? '' : String(v).trim());

/**
 * Create or refresh a PENDING variance approval. Idempotent per
 * (source, material, store, dept, date): re-counting the same item before it is
 * approved updates the SAME pending row instead of stacking duplicates. A zero
 * variance is a no-op (nothing to approve) and returns null.
 */
export function upsertVarianceApproval(db: Database.Database, inp: CreateVarianceInput): string | null {
  const variance = Math.round((Number(inp.physical_stock) - Number(inp.system_stock)) * 1000) / 1000;
  const storeId = norm(inp.store_id);
  const deptId = norm(inp.department_id);
  const outletId = norm(inp.outlet_id);

  // A corrected re-count that now matches the system clears any stale PENDING
  // approval for this key (nothing left to approve). Already-decided rows stay.
  if (variance === 0) {
    db.prepare(`
      DELETE FROM variance_approvals
      WHERE status = 'pending' AND source = ? AND material_id = ? AND store_id = ? AND department_id = ? AND date = ? AND outlet_id = ?
    `).run(inp.source, inp.material_id, storeId, deptId, inp.date, outletId);
    return null;
  }

  const mat = db.prepare('SELECT average_price FROM raw_materials WHERE id = ?').get(inp.material_id) as
    { average_price: number } | undefined;
  const avg = Number(mat?.average_price) || 0;
  const varianceValue = Math.round(variance * avg * 100) / 100;

  const existing = db.prepare(`
    SELECT id FROM variance_approvals
    WHERE status = 'pending' AND source = ? AND material_id = ? AND store_id = ? AND department_id = ? AND date = ? AND outlet_id = ?
  `).get(inp.source, inp.material_id, storeId, deptId, inp.date, outletId) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE variance_approvals SET
        system_stock = ?, physical_stock = ?, variance = ?, variance_value = ?, unit = ?,
        counted_by = ?, count_note = ?, created_at = datetime('now')
      WHERE id = ?
    `).run(
      inp.system_stock, inp.physical_stock, variance, varianceValue, norm(inp.unit),
      norm(inp.counted_by), norm(inp.count_note), existing.id,
    );
    return existing.id;
  }

  const id = generateId();
  db.prepare(`
    INSERT INTO variance_approvals
      (id, source, material_id, store_id, department_id, date, system_stock, physical_stock,
       variance, variance_value, unit, counted_by, count_note, status, outlet_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now'))
  `).run(
    id, inp.source, inp.material_id, storeId, deptId, inp.date, inp.system_stock, inp.physical_stock,
    variance, varianceValue, norm(inp.unit), norm(inp.counted_by), norm(inp.count_note), outletId,
  );
  return id;
}

/** Count of pending approvals (optionally scoped to one outlet). */
export function pendingVarianceCount(db: Database.Database, outletId?: string | null): number {
  const oid = norm(outletId);
  const row = oid
    ? db.prepare(`SELECT COUNT(*) AS n FROM variance_approvals WHERE status='pending' AND (outlet_id = ? OR outlet_id = '')`).get(oid) as { n: number }
    : db.prepare(`SELECT COUNT(*) AS n FROM variance_approvals WHERE status='pending'`).get() as { n: number };
  return row?.n || 0;
}

export interface VarianceRow {
  id: string; source: VarianceSource; material_id: string; material_name: string; material_sku: string;
  store_id: string; store_name: string; department_id: string; department_name: string;
  date: string; system_stock: number; physical_stock: number; variance: number; variance_value: number;
  unit: string; counted_by: string; count_note: string;
  status: string; reviewed_by: string; reviewed_at: string; review_reason: string; created_at: string;
  /** Set only when approval is refused — the reason. See varianceApprovalBlock(). */
  approve_blocked?: string | null;
}

/** List approvals (default: pending first, newest first). */
export function listVarianceApprovals(
  db: Database.Database,
  opts: { status?: string; outletId?: string | null; limit?: number } = {},
): VarianceRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status && opts.status !== 'all') { where.push('va.status = ?'); params.push(opts.status); }
  const oid = norm(opts.outletId);
  if (oid) { where.push("(va.outlet_id = ? OR va.outlet_id = '')"); params.push(oid); }
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);
  const rows = db.prepare(`
    SELECT va.*, rm.name AS material_name, rm.sku AS material_sku,
           COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS material_purchase_unit,
           COALESCE(rm.pack_size, 1) AS material_pack_size,
           COALESCE(sl.name, '')  AS store_name,
           COALESCE(d.name, '')   AS department_name
    FROM variance_approvals va
    JOIN raw_materials rm ON rm.id = va.material_id
    LEFT JOIN store_locations sl ON sl.id = va.store_id
    LEFT JOIN departments d ON d.id = va.department_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (va.status = 'pending') DESC, va.date DESC, va.created_at DESC
    LIMIT ${limit}
  `).all(...params) as VarianceRow[];
  // Additive: tell the queue up front which rows approveVariance() will refuse,
  // so the admin sees the reason instead of discovering it on click.
  return rows.map(r => ({ ...r, approve_blocked: varianceApprovalBlock(db, r, r.department_name) }));
}

export interface DecisionResult { ok: boolean; error?: string; applied?: boolean }

/**
 * Can this variance safely be APPROVED? Returns null when yes, otherwise the
 * reason to refuse (shown verbatim to the admin, and surfaced on the queue by
 * listVarianceApprovals so the refusal is visible before the click).
 *
 * A department count is now APPROVABLE — it posts a signed 'adjustment' to that
 * department's own ledger and leaves central alone (see approveVariance). What
 * survives here are the three states in which that posting would be a lie:
 *
 *  1. STORE-MAPPED (liquor). Store-mapped materials live on the TGBCL rail and
 *     are skipped by BOTH the central debit and the department credit at issue,
 *     so they never have a department ledger balance to correct. Posting one
 *     here would invent the department rail's only liquor row and put the same
 *     bottle on two rails. This carve-out is deliberate, not an oversight —
 *     do not "complete" it.
 *  2. NEVER COUNTED. No cutover `opening` row and no anchor, so the department
 *     has no balance to take a delta FROM. The first measurement of a
 *     department is an OPENING, which is an admin action with its own
 *     idempotency (POST /api/department-ledger/cutover) — minting one from the
 *     approval queue would stack a second opening and skip that guard.
 *  3. THE DOUBLE-ANCHOR. dept-ledger's latestCount() anchors a department
 *     balance on the newest closing_stock row, so the count re-bases the
 *     balance the moment it is SAVED — measured: an opening of 5000 plus a
 *     PENDING count of 4800 already reads 4800, with anchorSource flipping to
 *     'count', before anyone approves. While that is true, the count and this
 *     adjustment are two mechanisms for one correction and applying both takes
 *     the difference off twice (4800 → 4600). It also makes Reject a lie: the
 *     balance already moved. Refusing is the honest state until the anchor is
 *     resolved; see the handoff on dept-ledger.ts. The post-condition assert in
 *     approveVariance is the second line of defence and must stay even after
 *     this one is retired.
 *
 * Central Store/Overall (department_id '') and liquor rows are never blocked:
 * each posts a delta to its own rail.
 */
export function varianceApprovalBlock(
  db: Database.Database,
  row: { source: string; department_id?: string | null; material_id?: string },
  deptName?: string | null,
): string | null {
  if (String(row.source) !== 'central') return null;
  const deptId = norm(row.department_id);
  if (!deptId) return null;

  const who = norm(deptName) || 'this department';
  const matId = norm(row.material_id);
  if (!matId) return 'Count has no material — cannot be approved.';

  if (isStoreMappedMaterial(db, matId)) {
    return (
      `Liquor / store-mapped item — cannot be approved as a department count. This item is tracked on the ` +
      `liquor store ledger, not on ${who}'s raw-material stock, so there is no department balance to correct. ` +
      `Reject it and record the count against the store it belongs to.`
    );
  }

  const bal = deptOnHand(db, deptId, matId);
  if (bal.neverCounted || bal.onHand === null) {
    return (
      `${who} has no opening balance for this item yet, so a counted difference cannot be worked out. ` +
      `Record the department's opening stock first (the cutover count), then re-count. ` +
      `Reject this one — nothing moves.`
    );
  }
  if (bal.anchorSource === 'count') {
    return (
      `${who}'s balance is already anchored on a closing count, so this count has ALREADY moved the ` +
      `department's stock on its own. Approving would take the difference off a second time. ` +
      `Reject it — and note the department balance has moved regardless, which is a bug to fix in the ` +
      `department ledger (a count must not re-base a balance before it is approved).`
    );
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The department delta, as of the COUNT — not as of the approval.
 * ──────────────────────────────────────────────────────────────────────────*/

/** 3 dp, the rounding this table has always stored variances in. */
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Floating-point slack. Below this a delta is nothing, not a movement. */
const EPS = 1e-6;

/**
 * The instant a count speaks for, in the ledger's UTC basis.
 *
 * MIRRORS dept-ledger's countAnchorAt(): MIN(IST day-end of the count date,
 * when it was saved). MIN, not MAX, and both directions of getting it wrong
 * lose real movement — a count typed at 3pm must not swallow the 5pm issue that
 * followed it, and a count for the 1st typed on the 5th must not swallow four
 * days. 23:59:59 IST = 18:29:59 UTC on the SAME day (IST = UTC+5:30), so no
 * date rollover.
 *
 * This is a DUPLICATE of a rule that should have one home. It exists only
 * because deptOnHand() has no `asOf` parameter; when it gets one, delete this
 * and the query below. Do not let the two definitions drift in the meantime.
 */
function deptCountInstant(date: string, createdAt: string): string {
  const raw = String(createdAt || '').trim();
  // Same bare-date rule as dept-ledger's normTs(): a date with no time means the
  // START of that day. An import path that stamps created_at as 'YYYY-MM-DD'
  // would otherwise compare as a 10-char string and sort BEFORE the same day's
  // 00:00:00 here while sorting AT 00:00:00 there — the two windows would then
  // disagree on exactly the rows an import creates.
  const saved = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw} 00:00:00` : raw.slice(0, 19).replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '').trim())) return saved;
  const dayEnd = `${String(date).trim()} 18:29:59`;
  return saved && saved < dayEnd ? saved : dayEnd;
}

/**
 * Signed department movement strictly after `instant`. Same normalisation as
 * dept-ledger (19 chars, 'T' → ' '): comparing a raw ISO 'T' timestamp against
 * a raw ledger timestamp silently shifts a whole day, because 'T' > ' '.
 *
 * Deliberately NOT wrapped in a try/catch. A swallowed error here would return
 * 0, which reads as "nothing moved since the count" and would put every
 * post-count movement into the adjustment — the very overwrite this file exists
 * to stop. Throwing rolls the caller's transaction back instead.
 */
function deptMovementsAfter(db: Database.Database, deptId: string, matId: string, instant: string): number {
  if (!instant) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS s
      FROM department_material_transactions
     WHERE department_id = ? AND material_id = ?
       AND REPLACE(SUBSTR(created_at, 1, 19), 'T', ' ') > ?
  `).get(deptId, matId, instant) as { s: number } | undefined;
  return r3(Number(row?.s) || 0);
}

/**
 * Approve a pending variance → move stock to the physical count and log it.
 * `reason` is the explanation the admin recorded after asking the staff.
 */
export function approveVariance(
  db: Database.Database, id: string, reviewer: string, reason: string,
): DecisionResult {
  const row = db.prepare(`SELECT * FROM variance_approvals WHERE id = ?`).get(id) as (VarianceRow & Record<string, unknown>) | undefined;
  if (!row) return { ok: false, error: 'Variance approval not found' };
  if (row.status !== 'pending') return { ok: false, error: `Already ${row.status}` };

  // Refuse the department-clobber case BEFORE anything is written. See
  // varianceApprovalBlock().
  let deptName = '';
  if (norm(row.department_id)) {
    try {
      deptName = (db.prepare(`SELECT name FROM departments WHERE id = ?`).get(row.department_id) as
        { name?: string } | undefined)?.name || '';
    } catch { /* name is cosmetic */ }
  }
  const blocked = varianceApprovalBlock(db, row, deptName);
  if (blocked) return { ok: false, error: blocked };

  const apply = db.transaction(() => {
    if (row.source === 'liquor') {
      // Reconcile the store ledger to the physical count as of the count date.
      postLedger(db, {
        store_id: row.store_id,
        material_id: row.material_id,
        txn_type: 'adjustment',
        quantity: row.variance,        // signed (physical − system), recipe units
        unit_cost: 0,
        ref: `variance-approval:${row.date}`,
        notes: `Approved variance ${row.date}: system ${row.system_stock} → physical ${row.physical_stock} ${row.unit}`,
        created_by: reviewer,
      });
    } else if (norm(row.department_id)) {
      // ── DEPARTMENT count → the department's own ledger. CENTRAL IS NOT TOUCHED.
      //
      // The count says: at count time this department's shelf held `physical`,
      // while its ledger said `baseline`. The correction is that difference, and
      // ONLY that difference — every movement the department made after the
      // count (the lunch service it cooked while the approval sat in the queue)
      // has to survive, exactly as on the central branch above.
      //
      //   baseline = balance_now − movements_since_the_count
      //   delta    = counted − baseline
      //   result   = counted + movements_since_the_count
      //
      // Forcing the balance to `counted` instead would erase that service and
      // book it as a correction, which is the department-side twin of the
      // absolute-set bug.
      const deptId = norm(row.department_id);
      const counted = Number(row.physical_stock) || 0;

      const bal = deptOnHand(db, deptId, row.material_id);
      // varianceApprovalBlock() has already refused neverCounted; belt-and-braces
      // so a future caller that skips the block cannot post against a null.
      if (bal.onHand === null) throw new Error(`${deptName || 'Department'} has no opening balance for this item`);

      const countAt = deptCountInstant(String(row.date), String(row.created_at));

      // A COUNT THAT PREDATES THE ANCHOR CANNOT BE APPLIED. `baseline` below
      // rewinds the balance by the movements made after the count, which only
      // means anything while the count sits INSIDE the current window. For a
      // count dated before the opening row (or before the cutover floor), the
      // rewind subtracts movement the balance never included and the arithmetic
      // is nonsense — measured on a backdated count: a −200 correction came out
      // as +4800. It is also decision D: nothing dated before the cutover may
      // enter a department balance, and a backdated count is exactly how that
      // floor gets walked around. Refuse, and say which date wins.
      //
      // Strictly before, not `<=`: a count stamped in the SAME second as the
      // opening is the cutover day itself — the ordinary "count the kitchen,
      // enter it as opening, count again" morning — and is legitimately
      // approvable against that opening.
      if (countAt < bal.windowFrom) {
        throw new Error(
          `This count (${row.date}) is dated before ${deptName || 'the department'}'s opening balance ` +
          `(${bal.windowFrom}), so it cannot be applied — it would reach back past the cutover. ` +
          `Reject it and re-count.`,
        );
      }

      const movedSince = deptMovementsAfter(db, deptId, row.material_id, countAt);
      const baseline = r3(bal.onHand - movedSince);
      const delta = r3(counted - baseline);

      if (Math.abs(delta) > EPS) {
        // NO inventory_transactions ROW HERE. That table is the CENTRAL rail and
        // is what the Variance and Sales-vs-Purchase reports read; writing this
        // department correction into it would fabricate a central adjustment out
        // of stock that never left the store. The two writes below/above look
        // parallel and are not — do not merge them.
        postDeptLedger(db, {
          departmentId: deptId,
          materialId: row.material_id,
          type: 'adjustment',
          quantity: delta,              // SIGNED. − = the shelf held less than the ledger said.
          outletId: norm(row.outlet_id as string) || null,
          referenceId: id,
          source: 'variance-approval',
          user: norm(reviewer),
          notes:
            `Approved department count ${row.date}: counted ${counted} ${row.unit} vs ledger ${baseline} ` +
            `at count time (${movedSince === 0 ? 'no movement since' : `${movedSince} moved since`})`,
        });

        // POST-CONDITION, and the reason this branch can never double-correct.
        // If some other mechanism also re-bases a department balance from a
        // count (see the double-anchor note in varianceApprovalBlock), the
        // arithmetic below will not land and this throws, rolling the whole
        // approval back. Keep it even when that anchor is fixed: it is what
        // makes "the ledger is the one truth" checkable rather than asserted.
        const after = deptOnHand(db, deptId, row.material_id);
        const expected = r3(counted + movedSince);
        if (after.onHand === null || Math.abs(after.onHand - expected) > EPS) {
          throw new Error(
            `Department balance did not land where the count says it should ` +
            `(expected ${expected}, got ${after.onHand}). Nothing was changed. ` +
            `Another mechanism is re-basing this balance from the same count.`,
          );
        }
      }
    } else {
      // ── CENTRAL STORE count → raw_materials.current_stock.
      //
      // Post the COUNT-TIME delta (physical − system-as-counted) on top of
      // whatever central holds now. Recomputed from the two stored figures
      // rather than read off the stored `variance` column, so a row whose
      // variance was written by some other path still applies its own
      // definition.
      //
      // WHY NOT `SET current_stock = physical_stock`: count the store at 100 at
      // 10am, issue 40 kg to a kitchen at noon, approve at 4pm. The absolute set
      // writes 100 back — un-issuing the 40 kg that a department is standing
      // there holding, so the same 40 kg is on two rails at once. The delta
      // lands at 60 and the issue survives, which is the invariant: every gram
      // leaves central exactly once.
      //
      // NO FLOOR AT ZERO. If the delta takes central negative, central goes
      // negative and says so. Clamping would manufacture stock that nobody
      // bought, and hide the very gap a count exists to reveal.
      const cur = db.prepare(`SELECT current_stock FROM raw_materials WHERE id = ?`).get(row.material_id) as { current_stock: number } | undefined;
      const before = r3(Number(cur?.current_stock) || 0);
      const appliedDelta = r3(Number(row.physical_stock) - Number(row.system_stock));
      const after = r3(before + appliedDelta);
      if (Math.abs(appliedDelta) > EPS) {
        db.prepare(`UPDATE raw_materials SET current_stock = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(after, row.material_id);
        db.prepare(`
          INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
          VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
        `).run(
          generateId(), row.material_id, appliedDelta, id,
          `Approved variance ${row.date}: counted ${row.physical_stock} ${row.unit} against count-time system ` +
          `${row.system_stock} (delta ${appliedDelta}); central ${before} → ${after}`,
        );
      }
    }
    db.prepare(`
      UPDATE variance_approvals SET status='approved', reviewed_by=?, reviewed_at=datetime('now'), review_reason=? WHERE id=?
    `).run(norm(reviewer), norm(reason), id);
  });

  try { apply(); } catch (e) { return { ok: false, error: (e as Error).message }; }
  return { ok: true, applied: true };
}

/** Reject a pending variance → stock unchanged; variance stands as an open loss. */
export function rejectVariance(
  db: Database.Database, id: string, reviewer: string, reason: string,
): DecisionResult {
  const row = db.prepare(`SELECT status FROM variance_approvals WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!row) return { ok: false, error: 'Variance approval not found' };
  if (row.status !== 'pending') return { ok: false, error: `Already ${row.status}` };
  db.prepare(`
    UPDATE variance_approvals SET status='rejected', reviewed_by=?, reviewed_at=datetime('now'), review_reason=? WHERE id=?
  `).run(norm(reviewer), norm(reason), id);
  return { ok: true, applied: false };
}
