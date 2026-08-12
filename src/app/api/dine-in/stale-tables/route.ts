import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import { computeBill, sumItemTax, round2 } from '@/lib/bill-calc';
import {
  listIdleOpenOrders, sweepStaleTables, closeEmptyOrdersByHand,
  type IdleOpenOrder,
} from '@/lib/stale-tables';

/**
 * IDLE OPEN TABLES — the manager's decision screen, served.
 * ─────────────────────────────────────────────────────────
 * Nothing in this app has ever closed an open order. Measured on the live
 * database on 2026-08-12, eleven orders were still 'open': one 765 hours old
 * (32 days, 1 item, ₹279 of food), one 527 hours old (22 days, 3 items), and
 * nine empty ones about 17 hours old. Every one of them is still holding its
 * table on the cashier floor and the captain screens, because
 * /api/dine-in/tables joins orders ON o.status = 'open'.
 *
 * THE ASYMMETRY THIS ROUTE EXISTS TO PRESERVE
 * -------------------------------------------
 *   · EMPTY (zero order_items) — no bill, no money, nothing consumed. A timer
 *     may close these, and so may the manager, through ONE guarded writer.
 *   · HAS ITEMS — money is attached. A timer must NEVER decide its fate.
 *     Auto-settling invents revenue nobody collected; auto-voiding writes off
 *     food that was probably eaten and paid for in cash. These are FLAGGED for
 *     a human and nothing else.
 * The lists are returned separately and `with_items` carries no close action of
 * any kind. The POST below is `close_empty` — there is deliberately no verb on
 * this route that can close an order with items.
 *
 * WHO CLOSES WHAT, AND THROUGH WHAT
 * ---------------------------------
 *   empty, from this screen  → closeEmptyOrdersByHand() in src/lib/stale-tables.ts
 *       The same guarded UPDATE the timed sweep uses. Its NOT EXISTS on
 *       order_items is part of the statement, so it is structurally incapable
 *       of selecting an order that has a line — including one punched between
 *       the manager reading the list and clicking. It also stamps
 *       orders.auto_close_reason, so an automatic close and a human one stay
 *       distinguishable in any later report. That is strictly safer here than
 *       the generic void route, which would take any order id it is handed.
 *   has items                → the EXISTING /api/dine-in/orders/[id]/settle and
 *       .../void routes, called by the page directly. Every rule they enforce —
 *       settle-authority's floor/cashier model, payment validation, the sales +
 *       inventory writes, void's refusal once a ticket has been cooked — still
 *       applies, because this feature adds no second path around them.
 *
 * WHY THE LIST CAN BE WIDER THAN THE SWEEP
 * ----------------------------------------
 * `hours` (the review threshold) is what the manager is looking at; the
 * stale_table_auto_close_hours setting is what the sweep acts on, and it is 0
 * (OFF) until the owner turns it on. Independent on purpose — the screen has to
 * be usable BEFORE anything is switched on. The single coupling is a floor:
 * when the window is on and shorter than the review threshold, the list widens
 * to the window, so it can never hide an empty table the sweep is about to
 * close.
 */

/** Default review threshold, in hours, when the caller passes none. Three hours
 *  is long enough that a normal dinner service — order, courses, dessert, bill —
 *  never appears here, and short enough to catch a table the floor has walked
 *  away from before the shift ends. */
const DEFAULT_REVIEW_HOURS = 3;

/** Ceiling on the review threshold a caller may ask for (~1 year of hours).
 *  Keeps a hand-typed ?hours=999999999 from producing a nonsense window. */
const MAX_REVIEW_HOURS = 8760;

/** Lines shown per row before the "+n more" tail. */
const ITEM_PREVIEW = 6;

/** The bill_design settings computeBill needs. Same shape and defaults as the
 *  settle route's loader, so the money shown here is the money the cashier
 *  would collect. */
function loadBillDesign(db: ReturnType<typeof getDb>) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'bill_design'").get() as any;
  let d: any = {};
  if (row?.value) { try { d = JSON.parse(row.value) || {}; } catch { d = {}; } }
  return {
    serviceChargeOn: d.serviceChargeOn !== false,
    serviceChargePct: Number(d.serviceChargePct) || 0,
    cgstPct: d.cgstPct == null ? 2.5 : Number(d.cgstPct) || 0,
    sgstPct: d.sgstPct == null ? 2.5 : Number(d.sgstPct) || 0,
  };
}

