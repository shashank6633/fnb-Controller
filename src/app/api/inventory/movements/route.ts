import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { listStores, userStoreAccess } from '@/lib/store-engine';
import { canSeeAllDeptStock, allowedDeptIds } from '@/lib/dept-stock';
import { MOVEMENT_PARTY_KINDS, CENTRAL_TXN_TYPES } from '@/lib/movement-record';
import { DEPT_TXN_TYPES } from '@/lib/dept-ledger';
import { packFactor } from '@/lib/pack-units';

/**
 * GET /api/inventory/movements — THE MOVEMENT REGISTER.
 * ============================================================================
 *
 * One filterable list of every stock movement in the building, across the three
 * rails that carry them, showing the owner's eight fields on every row:
 *
 *   1 item · 2 quantity · 3 unit of measure · 4 source · 5 destination ·
 *   6 movement type · 7 transaction date · 8 responsible user
 *
 * ── WHY A NEW SURFACE AND NOT AN EXTENSION ─────────────────────────────────
 * The nearest existing thing is GET /api/stores/[id]/ledger, behind the Liquor
 * Store page's ledger tab. It was measured against the requirement and cannot
 * meet it without becoming a different route:
 *   · it reads ONE table (store_stock_ledger), so it can never show a
 *     department issue or a central purchase — two of the three rails;
 *   · it is scoped to ONE store by its path parameter, so "filter by store"
 *     means navigating, not filtering, and "filter by department" is not
 *     expressible at all;
 *   · its gate is that store's own can_view grant.
 * It is EXTENDED where extension is possible — it now returns the same movement
 * columns, so the store tab shows source/destination/unit/actor in place — but
 * the cross-rail register is this route. There is exactly one of them.
 *
 * ── THE UNION, AND WHAT IS NOT RESTATED ────────────────────────────────────
 * Three SELECTs, one shape. Each rail keeps its own column spellings in the
 * database (created_by / user / created_by; txn_type / type / type) and they are
 * NORMALISED HERE, at read, rather than by renaming columns — renaming would
 * rewrite three deployed schemas to save one CASE expression.
 *
 * NO QUANTITY IS COMPUTED FROM THESE ROWS. No balance, no running total, no
 * derived on-hand. This is a register, and the balances have exactly one
 * definition each, elsewhere (deptOnHand, storeStock,
 * raw_materials.current_stock). A second place that adds movements up is a
 * second truth.
 *
 * ROWS are counted — `total`, and `audit_mirrors` as a share of it. That is not
 * the same thing and the distinction is the point: counting how many records
 * matched a filter says nothing about how much stock exists, and without it the
 * Next button cannot know whether there is another page. What is forbidden is
 * summing the QUANTITY column, because that is a balance by another name.
 *
 * ── PRE-CHANGE ROWS ────────────────────────────────────────────────────────
 * Every movement column defaults to '' / 0, so a row written before this
 * feature returns blanks for fields 3, 4, 5 and (on the central rail) 8. That
 * is the honest answer — those facts were never captured — and the UI labels
 * them "not recorded" rather than guessing. The `unrecorded` flag on each row
 * says so explicitly so a caller does not have to test four strings.
 *
 * ── GATE ───────────────────────────────────────────────────────────────────
 * Mirrors its sibling /api/stores/reconciliation: admin / manager /
 * store-manager (is_store_manager) / HOD (is_head_chef). On top of that:
 *   · STORE ROWS are filtered to stores the user may view (userStoreAccess);
 *   · DEPARTMENT ROWS are filtered to the departments a non-privileged user may
 *     see (allowedDeptIds), the same rule /api/department-stock uses;
 *   · MONEY (unit_cost, value) is management-only, the house rule everywhere
 *     else — a store manager sees what moved, not what it cost.
 *
 * ── QUERY ──────────────────────────────────────────────────────────────────
 *   rail=all|store|department|central   (default all)
 *   store_id=<id>        only that store's rows (store rail)
 *   department_id=<id>   only that department's rows (department rail)
 *   type=<movement type> exact match on the rail's own type column
 *   from=YYYY-MM-DD & to=YYYY-MM-DD
 *        Filters on the BUSINESS date where the row has one, falling back to
 *        created_at for pre-change rows — otherwise every historical row would
 *        vanish from a dated search, which is a worse answer than an approximate
 *        one. COALESCE(NULLIF(txn_date,''), date(created_at,'+5 hours','+30 minutes'))
 *        — the shift is what puts a 1 a.m. movement on the right Indian day.
 *   q=<text>             material name, source name or destination name
 *   material_id=<id>
 *   actor=<text>         responsible user contains
 *   limit=<n> (default 200, max 2000) & offset=<n>
 *   format=csv           streams the same rows as CSV, same filters, same gate
 */
