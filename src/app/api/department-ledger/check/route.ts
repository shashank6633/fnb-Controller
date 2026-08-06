import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import type { DeptOnHandResult } from '@/lib/dept-ledger';
import { DEPT_TXN_TYPES, cutoverAt, deptKey, deptOnHandBulk, isDeptTxnType } from '@/lib/dept-ledger';
import { isStoreMappedMaterial } from '@/lib/store-engine';

/**
 * THE DRIFT CHECK — the department rail auditing itself. READ ONLY.
 *
 *   GET /api/department-ledger/check    (admin)
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The department-inventory cutover made department_material_transactions the
 * TRUTH (the signed SUM of `quantity`) and demoted department_materials.on_hand
 * to a maintained CACHE. A cache is only safe if its disagreement with the
 * truth is VISIBLE. Two things keep it honest — postDeptLedger() writing both
 * as one pair, and this endpoint proving that they still agree. Without the
 * second, "the cache is not the truth" is a comment, not a property.
 *
 * It matters more than a cache-consistency check usually would because the
 * cache still has a SECOND writer: party-fulfillment.ts (:85-138) upserts
 * on_hand and appends its ledger row with its own SQL rather than going through
 * postDeptLedger. That is deliberate (the party rail is out of scope for the
 * cutover) and it is exactly the interleaving that can pull the two apart.
 *
 * ── WHAT "cache == sum" MEANS, PRECISELY ───────────────────────────────────
 * The cache is a RUNNING TOTAL OF EVERY MOVEMENT EVER — no anchor, no window.
 * So the invariant is:
 *
 *      department_materials.on_hand  ==  SUM(quantity) over ALL rows
 *
 * It is NOT deptOnHand().onHand, which is anchored on the latest physical count
 * and sums only the movements AFTER it. Do not "improve" this comparison to use
 * the balance: every pair carrying a closing count would then report drift, the
 * report would cry wolf on day one, and the owner would stop reading it. The
 * two figures answer two different questions and both are correct.
 *
 * ── THE CHECKER MUST NOT OWN A DEFINITION OF A BALANCE ─────────────────────
 * The negative-balance leg calls deptOnHandBulk() and does not re-derive the
 * anchor arithmetic locally. A checker with its own copy of the rule is a THIRD
 * truth, and it would pass while the app was wrong (or fail while the app was
 * right) the first time the anchor rule changed. If you need a figure the
 * shared helper does not return, add it there.
 *
 * ── WHY IT NEVER WRITES, AND MUST NOT BE MADE TO REPAIR ────────────────────
 * There is no auto-heal here and no POST. Snapping the cache back to the sum
 * would erase the only evidence of the bug that split them — the reconcile
 * route already had exactly that habit (an absolute `SET on_hand = leftover`)
 * and it hid drift for as long as it existed. A repair would also make this a
 * FOURTH writer of department stock. Drift is a defect to be diagnosed, not a
 * number to be tidied. Read-only is a load-bearing property of this route.
 *
 * ── LIQUOR IS DELIBERATELY *NOT* FILTERED OUT ──────────────────────────────
 * Store-mapped (TGBCL) materials live on the store rail and are carved out of
 * BOTH legs of the department rail by every writer. Therefore a department row
 * for one is not "expected noise to skip" — it is a breach of the carve-out and
 * the only place it will ever be noticed. It gets its own list. A future
 * engineer's instinct will be to exclude liquor here for symmetry with the
 * writers; that instinct is backwards for a checker and would silence the exact
 * failure this section is watching for.
 *
 * ── THE ROUNDING-NOISE TRAP (why `within_rounding_noise` exists) ───────────
 * postDeptLedger stores r6 quantities and re-rounds the cache after each write;
 * party-fulfillment stores an UNROUNDED quantity and does not round the cache
 * at all. Interleave the two and the cache can shave up to ~5e-7 per rounded
 * write off a total the raw SUM keeps in full. That is float dust, not a lost
 * gram, but it accumulates and can cross a 1e-6 threshold. Rather than widen
 * the tolerance (which would hide small REAL losses of a low-density material
 * measured in grams), every drift row carries its row count and a
 * `within_rounding_noise` flag so dust is labelled instead of read as theft.
 * The permanent fix is upstream — see the handoff on party-fulfillment.
 *
 * ── WHY balance_after IS CHECKED STEP-WISE, NOT CUMULATIVELY ───────────────
 * balance_after is the cache value at write time, kept for the audit view only
 * (nothing may decide from it). Once one row's value is wrong the offset is
 * carried forward, so a plain "every row vs the running sum" test flags the
 * whole tail of the pair's history and buries the one row that actually broke.
 * The finding is therefore raised where the CHAIN breaks —
 * balance_after − previous balance_after != quantity — which names the exact
 * row. The cumulative comparison is still counted, in summary, so the wider
 * blast radius stays visible.
 *
 * ── ORDER IS rowid, NOT created_at ─────────────────────────────────────────
 * The balance query (dept-ledger sumMovements) orders by the normalised
 * timestamp with a rowid tie-break, because it answers "what happened after the
 * count". This chain answers a different question — "in what order did the two
 * writers touch the cache" — and that is INSERT order, which is rowid. Both
 * writers stamp created_at themselves (one with milliseconds, one with
 * second-resolution datetime('now')), so timestamps can tie or invert while
 * rowid cannot.
 *
 * Cost: this is a full-table scan by construction — a cumulative chain cannot
 * be verified from a window. `department_id` / `material_id` narrow it safely
 * because both the cache and the chain are per (department, material).
 */

