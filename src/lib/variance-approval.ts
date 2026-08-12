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
 *
 * ONE COUNT PER ITEM MAY BE APPROVED — THE LATEST ONE. The delta above is frozen
 * at count time, which is right for a single count and wrong for two: a second
 * count on a second DATE freezes the SAME baseline again, so approving both
 * applies the baseline correction TWICE. The pending-uniqueness index is keyed
 * per date and cannot see that. supersedeWhere() below is the rule that can, and
 * approveVariance() refuses anything it flags. See that comment for the measured
 * case; it is the reason this file grew a second guard.
 */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import { postLedger, isStoreMappedMaterial } from '@/lib/store-engine';
import { deptOnHand, postDeptLedger } from '@/lib/dept-ledger';
import {
  getCentralStoreCutoverDate,
  getCentralStoreCutoverCommittedAt,
} from '@/lib/central-cutover';

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

/**
 * Which outlets a queue read covers.
 *   'outlet' → rows stamped with the reader's own outlet, plus rows stamped
 *              with no outlet at all (''). The DEFAULT, and byte-for-byte what
 *              every caller got before this type existed.
 *   'all'    → every outlet. OPT-IN ONLY, never inferred.
 *
 * WHY 'all' HAD TO EXIST. A pending row carries the outlet of whoever COUNTED,
 * but the queue is read under the outlet of whoever REVIEWS, and those are two
 * different people. POST /api/outlets/switch moves any signed-in user to any
 * active outlet with no role gate, so a count saved from outlet B is invisible
 * to an admin sitting in outlet A — and pendingVarianceCount carried the
 * identical filter, so the badge read zero too and nothing hinted the row was
 * there. A variance nobody can see is a variance nobody reviews, which is the
 * one failure this whole queue exists to prevent.
 *
 * 'all' makes those rows REACHABLE. It does not remove outlet isolation: the
 * default stays 'outlet', so a single-outlet day looks exactly as it did.
 */
export type VarianceOutletScope = 'outlet' | 'all';

/**
 * Count of pending approvals, scoped like the list below.
 *
 * `scope` and `outletId` must be read together: 'all' ignores `outletId`
 * entirely. Passing no outlet at all has always meant "every outlet" here, but
 * that is implicit and easy to hit by accident — say `'all'` when you mean it.
 */