export const dynamic = 'force-dynamic';

type Rail = 'store' | 'department' | 'central';

/** Deepest page the merge will serve. Each rail fetches `limit + offset` rows
 *  and the union is sorted in memory, so this is the memory bound as much as a
 *  paging one. 250 pages of 200 is far past the point where filtering is the
 *  right answer, and the CSV export is what bulk reading is for. */
const MAX_OFFSET = 50000;

/** Movement types offered by the filter, per rail. Sourced from the vocabularies
 *  themselves so the picker cannot drift from what the writers actually emit. */
function typeVocabulary() {
  return {
    store: ['opening', 'purchase', 'inward', 'outward', 'adjustment', 'closing', 'transfer'],
    department: Object.keys(DEPT_TXN_TYPES),
    central: Object.keys(CENTRAL_TXN_TYPES),
  };
}

/* THE PURCHASE UNIT LEADS HERE TOO (owner rule, 2026-07-29). This used to run
 * Quantity, Unit, Qty (purchase), Purchase Unit — so column F of the owner's
 * spreadsheet was grams while the screen beside it showed kg, and a SUM() down
 * the leading column was in a different basis from the register that produced
 * it. On a same-unit packed material it also put two different numbers in the
 * same unit in adjacent columns, wrong one first. The recipe figure is kept,
 * because it is what the rows are stored in and a reconciliation needs it — but
 * it is declared as the recipe basis and it follows. */