export const dynamic = 'force-dynamic';

/** The spec's tolerance: one unit in the last place the rail actually stores
 *  (quantities are rounded to 6dp), so anything larger is an event, not float
 *  noise. Deliberately NOT the 1e-9 guard epsilon dept-ledger uses to refuse a
 *  zero movement — that is a different question at a different scale. */
const TOLERANCE = 1e-6;

/** Worst-case cache shave per rounded write. See the rounding-noise trap. */
const NOISE_PER_ROW = 5e-7;

/** Sign epsilon, matching dept-ledger's EPS, for "is this row's quantity zero". */
const EPS = 1e-9;

const r6 = (n: number) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

type Db = Database.Database;

function tableExists(db: Db, name: string): boolean {
  try {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
  } catch { return false; }
}

/** The additive trace columns (req_item_id / order_item_id / station / source)
 *  arrived with the cutover's guarded PRAGMA block. A database that has not run
 *  it yet — a restored backup, a stale deploy — must still get a usable report
 *  with a thinner audit trail, exactly as postDeptLedger still writes rows
 *  without them. Probed, never assumed. */
function columnsOf(db: Db, table: 'department_material_transactions'): Set<string> {
  const out = new Set<string>();
  try {
    for (const c of db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>) {
      out.add(String(c.name));
    }
  } catch { /* table already proven to exist; an empty set just drops the trace */ }
  return out;
}

interface LedgerRow {
  rid: number;
  id: string;
  department_id: string;
  material_id: string;
  type: string;
  quantity: number | null;
  balance_after: number | null;
  created_at: string;
  source?: string | null;
}

interface PairState {
  departmentId: string;
  materialId: string;
  rows: number;
  /** Raw signed sum of every row, no window. THE truth the cache is checked against. */
  sum: number;
  /** Rows whose balance_after disagreed with the cumulative sum — counted for the
   *  summary even though only the chain break is itemised. */
  cumulativeMismatches: number;
  lastBalanceAfter: number | null;
  lastAt: string;
  firstAt: string;
}

