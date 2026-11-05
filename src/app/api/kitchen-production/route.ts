import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canManageKitchenProduction } from '@/lib/auth';
import { enrichBatch, ProductionBatch } from '@/lib/production-batch';
import { batchDepartmentMap, resolveBatchDepartment, saveBatchDepartment } from '@/lib/production-departments';
import { batchNumberKey, resolveTypedBatchNumber } from '@/lib/production-batch-number';
import { fmtISTDate } from '@/lib/format-date';

/**
 * Kitchen Production — prepared-item batches.
 *
 * GET  /api/kitchen-production?status=active|all&category=&search=&kind=
 *        → { batches: [ {…columns}, remaining_quantity, expiry_status, batch_age_hours, fifo_priority,
 *                       department_key, department_name, department_id, department_inactive ] }
 *        kind is OPT-IN (ruling 114, Brewery Production): kind=brewery → only
 *        batches of items ticked as Brewery items; kind=kitchen → every other
 *        batch (legacy batches with no item link included). Left out, the list
 *        is exactly what it always was — scan, dashboard, reports and FSSAI do
 *        not call this list and are untouched.
 * POST /api/kitchen-production
 *        body: { item_name, category, material_id?, recipe_id?, production_date, production_time,
 *                expiry_date, expiry_time, shelf_life?, quantity_produced, unit, prepared_by,
 *                kitchen_section, storage_location, remarks?,
 *                department_key? | department_id? | production_department_id?,
 *                batch_number_entry? }
 *        → { batch }
 *        batch_number_entry is read ONLY for a Brewery item whose setting is
 *        typed / serial code + number (the item row decides, never the request);
 *        every other batch gets its number from buildBatchNumber exactly as
 *        before and any typed value is ignored. A typed number already used by
 *        another batch of the SAME item is refused with 409.
 *
 * ── THE DEPARTMENT A BATCH WAS MADE FOR ───────────────────────────────────
 * Optional, and its absence is a first-class state: every batch created before
 * this field existed has no link, reads back with department_name '' and behaves
 * exactly as it did. The link lives in its own table (see
 * src/lib/production-departments.ts) — `production_batches` gains no column, so
 * the reports, CSV exports, labels and FIFO queries all still run against the
 * columns they always ran against.
 *
 * The chosen name is ALSO written into the existing `kitchen_section` column,
 * which is the field this replaced in the form. That is the display-label +
 * machine-link pair the module already uses for item_name + production_item_id,
 * and it is what makes the Production CSV, the detail drawer and the scan screen
 * show the department without a line of change in any of them.
 *
 * NOTHING HERE MOVES MATERIAL. Kitchen Production is a separate ledger: no route
 * under /api/kitchen-production writes raw_materials, department stock, or a
 * requisition (the only raw_materials reads are a reorder-level lookup on the
 * dashboard and a cost join in reports). Naming a department on a batch records
 * WHO IT WAS MADE FOR; it does not debit that department, and Central Store
 * --issue--> Department Stock --recipe consumption at KOT complete--> consumed
 * is not touched by it.
 */

// Next unique 'PROD' + 6-digit barcode (max existing suffix + 1, start PROD000001).
function nextBarcode(db: ReturnType<typeof getDb>): string {
  const row = db.prepare(
    `SELECT MAX(CAST(SUBSTR(barcode, 5) AS INTEGER)) AS m
       FROM production_batches
      WHERE barcode LIKE 'PROD______'`
  ).get() as any;
  const next = (row?.m || 0) + 1;
  return 'PROD' + String(next).padStart(6, '0');
}

