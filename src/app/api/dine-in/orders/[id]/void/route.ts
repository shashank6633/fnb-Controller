import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Void an open order (manager/admin). No sales are written; the table frees up.
 *
 * A void is a "this never happened" record, so it is only honest while nothing
 * has actually left a shelf. Once the kitchen completes a ticket the recipe
 * consume path has already run for those lines (see kds/[id]/bump), and under
 * department stock that gram has come out of the kitchen that cooked it. Voiding
 * afterwards would leave a permanent department debit with no sale behind it —
 * which reads as theft on the very variance report this rail exists to produce.
 * v1 REFUSES instead. Do NOT "fix" this later by posting a compensating credit
 * here: that is a second consumption-reversal movement path, it needs its own
 * negative-balance guard and its own audit type, and it does not belong in a
 * cutover. Refusing is reversible; a stray credit is not.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && me.role !== 'manager') {
      return Response.json({ error: 'Manager role required to void' }, { status: 403 });
    }
    const { id } = await params;
    const db = getDb();
    const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.status !== 'open') return Response.json({ error: 'Only an open order can be voided' }, { status: 409 });

    // THE GATE IS recipe_deducted_at, NOT the KOT status. The stamp is written
    // line-by-line and only on a successful deduct (bump/route.ts stamps inside
    // the loop; settle and hold backstop anything that threw), so it is the only
    // field that answers "did the consume path already run for THIS line". A KOT
    // sitting at 'ready' has cooked nothing on the stock rail and still voids
    // exactly as it did before this change — do not widen the test to kot.status.
    //
    // Note there is no `await` between this read and the UPDATE below.
    // better-sqlite3 is synchronous, so no KDS bump can stamp a line in the gap.
    // Keep it that way: introducing an await here reopens a real TOCTOU.
    const cooked = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(station), ''), '') AS station, COUNT(*) AS n
      FROM order_items
      WHERE order_id = ? AND recipe_deducted_at IS NOT NULL
      GROUP BY 1
    `).all(id) as { station: string; n: number }[];
    const cookedCount = cooked.reduce((s, r) => s + Number(r.n || 0), 0);

    if (cookedCount > 0) {
      // Name the kitchen the guest's food came out of, resolved from the LINE's
      // own station through the admin-owned map — never guessed from kot.station
      // (kot-fire coerces a blank station to the literal 'kitchen', and 'Kitchen'
      // is a real department). An unmapped station (sushi, terracegrill, blank)
      // resolves to NOTHING here, exactly as applyDeduct skips it rather than
      // debiting a guessed department; the void is still refused, because the
      // stamp means the consume path ran and wrote the inventory_transactions row
      // that Variance and Sales-vs-Purchase read. Do not "simplify" this into
      // "only block when a department resolved" — that would let a voided order
      // quietly keep its consumption in those two reports.
      const departments: string[] = [];
      const unmappedStations: string[] = [];
      try {
        const lookup = db.prepare(`
          SELECT d.name AS name
          FROM station_departments sd
          JOIN departments d ON d.id = sd.department_id
          WHERE sd.is_active = 1 AND lower(trim(sd.station)) = ?
        `);
        for (const row of cooked) {
          const key = String(row.station || '').toLowerCase();
          const hit = key ? (lookup.get(key) as any) : null;
          // Department names carry stray double spaces in live data
          // ("Akan  Indian"); collapse for display only, never for matching.
          const name = hit?.name ? String(hit.name).replace(/\s+/g, ' ').trim() : '';
          if (name) { if (!departments.includes(name)) departments.push(name); }
          else {
            const label = row.station || '(no station)';
            if (!unmappedStations.includes(label)) unmappedStations.push(label);
          }
        }
      } catch (e) {
        // Map table absent or unreadable (it is admin-owned and may be unseeded).
        // Fail toward an unnamed department rather than a guessed one — the refusal
        // itself must not depend on the map being configured.
        console.error('[/api/dine-in/orders/[id]/void] station_departments unreadable', e);
        for (const row of cooked) {
          const label = row.station || '(no station)';
          if (!unmappedStations.includes(label)) unmappedStations.push(label);
        }
      }

      const where = departments.length === 0
        ? 'department'
        : departments.length === 1
          ? departments[0]
          : `${departments.slice(0, -1).join(', ')} and ${departments[departments.length - 1]}`;

      return Response.json({
        error: `This order cannot be voided — ${cookedCount} item(s) were already cooked and their ingredients have come out of ${where} stock. Void is only available before the kitchen completes a ticket.`,
        code: 'ORDER_ALREADY_CONSUMED',
        cooked_items: cookedCount,
        departments,
        // Stations whose department could not be resolved: nothing moved on the
        // department rail for these, but the consumption record exists. Carried
        // for the caller/logs; the operator-facing sentence stays as above.
        unmapped_stations: unmappedStations,
      }, { status: 400 });
    }

    const b = await req.json().catch(() => ({}));
    db.prepare(`
      UPDATE orders SET status = 'void', voided_at = datetime('now'),
             notes = TRIM(COALESCE(notes,'') || ' [void: ' || ? || ']'), updated_at = datetime('now')
      WHERE id = ?
    `).run(String(b.reason || '').slice(0, 200), id);
    return Response.json({ success: true });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/void]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