const CSV_HEADERS = [
  'Date',                 // 7 — business date
  'Recorded At',          // 7 — when it was written (blank on pre-change rows)
  'Rail',
  'Movement Type',        // 6
  'Item',                 // 1
  'Quantity (purchase)',  // 2 — signed, house display basis; LEADS
  'Purchase Unit',        // 3
  'Quantity (recipe)',    // 2 — signed, as stored
  'Recipe Unit',          // 3
  'Pack Size',
  'Source',            // 4
  'Source Type',
  'Destination',       // 5
  'Destination Type',
  'Responsible User',  // 8
  'Reference',
  'Notes',
  // Not one of the eight. It says whether this row IS the movement or the
  // record of one that happened on another rail — without it a spreadsheet
  // SUM() over a mixed export double-counts every sold gram.
  'Audit Mirror',
  // ...and WHY, so a row marked blank above is not mistaken for an ordinary
  // movement: a consumption that no rail booked carries a basis but no mirror.
  'Audit Basis',
];

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const privileged =
      me.role === 'admin' || me.role === 'manager' || me.is_store_manager || me.is_head_chef;
    if (!privileged) {
      return Response.json(
        { error: 'The movement register is for admins, managers, store managers and HODs.' },
        { status: 403 },
      );
    }
    const mgmt = isManagement(me);
    const db = getDb();

    const url = new URL(request.url);
    const railParam = (url.searchParams.get('rail') || 'all').trim();
    const wantRail = (r: Rail) => railParam === 'all' || railParam === r;
    const storeId = (url.searchParams.get('store_id') || '').trim();
    const deptId = (url.searchParams.get('department_id') || '').trim();
    const type = (url.searchParams.get('type') || '').trim();
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const q = (url.searchParams.get('q') || '').trim();
    const materialId = (url.searchParams.get('material_id') || '').trim();
    const actor = (url.searchParams.get('actor') || '').trim();
    const isCsv = (url.searchParams.get('format') || '').toLowerCase() === 'csv';
    // CSV is a download, so it is allowed a bigger window than the screen.
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), isCsv ? 20000 : 2000);
    /* OFFSET IS CAPPED, and it was not. limit was clamped while offset was
     * taken raw, and every rail runs `LIMIT limit + offset` — so ?offset=500000
     * made three rails each ask SQLite for half a million rows and materialised
     * the union in JS before slicing 200 off it. Paging by merge is O(offset) by
     * construction; the cap is what stops a hand-typed URL from turning that
     * into the whole table three times over. Deep paging is not how anyone finds
     * a movement anyway — that is what the filters are for — so the clamped
     * value is returned in `offset` and published as `max_offset` rather than
     * being silently honoured. */
    const offset = Math.min(Math.max(Number(url.searchParams.get('offset')) || 0, 0), MAX_OFFSET);

    // ── SCOPE ────────────────────────────────────────────────────────────────
    // Which stores this user may see. Resolved ONCE and applied as an IN list
    // rather than filtered after the query: a LIMIT applied before the scope
    // check would silently return a short page of someone else's stores.
    const visibleStores = listStores(db)
      .filter(s => userStoreAccess(db, me, s.id).can_view)
      .map(s => s.id);
    const storeScope = storeId
      ? (visibleStores.includes(storeId) ? [storeId] : [])
      : visibleStores;

    // Which departments. A privileged-for-all-departments user sees every one;
    // anyone else sees their own + granted, the same rule as /api/department-stock.
    const allDepts = canSeeAllDeptStock(me);
    const deptAllowed = allDepts ? null : allowedDeptIds(me);
    const deptScope: string[] | null = deptId
      ? ((!deptAllowed || deptAllowed.has(deptId)) ? [deptId] : [])
      : (deptAllowed ? [...deptAllowed] : null);   // null = no restriction

    /* ── WHEN DID THE DEPARTMENT RAIL START? ──────────────────────────────────
     * A consumption 'sale'/'nc' row on the central table is the MIRROR of a
     * department row only if that department row exists. It does not always:
     *
     *   · deductInventoryForSale has five notBooked(...) branches (store-mapped
     *     liquor, station unmapped, recipe deduction switched off, dept post
     *     failed, no department) that write the central row and NO department
     *     row. Those rows carry src_kind 'external' — notBooked returns
     *     { kind: 'external', name: 'Not booked — <why>' } — and for them this
     *     central row is the ONLY record that a gram ever left.
     *   · Rows written before the department ledger existed at all cannot have
     *     a twin either. Department consumption landed 2026-08-06 (44431ea);
     *     the movement columns only landed 2026-09-12 (c6c04cb), so there is a
     *     window of genuine mirrors that carry a BLANK src_kind. A blank is
     *     therefore not evidence of absence, and the naive test
     *     `src_kind = 'department'` would un-flag those and reintroduce the
     *     double count this flag exists to prevent.
     *
     * The rail's own first row settles it without a constant and without
     * guessing: anything written before the earliest department transaction
     * provably has no twin. One indexed lookup per request — EXPLAIN QUERY PLAN
     * reports `SEARCH ... USING COVERING INDEX idx_dept_mat_tx_created`, so it
     * is a single seek, not a scan. '' when the rail has never been written, in
     * which case no central row anywhere can have a twin.
     * ──────────────────────────────────────────────────────────────────────── */
    const deptRailStart = String(
      (db.prepare('SELECT MIN(created_at) AS t FROM department_material_transactions').get() as any)?.t || '',
    );

    /* ── ONE DEFINITION OF "IS THIS ROW A DUPLICATE" ──────────────────────────
     * Read by the shaping step below (to set audit_only on the rows the caller
     * gets) AND by the header tally (to say how many of `total` are mirrors).
     * Declared once so the two can never drift apart and report different
     * numbers about the same rows. Takes the RAW database row — the only
     * columns it reads are the three that decide it. */
    const auditBasisOf = (row: any): '' | 'department' | 'unbooked' | 'pre_dept_rail' | 'unknown' => {
      if (Number(row.consumption_audit) !== 1) return '';
      const kind = String(row.src_kind || '');
      if (kind === 'department') return 'department';
      if (kind) return 'unbooked';
      if (!deptRailStart || String(row.created_at || '') < deptRailStart) return 'pre_dept_rail';
      return 'unknown';
    };
    const isMirror = (row: any) => {
      const b = auditBasisOf(row);
      return b === 'department' || b === 'unknown';
    };

    const rows: any[] = [];
    /** One counter per rail that actually ran, each closing over that rail's own
     *  WHERE clause and arguments. Evaluated after the merge to produce `total`
     *  and the mirror share of it. */
    const counts: Array<() => { n: number; mirrors: number }> = [];

    /* ── THE COUNT IS SKIPPED WHEN THE ROWS ALREADY PROVE IT ──────────────────
     * Each rail is fetched under `LIMIT limit + offset`. If FEWER rows came
     * back than that, the LIMIT did not bind — the WHERE matched exactly what
     * we are holding, and its COUNT(*) can only return the same number. So the
     * count is free in that case and the aggregate is not run at all.
     *
     * This is exact, not an estimate: the only case that still needs the query
     * is a rail whose result filled the window, and that is also the only case
     * where the answer is not already in hand. It matters because the COUNT is
     * the expensive half of a filtered request — it carries the same
     * COALESCE/date() business-date predicate with NO LIMIT, so SQLite must
     * evaluate date() over every row of the rail, and a narrow search (one
     * item, one day — the question this register exists to answer) spent most
     * of its time counting rows the user was never going to look at.
     * ──────────────────────────────────────────────────────────────────────── */
    type Tally = { n: number; mirrors: number };
    const countFor = (fetched: any[], exact: () => Tally): (() => Tally) =>
      fetched.length < limit + offset
        ? () => ({ n: fetched.length, mirrors: fetched.filter(isMirror).length })
        : exact;

    // The business-date expression, shared by all three rails. A row with no
    // txn_date (written before this feature) falls back to its created_at day
    // so it stays findable in a dated search instead of disappearing.
    //
    // THE FALLBACK SHIFTS TO IST, and that is not cosmetic. created_at is
    // written as datetime('now'), i.e. UTC, on every one of these tables, and
    // SQLite's date() on a UTC timestamp yields the UTC day — so a movement
    // recorded between 00:00 and 05:30 IST was filed under the PREVIOUS day and
    // vanished from a `from=<that day>` search. This is a restaurant: the hours
    // either side of midnight are the busy ones. txn_date itself is already
    // stamped in IST by movement-record.businessDate(), so the two halves of
    // this COALESCE now mean the same thing.
    const BIZ = (alias: string) =>
      `COALESCE(NULLIF(${alias}.txn_date, ''), date(${alias}.created_at, '+5 hours', '+30 minutes'))`;

    const dateWhere = (alias: string, where: string[], args: any[]) => {
      if (from) { where.push(`${BIZ(alias)} >= date(?)`); args.push(from); }
      if (to)   { where.push(`${BIZ(alias)} <= date(?)`); args.push(to); }
    };
    const commonWhere = (alias: string, actorCol: string, where: string[], args: any[]) => {
      if (materialId) { where.push(`${alias}.material_id = ?`); args.push(materialId); }
      if (q) {
        where.push(`(rm.name LIKE ? OR ${alias}.src_name LIKE ? OR ${alias}.dst_name LIKE ?)`);
        args.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (actor) { where.push(`${alias}.${actorCol} LIKE ?`); args.push(`%${actor}%`); }
      dateWhere(alias, where, args);
    };

    // ── STORE RAIL ───────────────────────────────────────────────────────────
    if (wantRail('store') && storeScope.length && !deptId) {
      const where: string[] = [`l.store_id IN (${storeScope.map(() => '?').join(',')})`];
      const args: any[] = [...storeScope];
      if (type) { where.push('l.txn_type = ?'); args.push(type); }
      commonWhere('l', 'created_by', where, args);
      const fetched = db.prepare(`
        SELECT 'store' AS rail, l.id, l.txn_type AS movement_type, l.material_id,
               rm.name AS material_name, l.quantity,
               l.uom, l.purchase_uom, l.pack_size,
               l.src_kind, l.src_id, l.src_name, l.dst_kind, l.dst_id, l.dst_name,
               ${BIZ('l')} AS txn_date, l.created_at, l.recorded_at,
               l.created_by AS actor, l.ref AS reference_id, l.notes,
               l.unit_cost, l.store_id AS rail_id, s.name AS rail_name, 0 AS consumption_audit
        FROM store_stock_ledger l
        JOIN raw_materials rm ON rm.id = l.material_id
        LEFT JOIN store_locations s ON s.id = l.store_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${BIZ('l')} DESC, l.created_at DESC, l.rowid DESC
        LIMIT ?
      `).all(...args, limit + offset) as any[];
      for (const r of fetched) rows.push(r);
      // Same FROM, same JOIN, same WHERE, same args — no LIMIT.
      counts.push(countFor(fetched, () => ({
        n: Number((db.prepare(`
          SELECT COUNT(*) AS n
          FROM store_stock_ledger l
          JOIN raw_materials rm ON rm.id = l.material_id
          WHERE ${where.join(' AND ')}
        `).get(...args) as any)?.n || 0),
        mirrors: 0,   // nothing on this rail mirrors another rail
      })));
    }

    // ── DEPARTMENT RAIL ──────────────────────────────────────────────────────
    if (wantRail('department') && !storeId && (deptScope === null || deptScope.length)) {
      const where: string[] = ['1=1'];
      const args: any[] = [];
      if (deptScope) {
        where.push(`t.department_id IN (${deptScope.map(() => '?').join(',')})`);
        args.push(...deptScope);
      }
      if (type) { where.push('t.type = ?'); args.push(type); }
      commonWhere('t', 'user', where, args);
      const fetched = db.prepare(`
        SELECT 'department' AS rail, t.id, t.type AS movement_type, t.material_id,
               rm.name AS material_name, t.quantity,
               t.uom, t.purchase_uom, t.pack_size,
               t.src_kind, t.src_id, t.src_name, t.dst_kind, t.dst_id, t.dst_name,
               ${BIZ('t')} AS txn_date, t.created_at, t.recorded_at,
               t.user AS actor, t.reference_id, t.notes,
               0 AS unit_cost, t.department_id AS rail_id, d.name AS rail_name, 0 AS consumption_audit
        FROM department_material_transactions t
        JOIN raw_materials rm ON rm.id = t.material_id
        LEFT JOIN departments d ON d.id = t.department_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${BIZ('t')} DESC, t.created_at DESC, t.rowid DESC
        LIMIT ?
      `).all(...args, limit + offset) as any[];
      for (const r of fetched) rows.push(r);
      counts.push(countFor(fetched, () => ({
        n: Number((db.prepare(`
          SELECT COUNT(*) AS n
          FROM department_material_transactions t
          JOIN raw_materials rm ON rm.id = t.material_id
          WHERE ${where.join(' AND ')}
        `).get(...args) as any)?.n || 0),
        mirrors: 0,   // this rail IS the movement; the central row mirrors IT
      })));
    }

    // ── CENTRAL RAIL ─────────────────────────────────────────────────────────
    // Skipped when the caller narrowed to a specific store or department: a
    // central row's counterparty may be either, but the row itself belongs to
    // neither, and returning it under a store filter would misattribute it.
    if (wantRail('central') && !storeId && !deptId) {
      const where: string[] = ['1=1'];
      const args: any[] = [];
      if (type) { where.push('i.type = ?'); args.push(type); }
      commonWhere('i', 'created_by', where, args);
      const fetched = db.prepare(`
        SELECT 'central' AS rail, i.id, i.type AS movement_type, i.material_id,
               rm.name AS material_name, i.quantity,
               i.uom, i.purchase_uom, i.pack_size,
               i.src_kind, i.src_id, i.src_name, i.dst_kind, i.dst_id, i.dst_name,
               ${BIZ('i')} AS txn_date, i.created_at, i.recorded_at,
               i.created_by AS actor, i.reference_id, i.notes,
               0 AS unit_cost, '' AS rail_id,
               /* THE RAIL LABEL IS NOT ALWAYS 'Central Store', and calling it
                * that on a sale is the exact picture the owner reported as
                * wrong: "the system applies recipe-based inventory deduction at
                * the Store Level whenever an item is sold". It does not — the
                * balance never moves (proved) — but this label SAID it did, on
                * every sold line, while the row's own src_kind said
                * 'department'. A row is only a central movement when central is
                * actually one of its ends; a 'sale'/'nc' row is the consumption
                * AUDIT that every variance report reads, filed on this table
                * because that is where those reports look, and it is labelled
                * as what it is. */
               CASE WHEN i.type IN ('sale', 'nc')
                    THEN 'Recipe consumption (audit)'
                    ELSE 'Central Store' END AS rail_name,
               /* SAYS ONLY WHAT SQL KNOWS: this row is a consumption AUDIT, so
                * it never moved the central book. Whether the grams ALSO appear
                * as a department row — i.e. whether adding this register up
                * would double-count them — is a different question, decided in
                * the shaping step below where the row's src_kind and the
                * department rail's own start date are both in hand. */
               CASE WHEN i.type IN ('sale', 'nc') THEN 1 ELSE 0 END AS consumption_audit
        FROM inventory_transactions i
        JOIN raw_materials rm ON rm.id = i.material_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${BIZ('i')} DESC, i.created_at DESC, i.rowid DESC
        LIMIT ?
      `).all(...args, limit + offset) as any[];
      for (const r of fetched) rows.push(r);
      /* The mirror share rides on the SAME scan as the count — one extra
       * conditional, no second pass over the table. The CASE is the SQL
       * spelling of auditBasisOf() above and must stay in step with it:
       * 'department' is a mirror, a blank src_kind written after the department
       * rail started is assumed to be one, and everything else is not. */
      counts.push(countFor(fetched, () => {
        const row = db.prepare(`
          SELECT COUNT(*) AS n,
                 SUM(CASE WHEN i.type IN ('sale','nc')
                           AND ( i.src_kind = 'department'
                                 OR ( COALESCE(i.src_kind,'') = ''
                                      AND ? <> ''
                                      AND i.created_at >= ? ) )
                          THEN 1 ELSE 0 END) AS mirrors
          FROM inventory_transactions i
          JOIN raw_materials rm ON rm.id = i.material_id
          WHERE ${where.join(' AND ')}
        `).get(deptRailStart, deptRailStart, ...args) as any;
        return { n: Number(row?.n || 0), mirrors: Number(row?.mirrors || 0) };
      }));
    }

    // Merge newest-first across rails, then page. Sorted on the BUSINESS date
    // first (that is what the register is about) with created_at as the
    // tie-break, so two movements on the same day keep their recording order.
    rows.sort((a, b) => {
      const d = String(b.txn_date || '').localeCompare(String(a.txn_date || ''));
      if (d !== 0) return d;
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
    const page = rows.slice(offset, offset + limit);

    /* ── THE COUNT IS COUNTED, NOT MEASURED OFF THE PAGE ──────────────────────
     * `total` used to be `rows.length` — the length of the MERGED, PRE-SLICE
     * array. Each rail is fetched under its own `LIMIT limit + offset`, so that
     * number is capped at offset+limit by construction and is never the real
     * count once the data exceeds one page. On the owner's history it reported
     * "200 movements" against 2,430, and it CHANGED as you paged (400, 600, …),
     * which is worse than being wrong once: the page's own Next button reduces
     * to `offset + limit >= offset + limit`, permanently true, so 2,230 rows
     * were unreachable and the user was told they did not exist.
     *
     * Each rail is therefore counted with its OWN COUNT(*), under exactly the
     * same WHERE clause and the same arguments as its SELECT — built by the
     * same closures, so a filter cannot be added to one and forgotten on the
     * other — and with no LIMIT. Three cheap aggregate reads; the register is
     * an admin surface, not a hot path.
     * ──────────────────────────────────────────────────────────────────────── */
    const tally = counts.reduce(
      (acc, c) => { const v = c(); return { n: acc.n + v.n, mirrors: acc.mirrors + v.mirrors }; },
      { n: 0, mirrors: 0 },
    );
    const total = tally.n;

    const shaped = page.map(r => {
      const pack = Number(r.pack_size) || 0;
      const qty = Number(r.quantity) || 0;
      // The house PURCHASE-unit display, computed from the row's OWN snapshot
      // (never from the live material), so a historical row renders in the
      // basis it was actually recorded in. null when the row predates the
      // snapshot — the UI shows the recipe figure alone rather than a number
      // divided by a pack size that may since have changed.
      //
      // THE DIVISOR IS packFactor(), NOT pack_size. This used to hand-roll the
      // rule as `pack > 0`, which is half of it: the canonical rule in
      // pack-units.ts is `pack_size > 1 AND recipe unit <> purchase unit`, and
      // a SAME-UNIT packed material (PICKLED GINGER 1.5KG — kg/kg/1.5) fails
      // the second half. Under `pack > 0` a 6 kg movement led with "+4 kg" and
      // then declared "= 6 kg" underneath it: one row, one unit, two numbers.
      // Calling the canonical function rather than restating it also means this
      // register cannot drift from the 293 sites the purchase-unit rollout
      // converted — there is one definition of the pack rule and this is it.
      const factor = packFactor({
        unit: r.uom,
        purchase_unit: r.purchase_uom,
        pack_size: r.pack_size,
      });
      const qtyPurchase = factor > 1 ? Math.round((qty / factor) * 1000) / 1000 : null;
      const unrecorded = !String(r.uom || '') && !String(r.src_kind || '') && !String(r.dst_kind || '');

      /* ── IS THIS ROW A DUPLICATE, AND HOW DO WE KNOW? ──────────────────────
       * audit_only answers exactly one question: do these grams ALSO appear on
       * another row of this register? It is a de-duplication flag, not a
       * statement about the central book — every consumption audit row leaves
       * the central book untouched, and audit_basis being non-empty is what
       * says so.
       *
       *   department    src_kind names the department that lost the goods, so
       *                 that department row is in this register → duplicate.
       *   unbooked      notBooked(...) — no rail lost it, so this row is the
       *                 only record there is. Telling the owner to discount it
       *                 was the defect: it is the whole answer to "where did it
       *                 go?" for a store-mapped or unmapped-station line.
       *   pre_dept_rail written before the department ledger's first ever row,
       *                 so a twin cannot exist. PROVED per row, not assumed.
       *   unknown       blank src_kind, written after the rail started. A twin
       *                 may exist and we cannot tell from the row alone, so the
       *                 flag stays TRUE — the conservative answer, because an
       *                 over-cautious dedup hides a row while an under-cautious
       *                 one silently doubles a number.
       * ──────────────────────────────────────────────────────────────────── */
      const auditBasis = auditBasisOf(r);
      const auditOnly = isMirror(r);

      return {
        id: r.id,
        rail: r.rail,
        rail_id: r.rail_id || '',
        rail_name: r.rail_name || '',
        movement_type: r.movement_type,          // 6
        material_id: r.material_id,              // 1
        material_name: r.material_name,          // 1
        quantity: qty,                           // 2 (signed, recipe units)
        uom: r.uom || '',                        // 3
        purchase_uom: r.purchase_uom || '',      // 3
        pack_size: pack,
        qty_purchase: qtyPurchase,               // 2, house display basis
        src_kind: r.src_kind || '',              // 4
        src_id: r.src_id || '',
        src_name: r.src_name || '',
        dst_kind: r.dst_kind || '',              // 5
        dst_id: r.dst_id || '',
        dst_name: r.dst_name || '',
        txn_date: r.txn_date || '',              // 7 (business date)
        created_at: r.created_at,
        recorded_at: r.recorded_at || '',        // 7 (immutable write stamp)
        actor: r.actor || '',                    // 8
        reference_id: r.reference_id || '',
        notes: r.notes || '',
        // MONEY IS MANAGEMENT-ONLY, the same rule as every other surface here.
        // null, not 0 — a store manager must not read "₹0" as "it was free".
        unit_cost: mgmt ? (Number(r.unit_cost) || 0) : null,
        /** True when this row predates the movement record — fields 3/4/5 (and
         *  8 on the central rail) were never captured for it. Not a defect in
         *  the row; a fact about when it was written. */
        unrecorded,
        /** True when the same grams ALSO appear as another row of this
         *  register, so a reader adding it up would count them twice. Today
         *  that is recipe consumption whose department twin exists — see
         *  audit_basis for how each row was decided. The audit row is kept, not
         *  suppressed: for a store-mapped or unmapped-station line it is the
         *  ONLY row there is, and every variance report reads this table. */
        audit_only: auditOnly,
        /** WHY, and the discriminator the row's own badge needs. Non-empty on
         *  every consumption audit row — which is also what says "this row did
         *  not move the central book", true whether or not a twin exists.
         *  '' | 'department' | 'unbooked' | 'pre_dept_rail' | 'unknown'. */
        audit_basis: auditBasis,
      };
    });

    if (isCsv) {
      // Column order matches the on-screen table, and the eight fields lead:
      // date, type, item, quantity+unit, source, destination, user. Excel opens
      // it with a BOM (₹ and Devanagari item names otherwise mojibake).
      const lines = [CSV_HEADERS.join(',')];
      for (const r of shaped) {
        // When the row carries no real pack conversion the two bases ARE the
        // same figure, so the leading column falls back to it rather than going
        // blank — exactly what the on-screen cell does. A blank leading unit
        // still means "not recorded", which is the honest answer.
        const leadQty = r.qty_purchase === null ? r.quantity : r.qty_purchase;
        const leadUom = r.qty_purchase === null ? r.uom : r.purchase_uom;
        lines.push([
          r.txn_date, r.recorded_at, r.rail, r.movement_type, r.material_name,
          leadQty, leadUom,
          r.quantity, r.uom,
          r.pack_size || '',
          r.src_name, r.src_kind, r.dst_name, r.dst_kind,
          r.actor, r.reference_id, r.notes,
          r.audit_only ? 'Yes' : '',
          r.audit_basis,
        ].map(csvCell).join(','));
      }
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response('﻿' + lines.join('\r\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="stock-movements-${stamp}.csv"`,
        },
      });
    }

    return Response.json({
      movements: shaped,
      total,
      /** How many of `total` are audit mirrors — rows whose grams are already
       *  counted by another row in the same result. Published so the header can
       *  qualify its own number instead of presenting a row count that silently
       *  counts each sold gram twice. The per-row flag says which; this says how
       *  many, over the WHOLE filtered set rather than the visible page. */
      audit_mirrors: tally.mirrors,
      limit,
      offset,
      /** The offset ceiling, so a caller that hits it can say "narrow the
       *  filters" rather than serving the same page forever. */
      max_offset: MAX_OFFSET,
      /* ── "NO ROWS" IS TWO DIFFERENT ANSWERS ────────────────────────────────
       * "Your filter matched nothing" and "this rail has never been written"
       * look identical from the outside, and on this data the second one is the
       * true answer far more often than anyone expects: 14,149 requisition
       * issue lines (214,790 units across 701 materials) carry no row on ANY
       * rail, because they were imported and the issue ledger recorded a single
       * skip — stock_applied 0, skip_reason 'flag_off'. A register that answers
       * "no movements match these filters" there sends the owner back to check
       * a filter that was never the problem.
       *
       * So when nothing matched, and ONLY then, say how many rows each rail
       * holds in total. Three unfiltered counts on the one path where the user
       * is already stuck; nothing added to the hot path. A zero here means the
       * rail is empty and no filter would have helped. */
      rail_rows: total > 0 ? null : {
        store: Number((db.prepare('SELECT COUNT(*) AS n FROM store_stock_ledger').get() as any)?.n || 0),
        department: Number((db.prepare('SELECT COUNT(*) AS n FROM department_material_transactions').get() as any)?.n || 0),
        central: Number((db.prepare('SELECT COUNT(*) AS n FROM inventory_transactions').get() as any)?.n || 0),
      },
      can_see_value: mgmt,
      // Filter options, derived rather than hardcoded in the page.
      stores: listStores(db)
        .filter(s => visibleStores.includes(s.id))
        .map(s => ({ id: s.id, name: s.name, is_active: s.is_active })),
      departments: (db.prepare('SELECT id, name FROM departments ORDER BY name').all() as any[])
        .filter(d => !deptAllowed || deptAllowed.has(d.id)),
      types: typeVocabulary(),
      party_kinds: MOVEMENT_PARTY_KINDS,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
