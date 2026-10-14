import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { isStoreMappedMaterial } from '@/lib/store-engine';
import { materialsAwaitingQc } from '@/lib/grn-qc';
import { dualQty, fmtQtyNum } from '@/lib/pack-units';

/**
 * One-click repair: lift any NEGATIVE raw-material current_stock up to 0, and
 * BOOK THE LIFT as a signed 'adjustment' in inventory_transactions.
 *
 * WHY THE ROW IS THE POINT, NOT THE UPDATE. Setting current_stock = 0 creates
 * stock out of nothing. Until this route wrote a ledger row, that invention had
 * no trace at all: no quantity, no value, no actor, no timestamp — the on-hand
 * simply changed and every downstream report inherited the new number as if it
 * had always been true. One row per lifted material makes the invention a
 * recorded, attributable event. Do not "simplify" the per-material loop back
 * into a single blanket UPDATE: the loop exists so that no gram is created
 * without a row, and no row is written without a gram actually moving.
 *
 * WHY NEGATIVES ARE NO LONGER RARE. The original note here said negatives only
 * arise from an Admin Reset that strips purchases while leaving the consumption
 * behind. That is now the minor case. Under deduct-at-issue, central loses the
 * gram the moment the store issues it, and recorded issues have historically
 * run several times recorded purchases (CHICKEN LEG BONELESS: 1,309 kg bought
 * against 4,471 kg issued). Central going negative is therefore an ordinary,
 * expected consequence of an incomplete purchase history — not a corruption
 * event. Which is exactly why this button must stop being a silent one-click
 * eraser: it will be reached for often, and each use is a real write-up of
 * book value.
 *
 * THIS IS NOT A COUNT AND IT IS NOT A FIX. Lifting to 0 asserts "the shelf is
 * empty", which is almost never true. The honest correction is a physical count
 * (Opening/Closing Stock), or completing the missing purchases. This route only
 * stops the negative from poisoning Total Stock Value in the meantime.
 *
 * TYPE 'adjustment' IS DELIBERATE AND LOAD-BEARING. Every central reader was
 * checked line by line before choosing it:
 *   · variance-report/route.ts:78-81 EXCLUDES 'adjustment' from the central
 *     theoretical, for the same reason variance-approval posts one — the row
 *     moves the book ONTO a stated figure, so subtracting it again would
 *     double-count against the very count being reconciled.
 *   · variance-report:214 (unmodelled_outflow_to_date) is the diagnostic that
 *     fires a top-level warning the moment an unmodelled type appears. Its list
 *     is transfer / butchering_input / butchering_output ONLY. 'adjustment' is
 *     absent, so lifting a negative does NOT raise a phantom "unmodelled
 *     outflow" alarm on the Variance Report. If you ever add 'adjustment' to
 *     that list, this route starts crying wolf on every use.
 *   · inventory/route.ts:75 (total_consumed), daily-rollup:76/87/92 and
 *     anomalies:172 all whitelist sale/nc/party/staff_meal/wastage —
 *     'adjustment' is outside every one of them.
 *   · inventory/priority:89 only reads quantity < 0; these rows are positive.
 * So the audit gains a row and no report changes its numbers. Retyping these
 * as 'purchase' or 'opening' would silently inflate purchase-based reports.
 *
 * WHERE THE ROW IS ACTUALLY READ TODAY. There is no per-material transaction
 * history SCREEN — nothing under src/app renders inventory_transactions.notes.
 * The row is reachable through DB Explorer and through this route's own
 * response (batch_id groups one run). The actor is therefore written INTO the
 * notes text rather than a column, because there is no user_id column on
 * inventory_transactions and adding one is another owner's file. Say so plainly
 * rather than implying a UI that does not exist.
 *
 * LIQUOR CARVE-OUT (do not remove). Store-mapped materials live on the TGBCL
 * store rail (store_stock_ledger / store_locations); centralFlowBlock exists
 * precisely to keep them out of central flows. Their raw_materials.current_stock
 * is a vestigial central number that nothing on the liquor rail reads, so
 * lifting it here would create liquor that the store ledger has never heard of
 * — two truths for one bottle. They are SKIPPED by default and reported
 * separately, pointing at Inventory -> Liquor Store -> Adjust, which is the only
 * writer that keeps the store ledger and the balance in step. An explicit
 * include_store_mapped:true still lets an admin clear a stray central-book
 * negative, and stamps the reason on the row.
 *
 * KITCHEN-QC CARVE-OUT (do not remove, and there is no flag to override it).
 * A material with a delivery still AWAITING A QUALITY CHECK is never lifted:
 * its goods are on the shelf and off the book on purpose, so lifting to 0 and
 * then signing the check credits the same crate twice. See scan() below.
 *
 * Admin only.
 *   GET                          → preview only. Never writes. Safe to poll.
 *   POST {}                      → arms a confirmation: returns the preview and
 *                                  writes nothing. Repeat the same POST while
 *                                  the preview is unchanged to execute.
 *   POST { confirm: 'FIX' }      → executes immediately (explicit callers).
 *   POST { include_store_mapped: true } → also lifts store-mapped materials.
 */
