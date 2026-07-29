import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  getStoreById, materialStoreId, postLedger, userStoreAccess,
  upsertBillCharges, normalizeBillCharges,
} from '@/lib/store-engine';
import { caseFactor, packFactor, tripleToRecipe } from '@/lib/pack-units';

/**
 * POST /api/stores/[id]/procure-bulk — FORGIVING CSV bulk upload for a store
 * (liquor). One supplier invoice OR a multi-bill inward register, many rows
 * parsed from a CSV. Unlike /procure-bill (manual, all-or-nothing), this SKIPS
 * rows it can't handle and reports them back so the user can fix + re-upload
 * just those — mirroring the central Generic CSV upload (/api/purchases/bulk).
 *
 * body: {
 *   invoice_ref  — REQUIRED header bill/invoice number. A row that carries its
 *                  own inward_no posts under THAT number instead (a register
 *                  CSV holds many inward bills); invoice_ref covers rows
 *                  without one and keys the bill-level charges,
 *   supplier / vendor_id, date? (YYYY-MM-DD backdate),
 *   charges?     — bill-level { mrp_rounding, excise_turnover_tax,
 *                  special_excise_cess, tcs } (recorded, never touches cost),
 *   rows: [{
 *     item_name, sku?,               — match by SKU first, else name (NOCASE)
 *     cases?, bottles?, loose?,      — bar counting convention (blank = 0)
 *     unit_price?, per_case?,        — ₹ per BOTTLE (or per CASE if per_case)
 *     amount?,                       — …OR the line total ₹ (unit_price wins)
 *     batch_no?, expiry_date?, inward_no?,
 *   }]
 * }
 *
 * Idempotency: if invoice_ref already has purchase rows in this store, NOTHING
 * is posted and { duplicate: true } is returned — the same bill can't double.
 * Matched+valid rows post as one 'purchase' ledger row each in one transaction;
 * the bill charges upsert in the same transaction. Skipped rows are echoed with
 * a reason + all fields so the client can offer a "download un-uploaded rows" CSV.
 */
export const dynamic = 'force-dynamic';