export async function GET(request: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) {
      return Response.json(
        {
          error: gate.status === 403
            ? 'Admin role required to read the department ledger drift check'
            : gate.message,
        },
        { status: gate.status },
      );
    }

    const db = getDb();

    // A 503 naming the missing table beats a 500 stack trace: this route is
    // reached from the cutover screens, where "the migration has not run here"
    // is a real and answerable state.
    for (const t of ['department_material_transactions', 'department_materials']) {
      if (!tableExists(db, t)) {
        return Response.json(
          { error: `Table ${t} is missing — the department-ledger migration has not run on this database.` },
          { status: 503 },
        );
      }
    }

    const url = new URL(request.url);
    const deptFilter = String(url.searchParams.get('department_id') || '').trim();
    const matFilter = String(url.searchParams.get('material_id') || '').trim();
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 2000);

    const where: string[] = [];
    const params: string[] = [];
    if (deptFilter) { where.push('department_id = ?'); params.push(deptFilter); }
    if (matFilter) { where.push('material_id = ?'); params.push(matFilter); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const cols = columnsOf(db, 'department_material_transactions');
    const hasSource = cols.size === 0 || cols.has('source');

    /* ── reference data ──────────────────────────────────────────────────
     * departments is 19 rows and raw_materials under a thousand, so both load
     * whole. Worth it: every finding needs a NAME (an owner cannot act on a
     * UUID), and holding the map also turns "this id is in the ledger but not
     * in its parent table" into a free finding rather than an extra query. */
    const deptNames = new Map<string, string>();
    for (const d of db.prepare('SELECT id, name FROM departments').all() as Array<{ id: string; name: string }>) {
      deptNames.set(String(d.id), String(d.name || ''));
    }
    const materials = new Map<string, { name: string; category: string }>();
    for (const m of db.prepare('SELECT id, name, category FROM raw_materials').all() as
      Array<{ id: string; name: string; category: string }>) {
      materials.set(String(m.id), { name: String(m.name || ''), category: String(m.category || '') });
    }
    // Store-mapping is decided by CATEGORY, so memoise on it — otherwise the
    // liquor sweep costs one lookup per pair instead of one per category.
    const storeMappedByCategory = new Map<string, boolean>();
    const isLiquor = (materialId: string): boolean => {
      const mat = materials.get(materialId);
      if (!mat) return false;
      const key = mat.category;
      const hit = storeMappedByCategory.get(key);
      if (hit !== undefined) return hit;
      let v = false;
      try { v = isStoreMappedMaterial(db, materialId); } catch { v = false; }
      storeMappedByCategory.set(key, v);
      return v;
    };

    /* ── one pass over the ledger ────────────────────────────────────────── */
    const rows = db.prepare(`
      SELECT rowid AS rid, id, department_id, material_id, type, quantity,
             balance_after, created_at${hasSource ? ', source' : ''}
        FROM department_material_transactions
        ${whereSql}
       ORDER BY rowid ASC
    `).all(...params) as LedgerRow[];

    const pairs = new Map<string, PairState>();
    const rowIssues: Array<Record<string, unknown>> = [];
    const chainBreaks: Array<Record<string, unknown>> = [];
    let rowIssueCount = 0;
    let chainBreakCount = 0;
    let cumulativeMismatchTotal = 0;

    const pushRowIssue = (issue: Record<string, unknown>) => {
      rowIssueCount++;
      if (rowIssues.length < limit) rowIssues.push(issue);
    };

    for (const r of rows) {
      const deptId = String(r.department_id || '');
      const matId = String(r.material_id || '');
      const key = deptKey(deptId, matId);
      const qty = num(r.quantity);
      const at = String(r.created_at || '');

      let p = pairs.get(key);
      if (!p) {
        p = {
          departmentId: deptId, materialId: matId, rows: 0, sum: 0,
          cumulativeMismatches: 0, lastBalanceAfter: null, lastAt: at, firstAt: at,
        };
        pairs.set(key, p);
      }

      const prevBalanceAfter = p.lastBalanceAfter;
      const isFirstOfPair = p.rows === 0;
      p.rows++;
      p.sum += qty;
      p.lastAt = at;

      const material = materials.get(matId);
      const label = {
        row_id: String(r.id || ''),
        rowid: Number(r.rid),
        department_id: deptId,
        department_name: deptNames.get(deptId) || '',
        material_id: matId,
        material_name: material?.name || '',
        type: String(r.type || ''),
        quantity: qty,
        created_at: at,
        source: hasSource ? (r.source ?? null) : null,
      };

      /* row integrity — the corruption classes postDeptLedger refuses at the
       * door but the party rail's direct INSERT can still let through. */
      if (!isDeptTxnType(String(r.type || ''))) {
        pushRowIssue({ ...label, issue: 'unknown_type', detail: 'Type is not in the department vocabulary; reports grouping by type will drop this row.' });
      } else {
        // The one legacy alias ('adjusted') resolves to 'adjustment', whose sign
        // is '±', so declining to resolve aliases here costs no coverage.
        const spec = (DEPT_TXN_TYPES as Record<string, { sign: string } | undefined>)[String(r.type || '')];
        if (spec && spec.sign === '+' && qty < -EPS) {
          pushRowIssue({ ...label, issue: 'sign_contract', detail: `'${label.type}' must be positive (into the department). A negative one reads as an issue in any report summing ABS(quantity) — that is the bug 'issue_reversal' was added to fix.` });
        } else if (spec && spec.sign === '-' && qty > EPS) {
          pushRowIssue({ ...label, issue: 'sign_contract', detail: `'${label.type}' must be negative (out of the department).` });
        }
      }
      if (Math.abs(qty) < EPS) {
        pushRowIssue({ ...label, issue: 'zero_quantity', detail: 'A zero movement teaches the audit that a department received nothing; postDeptLedger refuses these, so this row came from somewhere else.' });
      }
      if (deptId && !deptNames.has(deptId)) {
        pushRowIssue({ ...label, issue: 'unknown_department', detail: 'department_id does not resolve; this stock belongs to nobody and no department screen will ever show it.' });
      }
      if (matId && !materials.has(matId)) {
        pushRowIssue({ ...label, issue: 'unknown_material', detail: 'material_id does not resolve in raw_materials.' });
      }

      /* balance_after: the chain, and the cumulative count */
      if (r.balance_after === null || r.balance_after === undefined) {
        chainBreakCount++;
        if (chainBreaks.length < limit) {
          chainBreaks.push({ ...label, reason: 'missing', balance_after: null, expected: r6(isFirstOfPair ? qty : num(prevBalanceAfter) + qty), running_sum: r6(p.sum) });
        }
        // Carry the running sum forward so one hole does not cascade.
        p.lastBalanceAfter = p.sum;
      } else {
        const stored = num(r.balance_after);
        const expected = isFirstOfPair ? qty : num(prevBalanceAfter) + qty;
        if (Math.abs(stored - expected) > TOLERANCE) {
          chainBreakCount++;
          if (chainBreaks.length < limit) {
            chainBreaks.push({
              ...label,
              reason: isFirstOfPair ? 'chain_start' : 'chain_step',
              balance_after: r6(stored),
              previous_balance_after: isFirstOfPair ? null : r6(num(prevBalanceAfter)),
              expected: r6(expected),
              difference: r6(stored - expected),
              running_sum: r6(p.sum),
              detail: isFirstOfPair
                ? 'First movement for this pair, so balance_after should equal the quantity. A larger figure means the cache row existed before the ledger did.'
                : 'balance_after moved by something other than this row\'s quantity — a writer that is not postDeptLedger touched the cache between the two rows.',
            });
          }
        }
        if (Math.abs(stored - p.sum) > TOLERANCE) {
          p.cumulativeMismatches++;
          cumulativeMismatchTotal++;
        }
        p.lastBalanceAfter = stored;
      }
    }

    /* ── the cache, read separately ──────────────────────────────────────── */
    const cacheWhere: string[] = [];
    const cacheParams: string[] = [];
    if (deptFilter) { cacheWhere.push('department_id = ?'); cacheParams.push(deptFilter); }
    if (matFilter) { cacheWhere.push('material_id = ?'); cacheParams.push(matFilter); }
    const cacheRows = db.prepare(`
      SELECT id, department_id, material_id, on_hand, updated_at
        FROM department_materials
        ${cacheWhere.length ? `WHERE ${cacheWhere.join(' AND ')}` : ''}
    `).all(...cacheParams) as Array<{ id: string; department_id: string; material_id: string; on_hand: number; updated_at: string }>;

    const cache = new Map<string, { id: string; onHand: number; updatedAt: string }>();
    for (const c of cacheRows) {
      cache.set(deptKey(String(c.department_id), String(c.material_id)), {
        id: String(c.id), onHand: num(c.on_hand), updatedAt: String(c.updated_at || ''),
      });
    }

    /* ── THE DRIFT LIST ──────────────────────────────────────────────────
     * Over the UNION of both sides. A cache row with no ledger rows is drift
     * too — it is department stock nothing can explain — and a ledger pair with
     * no cache row is the mirror image. Iterating one side only would silently
     * pass whichever half of the failure it did not look at. */
    const allKeys = new Set<string>([...pairs.keys(), ...cache.keys()]);
    // Pair-level lists are collected WHOLE and capped only after sorting —
    // capping first would report an arbitrary `limit` findings instead of the
    // worst ones, which on a badly drifted database is the difference between
    // a useful report and a random sample. Safe to hold: a pair is a
    // (department, material) and both are catalogues, so the count is bounded
    // by the catalogue, not by trading volume. The ROW-level lists below stay
    // streamed-and-capped for the opposite reason — they grow with every KOT.
    const driftAll: Array<Record<string, unknown>> = [];
    const liquorAll: Array<Record<string, unknown>> = [];

    for (const key of allKeys) {
      const p = pairs.get(key);
      const c = cache.get(key);
      const deptId = p?.departmentId ?? key.slice(0, key.indexOf('|'));
      const matId = p?.materialId ?? key.slice(key.indexOf('|') + 1);
      const ledgerSum = r6(p?.sum ?? 0);
      const cacheOnHand = r6(c?.onHand ?? 0);
      const difference = r6(cacheOnHand - ledgerSum);
      const rowCount = p?.rows ?? 0;

      if (isLiquor(matId)) {
        liquorAll.push({
          department_id: deptId, department_name: deptNames.get(deptId) || '',
          material_id: matId, material_name: materials.get(matId)?.name || '',
          category: materials.get(matId)?.category || '',
          ledger_rows: rowCount, ledger_sum: ledgerSum, cache_on_hand: cacheOnHand,
          detail: 'Store-mapped (TGBCL) material on the department raw-material rail. Both legs of the requisition rail are supposed to skip these — a row here means the carve-out was bypassed and this stock is now counted on two rails.',
        });
      }

      if (Math.abs(difference) > TOLERANCE) {
        driftAll.push({
          department_id: deptId,
          department_name: deptNames.get(deptId) || '',
          material_id: matId,
          material_name: materials.get(matId)?.name || '',
          cache_on_hand: cacheOnHand,
          ledger_sum: ledgerSum,
          difference,
          ledger_rows: rowCount,
          cache_row_exists: !!c,
          cache_row_id: c?.id ?? null,
          cache_updated_at: c?.updatedAt ?? null,
          last_balance_after: p?.lastBalanceAfter ?? null,
          first_movement_at: p?.firstAt ?? null,
          last_movement_at: p?.lastAt ?? null,
          cumulative_balance_after_mismatches: p?.cumulativeMismatches ?? 0,
          within_rounding_noise: Math.abs(difference) <= Math.max(rowCount, 1) * NOISE_PER_ROW,
          detail: !c
            ? 'Ledger movements exist with no cache row at all — every screen reading the cache sees nothing here.'
            : rowCount === 0
              ? 'Cache holds stock this department has no recorded movement for.'
              : 'The cache and the ledger disagree. The LEDGER is the truth; do not edit the cache by hand — find the writer that bypassed postDeptLedger.',
        });
      }
    }
    driftAll.sort((a, b) => Math.abs(Number(b.difference)) - Math.abs(Number(a.difference)));
    const driftCount = driftAll.length;
    const drift = driftAll.slice(0, limit);
    const liquorCount = liquorAll.length;
    const liquorPairs = liquorAll.slice(0, limit);

    /* ── NEGATIVE BALANCES ───────────────────────────────────────────────
     * The balance comes from deptOnHandBulk — the ONE definition — never from a
     * local re-derivation. Three different figures can go negative and they
     * mean three different things, so each is named rather than collapsed:
     *   balance     the anchored on-hand: this department holds less than
     *               nothing since its last count. The operational alarm.
     *   raw_ledger  never counted, and this rail has taken out more than it put
     *               in. It is what the party reconcile's fallback would read as
     *               "held", so it blocks legitimate returns.
     *   cache       the cache alone is negative — every screen reading it shows
     *               a negative holding even if the truth is fine. */
    const deptIds = [...new Set<string>([...allKeys].map((k) => k.slice(0, k.indexOf('|'))).filter(Boolean))];
    const balances: Map<string, DeptOnHandResult> = deptIds.length
      ? deptOnHandBulk(db, deptIds, matFilter ? [matFilter] : undefined)
      : new Map();

    const negativesAll: Array<Record<string, unknown>> = [];
    for (const key of new Set<string>([...allKeys, ...balances.keys()])) {
      const deptId = key.slice(0, key.indexOf('|'));
      const matId = key.slice(key.indexOf('|') + 1);
      if (deptFilter && deptId !== deptFilter) continue;
      if (matFilter && matId !== matFilter) continue;
      const b = balances.get(key);
      const ledgerSum = r6(pairs.get(key)?.sum ?? 0);
      const cacheOnHand = r6(b?.cacheOnHand ?? cache.get(key)?.onHand ?? 0);

      const reasons: string[] = [];
      if (b && !b.neverCounted && (b.onHand ?? 0) < -TOLERANCE) reasons.push('balance');
      if ((!b || b.neverCounted) && ledgerSum < -TOLERANCE) reasons.push('raw_ledger');
      if (cacheOnHand < -TOLERANCE) reasons.push('cache');
      if (reasons.length === 0) continue;

      negativesAll.push({
        department_id: deptId,
        department_name: deptNames.get(deptId) || '',
        material_id: matId,
        material_name: materials.get(matId)?.name || '',
        reasons,
        on_hand: b?.neverCounted ? null : (b?.onHand ?? null),
        never_counted: b?.neverCounted ?? true,
        anchor_qty: b?.anchorQty ?? null,
        anchor_source: b?.anchorSource ?? 'none',
        anchor_at: b?.anchorAt ?? null,
        window_from: b?.windowFrom ?? '',
        movements_since: b?.movementsSince ?? 0,
        ledger_sum: ledgerSum,
        cache_on_hand: cacheOnHand,
        ledger_rows: pairs.get(key)?.rows ?? 0,
        detail: 'A department cannot hold less than nothing. Either a consumption or reversal was posted against stock that was never issued, or the opening count is missing. Post a correction with a reason (type "adjustment") or record a count — never edit a historical row.',
      });
    }
    // Most negative first — the worst holding is the one an owner must see even
    // when the list is capped.
    negativesAll.sort((a, b) => {
      const av = Math.min(Number(a.on_hand ?? 0), Number(a.ledger_sum), Number(a.cache_on_hand));
      const bv = Math.min(Number(b.on_hand ?? 0), Number(b.ledger_sum), Number(b.cache_on_hand));
      return av - bv;
    });
    const negativeCount = negativesAll.length;
    const negatives = negativesAll.slice(0, limit);

    /* ── the report ──────────────────────────────────────────────────────── */
    const cutover = cutoverAt(db);
    const notes: string[] = [];
    if (!cutover) {
      notes.push('The department cutover has not been run (settings.dept_ledger_cutover_at is unset), so no pair has an opening balance yet. Balances read "not counted" rather than 0 — that is the expected state before cutover, not a fault.');
    }
    if (!hasSource) {
      notes.push('This database predates the ledger trace columns (req_item_id / order_item_id / station / source), so findings cannot name the writing route. Balances are unaffected.');
    }
    if (driftAll.some((d) => d.within_rounding_noise)) {
      notes.push('Some drift rows are flagged within_rounding_noise: the gap is smaller than the float dust the two writers can produce between them (party-fulfillment.ts stores unrounded quantities). Treat those as a code smell to fix upstream, not as missing stock.');
    }
    if (liquorCount > 0) {
      notes.push('Store-mapped (liquor) materials appear on the department rail. They are supposed to be carved out of both legs — this is a carve-out breach, and that stock is now represented on two rails at once.');
    }

    const summary = {
      cache_drift: driftCount,
      negative_balances: negativeCount,
      balance_after_chain_breaks: chainBreakCount,
      balance_after_rows_disagreeing_with_running_sum: cumulativeMismatchTotal,
      row_integrity: rowIssueCount,
      liquor_on_department_rail: liquorCount,
    };
    const clean = Object.values(summary).every((n) => n === 0);

    return Response.json({
      ok: true,
      clean,
      checked_at: new Date().toISOString(),
      cutover_at: cutover || null,
      tolerance: TOLERANCE,
      read_only: true,
      scope: { department_id: deptFilter || null, material_id: matFilter || null, limit },
      scanned: { ledger_rows: rows.length, cache_rows: cacheRows.length, pairs: allKeys.size },
      summary,
      truncated: {
        cache_drift: driftCount > drift.length,
        negative_balances: negativeCount > negatives.length,
        balance_after: chainBreakCount > chainBreaks.length,
        row_integrity: rowIssueCount > rowIssues.length,
        liquor_on_department_rail: liquorCount > liquorPairs.length,
      },
      cache_drift: drift,
      negative_balances: negatives,
      balance_after: chainBreaks,
      row_integrity: rowIssues,
      liquor_on_department_rail: liquorPairs,
      notes,
    });
  } catch (e: unknown) {
    console.error('[department-ledger check]', e);
    return Response.json({ error: (e as Error)?.message || 'Failed' }, { status: 500 });
  }
}