// Batch number: initials (up to 2 words) + YYMMDD(production_date) + 3-digit per-(item,day) seq.
// Falls back to the barcode when the item name has no letters.
function buildBatchNumber(
  db: ReturnType<typeof getDb>,
  itemName: string,
  productionDate: string,
  barcode: string,
): string {
  const words = (itemName || '')
    .replace(/[^a-zA-Z ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => /[a-zA-Z]/.test(w));
  const initials = words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  if (!initials) return barcode; // no letters → fall back to barcode suffix

  const d = (productionDate || '').replace(/-/g, '');
  const yymmdd = d.length >= 8 ? d.slice(2, 8) : d; // YYYYMMDD → YYMMDD

  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM production_batches WHERE item_name = ? AND production_date = ?`
  ).get(itemName, productionDate) as any;
  const seq = String((row?.c || 0) + 1).padStart(3, '0');
  return `${initials}${yymmdd}${seq}`;
}

// ---------- GET ----------
export async function GET(request: Request) {
  try {
    // READ — logged-in only. The page this feeds is open to every signed-in
    // user (the owner removed hodOnly from /kitchen-production); writes below
    // keep canManageKitchenProduction.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    const url = new URL(request.url);
    const status = (url.searchParams.get('status') || 'active').toLowerCase();
    const category = url.searchParams.get('category') || '';
    const search = (url.searchParams.get('search') || '').trim();

    const where: string[] = [];
    const params: any[] = [];

    const outletId = await getCurrentOutletId();
    if (outletId) { where.push('(outlet_id = ? OR outlet_id IS NULL)'); params.push(outletId); }

    if (status !== 'all') { where.push('status = ?'); params.push(status); }
    if (category) { where.push('category = ?'); params.push(category); }
    // Opt-in Kitchen / Brewery split (see header). Filtering by item keeps every
    // item's batches together, so the FIFO ranks below are unchanged per item.
    const kind = url.searchParams.get('kind') || '';
    const BREWERY_ITEM_IDS = `SELECT id FROM production_items WHERE is_brewery = 1 AND id IS NOT NULL`;
    if (kind === 'brewery') where.push(`production_item_id IN (${BREWERY_ITEM_IDS})`);
    else if (kind === 'kitchen') where.push(`(production_item_id IS NULL OR production_item_id NOT IN (${BREWERY_ITEM_IDS}))`);
    if (search) {
      where.push('(item_name LIKE ? OR barcode LIKE ? OR batch_number LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT * FROM production_batches ${whereSql}
       ORDER BY production_date ASC, production_time ASC, created_at ASC`
    ).all(...params) as ProductionBatch[];

    const now = new Date();

    // One batched lookup for the whole page — a batch with no link is simply
    // absent from the map and reads back with the same empty department fields
    // as every batch made before this feature.
    const deptMap = batchDepartmentMap(db, rows.map((b) => b.id));

    // fifo_priority: rank ACTIVE batches of the same item oldest-first (1,2,3…).
    const fifoCounter: Record<string, number> = {};
    const batches = rows.map((b) => {
      const enriched = enrichBatch(b, now);
      let fifo_priority: number | null = null;
      if (b.status === 'active') {
        // Rank by master-item id when present (matches computeFifo), else name.
        const key = b.production_item_id || b.item_name.trim().toLowerCase();
        fifoCounter[key] = (fifoCounter[key] || 0) + 1;
        fifo_priority = fifoCounter[key];
      }
      const dep = deptMap.get(b.id);
      return {
        ...enriched,
        fifo_priority,
        department_id: dep?.department_id ?? null,
        department_key: dep?.department_key ?? null,
        department_name: dep?.department_name ?? '',
        department_inactive: dep?.department_inactive ?? false,
      };
    });

    return Response.json({ batches });
  } catch (e: any) {
    console.error('GET /api/kitchen-production failed:', e);
    return Response.json({ error: e?.message || 'Failed to list batches' }, { status: 500 });
  }
}

