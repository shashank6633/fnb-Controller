/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  canRunFssaiCheck, fssaiToday, isISODate, daysBetweenISO,
  fssaiExpiryState, fssaiExpiryStateMeta, FSSAI_NEAR_EXPIRY_DAYS,
  FSSAI_EXPIRY_REASONS, FSSAI_EXPIRY_ACTIONS, FSSAI_SHIFTS,
  fssaiRecordStatusMeta, isFssaiRecordStatus, fssaiVoidRefusal,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAuditBestEffort,
  fssaiAppAudit, str,
} from '@/lib/fssai-server';
import { expiryStatus, shelfLifeRemaining } from '@/lib/production-batch';
import {
  P5_LIST_LIMIT, num, nullableInt, readBusinessDate, readClock,
  p5VisibilityClause, p5CanSee, attachP5Files, readP5AttachmentIndex,
  raiseP5CorrectiveAction, voidP5Record, real, voidFields,
} from '../_p5/records';

/**
 * FIFO / FEFO AND THE EXPIRY REGISTER (/api/fssai/fifo) — owner §3.
 *
 * ── THE TWO HALVES, AND WHY THEY ARE NOT THE SAME THING ─────────────────────
 *   · THE BOARD (`?view=board`) is a READ of stock that already exists. It
 *     ranks the kitchen's own batches by the date they expire, soonest first,
 *     so the older stock is used first. It writes nothing.
 *   · THE REGISTER (`?view=register`) is this module's own record: one row per
 *     thing found near or past its date, and what was done about it.
 *
 * ── THE THREE RULES THAT BOUND THIS ROUTE ───────────────────────────────────
 * 1. IT NEVER MOVES STOCK. HARD RULE 5 freezes the material-movement flow
 *    (Central Store → requisition → Department Stock → recipe consumption) and
 *    FSSAI only observes it. A discard recorded here is an OBSERVATION with a
 *    witness; the stock adjustment is still made in the inventory module by
 *    whoever owns that number. Grep this file: there is no INSERT or UPDATE
 *    against raw_materials, stock_movements, production_batches or any
 *    department ledger. Only fssai_ tables are written.
 * 2. IT DOES NOT WRITE A SECOND FIFO RANKING. Kitchen Production already owns
 *    FIFO and its maths lives in src/lib/production-batch.ts; RECON §5 row 4 is
 *    explicit that a second ranking inside fssai_ is an automatic drift defect.
 *    The board therefore orders by EXPIRY (FEFO) — which is the thing the owner
 *    actually asked for, "closest to its expiry first" — and imports
 *    expiryStatus and shelfLifeRemaining rather than re-deriving them. The FIFO
 *    position of a batch stays Kitchen Production's answer, and the board links
 *    there instead of restating it.
 * 3. A DATE NOBODY SET IS NOT "IN DATE". MEASURED: all 952 rows of
 *    raw_materials carry a blank shelf life and purchase/GRN lines carry no lot
 *    or expiry at all, so bought-in goods have nothing to sort on. The board
 *    says that out loud (`purchased`) instead of showing an empty green screen,
 *    and fssaiExpiryState returns 'none' — never 'ok' — for a blank date.
 *
 *   GET  ?view=board     [?near_days=&department_id=]
 *   GET  ?view=register  [?from=&to=&state=&status=&department_id=&q=]
 *   GET  ?id=<expiry row>
 *   POST { action: 'record' | 'decide' | 'void', … }
 */
export const dynamic = 'force-dynamic';

const BOARD_LIMIT = 400;

/**
 * THE ONLY COLUMNS A LATER POST MAY CHANGE ON A RECORD THAT IS ALREADY FILED.
 *
 * Named, exported in the response and read by the proof harness, on the model of
 * FSSAI_VERIFY_WRITABLE_RUN_COLUMNS in the approvals route. Why any at all: the
 * owner's own vocabulary has FSSAI_EXPIRY_ACTIONS[0] = 'Not decided yet', so the
 * decision genuinely arrives after the finding — a storekeeper photographs
 * mouldy paneer at 23:00 and the chef decides in the morning. Everything else on
 * the row is the observation itself and is frozen: the item, the date, the
 * quantity found, who found it and when.
 */
const DECIDE_WRITABLE_COLUMNS = ['action_taken', 'discard_qty', 'discard_method', 'witnessed_by'] as const;

/**
 * A stand-in reason, used ONLY to ask fssaiVoidRefusal everything except "did
 * you type a reason" when a screen needs to know whether to offer the button.
 * Never written anywhere — the real reason comes from the person.
 */
const VOID_REASON_PROBE = '----';

/* ------------------------------------------------------------------ *
 * Shaping
 * ------------------------------------------------------------------ */

