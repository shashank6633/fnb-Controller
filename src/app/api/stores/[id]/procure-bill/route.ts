import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, materialStoreId, postLedger, userStoreAccess } from '@/lib/store-engine';
import { caseFactor, packFactor, tripleToRecipe } from '@/lib/pack-units';

/**
 * POST /api/stores/[id]/procure-bill — BULK bill entry: one supplier invoice
 * with many lines, posted as one 'purchase' ledger row PER LINE in a single
 * transaction (all-or-nothing — a supplier bill must never half-post).
 * Gate: userStoreAccess(...).can_procure. Same central-isolation as /procure.
 *
 * body: {
 *   supplier            — bill header (required unless vendor_id resolves one),
 *   invoice_ref         — REQUIRED: shared ledger `ref`, the bill grouping key,
 *   vendor_id?, date? (YYYY-MM-DD backdate),
 *   lines: [{
 *     material_id,
 *     cases?, bottles?, loose?   — bar counting convention (blank = 0):
 *                                  recipe qty = cases×case_size×pack + bottles×pack + loose,
 *     unit_price                 — ₹ per BOTTLE (purchase unit)…
 *     per_case?                  — …or per CASE when true (÷ case_size),
 *     batch_no?, expiry_date?,
 *   }]
 * }
 *
 * Every line is validated (exists + mapped to this store + qty > 0) BEFORE any
 * write; any bad line rejects the whole bill with a per-line error message.
 * → { ok, posted, total_value, skipped: [], lines: [{material_id, ledger_id,
 *      recipe_qty, unit_cost, line_total}] }
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    const access = userStoreAccess(db, user, storeId);
    if (!access.can_procure) {
      return Response.json({ error: `You are not authorized to procure for ${store.name}` }, { status: 403 });
    }

    const b = await request.json();
    const invoiceRef = String(b.invoice_ref || '').trim();
    if (!invoiceRef) return Response.json({ error: 'invoice_ref is required (the bill / invoice number)' }, { status: 400 });

    let vendorId = String(b.vendor_id || '').trim();
    let supplier = String(b.supplier || '').trim();
    if (vendorId) {
      const v = db.prepare('SELECT id, name FROM vendors WHERE id = ?').get(vendorId) as any;
      if (!v) return Response.json({ error: 'Unknown vendor_id' }, { status: 400 });
      if (!supplier) supplier = v.name;
    }
    if (!supplier) return Response.json({ error: 'supplier is required' }, { status: 400 });

    const date = String(b.date || '').trim();
    const backdate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;

    if (!Array.isArray(b.lines) || b.lines.length === 0) {
      return Response.json({ error: 'lines array is required (at least one bill line)' }, { status: 400 });
    }

    // ── Validate EVERY line before writing anything ──
    const prepared: {
      material_id: string; name: string; unit: string; purchase_unit: string;
      cases: number; bottles: number; loose: number;
      recipe_qty: number; unit_cost: number; price_per_bottle: number;
      line_total: number; batch_no: string; expiry_date: string;
    }[] = [];
    for (let i = 0; i < b.lines.length; i++) {
      const line = b.lines[i] || {};
      const at = `Line ${i + 1}`;
      const materialId = String(line.material_id || '').trim();
      if (!materialId) return Response.json({ error: `${at}: material_id is required` }, { status: 400 });
      const mat = db.prepare(`
        SELECT id, name, category, unit, purchase_unit, pack_size, case_size
        FROM raw_materials WHERE id = ?
      `).get(materialId) as any;
      if (!mat) return Response.json({ error: `${at}: material not found` }, { status: 400 });
      if (materialStoreId(db, mat) !== storeId) {
        return Response.json({
          error: `${at}: "${mat.name}" is not a ${store.name} material — its category "${mat.category}" is not mapped to this store (Settings → Store Locations)`,
        }, { status: 400 });
      }
      const num = (v: any) => (v === undefined || v === null || v === '') ? 0 : Number(v);
      const cases = num(line.cases), bottles = num(line.bottles), loose = num(line.loose);
      if (![cases, bottles, loose].every(v => Number.isFinite(v) && v >= 0)) {
        return Response.json({ error: `${at} (${mat.name}): cases, bottles and loose must be numbers ≥ 0` }, { status: 400 });
      }
      const recipeQty = tripleToRecipe(cases, bottles, loose, mat);
      if (!(recipeQty > 0)) {
        return Response.json({ error: `${at} (${mat.name}): enter a quantity — cases, bottles and/or loose` }, { status: 400 });
      }
      const rawPrice = Number(line.unit_price);
      if (!Number.isFinite(rawPrice) || rawPrice < 0) {
        return Response.json({ error: `${at} (${mat.name}): unit_price must be a number ≥ 0` }, { status: 400 });
      }
      const cf = caseFactor(mat);
      const pricePerBottle = line.per_case ? rawPrice / cf : rawPrice;
      const pf = packFactor(mat);
      const unitCost = pf > 1 ? pricePerBottle / pf : pricePerBottle;   // ₹/recipe unit
      prepared.push({
        material_id: materialId, name: mat.name, unit: mat.unit,
        purchase_unit: mat.purchase_unit || mat.unit,
        cases, bottles, loose,
        recipe_qty: recipeQty, unit_cost: unitCost, price_per_bottle: pricePerBottle,
        line_total: Math.round(recipeQty * unitCost * 100) / 100,
        batch_no: String(line.batch_no || '').trim(),
        expiry_date: String(line.expiry_date || '').trim(),
      });
    }

    // ── ONE transaction: a ledger 'purchase' row per line, shared header ──
    const ledgerIds: string[] = [];
    const backdateStmt = db.prepare(`
      UPDATE store_stock_ledger SET created_at = ? || ' ' || strftime('%H:%M:%S', 'now') WHERE id = ?
    `);
    const txn = db.transaction(() => {
      for (const p of prepared) {
        const id = postLedger(db, {
          store_id: storeId,
          material_id: p.material_id,
          txn_type: 'purchase',
          quantity: p.recipe_qty,
          unit_cost: p.unit_cost,
          batch_no: p.batch_no,
          supplier,
          vendor_id: vendorId,
          expiry_date: p.expiry_date,
          ref: invoiceRef,
          notes: '',
          created_by: user.email,
        });
        if (backdate) backdateStmt.run(backdate, id);
        ledgerIds.push(id);
      }
    });
    txn();

    const totalValue = Math.round(prepared.reduce((s, p) => s + p.line_total, 0) * 100) / 100;

    logAuditEvent(db, {
      event_type: 'store.procure_bill',
      entity_type: 'store_stock_ledger',
      entity_id: invoiceRef,
      actor_email: user.email,
      after: {
        store_id: storeId, store: store.name,
        invoice_ref: invoiceRef, supplier, vendor_id: vendorId,
        date: backdate || undefined,
        lines: prepared.map((p, i) => ({
          ledger_id: ledgerIds[i], material_id: p.material_id, material: p.name,
          cases: p.cases, bottles: p.bottles, loose: p.loose,
          recipe_qty: p.recipe_qty, recipe_unit: p.unit,
          price_per_bottle: p.price_per_bottle, unit_cost: p.unit_cost,
          line_total: p.line_total,
          batch_no: p.batch_no, expiry_date: p.expiry_date,
        })),
        total_value: totalValue,
      },
      note: `${store.name}: bill ${invoiceRef} from ${supplier} — ${prepared.length} line(s), ₹${totalValue}`,
    });

    return Response.json({
      ok: true,
      posted: prepared.length,
      total_value: totalValue,
      skipped: [],
      lines: prepared.map((p, i) => ({
        material_id: p.material_id, ledger_id: ledgerIds[i],
        recipe_qty: p.recipe_qty, unit_cost: p.unit_cost, line_total: p.line_total,
      })),
    }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/stores/[id]/procure-bill POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