/** What the screen adds on top of an IdleOpenOrder from the lib. */
type DecoratedRow = IdleOpenOrder & {
  /** Up to ITEM_PREVIEW lines, dearest first. */
  items: { name: string; quantity: number; line_total: number }[];
  more_items: number;
  /** What the cashier would collect if this were settled right now. */
  value: number;
  /** Lines the void route would refuse on (advisory — see below). */
  cooked_items: number;
};

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    // Management only. This lists what every open table is WORTH and fronts the
    // buttons that take the money or write it off, so it is not a floor
    // surface. The page carries mgmtOnly in src/lib/page-catalog.ts; this 403 is
    // the actual boundary — the catalog flag only hides the link.
    if (!isManagement(me)) {
      return Response.json({ error: 'Management access required (Admin, Manager or HOD)' }, { status: 403 });
    }

    const db = getDb();
    const outletId = await getCurrentOutletId();
    const url = new URL(request.url);

    // OPPORTUNISTIC SWEEP. Cheap by design: with the window OFF (the shipped
    // default) it is one settings lookup and touches nothing, and its own
    // 60s throttle keeps this page's 60s poll from re-running the UPDATE every
    // tick. It is NOT the only trigger — scheduler.ts runs the same sweep on its
    // cadence, so tables still free themselves on a day nobody opens this page.
    // Best-effort by contract: it swallows its own errors, so a sweep failure
    // can never fail the read the manager is waiting on.
    const swept = sweepStaleTables();

    const askedRaw = url.searchParams.get('hours');
    const asked = askedRaw == null ? DEFAULT_REVIEW_HOURS : Number(askedRaw);
    // 0 (or anything unparseable) means "show every open table".
    let reviewHours = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_REVIEW_HOURS) : 0;

    // The lib is the single definition of idle (MAX(order_items.created_at),
    // falling back to orders.created_at) and of the empty/has-items split.
    // Nothing about that is recomputed here.
    const report = listIdleOpenOrders({ db, outletId, minIdleHours: reviewHours });

    // FLOOR THE LIST AT THE SWEEP. If the owner sets a 2-hour window while the
    // manager is looking at a 6-hour list, empties between 2h and 6h would be
    // closing without ever having appeared on screen. Widen and re-read.
    let widened = false;
    if (report.window_hours > 0 && reviewHours > report.window_hours) {
      reviewHours = report.window_hours;
      widened = true;
    }
    const list = widened ? listIdleOpenOrders({ db, outletId, minIdleHours: reviewHours }) : report;

    const design = loadBillDesign(db);
    const itemStmt = db.prepare(`
      SELECT name, quantity, unit_price, line_total, tax_value
      FROM order_items WHERE order_id = ? ORDER BY line_total DESC, name
    `);
    // ADVISORY ONLY. The same two conditions the void route gates on
    // (order_items.recipe_deducted_at, or the line's KOT stamped served_at), so
    // the screen can grey out a Void that would be refused and say why, instead
    // of firing a request that 400s. It is NOT the gate: the void route re-reads
    // this itself, inside the same synchronous span as its UPDATE, and that read
    // is the authority. Nothing here decides anything.
    const cookedStmt = db.prepare(`
      SELECT COUNT(*) AS n
      FROM order_items oi
      LEFT JOIN kots k ON k.id = oi.kot_id
      WHERE oi.order_id = ?
        AND (oi.recipe_deducted_at IS NOT NULL
             OR NULLIF(TRIM(COALESCE(k.served_at, '')), '') IS NOT NULL)
    `);
    // The bill adjustments the lib's row does not carry. Read per order so the
    // quoted figure includes a discount or a waived service charge a cashier
    // already applied — quoting the undiscounted total would overstate what is
    // actually collectable on a table that has been sitting for weeks.
    const adjStmt = db.prepare(
      'SELECT discount, discount_pct, service_charge_reason FROM orders WHERE id = ?',
    );

    /** Money + lines for a row that has items. An empty row is decorated with
     *  zeroes without touching the database — it has nothing to read. */
    const decorate = (r: IdleOpenOrder): DecoratedRow => {
      if (r.item_count === 0) {
        return { ...r, items: [], more_items: 0, value: 0, cooked_items: 0 };
      }
      const lines = itemStmt.all(r.id) as any[];
      // Value = what the cashier would collect, through the SAME computeBill the
      // settle route and the printed bill use, so the figure on this screen is
      // the figure on the bill. NOT orders.total: that column is authoritative
      // only once a bill has been finalised, and on this database it disagrees
      // with the lines on every open row — the nine empty orders carry
      // total 105.0 with no items at all, and the 22-day-old order carries 0.0
      // with three lines on it. (The lib reports orders.total as order_total
      // beside this, so the two can be compared rather than confused.)
      const subtotal = round2(lines.reduce((s, l) => s + (Number(l.line_total) || 0), 0));
      // A missing row cannot happen — the id came from the same query moments
      // ago — but fall back to the unadjusted bill rather than throw if it ever
      // does. `?? undefined` because computeBill's optional fields are typed
      // number | undefined, and better-sqlite3 hands back null.
      const adj = adjStmt.get(r.id) as any;
      const bill = computeBill(
        {
          subtotal,
          itemTax: sumItemTax(lines),
          serviceRemoved: !!adj?.service_charge_reason,
          discount_pct: adj?.discount_pct ?? undefined,
          discount: adj?.discount ?? undefined,
        },
        design,
      );
      return {
        ...r,
        items: lines.slice(0, ITEM_PREVIEW).map((l) => ({
          name: String(l.name || ''),
          quantity: Number(l.quantity) || 0,
          line_total: Number(l.line_total) || 0,
        })),
        more_items: Math.max(0, lines.length - ITEM_PREVIEW),
        value: bill.total,
        cooked_items: Number((cookedStmt.get(r.id) as any)?.n || 0),
      };
    };

    const empty = list.empty.map(decorate);
    const withItems = list.with_items.map(decorate);

    return Response.json({
      // Longest idle first in both groups — the lib already ordered them.
      empty,
      with_items: withItems,
      window_hours: list.window_hours,
      window_enabled: list.enabled,
      review_hours: reviewHours,
      review_widened_to_window: widened,
      // Whether the viewer may change the window from the screen. The window
      // route enforces this itself; this only decides whether the control
      // renders.
      can_change_window: me.role === 'admin',
      // Settle and Void are admin/manager on their own routes (void checks the
      // role outright; settle runs settle-authority, under which the management
      // TIER may always settle), and close_empty below matches them. An HOD can
      // read this page and cannot act on it, so say so rather than showing
      // buttons that 403.
      can_act: me.role === 'admin' || me.role === 'manager',
      totals: {
        empty_count: empty.length,
        with_items_count: withItems.length,
        with_items_value: round2(withItems.reduce((s, r) => s + r.value, 0)),
        would_auto_close: list.counts.would_auto_close,
        open_total: list.counts.open_total,
      },
      // What the opportunistic sweep did on this request, if anything. Lets the
      // screen say "3 empty tables closed themselves" rather than silently
      // showing a shorter list than the manager saw a minute ago.
      sweep: { closed: swept.closed, skipped: swept.skipped ?? null },
    });
  } catch (e: any) {
    console.error('[/api/dine-in/stale-tables GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/**
 * POST { action: 'close_empty', ids: string[] } — close empty tables now.
 *
 * THE ONLY WRITE ON THIS ROUTE, AND IT CANNOT TOUCH AN ORDER WITH ITEMS.
 * It forwards to closeEmptyOrdersByHand(), whose UPDATE carries
 * `NOT EXISTS (SELECT 1 FROM order_items …)` in the statement itself. Passing
 * the id of a table with food on it is not an error path here — the row simply
 * is not selected, and the response reports it as skipped. There is no verb on
 * this route that settles or voids an order that has items; those go to the
 * existing per-order routes.
 */
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    // Same tier the void route requires, so a close from this screen is not a
    // softer door than the one beside it.
    if (me.role !== 'admin' && me.role !== 'manager') {
      return Response.json({ error: 'Manager role required to close a table' }, { status: 403 });
    }
    const b = await request.json().catch(() => ({}));
    const action = String(b?.action || 'close_empty');
    if (action !== 'close_empty') {
      return Response.json({ error: `Unknown action '${action}'. This route only closes EMPTY tables; settle and void an order with items through /api/dine-in/orders/[id].` }, { status: 400 });
    }
    const ids: string[] = Array.isArray(b?.ids) ? b.ids.map((v: any) => String(v || '').trim()).filter(Boolean) : [];
    if (!ids.length) return Response.json({ error: 'ids is required' }, { status: 400 });

    const res = closeEmptyOrdersByHand(ids, { actor: String(me.name || me.email || '') });
    const closedIds = new Set(res.orders.map((o) => o.id));
    return Response.json({
      success: true,
      closed: res.closed,
      requested: res.requested,
      orders: res.orders,
      freed_tables: res.freed_tables,
      // Anything asked for that did not close: it had items, was already
      // settled/voided, or does not exist. The caller names them rather than
      // being told "closed 0" with no explanation.
      skipped: ids.filter((id) => !closedIds.has(id)),
    });
  } catch (e: any) {
    console.error('[/api/dine-in/stale-tables POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
