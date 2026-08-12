import { getDb } from '@/lib/db';
import { getCurrentOutletId, getCurrentUser } from '@/lib/auth';
import { getCentralStoreCutoverDate, cutoverReportBasis, cutoverStampedWithoutBatch } from '@/lib/central-cutover';

/**
 * Daily Closing Roll-up — Phase 1 §6 spec.
 *
 *   For each (material, day) in the requested range:
 *     Opening   = current_stock at start-of-day
 *               = (purchases before day) − (sales/party/staff_meal/wastage before day)
 *     Received  = purchases ON the day
 *     Consumed  = recipe + wastage ON the day
 *     Closing   = Opening + Received − Consumed
 *     Counted   = closing_stock.physical_stock for the day (NULL if no count)
 *     Variance  = Closing − Counted  (positive = leakage between recorded & physical)
 *
 * Query params:
 *   from, to       — date range (default last 7 days)
 *   material_id    — single material drill-down
 *   only_counted   — '1' restricts to days that have a physical count
 *
 * Output is sorted by date ASC, material name ASC. Suitable for an Excel-style table.
 *
 * ── THE CENTRAL-STORE CUTOVER FLOOR, AND THE OPENING IT SEEDS ──────────────
 * With NO cutover committed (settings.central_store_cutover_at absent — every
 * install as this shipped, production included) cutoverReportBasis() returns
 * null, `from` is requestedFrom by identity, every prepared statement takes the
 * same parameters as before, and the payload has no `cutover` key: byte-
 * identical to the pre-cutover build. That is the whole contract of the null.
 *
 * Once a cutover IS committed:
 *   · `from` is clamped up to the DAY AFTER the cutover date. Days before the
 *     cutover reconciled against a book that had drifted for months, so their
 *     variance was missing paperwork, not loss; the cutover DAY ITSELF is
 *     excluded too, because the counted figure IS that day's closing position
 *     (src/lib/central-cutover.ts, "STRICTLY AFTER, AND WHY THAT IS SAFE") and
 *     re-opening the same day from it would count that day's movements twice.
 *   · `running` is SEEDED FROM THE COUNT for every material the cutover
 *     counted, and the two opening sub-sums are floored at the cutover date, so
 *     the Opening on the first reported day is the counted shelf plus whatever
 *     was recorded between the cutover and `from`. It used to be seeded from
 *     ALL-TIME history and carried every month of pre-cutover drift forward
 *     through `running = closing`.
 *   · A material with NO cutover line keeps the ALL-TIME seed, row by row, and
 *     is labelled `basis: 'all_time'`. It was never counted, so it has no
 *     trustworthy opening — seeding it at 0 would invent a shortage of its
 *     whole stock.
 *
 * WHAT IS STILL NOT MODELLED HERE, cutover or no cutover: `Consumed` counts the
 * recipe rail ('sale') and wastage only. Requisition issues to departments and
 * non-chargeable ('nc') consumption are NOT subtracted, so Closing reads HIGH
 * for anything issued out of the store. `cutover.note` says so on screen; the
 * Central Store variance report (/api/variance-report) is the surface that
 * models the full central outflow.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The IST-business-date day after `d`. The first day this roll-up can report
 *  after a cutover: the counted figure is the cutover day's CLOSING position,
 *  so the day it re-opens is the next one. */