// ---------- POST ----------
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageKitchenProduction(me)) return Response.json({ error: 'Head chef, manager or admin only' }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    let item_name = String(body?.item_name || '').trim();

    const quantity_produced = Number(body?.quantity_produced) || 0;
    if (quantity_produced <= 0) {
      return Response.json({ error: 'quantity_produced must be greater than 0' }, { status: 400 });
    }

    const outletId = await getCurrentOutletId();
    const db = getDb();

    // Every batch MUST link to a Production Item (production_item_id), so FIFO can
    // never be split by a free-typed variant. The item is authoritative for the
    // name; category/unit/storage fall back to its defaults when left blank.
    //   - production_item_id given (the shipped UI path) → validate it.
    //   - only item_name given (a stale tablet mid-rolling-deploy) → RESOLVE it to
    //     an existing master by name (NOCASE); reject unknown names rather than
    //     insert a NULL-id row that would resurrect a name / split a chain later.
    let production_item_id = String(body?.production_item_id || '').trim() || null;
    let pItem: any = null;
    if (production_item_id) {
      pItem = db.prepare(`SELECT * FROM production_items WHERE id = ?`).get(production_item_id);
      if (!pItem) return Response.json({ error: 'Unknown production item — refresh the item list' }, { status: 400 });
      if (!pItem.is_active) return Response.json({ error: `"${pItem.name}" is deactivated — reactivate it in the item list first` }, { status: 400 });
      item_name = pItem.name;
    } else if (item_name) {
      pItem = db.prepare(`SELECT * FROM production_items WHERE name = ? COLLATE NOCASE`).get(item_name);
      if (!pItem) return Response.json({ error: `"${item_name}" is not in the Production Items list — refresh and select an item (or add it via Manage Items).` }, { status: 400 });
      production_item_id = pItem.id;
      item_name = pItem.name;   // canonicalise to the master's exact name/case
    } else {
      return Response.json({ error: 'A production item is required — refresh and select one from the list.' }, { status: 400 });
    }

    const production_date = String(body?.production_date || '').trim();
    const department = me.department_id || '';
    const userLabel = me.name || me.email || '';

    // Which department this batch was made FOR. null = not stated, which is the
    // supported legacy state — the field is optional and always has been.
    // resolveBatchDepartment throws a chef-readable message rather than storing
    // a dangling id when the choice names something retired or gone.
    let deptLink;
    try {
      deptLink = resolveBatchDepartment(db, body);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : 'Invalid department' }, { status: 400 });
    }
    // The chosen name is the section label from here on. A client that sent no
    // department keeps whatever it put in kitchen_section — unchanged behaviour.
    const kitchen_section = deptLink ? deptLink.label : String(body?.kitchen_section || '');

    // Brewery batch number (ruling 114). The ITEM's setting decides: anything
    // but a Brewery item set to typed / serial code comes back null here and
    // takes the automatic number below, exactly as before.
    const typed = resolveTypedBatchNumber(pItem, body?.batch_number_entry);
    // `code` lets the Brewery form show the message under its Batch Number box.
    if (typed.error) return Response.json({ error: typed.error, code: 'batch_number' }, { status: 400 });

    const insert = db.transaction((): { id: string } | { duplicate: { batch_number: string; production_date: string; created_at: string } } => {
      // Already used by another batch of the SAME item → refuse, inside the
      // same transaction as the insert so two saves cannot both pass. Every
      // batch of the item counts, whatever its status; other items may reuse
      // the number.
      if (typed.batch_number !== null) {
        const want = batchNumberKey(typed.batch_number);
        const prior = db.prepare(
          `SELECT batch_number, production_date, created_at FROM production_batches
            WHERE production_item_id = ? ORDER BY COALESCE(production_date, '') ASC, created_at ASC, rowid ASC`
        ).all(production_item_id) as Array<{ batch_number: string; production_date: string; created_at: string }>;
        const hit = prior.find((b) => batchNumberKey(b.batch_number) === want);
        if (hit) return { duplicate: hit };
      }

      const id = generateId();
      const barcode = nextBarcode(db);
      const batch_number = typed.batch_number ?? buildBatchNumber(db, item_name, production_date, barcode);

      db.prepare(
        `INSERT INTO production_batches (
           id, outlet_id, batch_number, barcode, item_name, production_item_id, category,
           material_id, recipe_id, production_date, production_time,
           expiry_date, expiry_time, shelf_life, quantity_produced, quantity_consumed,
           unit, prepared_by, kitchen_section, storage_location, remarks, status
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        outletId,
        batch_number,
        barcode,
        item_name,
        production_item_id,
        String(body?.category || '') || String(pItem?.category || ''),
        body?.material_id || null,
        body?.recipe_id || null,
        production_date,
        String(body?.production_time || ''),
        String(body?.expiry_date || ''),
        String(body?.expiry_time || ''),
        String(body?.shelf_life || ''),
        quantity_produced,
        0,
        String(body?.unit || '') || String(pItem?.unit || ''),
        String(body?.prepared_by || ''),
        kitchen_section,
        String(body?.storage_location || '') || String(pItem?.default_storage_location || ''),
        String(body?.remarks || ''),
        'active',
      );

      // Same transaction as the batch: a batch can never exist with a half-
      // written department link, and no link is written when none was chosen.
      saveBatchDepartment(db, id, deptLink);

      db.prepare(
        `INSERT INTO batch_transactions (
           id, batch_id, outlet_id, type, quantity, balance_quantity, user, department, remarks
         ) VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(
        generateId(),
        id,
        outletId,
        'created',
        quantity_produced,
        quantity_produced,
        userLabel,
        department,
        '',
      );

      return { id };
    });

    const result = insert();
    if ('duplicate' in result) {
      const d = result.duplicate;
      const made = fmtISTDate(d.production_date || d.created_at, { fallback: 'date not recorded' });
      return Response.json({
        error: `Batch ${d.batch_number} already exists for ${item_name} (made ${made}). Nothing was saved.`,
        code: 'duplicate_batch_number',
      }, { status: 409 });
    }
    const id = result.id;
    const row = db.prepare('SELECT * FROM production_batches WHERE id = ?').get(id) as ProductionBatch;
    const now = new Date();
    const dep = batchDepartmentMap(db, [id]).get(id);
    const batch = {
      ...enrichBatch(row, now),
      fifo_priority: null,
      department_id: dep?.department_id ?? null,
      department_key: dep?.department_key ?? null,
      department_name: dep?.department_name ?? '',
      department_inactive: dep?.department_inactive ?? false,
    };

    return Response.json({ batch });
  } catch (e: any) {
    console.error('POST /api/kitchen-production failed:', e);
    return Response.json({ error: e?.message || 'Failed to create batch' }, { status: 500 });
  }
}