type SkipKind = 'missing' | 'not_found' | 'wrong_store' | 'invalid' | 'duplicate';
interface SkippedRow {
  row: number;
  item_name: string; sku: string;
  cases: any; bottles: any; loose: any; unit_price: any; amount: any;
  batch_no: string; expiry_date: string; date: string;
  kind: SkipKind; reason: string;
}

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

    // Bill-level default date (from the modal). A CSV row may override it with
    // its own `date` column; otherwise every row falls back to this.
    const date = String(b.date || '').trim();
    const backdate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    const rowDate = (v: any) => {
      const d = String(v || '').trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : backdate;
    };

    if (!Array.isArray(b.rows) || b.rows.length === 0) {
      return Response.json({ error: 'rows array is required (at least one CSV line)' }, { status: 400 });
    }

    // ── Idempotency at the LINE level, keyed by the row's OWN ref. A register
    //    CSV holds MANY inward bills: the same material at the same qty on TWO
    //    different inwards is two real purchases, so the dup key must include
    //    the ref. The HEADER ref's rows are ALSO checked for every row — before
    //    per-row refs existed, whole registers posted under one header number,
    //    and re-uploading such a file must not double those legacy lines. ──
    const rowRefOf = (row: any) => String(row?.inward_no || '').trim() || invoiceRef;
    const involvedRefs = Array.from(new Set(
      [invoiceRef, ...b.rows.map((r: any) => rowRefOf(r))].map(r => r.toLowerCase()),
    ));
    const postedByRef = new Map<string, Set<string>>();
    {
      const q = db.prepare(`
        SELECT material_id, quantity FROM store_stock_ledger
        WHERE store_id = ? AND txn_type = 'purchase' AND LOWER(TRIM(ref)) = ?
      `);
      for (const ref of involvedRefs) {
        postedByRef.set(ref, new Set(
          (q.all(storeId, ref) as any[])
            .map(r => `${r.material_id}|${Math.round(Number(r.quantity) * 1000)}`),
        ));
      }
    }
    const seenInFile = new Set<string>();
    const dupKey = (matId: string, recipeQty: number) => `${matId}|${Math.round(recipeQty * 1000)}`;

    // Name + SKU lookup over ALL materials (match then verify store mapping).
    const mats = db.prepare(`
      SELECT id, name, sku, category, unit, purchase_unit, pack_size, case_size FROM raw_materials
    `).all() as any[];
    const byName = new Map<string, any>();
    const bySku = new Map<string, any>();
    for (const m of mats) {
      byName.set(String(m.name || '').toLowerCase().trim(), m);
      const s = String(m.sku || '').toLowerCase().trim();
      if (s) bySku.set(s, m);
    }

    // Bill charges: incoming (this upload) + any already-stored row for the ref.
    // On a balance re-upload the user usually leaves charges blank — so when
    // this upload carries no charge amounts we PRESERVE the stored ones rather
    // than overwrite them with zeros. mrp_rounding is signed (may be negative).
    const incoming = normalizeBillCharges(b.charges);
    const incomingHasValue = incoming.mrp_rounding !== 0 || incoming.excise_turnover_tax !== 0
      || incoming.special_excise_cess !== 0 || incoming.tcs !== 0;
    const existingCharges = db.prepare(`
      SELECT mrp_rounding, excise_turnover_tax, special_excise_cess, tcs
      FROM store_bill_charges WHERE store_id = ? AND TRIM(invoice_ref) = ? COLLATE NOCASE
    `).get(storeId, invoiceRef) as any;
    const effectiveCharges = incomingHasValue
      ? incoming
      : (existingCharges
        ? { mrp_rounding: existingCharges.mrp_rounding, excise_turnover_tax: existingCharges.excise_turnover_tax,
            special_excise_cess: existingCharges.special_excise_cess, tcs: existingCharges.tcs }
        : incoming);
    const num = (v: any) => (v === undefined || v === null || v === '') ? 0 : Number(v);

    let duplicates = 0;
    const skipped_rows: SkippedRow[] = [];
    const prepared: {
      material_id: string; name: string; unit: string; recipe_qty: number;
      unit_cost: number; line_total: number; batch_no: string; expiry_date: string;
      date: string | null; ref: string;
      discount: number; cgst: number; sgst: number; delivery_charges: number;
    }[] = [];

    const skip = (row: any, i: number, kind: SkipKind, reason: string) => {
      if (kind === 'duplicate') duplicates++;
      skipped_rows.push({
        row: i + 1,
        item_name: String(row.item_name || '').trim(), sku: String(row.sku || '').trim(),
        cases: row.cases ?? '', bottles: row.bottles ?? '', loose: row.loose ?? '',
        unit_price: row.unit_price ?? '', amount: row.amount ?? '',
        batch_no: String(row.batch_no || '').trim(), expiry_date: String(row.expiry_date || '').trim(),
        date: String(row.date || '').trim(),
        kind, reason,
      });
    };

    for (let i = 0; i < b.rows.length; i++) {
      const row = b.rows[i] || {};
      const name = String(row.item_name || '').trim();
      const sku = String(row.sku || '').trim();
      if (!name && !sku) { skip(row, i, 'missing', 'No item name or SKU on this row.'); continue; }

      const mat = (sku && bySku.get(sku.toLowerCase())) || byName.get(name.toLowerCase());
      if (!mat) {
        skip(row, i, 'not_found', `Material not found: "${name || sku}" — name/SKU must match a Raw Material.`);
        continue;
      }
      if (materialStoreId(db, mat) !== storeId) {
        skip(row, i, 'wrong_store',
          `"${mat.name}" is not a ${store.name} material — its category "${mat.category}" is not mapped to this store (Settings → Store Locations).`);
        continue;
      }

      const cases = num(row.cases), bottles = num(row.bottles), loose = num(row.loose);
      if (![cases, bottles, loose].every(v => Number.isFinite(v) && v >= 0)) {
        skip(row, i, 'invalid', `${mat.name}: cases/bottles/loose must be numbers ≥ 0.`); continue;
      }
      const recipeQty = tripleToRecipe(cases, bottles, loose, mat);
      if (!(recipeQty > 0)) { skip(row, i, 'invalid', `${mat.name}: enter a quantity (cases / bottles / loose).`); continue; }

      // Line-level idempotency: this material at this qty already posted under
      // this row's ref (earlier upload), under the header ref (legacy uploads
      // stamped everything with it), or repeated within this file → skip.
      const rowRef = rowRefOf(row);
      const key = dupKey(mat.id, recipeQty);
      const fileKey = `${rowRef.toLowerCase()}|${key}`;
      if (postedByRef.get(rowRef.toLowerCase())?.has(key)
          || postedByRef.get(invoiceRef.toLowerCase())?.has(key)
          || seenInFile.has(fileKey)) {
        skip(row, i, 'duplicate',
          `${mat.name}: already uploaded under invoice ${rowRef} — skipped to avoid double-counting.`);
        continue;
      }
      seenInFile.add(fileKey);

      // Price: explicit unit_price (per bottle, or per case) wins; else derive
      // ₹/recipe-unit straight from the line amount (amount ÷ recipe qty).
      const rawPrice = num(row.unit_price);
      const amount = num(row.amount);
      let unitCost = 0;   // ₹ per recipe unit
      let lineTotal = 0;
      if (rawPrice > 0) {
        const cf = caseFactor(mat);
        const perBottle = row.per_case ? rawPrice / cf : rawPrice;
        const pf = packFactor(mat);
        unitCost = pf > 1 ? perBottle / pf : perBottle;
        lineTotal = Math.round(recipeQty * unitCost * 100) / 100;
      } else if (amount > 0) {
        unitCost = amount / recipeQty;
        lineTotal = Math.round(amount * 100) / 100;
      } else {
        skip(row, i, 'invalid', `${mat.name}: enter a unit price OR a line amount.`); continue;
      }

      prepared.push({
        material_id: mat.id, name: mat.name, unit: mat.unit,
        recipe_qty: recipeQty, unit_cost: unitCost, line_total: lineTotal,
        batch_no: String(row.batch_no || '').trim(),
        expiry_date: String(row.expiry_date || '').trim(),
        date: rowDate(row.date), ref: rowRef,
        discount: Math.max(0, num(row.discount)), cgst: Math.max(0, num(row.cgst)),
        sgst: Math.max(0, num(row.sgst)), delivery_charges: Math.max(0, num(row.delivery_charges)),
      });
    }

    const totalValue = Math.round(prepared.reduce((s, p) => s + p.line_total, 0) * 100) / 100;
    const ledgerIds: string[] = [];
    let billCharges: any = null;

    if (prepared.length > 0) {
      const backdateStmt = db.prepare(`
        UPDATE store_stock_ledger SET created_at = ? || ' ' || strftime('%H:%M:%S', 'now') WHERE id = ?
      `);
      const txn = db.transaction(() => {
        for (const p of prepared) {
          const id = postLedger(db, {
            store_id: storeId, material_id: p.material_id, txn_type: 'purchase',
            quantity: p.recipe_qty, unit_cost: p.unit_cost, batch_no: p.batch_no,
            supplier, vendor_id: vendorId, expiry_date: p.expiry_date,
            ref: p.ref, notes: '', created_by: user.email,
            discount: p.discount, cgst: p.cgst, sgst: p.sgst, delivery_charges: p.delivery_charges,
          });
          if (p.date) backdateStmt.run(p.date, id);
          ledgerIds.push(id);
        }
        // Record/refresh bill charges when this upload carries charge amounts OR
        // a charges row already exists (balance re-upload). Invoice Value is
        // recomputed from the FULL ledger for this (store, invoice_ref) so it
        // stays correct across a first upload + later balance re-uploads.
        if (incomingHasValue || existingCharges) {
          // Invoice Value spans the header ref AND every per-row inward ref this
          // upload touched — a register's charges cover all its inwards.
          const refList = Array.from(new Set([invoiceRef.toLowerCase(), ...prepared.map(p => p.ref.toLowerCase())]));
          const inv = db.prepare(`
            SELECT COALESCE(SUM(quantity * unit_cost), 0) AS v FROM store_stock_ledger
            WHERE store_id = ? AND txn_type = 'purchase'
              AND LOWER(TRIM(ref)) IN (${refList.map(() => '?').join(',')})
          `).get(storeId, ...refList) as any;
          billCharges = upsertBillCharges(db, {
            store_id: storeId, invoice_ref: invoiceRef, supplier, date: backdate || '',
            invoice_value: Math.round((Number(inv?.v) || 0) * 100) / 100,
            charges: effectiveCharges, created_by: user.email,
          });
        }
      });
      txn();

      logAuditEvent(db, {
        event_type: 'store.procure_bulk_csv',
        entity_type: 'store_stock_ledger',
        entity_id: invoiceRef,
        actor_email: user.email,
        after: {
          store_id: storeId, store: store.name, invoice_ref: invoiceRef, supplier,
          vendor_id: vendorId, date: backdate || undefined,
          posted: prepared.length, skipped: skipped_rows.length, total_value: totalValue,
          bill_charges: billCharges || undefined,
        },
        note: `${store.name}: CSV bill ${invoiceRef} from ${supplier} — ${prepared.length} posted, `
          + `${skipped_rows.length} skipped, ₹${totalValue}`
          + (() => { const n = new Set(prepared.map(p => p.ref)).size; return n > 1 ? ` across ${n} inward numbers` : ''; })()
          + (billCharges ? ` (Net Indent ₹${billCharges.net_indent_value})` : ''),
      });
    }

    return Response.json({
      ok: true,
      posted: prepared.length,
      skipped: skipped_rows.length,
      duplicates,
      total_value: totalValue,
      bill_charges: billCharges || null,
      skipped_rows,
      lines: prepared.map((p, i) => ({
        material_id: p.material_id, ledger_id: ledgerIds[i],
        material: p.name, recipe_qty: p.recipe_qty, unit_cost: p.unit_cost, line_total: p.line_total,
      })),
    }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/stores/[id]/procure-bulk POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