export function pendingVarianceCount(
  db: Database.Database,
  outletId?: string | null,
  scope: VarianceOutletScope = 'outlet',
): number {
  // The INNER JOIN mirrors listVarianceApprovals. Without it the two disagree:
  // a pending row whose material was deleted is COUNTED here but can never be
  // LISTED there, so the bell would show "3 waiting" over a queue rendering
  // "All counts reconcile with the system — no variances to review." Counting
  // only what the admin can actually open keeps the badge honest; a row orphaned
  // that way is unreviewable and nagging about it helps nobody.
  const oid = scope === 'all' ? '' : norm(outletId);
  const row = oid
    ? db.prepare(`SELECT COUNT(*) AS n FROM variance_approvals va JOIN raw_materials m ON m.id = va.material_id WHERE va.status='pending' AND (va.outlet_id = ? OR va.outlet_id = '')`).get(oid) as { n: number }
    : db.prepare(`SELECT COUNT(*) AS n FROM variance_approvals va JOIN raw_materials m ON m.id = va.material_id WHERE va.status='pending'`).get() as { n: number };
  return row?.n || 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * SUPERSEDED COUNTS — why an OLDER count may not be approved after a NEWER one.
 * ──────────────────────────────────────────────────────────────────────────*/

/** The newest count competing with a given row. */
export interface SupersedingCount {
  /** Count date of that newer row (YYYY-MM-DD). */
  date: string;
  /** Where it stands. 'rejected' is deliberately not a member — see below. */
  status: 'pending' | 'approved';
}

/** The key fields the supersede test reads. A whole variance_approvals row fits. */
export interface VarianceKeyRow {
  id?: string | null;
  source: string;
  material_id?: string | null;
  store_id?: string | null;
  department_id?: string | null;
  outlet_id?: string | null;
  date?: string | null;
  created_at?: string | null;
}

/**
 * THE SUPERSEDE PREDICATE. Written ONCE on purpose — read this before touching
 * either of its two callers.
 *
 * A pending row FREEZES system_stock at count time and approveVariance() posts
 * (physical − that frozen system) on top of LIVE stock. Correct for ONE count.
 * Wrong the instant two counts on two DATES exist for the same item, because
 * both froze the SAME baseline and the baseline correction is then applied
 * TWICE. Measured on the owner's data — Testing Curd 2 (g, pack 1000), live
 * stock −997 g:
 *     07-08  system −997  counted    997  → delta  +1,994
 *     08-08  system −997  counted 11,000  → delta +11,997
 * Approving 08-08 lands −997 + 11,997 = 11,000 g = 11 kg, which is the shelf.
 * Approving 07-08 on top of that lands 12,994 g — overstated by exactly the
 * −997 baseline, a second time. The reverse order is equally wrong. And it
 * overstates, i.e. it inflates in the direction that HIDES a shortage.
 *
 * uq_variance_appr_pending DOES NOT STOP THIS. It is keyed per DATE, so two
 * dates are two independent pending rows and neither supersedes the other.
 *
 * The rule: only the LATEST-dated count per (source, material, store,
 * department, outlet) may be approved. Older ones are REFUSED and left sitting
 * in the queue — nothing is auto-decided, because rejecting is a judgement
 * about a real count a real person made.
 *
 * 'pending' AND 'approved' both supersede. 'rejected' does NOT: a rejection
 * moves no stock, so the older count's frozen baseline is still the live one
 * and approving it is still exactly right.
 *
 * THE SAME-DATE TIE-BREAK IS LOAD-BEARING, not padding. The pending-unique index
 * covers PENDING rows only, so an APPROVED row and a newer PENDING row can
 * legitimately share a date — which is precisely what "save with Adjust system
 * stock, then re-count the same day" produces. created_at decides those, and it
 * must decide them the right way round or that ordinary flow breaks.
 *
 * `self` is the alias of the row being judged, so this ONE text serves both the
 * correlated subquery in listVarianceApprovals (self = the outer `va`) and the
 * point lookup in findSupersedingCount (self = a one-row CTE of bound params).
 * If those two ever drift, the queue offers an Approve button the API refuses —
 * the most likely way this whole fix fails in practice. Do not inline either.
 *
 * COALESCE on the three key columns even though all are NOT NULL DEFAULT '':
 * a stray NULL would make the key never match itself (NULL = NULL is NULL), and
 * a supersede test that silently matches nothing fails OPEN.
 */
function supersedeWhere(self: string): string {
  return `
    nv.id <> ${self}.id
    AND nv.source      = ${self}.source
    AND nv.material_id = ${self}.material_id
    AND COALESCE(nv.store_id, '')      = COALESCE(${self}.store_id, '')
    AND COALESCE(nv.department_id, '') = COALESCE(${self}.department_id, '')
    -- OUTLET IS PART OF THE KEY ONLY WHERE THE STOCK RAIL IS ACTUALLY
    -- OUTLET-SEPARATED, WHICH FOR CENTRAL IT IS NOT.
    -- raw_materials.current_stock is ONE global pool: the central branch of
    -- approveVariance writes that single column with no outlet dimension. Keying
    -- the supersede test on outlet_id therefore reopens the exact double-apply
    -- this guard exists to stop, one axis over — and it is reachable today, not
    -- theoretical. variance_approvals is NOT in TABLES_NEEDING_OUTLET (db.ts), so
    -- rows written before outlet stamping keep outlet_id = '' and sit in the SAME
    -- admin queue as stamped rows (the scope filter matches the current outlet
    -- OR the empty one). Two counts
    -- of one material, one '' and one 'main', would each report "not superseded",
    -- both be approvable, and both post their frozen delta to the same pool.
    -- Liquor and department rows are genuinely partitioned — by store_id and
    -- department_id above, which are already in the key — so they keep the outlet
    -- term and are unaffected.
    AND (
      (COALESCE(${self}.source, '') = 'central' AND COALESCE(${self}.department_id, '') = '')
      OR COALESCE(nv.outlet_id, '') = COALESCE(${self}.outlet_id, '')
    )
    AND nv.status IN ('pending', 'approved')
    AND (
          nv.date > ${self}.date
       OR (nv.date = ${self}.date
           AND REPLACE(SUBSTR(nv.created_at, 1, 19), 'T', ' ')
             > REPLACE(SUBSTR(${self}.created_at, 1, 19), 'T', ' '))
    )
  `;
}

/**
 * Newest competing row first. `nv.id` is the last tie-break so an exact
 * (date, created_at) collision still resolves to ONE deterministic row — the
 * date and the status reported for it have to describe the same row.
 *
 * The SUBSTR/REPLACE normalisation in the predicate above is mirrored nowhere
 * here on purpose: every writer of this table is upsertVarianceApproval(), which
 * stamps datetime('now'), so created_at is uniformly 'YYYY-MM-DD HH:MM:SS' and
 * plain DESC orders it correctly. The normalisation exists only so a future
 * import path stamping ISO 'T' timestamps cannot silently shift a whole day
 * ('T' > ' ') in the comparison, which is the same trap deptMovementsAfter()
 * below already guards.
 */
const SUPERSEDE_ORDER = 'ORDER BY nv.date DESC, nv.created_at DESC, nv.id DESC';

/**
 * The newest count that supersedes `row`, or null when `row` IS the newest.
 * One indexed lookup (idx_variance_appr_material carries the material equality).
 *
 * A row with no `id` is still safe: the self-exclusion is belt-and-braces, since
 * a row can never satisfy a STRICT date/created_at inequality against itself.
 */
export function findSupersedingCount(
  db: Database.Database,
  row: VarianceKeyRow,
): SupersedingCount | null {
  const hit = db.prepare(`
    WITH self AS (
      SELECT ? AS id, ? AS source, ? AS material_id, ? AS store_id,
             ? AS department_id, ? AS outlet_id, ? AS date, ? AS created_at
    )
    SELECT nv.date AS date, nv.status AS status
      FROM variance_approvals nv, self
     WHERE ${supersedeWhere('self')}
     ${SUPERSEDE_ORDER}
     LIMIT 1
  `).get(
    norm(row.id), norm(row.source), norm(row.material_id), norm(row.store_id),
    norm(row.department_id), norm(row.outlet_id), norm(row.date), norm(row.created_at),
  ) as { date: string; status: string } | undefined;
  if (!hit) return null;
  return { date: String(hit.date), status: hit.status === 'approved' ? 'approved' : 'pending' };
}

/**
 * The refusal, worded in ONE place so the queue's amber notice and the API's
 * error are the same sentence. It names the date and tells the admin the two
 * ways out, because "refused" without a next step just moves the confusion.
 */
function supersededMessage(s: SupersedingCount): string {
  return (
    `A newer count dated ${s.date} was already ${s.status} for this item. ` +
    `Approve that one instead, or reject it first — approving this older count ` +
    `applies the same correction a second time.`
  );
}

/** `date|status` as packed by the list query, back into a SupersedingCount. */
function parseSuperseded(packed?: string | null): SupersedingCount | null {
  const s = String(packed ?? '');
  const cut = s.indexOf('|');
  // `< 0`, not `<= 0`: a packed "|pending" (a superseding row whose date is
  // somehow empty) means SUPERSEDED WITH AN UNKNOWN DATE, not "not superseded".
  // Reading it as the latter is the one drift this design exists to prevent —
  // the list would render Approve enabled on a row approveVariance refuses.
  // Empty dates are not reachable through either writer today; this is about
  // which way the parse fails if one ever becomes reachable.
  if (cut < 0) return null;
  const status = s.slice(cut + 1);
  if (status !== 'pending' && status !== 'approved') return null;
  return { date: s.slice(0, cut), status };
}

/** One material with more than one pending count stacked on a single key. */
export interface StackedPendingItem {
  material_id: string;
  material_name: string;
  /** How many pending rows are involved in the stack(s) for this material. */
  pending_count: number;
  /** Newest count date among them — the one that is actually approvable. */
  latest_date: string;
}

/**
 * Items whose pending queue holds MORE THAN ONE count on the same key, newest
 * first. This is the queue-level warning: it is what makes 963 pending rows
 * readable as "these N items will double-apply if you just work down the list".
 *
 * GROUPED BY THE SUPERSEDE KEY, NOT BY MATERIAL, then rolled up to the material
 * for display. Grouping by material_id alone would flag Curd counted in the
 * kitchen AND Curd counted centrally as a stack — two different rails, two
 * independent baselines, both legitimately approvable. That is a false alarm on
 * a banner whose whole job is to be believed. Counting only rows that really
 * share a key can never miss a real stack and never invents one.
 *
 * Scoped exactly like listVarianceApprovals: same INNER JOIN raw_materials (an
 * orphaned row is unreviewable, so warning about it helps nobody) and the same
 * outlet filter. `status` is honoured too — the field is called pending_count,
 * so a queue filtered to approved/rejected has no stack to warn about and gets
 * an empty array rather than a count of something else.
 */
export function stackedPendingCounts(
  db: Database.Database,
  opts: { status?: string; outletId?: string | null; outletScope?: VarianceOutletScope } = {},
): StackedPendingItem[] {
  const status = opts.status || 'pending';
  if (status !== 'pending' && status !== 'all') return [];

  const scope: VarianceOutletScope = opts.outletScope === 'all' ? 'all' : 'outlet';
  const oid = scope === 'all' ? '' : norm(opts.outletId);
  const params: unknown[] = [];
  let outletWhere = '';
  if (oid) { outletWhere = "AND (va.outlet_id = ? OR va.outlet_id = '')"; params.push(oid); }

  return db.prepare(`
    SELECT g.material_id            AS material_id,
           rm.name                  AS material_name,
           SUM(g.n)                 AS pending_count,
           MAX(g.latest_date)       AS latest_date
      FROM (
            SELECT va.material_id   AS material_id,
                   COUNT(*)         AS n,
                   MAX(va.date)     AS latest_date
              FROM variance_approvals va
              JOIN raw_materials rmk ON rmk.id = va.material_id
             WHERE va.status = 'pending' ${outletWhere}
             -- Grouped on the SAME key supersedeWhere() uses, including its
             -- central carve-out: outlet collapses to '' for central Store/
             -- Overall rows because that rail is one global pool. Without the
             -- CASE, a '' row and a 'main' row for one material form two groups
             -- of one, HAVING COUNT(*) > 1 never fires, and the banner reads
             -- clean over precisely the pair that double-applies. The banner and
             -- the guard have to agree or the banner is worse than absent.
             GROUP BY va.source, va.material_id, COALESCE(va.store_id, ''),
                      COALESCE(va.department_id, ''),
                      CASE WHEN va.source = 'central' AND COALESCE(va.department_id, '') = ''
                           THEN '' ELSE COALESCE(va.outlet_id, '') END
            HAVING COUNT(*) > 1
           ) g
      JOIN raw_materials rm ON rm.id = g.material_id
     GROUP BY g.material_id
     ORDER BY latest_date DESC, material_name COLLATE NOCASE
  `).all(...params) as StackedPendingItem[];
}

export interface VarianceRow {
  id: string; source: VarianceSource; material_id: string; material_name: string; material_sku: string;
  store_id: string; store_name: string; department_id: string; department_name: string;
  date: string; system_stock: number; physical_stock: number; variance: number; variance_value: number;
  unit: string; counted_by: string; count_note: string;
  status: string; reviewed_by: string; reviewed_at: string; review_reason: string; created_at: string;
  /** Set only when approval is refused — the reason. See varianceApprovalBlock(). */
  approve_blocked?: string | null;
  /**
   * ADDITIVE (2026-08). The newest count competing with this one — see
   * supersedeWhere(). Non-null ⇒ approveVariance() WILL refuse this row, and
   * `approve_blocked` already carries the sentence saying so; these two fields
   * exist so the page can also say WHICH count wins without re-parsing it.
   */
  superseded_by_date?: string | null;
  superseded_by_status?: 'pending' | 'approved' | null;
  /**
   * ADDITIVE (2026-08). Live on-hand for THIS ROW'S OWN RAIL, in the SAME unit
   * basis as system_stock / physical_stock beside it (recipe units) — so the
   * page can finally show the real projection (live + variance) instead of the
   * unconditional "only if nothing moved since" caveat.
   *
   * null on department rows, and that is the honest answer, not a gap to fill:
   * a department balance comes from deptOnHand(), which is per-row machinery
   * (opening + anchor + ledger window) with no set-based form. Dragging it into
   * this query would be an N+1 over a queue that already runs to 963 rows. Do
   * NOT substitute rm.current_stock there — that is the CENTRAL pool and would
   * look authoritative while being wrong on every department row.
   *
   * Optional like approve_blocked above, for the same reason: only
   * listVarianceApprovals() computes these. A raw `SELECT *` row (approveVariance)
   * has none of them.
   */
  live_stock?: number | null;
}

export interface VarianceListResult {
  rows: VarianceRow[];
  /** Rows matching the SAME filters with no LIMIT — what `rows` is a slice of. */
  total: number;
  /** True when the LIMIT cut rows off the end, i.e. `rows` is not the whole story. */
  truncated: boolean;
  /** The limit actually applied, after clamping. */
  limit: number;
  /** The scope the rows were read under, echoed so a caller cannot mislabel them. */
  outletScope: VarianceOutletScope;
}

/**
 * List approvals (default: pending first, newest first) WITH the honest total.
 *
 * WHY THIS RETURNS A TOTAL AND NOT JUST ROWS. The LIMIT here is not a page —
 * there is no offset to fetch the remainder with, so whatever falls past it is
 * simply absent from the admin's screen with nothing saying so. ORDER BY puts
 * pending first and then date DESC, so what overflows is the OLDEST pending
 * counts: precisely the ones that have waited longest and most need a decision.
 * With ~950 raw materials one closing sheet can fill the limit by itself. The
 * caller cannot be honest about that without knowing how many rows actually
 * matched, so it is counted here.
 *
 * The count runs the IDENTICAL FROM/JOIN/WHERE as the list — that is the whole
 * point of `fromWhere` below, and it must stay shared. Counting over a
 * different shape would report truncation that never happened: the JOIN on
 * raw_materials is an INNER join, so a row whose material was deleted is
 * dropped from BOTH here, and a count without that join would sit permanently
 * above the row count and pin `truncated` to true forever.
 */
export function listVarianceApprovals(
  db: Database.Database,
  opts: { status?: string; outletId?: string | null; limit?: number; outletScope?: VarianceOutletScope } = {},
): VarianceListResult {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status && opts.status !== 'all') { where.push('va.status = ?'); params.push(opts.status); }
  // Outlet scope. 'all' drops the filter entirely so rows stamped with ANOTHER
  // outlet become reachable — see VarianceOutletScope for why that is needed
  // and why it is opt-in.
  const scope: VarianceOutletScope = opts.outletScope === 'all' ? 'all' : 'outlet';
  const oid = scope === 'all' ? '' : norm(opts.outletId);
  if (oid) { where.push("(va.outlet_id = ? OR va.outlet_id = '')"); params.push(oid); }
  // FLOOR, not just clamp. `limit` is interpolated straight into `LIMIT ${limit}`
  // below (it cannot be bound as a parameter there), and SQLite throws
  // "datatype mismatch" on a fractional LIMIT — so `?limit=1.5` from the API
  // would 500 the entire queue and show the admin an empty list. Clamping alone
  // does not stop that; 1.5 is already inside 1..1000.
  const limit = Math.floor(Math.min(Math.max(Number(opts.limit) || 200, 1), 1000));

  // ONE source of truth for the row set. Both queries below bind `params` in
  // this same order, so they can only ever describe the same rows.
  const fromWhere = `
    FROM variance_approvals va
    JOIN raw_materials rm ON rm.id = va.material_id
    LEFT JOIN store_locations sl ON sl.id = va.store_id
    LEFT JOIN departments d ON d.id = va.department_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
  `;

  // THE TWO ADDITIONS BELOW ARE SELECT-LIST ONLY. `fromWhere` and `params` are
  // untouched, so the count still describes exactly these rows and the `?`
  // binding order is unchanged — both correlated subqueries reference the outer
  // `va` and bind nothing of their own. Adding a parameter to either would
  // silently shift every existing bind.
  const raw = db.prepare(`
    SELECT va.*, rm.name AS material_name, rm.sku AS material_sku,
           COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS material_purchase_unit,
           COALESCE(rm.pack_size, 1) AS material_pack_size,
           COALESCE(sl.name, '')  AS store_name,
           COALESCE(d.name, '')   AS department_name,
           -- ONE subquery packing both fields, not two returning one each. Two
           -- would each resolve the tie independently and could report the date
           -- of one competing row beside the status of another. '|' separates
           -- them because neither a YYYY-MM-DD date nor pending/approved can
           -- contain it. Correlated rather than a per-row findSupersedingCount()
           -- call: SQLite still evaluates it once per row, but inside the one
           -- statement and on an index seek, instead of 500 prepared-statement
           -- round trips out through JS. Measured at 963 pending rows: ~6 ms for
           -- the whole list, both new columns included.
           (SELECT nv.date || '|' || nv.status
              FROM variance_approvals nv
             WHERE ${supersedeWhere('va')}
             ${SUPERSEDE_ORDER}
             LIMIT 1) AS superseded_by,
           -- LIVE ON-HAND, RESOLVED PER RAIL — the one shortcut that must not be
           -- taken here is a single materials lookup for all three. See the
           -- live_stock note on VarianceRow. Liquor with no ledger row at all is
           -- genuinely 0 on hand, not unknown; department is NULL because there
           -- is no set-based source for it.
           CASE
             WHEN va.source = 'liquor' THEN (
               SELECT COALESCE(SUM(l.quantity), 0)
                 FROM store_stock_ledger l
                WHERE l.store_id = va.store_id AND l.material_id = va.material_id
             )
             WHEN COALESCE(va.department_id, '') = '' THEN rm.current_stock
             ELSE NULL
           END AS live_stock
    ${fromWhere}
    ORDER BY (va.status = 'pending') DESC, va.date DESC, va.created_at DESC
    LIMIT ${limit}
  `).all(...params) as (VarianceRow & { superseded_by?: string | null })[];

  // The packed column is an implementation detail of the query above; it is
  // destructured OFF the row so the wire shape stays exactly the documented one.
  const rows: VarianceRow[] = raw.map(r => {
    const { superseded_by, ...rest } = r;
    const superseding = parseSuperseded(superseded_by);
    return {
      ...rest,
      superseded_by_date: superseding?.date ?? null,
      superseded_by_status: superseding?.status ?? null,
      live_stock: r.live_stock == null ? null : Number(r.live_stock),
      // Additive: tell the queue up front which rows approveVariance() will
      // refuse, so the admin sees the reason instead of discovering it on click.
      // The supersede verdict is HANDED IN rather than looked up again — same
      // predicate, and one query for the whole page instead of one per row.
      approve_blocked: varianceApprovalBlock(db, r, r.department_name, { superseding }),
    };
  });

  // The two LEFT JOINs are kept in the count even though they cannot change its
  // value (both join on a primary key, so no fan-out) — carrying the identical
  // FROM is what makes "same rows" true by construction rather than by review.
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n ${fromWhere}`).get(...params) as { n: number } | undefined)?.n,
  ) || 0;

  return {
    rows,
    total,
    truncated: total > rows.length,
    limit,
    outletScope: scope,
  };
}

export interface DecisionResult { ok: boolean; error?: string; applied?: boolean }

/**
 * Can this variance safely be APPROVED? Returns null when yes, otherwise the
 * reason to refuse (shown verbatim to the admin, and surfaced on the queue by
 * listVarianceApprovals so the refusal is visible before the click).
 *
 * FIRST, AND ON ALL THREE RAILS: IS A NEWER COUNT ALREADY IN PLAY? Approving an
 * older count after a newer one applies the same frozen baseline correction
 * twice — see supersedeWhere() for the measured case. That is not a department
 * problem, it is a delta problem, so this check runs BEFORE the central/liquor
 * early-out below and not after it. It is also the reason this function gained a
 * fourth parameter: the queue resolves the verdict for every row in one query
 * and hands it in, so the page and the API can never disagree about which rows
 * are approvable.
 *
 * The remaining reasons are department-only.
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
 * Central Store/Overall rows (department_id '') are blocked by ONE thing and
 * only one: the central cutover floor — see centralCutoverBlock() below. Before
 * a cutover is committed that returns null and they are never blocked, which is
 * what this comment used to say outright and is no longer the whole truth.
 * Liquor rows are still never blocked here: they post a delta to the store
 * ledger, which no central cutover touches.
 */
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE CENTRAL CUTOVER FLOOR — the central twin of the department refusal.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A pending central row FREEZES system_stock at count time, and the central
 * branch of approveVariance() posts (physical − that frozen system) onto LIVE
 * raw_materials.current_stock. Correct while the book it was frozen against is
 * still the book. A central-store cutover REPLACES that book: commitBatch SETs
 * current_stock to the physically counted figure and stamps the date.
 *
 * Approving a pre-cutover row after that posts a delta measured against the
 * OLD, drifted book on top of the freshly corrected one — it re-injects exactly
 * the drift the cutover just eliminated, ONE CLICK AT A TIME, and 963 pending
 * rows is 963 chances to undo it silently. Nothing about the row looks wrong on
 * screen; the arithmetic is simply against a baseline that no longer exists.
 *
 * THIS IS THE SAME REFUSAL THE DEPARTMENT BRANCH ALREADY MAKES ("This count is
 * dated before the department's opening balance, so it cannot be applied — it
 * would reach back past the cutover"). Central had no equivalent.
 *
 * WHICH INSTANT DECIDES. The question is not "which day was counted" but "was
 * this row's frozen system figure read from the old book or the new one", so
 * the boundary is central_store_cutover_committed_at — the real UTC instant
 * current_stock was re-based — and NOT central_store_cutover_at, which is a
 * business date at midnight and would wave through everything typed on the
 * cutover day before the commit. The count instant is the same MIN(IST day-end
 * of the count date, when it was saved) the department branch uses, so a count
 * dated the 5th and typed on the 12th is judged on the 5th.
 *
 * FALLBACKS, BOTH FAIL CLOSED:
 *   · committed-at missing (a stamp written by hand) → fall back to comparing
 *     business dates, which still catches every count dated before the cutover.
 *   · no usable count instant at all → refuse. A row whose age cannot be
 *     established cannot be proven to post against the current book, and
 *     Reject is always available.
 *
 * Returns the sentence to show, or null when there is nothing to refuse —
 * including on every install with no cutover committed, where
 * getCentralStoreCutoverDate() is null and this is a no-op.
 */
export function centralCutoverBlock(
  db: Database.Database,
  row: VarianceKeyRow,
): string | null {
  const cutDate = getCentralStoreCutoverDate(db);
  if (!cutDate) return null;

  const committedAt = getCentralStoreCutoverCommittedAt(db);
  const countAt = deptCountInstant(String(row.date ?? '').trim(), String(row.created_at ?? '').trim());
  const rowDate = String(row.date ?? '').trim().slice(0, 10);

  const stale = committedAt
    ? (!countAt || countAt < committedAt)
    : (!rowDate || rowDate < cutDate);
  if (!stale) return null;

  return (
    `The central store was cut over on ${cutDate} — its stock was re-based onto a physical count that day. ` +
    `This count (${rowDate || 'undated'}) was taken against the OLD book, so its difference of ` +
    `(counted − system-at-count-time) no longer describes anything: approving it would post months of ` +
    `pre-cutover drift back onto the corrected stock. Reject it. If the shelf is wrong TODAY, count it again ` +
    `and approve that count instead.`
  );
}

export function varianceApprovalBlock(
  db: Database.Database,
  row: VarianceKeyRow,
  deptName?: string | null,
  /**
   * The supersede verdict, already resolved. Pass it (with an explicit `null`
   * for "nothing supersedes this") from a caller that has just computed it in
   * bulk; omit the whole object and this looks it up itself. The property is
   * REQUIRED inside the object on purpose — an optional one would let a typo'd
   * or undefined field read as "not superseded" and fail OPEN.
   */
  precomputed?: { superseding: SupersedingCount | null },
): string | null {
  const superseding = precomputed ? precomputed.superseding : findSupersedingCount(db, row);
  if (superseding) return supersededMessage(superseding);

  if (String(row.source) !== 'central') return null;
  const deptId = norm(row.department_id);
  if (!deptId) {
    // CENTRAL STORE (no department): the cutover floor. Placed here, in the
    // shared block, so the queue disables Approve on exactly the rows the
    // approval will refuse — a list that renders Approve on a row the server
    // then rejects is how an admin ends up clicking 963 times.
    return centralCutoverBlock(db, row);
  }

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

  // Refuse the department-clobber case AND the superseded-count case BEFORE
  // anything is written. See varianceApprovalBlock().
  //
  // THE GUARD LIVES HERE, NOT IN THE ROUTE, because the route is not the only
  // caller: POST /api/closing-stock calls approveVariance() directly for the
  // admin "Adjust system stock" tick. That path normally passes — the count it
  // just saved IS the newest, and a same-date row approved earlier today has an
  // OLDER created_at so it does not supersede. What it now refuses is a
  // BACKDATED save made after a newer count already corrected the item: there
  // the count still saves, the approval stays pending, and the admin is told
  // why. That refusal is the fix working, not a regression — it is exactly the
  // double-application this guard exists to stop.
  //
  // No precomputed verdict is passed, so this does its own one-row lookup.
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
      // THE CUTOVER FLOOR, a second time. varianceApprovalBlock() above already
      // refused this row, and this is the belt-and-braces copy for the same
      // reason the department branch keeps its own windowFrom check: this
      // function is not only reached through the queue (POST /api/closing-stock
      // calls it directly for the admin "Adjust system stock" tick), and the
      // failure mode here is silent — a stale delta posted onto a re-based book
      // looks like an ordinary correction and undoes the cutover one row at a
      // time. Throwing rolls the whole approval back.
      const floorMsg = centralCutoverBlock(db, row as VarianceKeyRow);
      if (floorMsg) throw new Error(floorMsg);

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

/**
 * Reject a pending variance → stock unchanged; variance stands as an open loss.
 *
 * DELIBERATELY NOT SUPERSEDE-GATED. Rejecting is how a superseded count leaves
 * the queue, so gating it would strand every stale row permanently — and it
 * moves no stock, so there is nothing to double-apply. Only approveVariance()
 * carries that guard.
 */
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