export const dynamic = 'force-dynamic';

const EPS = 1e-9;

/** How long an armed confirmation stays valid. Short on purpose — the preview
 *  quotes a rupee figure, and a stale figure is a lie, not a convenience. */
const CONFIRM_WINDOW_MS = 2 * 60 * 1000;

/**
 * WHY THE HANDSHAKE IS IN-MEMORY AND WHY THAT IS SAFE. The only caller today
 * (/admin/reset) POSTs with no body and cannot be taught a token from here, so
 * the confirmation has to survive between two identical requests. This map is
 * the whole of that state. Losing it — a redeploy, a second worker — costs the
 * admin one extra click and can never cause a write: an unarmed POST always
 * previews. The signature is hashed over the exact rows quoted, so if stock
 * moved between the two clicks the arm is void and the admin re-reads the new
 * numbers instead of confirming figures that no longer exist.
 */
const armed = new Map<string, { sig: string; at: number }>();

type NegRow = {
  id: string; name: string; sku: string; category: string;
  current_stock: number; average_price: number; is_active: number;
  unit: string; purchase_unit: string; pack_size: number; case_size: number;
};

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const inr = (n: number) =>
  `₹${money(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Read every negative row once, split by rail. Pure read — no writes here. */
function scan(db: ReturnType<typeof getDb>) {
  const rows = db.prepare(`
    SELECT id, name, COALESCE(sku,'') AS sku, COALESCE(category,'') AS category,
           current_stock, COALESCE(average_price, 0) AS average_price, is_active,
           COALESCE(unit,'') AS unit, COALESCE(purchase_unit,'') AS purchase_unit,
           COALESCE(pack_size, 1) AS pack_size, COALESCE(case_size, 1) AS case_size
    FROM raw_materials
    WHERE current_stock < 0
    ORDER BY (current_stock * COALESCE(average_price, 0)) ASC
  `).all() as NegRow[];

  // ── THE KITCHEN-QC CARVE-OUT (do not remove) ─────────────────────────────
  // A GRN held for a quality check has its goods PHYSICALLY ON THE SHELF and
  // DELIBERATELY OFF THE BOOK (src/lib/grn-qc.ts). Lifting such a material to 0
  // asserts "the shelf is empty" at the one moment that is provably false, and
  // the sign-off then adds the whole delivery ON TOP of the lifted zero:
  //
  //   book −60  ·  100 kg held at the bay        (shelf holds the 100)
  //   lift → 0                                   (+60 created out of nothing)
  //   kitchen signs → +100                       book 100, not 40
  //
  // Exactly the argument the central-store cutover already makes inside
  // decideGrnQc, and the reason varianceApprovalBlock refuses a closing count
  // taken in the same window. It matters MORE here than anywhere else, because
  // a hold DRIVES central negative — the department consumes at KOT-complete
  // against goods the book does not yet own — so this button is reached for
  // precisely while a delivery is waiting.
  //
  // Skipped like the liquor rail: named, reported, never silently dropped, and
  // with no include_ flag to override it. There is no case where lifting a
  // material that has an unsigned delivery against it is the right correction —
  // clearing the queue IS the correction, and it lands the real number.
  const held = materialsAwaitingQc(db);

  const central: NegRow[] = [];
  const storeMapped: NegRow[] = [];
  const heldQc: Array<NegRow & { grn_number: string }> = [];
  for (const r of rows) {
    const grn = held.get(r.id);
    if (grn) { heldQc.push({ ...r, grn_number: grn }); continue; }
    (isStoreMappedMaterial(db, r.id) ? storeMapped : central).push(r);
  }
  return { central, storeMapped, heldQc };
}

/** OWNER RULE: quantities lead with the PURCHASE unit; value is always computed
 *  on the recipe basis (average_price is ₹/recipe-unit), never on the display
 *  figure — purchasePrice() rounds and would drift against the total. */
function describe(r: NegRow) {
  const lift = -Number(r.current_stock);            // positive: what we create
  const d = dualQty(lift, r);
  return {
    material_id: r.id,
    name: r.name,
    sku: r.sku,
    category: r.category,
    is_active: r.is_active === 1,
    from_stock: Number(r.current_stock),
    to_stock: 0,
    lift_recipe_qty: lift,
    lift_purchase_qty: d.qty_purchase,
    unit: d.unit,
    purchase_unit: d.purchase_unit,
    avg_price_per_recipe_unit: Number(r.average_price),
    value_created: money(lift * Number(r.average_price)),
    display: `${fmtQtyNum(d.qty_purchase)} ${d.purchase_unit || d.unit}`.trim(),
  };
}

function buildPreview(db: ReturnType<typeof getDb>, includeStoreMapped: boolean) {
  const { central, storeMapped, heldQc } = scan(db);
  const target = includeStoreMapped ? [...central, ...storeMapped] : central;
  const items = target.map(describe);
  const skipped = includeStoreMapped ? [] : storeMapped.map(describe);
  // Never lifted, on either flag — see the carve-out note in scan().
  const skippedQc = heldQc.map(r => ({ ...describe(r), grn_number: r.grn_number }));

  const valueCreated = money(items.reduce((s, i) => s + i.value_created, 0));
  const totalAfter = db.prepare(`
    SELECT COALESCE(SUM(current_stock * average_price), 0) AS v
    FROM raw_materials WHERE is_active = 1
  `).get() as any;

  return {
    items,
    skipped_store_mapped: skipped,
    skipped_awaiting_qc: skippedQc,
    items_count: items.length,
    value_created: valueCreated,
    total_stock_value_now: money(totalAfter?.v || 0),
    // Signature over exactly what is quoted. Any drift voids the arm.
    sig: JSON.stringify(items.map(i => [i.material_id, i.from_stock])),
  };
}

/** The one sentence about held deliveries, used by every response shape. */
function qcSkipNote(p: ReturnType<typeof buildPreview>): string {
  const n = p.skipped_awaiting_qc.length;
  if (n === 0) return '';
  const names = p.skipped_awaiting_qc.slice(0, 3)
    .map(i => `${i.name} (${i.grn_number})`).join(', ');
  return ` ${n} item${n === 1 ? '' : 's'} skipped because a delivery is still awaiting a kitchen quality check `
    + `— ${names}${n > 3 ? ` and ${n - 3} more` : ''}. `
    + `Those goods are on the shelf but not on the book on purpose; lifting them to 0 now would double-count them `
    + `when the check is signed off. Clear them on Purchasing → Pending Quality Checks instead.`;
}

function previewSummary(p: ReturnType<typeof buildPreview>, includeStoreMapped: boolean) {
  if (p.items_count === 0) {
    return (p.skipped_store_mapped.length > 0
      ? `No central material is negative. ${p.skipped_store_mapped.length} liquor/store-mapped `
        + `item${p.skipped_store_mapped.length === 1 ? ' is' : 's are'} negative — fix those in `
        + `Inventory → Liquor Store → Adjust so the store ledger stays in step.`
      : (p.skipped_awaiting_qc.length > 0
        ? 'Nothing to fix right now.'
        : 'Nothing to fix — no material has negative stock.')) + qcSkipNote(p);
  }
  const names = p.items.slice(0, 3).map(i => `${i.name} (${i.display})`).join(', ');
  const more = p.items_count > 3 ? ` and ${p.items_count - 3} more` : '';
  return `CONFIRM: this will CREATE stock on ${p.items_count} item${p.items_count === 1 ? '' : 's'} `
    + `worth ${inr(p.value_created)} — ${names}${more}. `
    + `Nothing has changed yet. Click again within 2 minutes to confirm.`
    + (!includeStoreMapped && p.skipped_store_mapped.length > 0
      ? ` (${p.skipped_store_mapped.length} liquor/store-mapped item${p.skipped_store_mapped.length === 1 ? '' : 's'} skipped — fix in Liquor Store → Adjust.)`
      : '')
    + qcSkipNote(p);
}

async function requireAdmin() {
  const me = await getCurrentUser();
  if (!me) return { err: Response.json({ error: 'Sign in required' }, { status: 401 }) };
  if (me.role !== 'admin') return { err: Response.json({ error: 'Admin only' }, { status: 403 }) };
  return { me };
}

export async function GET(request: Request) {
  try {
    const { me, err } = await requireAdmin();
    if (err) return err;
    const includeStoreMapped = new URL(request.url).searchParams.get('include_store_mapped') === '1';
    const db = getDb();
    const p = buildPreview(db, includeStoreMapped);
    return Response.json({
      preview: true,
      requires_confirmation: p.items_count > 0,
      items: p.items,
      skipped_store_mapped: p.skipped_store_mapped,
      skipped_awaiting_qc: p.skipped_awaiting_qc,
      items_to_fix: p.items_count,
      value_to_create: p.value_created,
      total_stock_value_now: p.total_stock_value_now,
      summary: previewSummary(p, includeStoreMapped),
      actor: me!.email,
    });
  } catch (e: any) {
    console.error('[/api/inventory/fix-negative-stock GET]', e);
    return Response.json({ error: e?.message || 'Failed to read negative stock' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { me, err } = await requireAdmin();
    if (err) return err;

    // The live caller (/admin/reset) sends no body at all — tolerate it rather
    // than 400, or the button dies the moment this ships.
    let body: any = {};
    try { body = await request.json(); } catch { body = {}; }
    const includeStoreMapped = body?.include_store_mapped === true;
    const explicitConfirm = String(body?.confirm || '').trim().toUpperCase() === 'FIX';

    const db = getDb();
    const p = buildPreview(db, includeStoreMapped);

    if (p.items_count === 0) {
      armed.delete(me!.id);
      return Response.json({
        success: true,
        items_fixed: 0,
        adjustments_written: 0,
        quantity_created: 0,
        value_created: 0,
        skipped_store_mapped: p.skipped_store_mapped,
        skipped_awaiting_qc: p.skipped_awaiting_qc,
        total_stock_value_after: p.total_stock_value_now,
        summary: previewSummary(p, includeStoreMapped),
      });
    }

    // ── Confirmation gate ──────────────────────────────────────────────────
    const prev = armed.get(me!.id);
    const stillValid = !!prev && prev.sig === p.sig && (Date.now() - prev.at) < CONFIRM_WINDOW_MS;
    if (!explicitConfirm && !stillValid) {
      armed.set(me!.id, { sig: p.sig, at: Date.now() });
      return Response.json({
        success: false,
        requires_confirmation: true,
        items_fixed: 0,
        items: p.items,
        skipped_store_mapped: p.skipped_store_mapped,
        skipped_awaiting_qc: p.skipped_awaiting_qc,
        items_to_fix: p.items_count,
        value_to_create: p.value_created,
        summary: previewSummary(p, includeStoreMapped),
      });
    }
    armed.delete(me!.id);

    // ── Apply ──────────────────────────────────────────────────────────────
    const batchId = generateId();
    const stamp = `${me!.name || me!.email} <${me!.email}>`;
    const insertTx = db.prepare(`
      INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
      VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
    `);
    const updStock = db.prepare(`
      UPDATE raw_materials SET current_stock = 0, updated_at = datetime('now') WHERE id = ?
    `);

    const applied: ReturnType<typeof describe>[] = [];
    const run = db.transaction(() => {
      // Re-read INSIDE the transaction. better-sqlite3 is synchronous and this
      // is atomic, so the figure booked on the row is provably the figure that
      // was lifted — the preview above is for the human, never for the write.
      const fresh = scan(db);
      const rows = includeStoreMapped ? [...fresh.central, ...fresh.storeMapped] : fresh.central;
      for (const r of rows) {
        const lift = -Number(r.current_stock);
        // A zero movement would be a row asserting a change that did not happen.
        if (!(lift > EPS)) continue;
        const d = describe(r);
        const res = updStock.run(r.id);
        // Row must exist and must have moved. If it did not, throwing rolls the
        // whole batch back — a booked adjustment with no matching stock change
        // is worse than the negative it was meant to clear.
        if (res.changes !== 1) throw new Error(`Could not lift "${r.name}" — stock changed mid-fix. Nothing was applied; try again.`);
        insertTx.run(
          generateId(),
          r.id,
          lift,
          `fix-negative-stock:${batchId}`,
          `Negative stock lifted to 0 by ${stamp}. `
            + `${fmtQtyNum(d.lift_purchase_qty)} ${d.purchase_unit || d.unit} `
            + `(${fmtQtyNum(lift)} ${d.unit}) created, ${inr(d.value_created)} @ ${inr(r.average_price)}/${d.unit}. `
            + `Was ${fmtQtyNum(r.current_stock)} ${d.unit}.`
            + (isStoreMappedMaterial(db, r.id)
              ? ' STORE-MAPPED (liquor) — central book only; the store ledger is unchanged.'
              : '')
            + ' Not a physical count — record Opening/Closing Stock for the real on-hand.',
        );
        applied.push(d);
      }
    });
    run();

    const qtyCreated = applied.reduce((s, i) => s + i.lift_recipe_qty, 0);
    const valueCreated = money(applied.reduce((s, i) => s + i.value_created, 0));
    const after = db.prepare(`
      SELECT COALESCE(SUM(current_stock * average_price), 0) AS v
      FROM raw_materials WHERE is_active = 1
    `).get() as any;

    return Response.json({
      success: true,
      batch_id: batchId,
      actor: me!.email,
      items_fixed: applied.length,
      adjustments_written: applied.length,   // invariant: one row per lifted item
      quantity_created: Math.round(qtyCreated * 1000) / 1000,
      value_created: valueCreated,
      items: applied,
      skipped_store_mapped: includeStoreMapped ? [] : p.skipped_store_mapped,
      skipped_awaiting_qc: p.skipped_awaiting_qc,
      total_stock_value_after: money(after?.v || 0),
      summary: `Lifted ${applied.length} item${applied.length === 1 ? '' : 's'} to 0 and booked `
        + `${applied.length} adjustment row${applied.length === 1 ? '' : 's'} (${inr(valueCreated)} created) `
        + `against ${stamp}. This is a write-up, not a count — record Opening/Closing Stock for the real on-hand.`
        + (!includeStoreMapped && p.skipped_store_mapped.length > 0
          ? ` ${p.skipped_store_mapped.length} liquor/store-mapped item${p.skipped_store_mapped.length === 1 ? '' : 's'} left alone — fix in Liquor Store → Adjust.`
          : '')
        + qcSkipNote(p),
    });
  } catch (e: any) {
    console.error('[/api/inventory/fix-negative-stock]', e);
    return Response.json({ error: e?.message || 'Failed to fix negative stock' }, { status: 500 });
  }
}