function shapeExpiryItem(row: any, today: string) {
  const expiry = String(row.expiry_date || '');
  return {
    id: String(row.id),
    business_date: String(row.business_date || ''),
    found_at: String(row.found_at || ''),
    source_kind: String(row.source_kind || 'manual'),
    run_id: String(row.run_id || ''),
    response_id: String(row.response_id || ''),
    batch_id: String(row.batch_id || ''),
    batch_label: String(row.batch_label || ''),
    material_id: String(row.material_id || ''),
    material_name: String(row.material_name || ''),
    lot_no: String(row.lot_no || ''),
    department_id: String(row.department_id || ''),
    department_name: String(row.department_name || ''),
    store_id: String(row.store_id || ''),
    store_name: String(row.store_name || ''),
    location_label: String(row.location_label || ''),
    expiry_date: expiry,
    /* FROZEN AT THE TIME OF THE FINDING and never recomputed — the DDL says so
     * and the reason is that "4 days left" is a fact about the day it was
     * written, not about today. `expiry_state_now` below is the live view, kept
     * separate so a reader can see both and never confuse them. */
    days_to_expiry: row.days_to_expiry === null || row.days_to_expiry === undefined
      ? null : Number(row.days_to_expiry),
    expiry_state_now: fssaiExpiryState(expiry, today),
    expiry_state_now_label: fssaiExpiryStateMeta(fssaiExpiryState(expiry, today)).label,
    state: String(row.state || ''),
    state_label: FSSAI_EXPIRY_REASONS.find((r) => r.key === String(row.state || ''))?.label
      || String(row.state || ''),
    qty: real(row.qty),
    uom: String(row.uom || ''),
    pack_size: real(row.pack_size),
    recipe_uom: String(row.recipe_uom || ''),
    action_taken: String(row.action_taken || ''),
    action_label: FSSAI_EXPIRY_ACTIONS.find((a) => a.key === String(row.action_taken || ''))?.label
      || String(row.action_taken || ''),
    discard_qty: real(row.discard_qty),
    discard_method: String(row.discard_method || ''),
    witnessed_by: String(row.witnessed_by || ''),
    ca_id: String(row.ca_id || ''),
    ca_number: String(row.ca_number || ''),
    ca_status: String(row.ca_status || ''),
    note: String(row.note || ''),
    status: String(row.status || 'submitted'),
    status_label: fssaiRecordStatusMeta(row.status).label,
    recorded_by: String(row.recorded_by || ''),
    recorded_name: String(row.recorded_name || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
    ...voidFields(row),
  };
}

const EXPIRY_SELECT = `
  SELECT x.*, d.name AS department_name, s.name AS store_name,
         c.ca_number AS ca_number, c.status AS ca_status
    FROM fssai_expiry_items x
    LEFT JOIN departments             d ON d.id = x.department_id
    LEFT JOIN store_locations         s ON s.id = x.store_id
    LEFT JOIN fssai_corrective_actions c ON c.id = x.ca_id`;

/* ------------------------------------------------------------------ *
 * GET
 * ------------------------------------------------------------------ */

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const url = new URL(request.url);
    const today = fssaiToday();

    /* ══ ONE REGISTER ROW ═══════════════════════════════════════════════════ */
    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(`${EXPIRY_SELECT} WHERE x.id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That entry no longer exists.' }, { status: 404 });
      if (!p5CanSee(me, row)) {
        return Response.json({ error: 'That entry belongs to another department.' }, { status: 403 });
      }
      const photos = readP5AttachmentIndex(db, 'fssai_expiry_items', [id]).get(id) || [];
      /* "May this person void this at all", asked of the SAME predicate the POST
       * re-checks, so the button and the refusal cannot disagree. The reason is
       * supplied by the user at the moment they press it, so a stand-in long
       * enough to clear the four-character rule is passed here to get everything
       * except that one check. */
      const voidRefusal = fssaiVoidRefusal(me, row, VOID_REASON_PROBE);
      return Response.json({
        item: shapeExpiryItem(row, today),
        photos,
        can_void: !voidRefusal,
        void_refusal: voidRefusal,
        decide_writable_columns: DECIDE_WRITABLE_COLUMNS,
      });
    }

    const view = str(url.searchParams.get('view')) || 'board';

    /* ══ THE BOARD — use the soonest date first ═════════════════════════════ */
    if (view === 'board') {
      const nearDaysRaw = nullableInt(url.searchParams.get('near_days'));
      const globalNear = nearDaysRaw !== null && nearDaysRaw >= 0 && nearDaysRaw <= 365
        ? nearDaysRaw : FSSAI_NEAR_EXPIRY_DAYS;

      /* THE KITCHEN'S OWN BATCHES. Ordered by expiry, blanks LAST — a batch with
       * no date is not the most urgent thing in the cold room, it is a labelling
       * problem, and it is counted separately below so it cannot hide. */
      const rows = db.prepare(
        `SELECT b.id, b.batch_number, b.barcode, b.item_name, b.category, b.material_id,
                b.production_date, b.production_time, b.expiry_date, b.expiry_time,
                b.quantity_produced, b.quantity_consumed, b.unit, b.storage_location,
                b.kitchen_section, b.prepared_by, b.status,
                sl.near_expiry_days AS near_expiry_days, sl.is_high_risk AS is_high_risk,
                sl.storage_condition AS storage_condition
           FROM production_batches b
           LEFT JOIN fssai_item_shelf_life sl
                  ON sl.material_id = b.material_id AND sl.is_active = 1
          WHERE b.status = 'active'
            AND (b.quantity_produced - b.quantity_consumed) > 0
          ORDER BY CASE WHEN IFNULL(b.expiry_date,'') = '' THEN 1 ELSE 0 END ASC,
                   b.expiry_date ASC, b.expiry_time ASC,
                   b.production_date ASC, b.production_time ASC, b.rowid ASC
          LIMIT ${BOARD_LIMIT}`,
      ).all() as any[];

      const now = new Date();
      const batches = rows.map((b) => {
        /* THE NEAR-EXPIRY WINDOW IS PER ITEM WHERE THE OWNER HAS SET ONE. A
         * 3-day warning on milk is useless and on canned tomatoes is noise, so
         * fssai_item_shelf_life.near_expiry_days wins over the request's window,
         * which in turn wins over the constant. Nothing compares against a
         * literal anywhere. */
        const near = b.near_expiry_days === null || b.near_expiry_days === undefined
          ? globalNear : Number(b.near_expiry_days);
        const state = fssaiExpiryState(b.expiry_date, today, near);
        return {
          id: String(b.id),
          batch_number: String(b.batch_number || ''),
          barcode: String(b.barcode || ''),
          item_name: String(b.item_name || ''),
          category: String(b.category || ''),
          material_id: String(b.material_id || ''),
          production_date: String(b.production_date || ''),
          expiry_date: String(b.expiry_date || ''),
          expiry_time: String(b.expiry_time || ''),
          remaining_quantity: Math.max(0, (Number(b.quantity_produced) || 0) - (Number(b.quantity_consumed) || 0)),
          unit: String(b.unit || ''),
          storage_location: String(b.storage_location || ''),
          kitchen_section: String(b.kitchen_section || ''),
          prepared_by: String(b.prepared_by || ''),
          storage_condition: String(b.storage_condition || ''),
          is_high_risk: Number(b.is_high_risk) === 1,
          near_days_used: near,
          expiry_state: state,
          expiry_state_label: fssaiExpiryStateMeta(state).label,
          /* The kitchen module's own words and its own traffic light, imported
           * rather than re-derived, so the two screens cannot disagree about the
           * same batch. */
          time_left: shelfLifeRemaining(b.expiry_date, b.expiry_time, now),
          kitchen_light: expiryStatus(b.expiry_date, b.expiry_time, now),
          days_to_expiry: isISODate(String(b.expiry_date || ''))
            ? daysBetweenISO(today, String(b.expiry_date)) : null,
        };
      });

      const counts = {
        total: batches.length,
        expired: batches.filter((b) => b.expiry_state === 'expired').length,
        near_expiry: batches.filter((b) => b.expiry_state === 'near_expiry').length,
        in_date: batches.filter((b) => b.expiry_state === 'ok').length,
        no_date: batches.filter((b) => b.expiry_state === 'none').length,
      };

      /* THE GAP, MEASURED ON EVERY REQUEST RATHER THAN ASSERTED IN A COMMENT.
       * This is the one number that tells the owner why the board shows kitchen
       * batches only, and it has to stay true as he fills the shelf-life table
       * in. A screen that said "bought-in goods are not covered" forever, long
       * after he had configured 200 items, would be lying. */
      const items = db.prepare(`SELECT COUNT(*) AS n FROM raw_materials`).get() as any;
      const configured = db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_item_shelf_life WHERE is_active = 1 AND shelf_life_days IS NOT NULL`,
      ).get() as any;
      const masterShelfLife = db.prepare(
        `SELECT COUNT(*) AS n FROM raw_materials WHERE IFNULL(shelf_life_days, 0) > 0`,
      ).get() as any;

      const openRegister = db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_expiry_items
          WHERE status <> 'void' AND action_taken = ''`,
      ).get() as any;

      return Response.json({
        view: 'board',
        today,
        near_days_default: globalNear,
        order: 'expiry_date',
        batches,
        counts,
        /* Said in the payload, not only on the screen, so a report built on this
         * endpoint later cannot quietly present the board as "all stock". */
        purchased: {
          items_total: Number(items?.n) || 0,
          shelf_life_configured_here: Number(configured?.n) || 0,
          shelf_life_on_item_master: Number(masterShelfLife?.n) || 0,
          lots_with_expiry: 0,
          note: 'Bought-in goods carry no batch number and no expiry date anywhere in this system — not on the purchase, not on the goods receipt. Until a lot and a date are captured at the door, this board can only rank what the kitchen produced itself.',
        },
        register_awaiting_decision: Number(openRegister?.n) || 0,
        fifo_owner: {
          path: '/kitchen-production',
          note: 'The FIFO position of a batch is Kitchen Production\'s answer and is not restated here. This board is ordered by expiry date (FEFO), which is what the food-safety rule asks for.',
        },
        moves_stock: false,
        truncated: rows.length >= BOARD_LIMIT,
        generated_at: new Date().toISOString(),
      });
    }

    /* ══ THE REGISTER ═══════════════════════════════════════════════════════ */
    if (view !== 'register') {
      return Response.json(
        { error: `"${view}" is not a view on this screen. Use board or register.` },
        { status: 400 },
      );
    }

    const where: string[] = [];
    const args: any[] = [];

    const from = str(url.searchParams.get('from'));
    const to = str(url.searchParams.get('to'));
    if (from) { where.push('x.business_date >= ?'); args.push(from); }
    if (to) { where.push('x.business_date <= ?'); args.push(to); }

    const state = str(url.searchParams.get('state'));
    if (state) {
      if (!FSSAI_EXPIRY_REASONS.some((r) => r.key === state)) {
        return Response.json({ error: `"${state}" is not a reason an item goes on this register.` }, { status: 400 });
      }
      where.push('x.state = ?'); args.push(state);
    }

    const status = str(url.searchParams.get('status')) || 'live';
    if (status === 'live') {
      /* THE DEFAULT HIDES VOIDED ROWS AND NOTHING ELSE. §19 keeps a voided row
       * in the file for ever; a daily working list is simply not where it
       * belongs, and `status=all` brings it back with its reason. */
      where.push(`x.status <> 'void'`);
    } else if (status === 'awaiting') {
      where.push(`x.status <> 'void' AND x.action_taken = ''`);
    } else if (status !== 'all') {
      if (!isFssaiRecordStatus(status)) {
        return Response.json({ error: `"${status}" is not a state a record can be in.` }, { status: 400 });
      }
      where.push('x.status = ?'); args.push(status);
    }

    const deptId = str(url.searchParams.get('department_id'));
    if (deptId) { where.push('x.department_id = ?'); args.push(deptId === '__none__' ? '' : deptId); }

    const vis = p5VisibilityClause(me, 'x');
    if (vis.sql) { where.push(vis.sql); args.push(...vis.args); }

    const rows = db.prepare(
      `${EXPIRY_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY x.business_date DESC, x.found_at DESC, x.created_at DESC, x.rowid DESC
       LIMIT ${P5_LIST_LIMIT}`,
    ).all(...args) as any[];

    const q = str(url.searchParams.get('q')).toLowerCase();
    const shaped = rows.map((r) => shapeExpiryItem(r, today)).filter((r) => !q
      || r.material_name.toLowerCase().includes(q)
      || r.batch_label.toLowerCase().includes(q)
      || r.lot_no.toLowerCase().includes(q)
      || r.location_label.toLowerCase().includes(q)
      || r.note.toLowerCase().includes(q)
      || r.recorded_by.toLowerCase().includes(q));

    const photos = readP5AttachmentIndex(db, 'fssai_expiry_items', shaped.map((r) => r.id));

    /* The counts are over what THIS person may see, so the tab numbers and the
     * list can never disagree — the trap a global COUNT(*) walks straight into
     * when visibility is department-scoped. */
    const visCount = p5VisibilityClause(me, 'x');
    const countRows = db.prepare(
      `SELECT state, status, action_taken, COUNT(*) AS n FROM fssai_expiry_items x
        ${visCount.sql ? `WHERE ${visCount.sql}` : ''}
        GROUP BY state, status, action_taken`,
    ).all(...visCount.args) as any[];
    const live = countRows.filter((c) => String(c.status) !== 'void');
    const sum = (f: (c: any) => boolean) => live.filter(f).reduce((t, c) => t + (Number(c.n) || 0), 0);

    return Response.json({
      view: 'register',
      today,
      items: shaped.map((r) => ({ ...r, photos: photos.get(r.id) || [] })),
      counts: {
        live: sum(() => true),
        expired: sum((c) => String(c.state) === 'expired'),
        near_expiry: sum((c) => String(c.state) === 'near_expiry'),
        awaiting_decision: sum((c) => String(c.action_taken || '') === ''),
        void: countRows.filter((c) => String(c.status) === 'void').reduce((t, c) => t + (Number(c.n) || 0), 0),
      },
      can_record: canRunFssaiCheck(me),
      is_management: isManagement(me),
      me: me.email || '',
      vocab: {
        reasons: FSSAI_EXPIRY_REASONS,
        actions: FSSAI_EXPIRY_ACTIONS,
        shifts: FSSAI_SHIFTS,
      },
      decide_writable_columns: DECIDE_WRITABLE_COLUMNS,
      moves_stock: false,
      truncated: rows.length >= P5_LIST_LIMIT,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/fifo failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the expiry information' }, { status: 500 });
  }
}

/* ------------------------------------------------------------------ *
 * POST
 * ------------------------------------------------------------------ */

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const today = fssaiToday();
    const action = str(body?.action) || 'record';

    /* ══ RECORD A FINDING ═══════════════════════════════════════════════════ */
    if (action === 'record') {
      if (!canRunFssaiCheck(me)) {
        return Response.json({ error: 'You are not able to file food-safety records.' }, { status: 403 });
      }

      const date = readBusinessDate(body?.business_date, today);
      if (!date.ok) return Response.json({ error: date.error }, { status: 400 });

      const state = str(body?.state);
      if (!FSSAI_EXPIRY_REASONS.some((r) => r.key === state)) {
        return Response.json(
          { error: 'Say why this item is going on the register — near its date, past it, damaged, spoiled, unlabelled or recalled.' },
          { status: 400 },
        );
      }

      const materialId = str(body?.material_id);
      const batchId = str(body?.batch_id);
      const materialName = str(body?.material_name).slice(0, 300);
      if (!materialId && !batchId && !materialName) {
        return Response.json(
          { error: 'Which item? Pick it from the list, scan the batch label, or type what it was.' },
          { status: 400 },
        );
      }

      /* THE ITEM MASTER AND THE BATCH TABLE STAY THE MASTERS. The name is read
       * off them, never off the body, so a record cannot claim an item that does
       * not exist — and a free-typed name is only used when neither was picked
       * (RECON §5 row 1: there is no second item master in this module). */
      let name = materialName;
      let packSize = num(body?.pack_size);
      let recipeUom = str(body?.recipe_uom);
      if (materialId) {
        const m = db.prepare(
          `SELECT name, unit, purchase_unit, pack_size FROM raw_materials WHERE id = ?`,
        ).get(materialId) as any;
        if (!m) return Response.json({ error: 'That item is not in the Item Master.' }, { status: 400 });
        name = String(m.name || '');
        if (packSize === null) packSize = real(m.pack_size);
        if (!recipeUom) recipeUom = String(m.unit || '');
      }
      let batchLabel = str(body?.batch_label).slice(0, 120);
      let expiry = str(body?.expiry_date);
      if (batchId) {
        const b = db.prepare(
          `SELECT barcode, batch_number, item_name, expiry_date, unit, material_id
             FROM production_batches WHERE id = ?`,
        ).get(batchId) as any;
        if (!b) return Response.json({ error: 'That batch no longer exists.' }, { status: 400 });
        batchLabel = String(b.barcode || b.batch_number || '');
        if (!name) name = String(b.item_name || '');
        if (!expiry) expiry = String(b.expiry_date || '');
      }
      if (expiry && !isISODate(expiry)) {
        return Response.json({ error: `"${expiry}" is not a date. Use the date picker.` }, { status: 400 });
      }

      const actionTaken = str(body?.action_taken);
      if (actionTaken && !FSSAI_EXPIRY_ACTIONS.some((a) => a.key === actionTaken)) {
        return Response.json({ error: `"${actionTaken}" is not one of the things that can be done about it.` }, { status: 400 });
      }

      const witnessedBy = str(body?.witnessed_by);
      const note = str(body?.note).slice(0, 2000);
      const discardQty = num(body?.discard_qty);

      /* A DISCARD NEEDS A WITNESS **OR** AN EXPLANATION — and this is a
       * deliberate middle, not a soft gate. Food leaving the building
       * unaccounted for is the single weakest record a kitchen can keep, so the
       * route will not take a bare "discarded". But refusing outright would mean
       * the storekeeper who finds mouldy paneer alone at 23:00 cannot record the
       * discard AT ALL, and an unrecorded discard is strictly worse than one
       * annotated "no one else on site". So either satisfies it, and the refusal
       * says both. */
      if (actionTaken === 'discarded' && !witnessedBy && !note) {
        return Response.json(
          {
            error: 'A discard needs either a witness or a line saying why there was nobody to witness it. Food leaving the building with neither is the weakest record a kitchen can keep.',
            code: 'witness_or_note',
          },
          { status: 400 },
        );
      }

      /* days_to_expiry IS FROZEN HERE and never recomputed on read (RECON §10
       * R3's rule applied to dates): "2 days left" is a fact about the day it
       * was written. A reader who wants today's position gets expiry_state_now,
       * computed fresh and clearly labelled as a different thing. */
      const daysToExpiry = isISODate(expiry) ? daysBetweenISO(date.date, expiry) : null;

      const id = generateId();
      const files = Array.isArray(body?.photos) ? body.photos : [];
      const raiseCa = Number(body?.raise_corrective_action) === 1;

      let raised: ReturnType<typeof raiseP5CorrectiveAction> = null;
      let attached: ReturnType<typeof attachP5Files> = [];

      const write = db.transaction(() => {
        db.prepare(
          `INSERT INTO fssai_expiry_items
             (id, business_date, found_at, source_kind, run_id, response_id,
              batch_id, batch_label, material_id, material_name, lot_no,
              department_id, store_id, location_label, expiry_date, days_to_expiry,
              state, qty, uom, pack_size, recipe_uom, action_taken, discard_qty,
              discard_method, witnessed_by, ca_id, note, status,
              recorded_by, recorded_name, outlet_id)
           VALUES (?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 'submitted', ?, ?, ?)`,
        ).run(
          id, date.date, readClock(body?.found_at), str(body?.source_kind) || 'manual',
          batchId, batchLabel, materialId, name.slice(0, 300), str(body?.lot_no).slice(0, 120),
          str(body?.department_id) || me.department_id || '', str(body?.store_id),
          str(body?.location_label).slice(0, 200), expiry, daysToExpiry,
          state, num(body?.qty), str(body?.uom), packSize, recipeUom,
          actionTaken, discardQty, str(body?.discard_method).slice(0, 200), witnessedBy,
          note, me.email || '', me.name || '', outletId,
        );

        attached = attachP5Files(db, {
          entityTable: 'fssai_expiry_items', entityId: id, files,
          actor: { email: me.email, name: me.name }, outletId,
        });

        /* RAISING AN ACTION HERE IS THE RECORDER'S EXPLICIT CHOICE, and that is
         * a decision this phase is taking in the absence of a ruling. An oil or
         * water reading outside a configured limit raises one automatically —
         * there the limit IS the owner's rule. "Past its date" is not the same
         * kind of event: one tub of yoghurt found on a Tuesday is a rotation
         * slip, and raising a tracked corrective action for every one of them
         * would bury the queue the fridge breakdown needs to be visible in. So
         * the switch is on the form, defaulted off, and it is recorded in the
         * phase's assumptions. Reversing it is a one-line default. */
        if (raiseCa) {
          raised = raiseP5CorrectiveAction(db, {
            sourceKind: 'expiry',
            title: `${name || 'Item'} — ${FSSAI_EXPIRY_REASONS.find((r) => r.key === state)?.label || state}`,
            description: [
              `${name || 'An item'}${batchLabel ? ` (batch ${batchLabel})` : ''}${str(body?.lot_no) ? ` (lot ${str(body?.lot_no)})` : ''} was found ${(FSSAI_EXPIRY_REASONS.find((r) => r.key === state)?.label || state).toLowerCase()} on ${date.date}.`,
              expiry ? `Its date was ${expiry}${daysToExpiry === null ? '' : ` (${daysToExpiry} day${Math.abs(daysToExpiry) === 1 ? '' : 's'} from the day it was found)`}.` : 'It carried no date.',
              str(body?.location_label) ? `Found at ${str(body?.location_label)}.` : '',
              note ? `Note: “${note}”` : '',
              'Recorded on the FSSAI expiry register. This action is about stopping it happening again — the register entry stays exactly as it was written.',
            ].filter(Boolean).join(' '),
            severity: str(body?.ca_severity) || (state === 'expired' || state === 'spoiled' ? 'high' : 'medium'),
            departmentId: str(body?.department_id) || me.department_id || '',
            businessDate: date.date,
            recordTable: 'fssai_expiry_items', recordId: id,
            actor: { email: me.email, name: me.name }, outletId,
          });
          if (raised) {
            db.prepare(`UPDATE fssai_expiry_items SET ca_id = ?, updated_at = datetime('now') WHERE id = ?`)
              .run(raised.id, id);
          }
        }

        /* BEST-EFFORT, as §7 Q4 settled for anything a member of staff really
         * did: an audit row that will not insert must never cost somebody the
         * record of a discard they performed. The console line is what makes the
         * rot visible. */
        fssaiAuditBestEffort(db, {
          entity_table: 'fssai_expiry_items', entity_id: id, action: 'create',
          after: {
            business_date: date.date, state, material_id: materialId, material_name: name,
            batch_id: batchId, expiry_date: expiry, days_to_expiry: daysToExpiry,
            qty: num(body?.qty), action_taken: actionTaken, discard_qty: discardQty,
            witnessed_by: witnessedBy, photos: attached.length,
          },
          reason: date.backdated ? `Filed on ${today} for ${date.date}.` : '',
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      });

      try {
        write();
      } catch (e: any) {
        const m = String(e?.message || '');
        if (m.startsWith('P5_BAD_PHOTO:')) {
          return Response.json({ error: m.slice('P5_BAD_PHOTO:'.length) }, { status: 413 });
        }
        if (m.startsWith('P5_TOO_MANY_PHOTOS:')) {
          return Response.json({ error: m.slice('P5_TOO_MANY_PHOTOS:'.length) }, { status: 400 });
        }
        throw e;
      }

      fssaiAppAudit(db, {
        event_type: 'fssai.expiry.record', entity_type: 'fssai_expiry_items', entity_id: id,
        actor_email: me.email, after: { state, material_name: name, business_date: date.date },
        note: actionTaken,
      });

      const fresh = db.prepare(`${EXPIRY_SELECT} WHERE x.id = ?`).get(id) as any;
      return Response.json({
        ok: true,
        item: shapeExpiryItem(fresh, today),
        photos: attached,
        corrective_action: raised,
        /* Said every time, because it is the one thing somebody who has just
         * recorded a discard will otherwise assume happened. */
        stock_unchanged: true,
        note_to_staff: 'This is the food-safety record. The stock figure is not changed by it — adjust that in the inventory screens as you normally would.',
        ...(raiseCa && !raised
          ? { corrective_action_warning: 'The entry is saved. A corrective action could not be raised against it — raise one by hand if it is needed. The finding stands exactly as recorded.' }
          : {}),
      });
    }

    /* ══ DECIDE WHAT WAS DONE ABOUT IT ══════════════════════════════════════ */
    if (action === 'decide') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which entry? No id was sent.' }, { status: 400 });
      const row = db.prepare(`SELECT * FROM fssai_expiry_items WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That entry no longer exists.' }, { status: 404 });

      if (String(row.status) === 'void') {
        return Response.json({ error: 'That entry has been voided. Nothing more is recorded against it.' }, { status: 409 });
      }
      if (String(row.status) === 'verified') {
        return Response.json(
          { error: 'A manager has already verified this entry, so it is closed. File a new entry if something further was done.' },
          { status: 409 },
        );
      }
      /* WHO MAY DECIDE: the person who found it, anybody in that department, or
       * management. Not "anybody signed in" — a decision about somebody else's
       * finding in another department is not theirs to record. */
      if (!p5CanSee(me, row)) {
        return Response.json({ error: 'That entry belongs to another department.' }, { status: 403 });
      }

      const actionTaken = str(body?.action_taken);
      if (!FSSAI_EXPIRY_ACTIONS.some((a) => a.key === actionTaken) || !actionTaken) {
        return Response.json(
          { error: 'Say what was done about it — used first, relabelled, segregated, returned or discarded.' },
          { status: 400 },
        );
      }
      const witnessedBy = str(body?.witnessed_by);
      const reason = str(body?.reason).slice(0, 1000);
      const discardMethod = str(body?.discard_method).slice(0, 200);
      const discardQty = num(body?.discard_qty);

      if (actionTaken === 'discarded' && !witnessedBy && !reason && !String(row.note || '')) {
        return Response.json(
          {
            error: 'A discard needs either a witness or a line saying why there was nobody to witness it.',
            code: 'witness_or_note',
          },
          { status: 400 },
        );
      }
      /* CHANGING A DECISION ALREADY ON THE FILE NEEDS A WRITTEN REASON — owner
       * §19 ("original value vs changed value, reason for change"). Recording
       * one for the first time does not: there is nothing being overwritten. */
      const previous = String(row.action_taken || '');
      if (previous && previous !== actionTaken && !reason) {
        return Response.json(
          {
            error: `This entry already says “${FSSAI_EXPIRY_ACTIONS.find((a) => a.key === previous)?.label || previous}”. Say why that is changing — the file keeps both.`,
            code: 'reason_required',
          },
          { status: 400 },
        );
      }

      const apply = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_expiry_items
              SET action_taken = ?, discard_qty = ?, discard_method = ?, witnessed_by = ?,
                  updated_at = datetime('now')
            WHERE id = ? AND status NOT IN ('void','verified')`,
        ).run(actionTaken, discardQty, discardMethod, witnessedBy, id);
        if (res.changes !== 1) throw new Error('FSSAI_EXPIRY_NOT_OPEN');

        /* THROWS, not best-effort, and the difference is the point. §7 Q4
         * protects a check staff PERFORMED; this is an amendment to a record
         * already in the file, and an unrecorded amendment is exactly what §19
         * exists to prevent. If the audit row will not write, the change does
         * not happen and the person can retry. */
        fssaiAudit(db, {
          entity_table: 'fssai_expiry_items', entity_id: id, action: 'update',
          field: DECIDE_WRITABLE_COLUMNS.join(','),
          before: {
            action_taken: previous, discard_qty: real(row.discard_qty),
            discard_method: String(row.discard_method || ''), witnessed_by: String(row.witnessed_by || ''),
          },
          after: {
            action_taken: actionTaken, discard_qty: discardQty,
            discard_method: discardMethod, witnessed_by: witnessedBy,
          },
          reason,
          actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id,
        });
      });

      try { apply(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_EXPIRY_NOT_OPEN') {
          const now = db.prepare(`SELECT status FROM fssai_expiry_items WHERE id = ?`).get(id) as any;
          return Response.json(
            { error: `Somebody has already closed this entry — it now reads "${now?.status || 'unknown'}".`, code: 'already_closed' },
            { status: 409 },
          );
        }
        throw e;
      }

      const fresh = db.prepare(`${EXPIRY_SELECT} WHERE x.id = ?`).get(id) as any;
      return Response.json({
        ok: true, item: shapeExpiryItem(fresh, today),
        changed_columns: DECIDE_WRITABLE_COLUMNS,
        stock_unchanged: true,
      });
    }

    /* ══ VOID (owner §19 — never delete) ════════════════════════════════════ */
    if (action === 'void') {
      const id = str(body?.id);
      const reason = str(body?.reason).slice(0, 1000);
      if (!id) return Response.json({ error: 'Which entry? No id was sent.' }, { status: 400 });
      const row = db.prepare(`SELECT * FROM fssai_expiry_items WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That entry no longer exists.' }, { status: 404 });

      /* ONE SHARED PREDICATE for P4, P5 and P6 — management only, never the
       * recorder, a reason of at least four characters. The screen shows this
       * same sentence, so the button and the refusal cannot disagree. */
      const refusal = fssaiVoidRefusal(me, row, reason);
      if (refusal) {
        /* 400 when the person simply has not typed a reason yet, 403 when they
         * are not allowed to do this at all. Told apart on the refusal's
         * identity, not by matching its wording — a sentence somebody improves
         * later must not change an HTTP status. */
        const needsReason = refusal === fssaiVoidRefusal(me, row, VOID_REASON_PROBE)
          ? false : !fssaiVoidRefusal(me, row, VOID_REASON_PROBE);
        return Response.json({ error: refusal }, { status: needsReason ? 400 : 403 });
      }
      /* ⚠️ NOT CHECKED HERE: whether the person voiding is the person who
       * recorded it. fssaiVoidRefusal is the ONE shared predicate for P4, P5 and
       * P6 and it does not make that check — see the gap reported with this
       * phase. Adding it in this file alone would give three lanes three
       * different void rules, which is the drift this module keeps paying for. */

      const doVoid = db.transaction(() => {
        const changes = voidP5Record(db, 'fssai_expiry_items', {
          id, reason, actor: { email: me.email, name: me.name },
        });
        if (changes !== 1) throw new Error('FSSAI_EXPIRY_ALREADY_VOID');
        fssaiAudit(db, {
          entity_table: 'fssai_expiry_items', entity_id: id, action: 'void', field: 'status',
          before: { status: String(row.status || '') }, after: { status: 'void' },
          reason, actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id,
        });
      });
      try { doVoid(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_EXPIRY_ALREADY_VOID') {
          return Response.json({ error: 'That entry has already been voided.' }, { status: 409 });
        }
        throw e;
      }

      fssaiAppAudit(db, {
        event_type: 'fssai.expiry.void', entity_type: 'fssai_expiry_items', entity_id: id,
        actor_email: me.email, before: { status: row.status }, after: { status: 'void' }, note: reason,
      });

      const fresh = db.prepare(`${EXPIRY_SELECT} WHERE x.id = ?`).get(id) as any;
      return Response.json({
        ok: true, item: shapeExpiryItem(fresh, today),
        kept: 'The entry stays in the file with your reason on it. Nothing is deleted.',
      });
    }

    return Response.json(
      { error: `"${action}" is not something this screen does. Use record, decide or void.` },
      { status: 400 },
    );
  } catch (e: any) {
    console.error('POST /api/fssai/fifo failed:', e);
    return Response.json({ error: e?.message || 'Failed to save the entry' }, { status: 500 });
  }
}

/* There is no DELETE and no PUT. Owner §19: a sensitive record is voided with a
 * written reason and stays in the file for ever. The one amendment this route
 * allows is the 'decide' action above, limited to DECIDE_WRITABLE_COLUMNS and
 * audited with the value it replaced. */