const dayAfter = (d: string) =>
  new Date(Date.parse(String(d).slice(0, 10) + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);

/** The on-screen label for the cutover floor — built server-side so the screen
 *  and the CSV export read it from the same place as the clamp itself.
 *  `withOpening` is false in the one state where a stamp exists but its batch
 *  does not, because then no opening can be seeded and saying otherwise would
 *  be a lie on screen. */
const cutoverNote = (d: string, first: string, withOpening: boolean) =>
  'Stock cutover ' + d + '. This roll-up starts on ' + first + ': days before the cutover reconciled against a book '
  + 'that had drifted for months (their variance was missing paperwork, not loss), and the cutover day itself is '
  + 'excluded because the counted figure IS that day’s closing position. Rows are missing because they were '
  + 'excluded, not because nothing happened. '
  + (withOpening
    ? 'Opening on ' + first + ' is now taken from the CUTOVER COUNT plus anything recorded after ' + d
      + ', for every material the cutover counted. A material that was NOT counted keeps the old all-time opening '
      + 'and is marked "all_time" on its rows — its variance still carries pre-cutover drift.'
    : 'The cutover date is stamped but the batch behind it is missing, so no counted opening could be read: every '
      + 'Opening below is still the ALL-TIME figure and still carries pre-cutover drift.')
  + ' STILL TO WATCH: Consumed here counts recipe sales and wastage only — requisition issues to departments and '
  + 'non-chargeable (nc) consumption are NOT subtracted, so Closing reads high for anything issued out of the store.';

export async function GET(request: Request) {
  try {
    const db = getDb();
    // Blind count: this whole report reconciles expected vs counted stock, so the
    // system figure is derivable from opening+received-consumed. It is admin-only
    // (the /daily-rollup page is adminOnly too) — 403 for everyone else.
    const me = await getCurrentUser();
    if (me?.role !== 'admin') {
      return Response.json({ error: 'Daily roll-up is available to admins only.' }, { status: 403 });
    }
    const url = new URL(request.url);
    const requestedFrom = url.searchParams.get('from') || (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })();
    const to   = url.searchParams.get('to')   || new Date().toISOString().slice(0, 10);
    // HARD central-store cutover floor. Clamping `from` (rather than adding a
    // clause) is deliberate because `from` is this report's only lower bound: it
    // drives the day series, every per-day window, AND the opening seed.
    // Unstamped, getCentralStoreCutoverDate returns null and `from` is
    // requestedFrom by identity — the day series, every prepared statement's
    // params and the payload are byte-identical to the pre-cutover build.
    // A window that lies entirely before the floor yields an empty day series
    // and zero rows; `cutover.note` on the payload says that is exclusion, not
    // an absence of counts.
    const cutoverDate = getCentralStoreCutoverDate(db);
    // The first reportable day is the day AFTER the count, not the count day —
    // the counted figure is that day's CLOSING position, so re-opening the same
    // day from it would count that day's own movements twice.
    const cutoverFirstDay = cutoverDate ? dayAfter(cutoverDate) : null;
    const from = (cutoverFirstDay && requestedFrom < cutoverFirstDay) ? cutoverFirstDay : requestedFrom;
    // The batch whose counted lines ARE the openings. null when nothing is
    // stamped (the ordinary case) AND in the hand-edited "stamp without a
    // batch" state, where the all-time seed is kept and the note says so.
    const basis = cutoverReportBasis(db);
    const openingMap = new Map<string, number>();
    if (basis) {
      for (const l of db.prepare(
        'SELECT material_id, counted_qty_recipe FROM central_cutover_lines WHERE batch_id = ?',
      ).all(basis.batchId) as Array<{ material_id: string; counted_qty_recipe: number }>) {
        openingMap.set(l.material_id, Number(l.counted_qty_recipe) || 0);
      }
    }
    const materialId = url.searchParams.get('material_id') || '';
    const onlyCounted = url.searchParams.get('only_counted') === '1';
    const outletId = await getCurrentOutletId();

    // Build the date series in JS — works across SQLite versions without recursive CTEs.
    const days: string[] = [];
    for (let d = new Date(from); d.toISOString().slice(0,10) <= to; d.setDate(d.getDate()+1)) {
      days.push(d.toISOString().slice(0,10));
    }

    // Pull all materials in scope.
    const materials = (materialId
      ? db.prepare('SELECT id, name, sku, unit, pack_size, purchase_unit, average_price FROM raw_materials WHERE id = ?').all(materialId)
      : db.prepare(`
          SELECT id, name, sku, unit, pack_size, purchase_unit, average_price
          FROM raw_materials
          WHERE id IN (
            SELECT material_id FROM purchases WHERE date BETWEEN ? AND ?
            UNION SELECT material_id FROM inventory_transactions WHERE DATE(created_at) BETWEEN ? AND ?
            UNION SELECT material_id FROM closing_stock WHERE date BETWEEN ? AND ?
          )
        `).all(from, to, from, to, from, to)
    ) as any[];

    // Per material, fetch:
    //   - opening at start of "from" (purchases before from − consumption before from)
    //   - per-day received (purchases)
    //   - per-day consumed_recipe + consumed_wastage
    //   - closing-stock counts in range
    // Purchases are stored in PURCHASE units; consumption in RECIPE units. Keep
    // them separate here so we can scale ONLY purchases by the pack factor (below)
    // before subtracting consumption — otherwise opening/closing mixes unit systems
    // for pack-bought items (bottles/tins) and variance is meaningless.
    const openingStmt = db.prepare(`
      SELECT
        COALESCE((SELECT SUM(quantity) FROM purchases WHERE material_id = ? AND date < ?), 0) AS purch_before,
        COALESCE((SELECT SUM(ABS(quantity)) FROM inventory_transactions
                    WHERE material_id = ? AND type IN ('sale','party','staff_meal','wastage')
                      AND DATE(created_at) < ?), 0) AS cons_before
    `);
    // THE SAME TWO SUMS, FLOORED AT THE CUTOVER. Prepared only when a cutover is
    // in force, and used only for a material the cutover actually counted: its
    // seed is the counted figure, so the window must start where that count
    // stops. Same type list as openingStmt above on purpose — the floor is the
    // only difference, and changing the vocabulary here would move numbers that
    // have nothing to do with the cutover.
    const openingSinceCutStmt = basis ? db.prepare(`
      SELECT
        COALESCE((SELECT SUM(quantity) FROM purchases
                    WHERE material_id = ? AND date > ? AND date < ?), 0) AS purch_before,
        COALESCE((SELECT SUM(ABS(quantity)) FROM inventory_transactions
                    WHERE material_id = ? AND type IN ('sale','party','staff_meal','wastage')
                      AND DATE(created_at) > ? AND DATE(created_at) < ?), 0) AS cons_before
    `) : null;
    const receivedStmt = db.prepare(`
      SELECT date, COALESCE(SUM(quantity), 0) AS qty
      FROM purchases WHERE material_id = ? AND date BETWEEN ? AND ?
      GROUP BY date
    `);
    const consumedRecipeStmt = db.prepare(`
      SELECT DATE(created_at) AS date, COALESCE(SUM(ABS(quantity)), 0) AS qty
      FROM inventory_transactions
      WHERE material_id = ? AND type IN ('sale','party','staff_meal')
        AND DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at)
    `);
    const consumedWastageStmt = db.prepare(`
      SELECT DATE(created_at) AS date, COALESCE(SUM(ABS(quantity)), 0) AS qty
      FROM inventory_transactions
      WHERE material_id = ? AND type = 'wastage'
        AND DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at)
    `);
    const countStmt = db.prepare(`
      SELECT date, physical_stock FROM closing_stock
      WHERE material_id = ? AND date BETWEEN ? AND ?
    `);

    const rows: any[] = [];
    for (const m of materials) {
      // Recipe-units per purchase-unit: pack_size when the item is pack-bought
      // (pack_size > 1) AND recipe unit ≠ purchase unit — the same guard every
      // purchase writer + the variance report use.
      const factor = (Number(m.pack_size) > 1
        && String(m.unit || '').toLowerCase() !== String(m.purchase_unit || m.unit || '').toLowerCase())
        ? Number(m.pack_size) : 1;

      // THE SEED. counted_qty_recipe is already in RECIPE units (it is the
      // figure commitBatch wrote to current_stock), so it is added raw; only
      // purchases need the pack factor.
      const counted = basis ? openingMap.get(m.id) : undefined;
      const onCutoverBasis = counted !== undefined;
      const openingRow = (onCutoverBasis && openingSinceCutStmt
        ? openingSinceCutStmt.get(m.id, basis!.date, from, m.id, basis!.date, from)
        : openingStmt.get(m.id, from, m.id, from)) as any;
      // Opening in RECIPE units: scale purchases-before by the factor, keep
      // consumption-before as-is (already recipe units).
      let running = (counted ?? 0)
        + (Number(openingRow.purch_before) || 0) * factor - (Number(openingRow.cons_before) || 0);

      const recv = new Map((receivedStmt.all(m.id, from, to) as any[]).map(r => [r.date, Number(r.qty) * factor]));
      const rcp  = new Map((consumedRecipeStmt.all(m.id, from, to) as any[]).map(r => [r.date, Number(r.qty)]));
      const wst  = new Map((consumedWastageStmt.all(m.id, from, to) as any[]).map(r => [r.date, Number(r.qty)]));
      const cnt  = new Map((countStmt.all(m.id, from, to) as any[]).map(r => [r.date, Number(r.physical_stock)]));

      for (const day of days) {
        const received = recv.get(day) || 0;
        const consumedRecipe  = rcp.get(day) || 0;
        const consumedWastage = wst.get(day) || 0;
        const consumed = consumedRecipe + consumedWastage;
        const closing  = running + received - consumed;
        const counted  = cnt.has(day) ? cnt.get(day)! : null;
        const variance = counted != null ? (closing - counted) : null;

        if (onlyCounted && counted == null) {
          running = closing; continue;
        }
        // Skip totally inactive days (no activity AND no count) to keep the report compact.
        if (received === 0 && consumed === 0 && counted == null && running === 0) {
          running = closing; continue;
        }
        rows.push({
          date: day,
          material_id: m.id, material_name: m.name, material_sku: m.sku,
          unit: m.unit, pack_size: m.pack_size, purchase_unit: m.purchase_unit,
          average_price: m.average_price,
          opening: running, received, consumed_recipe: consumedRecipe,
          consumed_wastage: consumedWastage, consumed,
          closing, counted, variance,
          loss_value: variance != null ? variance * (m.average_price || 0) : null,
          // Which opening this material's running balance came from. Added only
          // when a cutover is in force, so an unstamped payload gains no key.
          ...(basis ? { basis: onCutoverBasis ? 'cutover' : 'all_time' } : {}),
        });
        running = closing;
      }
    }
    rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.material_name.localeCompare(b.material_name));

    // Top-line summary
    let total_loss_value = 0, days_with_count = new Set<string>();
    for (const r of rows) {
      if (r.variance != null) total_loss_value += r.loss_value || 0;
      if (r.counted != null)  days_with_count.add(r.date);
    }
    return Response.json({
      range: { from, to, days: days.length },
      summary: { rows: rows.length, days_with_count: days_with_count.size, total_loss_value },
      rows,
      // Spread, not a null field: with no cutover stamped the payload has no
      // `cutover` key and is byte-identical to the pre-cutover build.
      ...(cutoverDate ? {
        cutover: {
          date: cutoverDate,
          /** The earliest day this roll-up can report — quote THIS as the floor. */
          first_day: cutoverFirstDay,
          requested_from: requestedFrom,
          /** Materials whose Opening was seeded from the cutover count. */
          materials_opened_from_count: basis ? openingMap.size : 0,
          note: cutoverNote(cutoverDate, String(cutoverFirstDay), !!basis),
          ...(cutoverStampedWithoutBatch(db) ? { stamp_without_batch: true } : {}),
        },
      } : {}),
    });
  } catch (e: any) {
    console.error('[daily-rollup]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
