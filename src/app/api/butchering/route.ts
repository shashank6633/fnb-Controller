import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { deptOnHandBulk, deptKey } from '@/lib/dept-ledger';
import { planCentralDebit, holdsAny, fmtGridQty } from '@/lib/central-debit-clamp';

/**
 * Butchering — carcass breakdown into named cuts.
 *
 * Lifecycle:
 *   open   → batch created, outputs being added
 *   closed → inventory transactions posted (source debited, cuts credited)
 *   cancelled → batch discarded before close
 *
 * GET    /api/butchering                        → list batches (?status, ?from, ?to)
 * GET    /api/butchering?id=<uuid>              → batch detail with outputs
 * POST   /api/butchering                        → create open batch
 *        body: { batch_id, source_material_id, gross_weight, invoice_weight?,
 *                vendor_id?, grn_id?, butcher?, head_chef?, notes? }
 * PUT    /api/butchering                        → update open batch (outputs + meta)
 *        body: { id, outputs?: [...], butcher?, head_chef?, notes?, action?: 'close' | 'cancel' }
 * DELETE /api/butchering?id=<uuid>              → delete open batch only
 *
 * On close: validates reconciliation gap ≤ 1.5%, refuses if a DEPARTMENT holds
 * the carcass, refuses if the CENTRAL STORE does not hold it (both guards in
 * PUT — a breakdown posts both halves or neither), then atomically:
 *   1. Debits source_material.current_stock by gross_weight
 *   2. Credits each cut's material.current_stock by its weight (pro-rata cost)
 *   3. Writes inventory_transactions rows for the audit log
 *
 * Butchering is a CENTRAL-STORE operation, start to finish. Both stock legs
 * above are raw_materials.current_stock — the store's pool. Nothing here posts
 * to the department ledger, and v1 deliberately does not learn how to.
 */
export const dynamic = 'force-dynamic';

const RECONCILE_TOLERANCE = 0.015; // 1.5%

// THE CARCASS FLOOR'S TOLERANCE is not a constant in this file any more, and it
// is NOT the department guard's HOLD_EPS. It is planCentralDebit's 6-dp grid
// (src/lib/central-debit-clamp.ts) — the one rule every central floor asks, the
// GRN void guard included. The two local copies that stood here (STOCK_EPS 1e-9
// + r6) let a carcass 4e-7 over the balance through and wrote −4e-7.
// MEASURED, and still true under the grid: at the department guard's additive
// 1e-6 a carcass 1 mg short of the balance closed anyway and left current_stock
// at -0.000001. The grid refuses that carcass (it is a whole step over), and a
// carcass that IS everything on the shelf lands on exactly 0, never below.
// "Does a department hold any of this" tolerates more slop than "may this debit
// be written", so they still do not share a figure.

/**
 * Thrown by the carcass floor INSIDE the close transaction, so the refusal and
 * the debit it guards are the same transaction. PUT catches it immediately
 * around txn() and answers 409 with `.message` — the same status the
 * department-held refusal next to it uses, because it is the same physical
 * question asked of the other pool. Nothing is posted and the batch stays open.
 */
class CarcassShort extends Error {
  readonly code = 'CARCASS_SHORT';
  constructor(message: string) {
    super(message);
    this.name = 'CarcassShort';
  }
}

// Metric normalization — MIRRORS page.tsx (uNorm/METRIC/wtFactor). Weights are
// stored in each material's OWN recipe unit; any math that sums or divides
// weights across materials (reconciliation gap, cost proration, yield %) must
// first express them in the SOURCE material's unit. g↔kg and ml↔l only;
// anything else (pcs, btl…) is non-convertible: excluded from the gap sum
// (same as the page strip) and left raw in the proration (documented fallback).
const uNorm = (u?: string | null) => String(u || 'kg').toLowerCase().trim();
const METRIC: Record<string, { base: string; f: number }> = {
  g: { base: 'g', f: 1 }, kg: { base: 'g', f: 1000 },
  ml: { base: 'ml', f: 1 }, l: { base: 'ml', f: 1000 }, ltr: { base: 'ml', f: 1000 }, litre: { base: 'ml', f: 1000 },
};
const wtFactor = (from?: string | null, to?: string | null): number | null => {
  const f = uNorm(from), t = uNorm(to);
  if (f === t) return 1;
  const F = METRIC[f], T = METRIC[t];
  return F && T && F.base === T.base ? F.f / T.f : null;
};

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (id) {
      const batch = db.prepare(`
        SELECT bb.*, rm.name AS source_material_name, rm.unit AS source_material_unit,
               v.name AS vendor_name
        FROM butchering_batches bb
        JOIN raw_materials rm ON rm.id = bb.source_material_id
        LEFT JOIN vendors v ON v.id = bb.vendor_id
        WHERE bb.id = ?
      `).get(id) as any;
      if (!batch) return Response.json({ error: 'Not found' }, { status: 404 });
      const outputs = db.prepare(`
        SELECT bo.*, rm.name AS material_name, rm.unit AS material_unit
        FROM butchering_outputs bo
        LEFT JOIN raw_materials rm ON rm.id = bo.material_id
        WHERE bo.batch_id = ?
        ORDER BY bo.output_type DESC, rm.name
      `).all(id);
      // Reconciliation summary — normalized into the source unit; waste rows
      // are recorded against the source material so they use the source unit.
      const srcU = batch.source_material_unit;
      const totalOutput = (outputs as any[]).reduce((a, o) => {
        const k = wtFactor(o.output_type === 'waste' ? srcU : (o.material_unit || srcU), srcU);
        return k == null ? a : a + (Number(o.weight) || 0) * k;
      }, 0);
      const gap = batch.gross_weight - totalOutput;
      const gapPct = batch.gross_weight > 0 ? Math.abs(gap) / batch.gross_weight : 0;
      return Response.json({
        batch: {
          ...batch,
          outputs,
          reconciliation: {
            gross_weight: batch.gross_weight,
            total_output_weight: totalOutput,
            gap,
            gap_pct: gapPct * 100,
            within_tolerance: gapPct <= RECONCILE_TOLERANCE,
          },
        },
      });
    }

    const status = url.searchParams.get('status');
    const from   = url.searchParams.get('from');
    const to     = url.searchParams.get('to');
    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (status) { where.push('bb.status = ?'); params.push(status); }
    if (from)   { where.push("date(bb.created_at) >= ?"); params.push(from); }
    if (to)     { where.push("date(bb.created_at) <= ?"); params.push(to); }

    const rows = db.prepare(`
      SELECT bb.*, rm.name AS source_material_name, rm.unit AS source_material_unit,
             (SELECT COUNT(*) FROM butchering_outputs WHERE batch_id = bb.id AND output_type = 'cut')   AS cut_count,
             (SELECT COALESCE(SUM(weight), 0) FROM butchering_outputs WHERE batch_id = bb.id AND output_type = 'cut')   AS total_cut_weight,
             (SELECT COALESCE(SUM(weight), 0) FROM butchering_outputs WHERE batch_id = bb.id AND output_type = 'waste') AS total_waste_weight,
             -- DISTINCT recipe units across this batch's cut materials: the UI only
             -- labels the cut-weight SUM when there is exactly one unit (no comma).
             (SELECT GROUP_CONCAT(DISTINCT lower(trim(COALESCE(rm2.unit, ''))))
                FROM butchering_outputs bo2 JOIN raw_materials rm2 ON rm2.id = bo2.material_id
               WHERE bo2.batch_id = bb.id AND bo2.output_type = 'cut') AS cut_units
      FROM butchering_batches bb
      JOIN raw_materials rm ON rm.id = bb.source_material_id
      WHERE ${where.join(' AND ')}
      ORDER BY bb.created_at DESC
      LIMIT 200
    `).all(...params);
    return Response.json({ batches: rows });
  } catch (e: any) {
    console.error('[/api/butchering GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();
    const { batch_id, source_material_id, gross_weight, invoice_weight,
            vendor_id, grn_id, butcher, head_chef, notes } = b;

    if (!batch_id || !String(batch_id).trim()) {
      return Response.json({ error: 'batch_id required (e.g. MUT-20260520-RAJBR-01)' }, { status: 400 });
    }
    if (!source_material_id) return Response.json({ error: 'source_material_id required' }, { status: 400 });
    if (!Number.isFinite(Number(gross_weight)) || Number(gross_weight) <= 0) {
      return Response.json({ error: 'gross_weight must be > 0' }, { status: 400 });
    }

    // Snapshot the source material's current avg price for the cost basis.
    const src = db.prepare(`SELECT average_price FROM raw_materials WHERE id = ?`).get(source_material_id) as { average_price?: number } | undefined;
    if (!src) return Response.json({ error: 'source material not found' }, { status: 404 });
    const costPerUnit = src.average_price || 0;
    const totalCost = costPerUnit * Number(gross_weight);

    const id = generateId();
    const outletId = await getCurrentOutletId();
    try {
      db.prepare(`
        INSERT INTO butchering_batches (id, batch_id, source_material_id, vendor_id, grn_id,
                                        gross_weight, invoice_weight, cost_per_unit, total_cost,
                                        butcher, head_chef, notes, outlet_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, String(batch_id).trim(), source_material_id, vendor_id || null, grn_id || null,
              Number(gross_weight), invoice_weight != null ? Number(invoice_weight) : null,
              costPerUnit, totalCost,
              butcher || '', head_chef || '', notes || '', outletId, me.email);
    } catch (e: any) {
      if (String(e.message).includes('UNIQUE')) {
        return Response.json({ error: `batch_id "${batch_id}" already exists` }, { status: 409 });
      }
      throw e;
    }
    const fresh = db.prepare('SELECT * FROM butchering_batches WHERE id = ?').get(id);
    return Response.json({ batch: fresh }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/butchering POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();
    const { id, outputs, butcher, head_chef, notes, gross_weight, invoice_weight, action } = b;
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });

    const batch = db.prepare('SELECT * FROM butchering_batches WHERE id = ?').get(id) as any;
    if (!batch) return Response.json({ error: 'Not found' }, { status: 404 });
    if (batch.status !== 'open' && action !== 'cancel') {
      return Response.json({ error: `Batch is ${batch.status}, cannot edit` }, { status: 400 });
    }

    // Pre-validate outputs so bad lines get a clean 400 (never a silent drop
    // or a mid-transaction throw).
    if (Array.isArray(outputs)) {
      for (const o of outputs) {
        const w = Number(o.weight) || 0;
        if (w < 0) return Response.json({ error: 'Output weights cannot be negative' }, { status: 400 });
        if (w > 0 && o.output_type === 'cut' && !o.material_id) {
          return Response.json({ error: 'Every cut line with a weight needs a material — pick one or remove the line' }, { status: 400 });
        }
      }
    }

    // Meta updates always allowed while open
    if (batch.status === 'open' && (butcher !== undefined || head_chef !== undefined || notes !== undefined)) {
      db.prepare(`
        UPDATE butchering_batches
        SET butcher = COALESCE(?, butcher), head_chef = COALESCE(?, head_chef),
            notes = COALESCE(?, notes)
        WHERE id = ?
      `).run(butcher ?? null, head_chef ?? null, notes ?? null, id);
    }

    // Gross / invoice weight edits while open — the cost basis follows the
    // gross weight (total_cost = snapshot cost_per_unit × gross), and every
    // stored output's yield % + allocated cost is recomputed on the new basis.
    if (batch.status === 'open' && invoice_weight !== undefined) {
      const iw = invoice_weight === null || invoice_weight === '' ? null : Number(invoice_weight);
      if (iw !== null && (!Number.isFinite(iw) || iw < 0)) {
        return Response.json({ error: 'invoice_weight must be a number ≥ 0' }, { status: 400 });
      }
      db.prepare('UPDATE butchering_batches SET invoice_weight = ? WHERE id = ?').run(iw, id);
    }
    if (batch.status === 'open' && gross_weight !== undefined) {
      const gw = Number(gross_weight);
      if (!Number.isFinite(gw) || gw <= 0) {
        return Response.json({ error: 'gross_weight must be > 0' }, { status: 400 });
      }
      const newTotalCost = batch.cost_per_unit * gw;
      const txn = db.transaction(() => {
        db.prepare('UPDATE butchering_batches SET gross_weight = ?, total_cost = ? WHERE id = ?')
          .run(gw, newTotalCost, id);
        // If this request does NOT also replace the outputs, re-base the
        // stored rows now (the replacement block below re-bases anyway).
        if (!Array.isArray(outputs)) {
          const rows = db.prepare('SELECT * FROM butchering_outputs WHERE batch_id = ?').all(id) as any[];
          const totalCutWeight = rows.filter(r => r.output_type === 'cut').reduce((a, r) => a + (r.weight || 0), 0);
          const updOut = db.prepare('UPDATE butchering_outputs SET yield_pct = ?, cost_allocated = ? WHERE id = ?');
          for (const r of rows) {
            const yp = gw > 0 ? ((r.weight || 0) / gw) * 100 : 0;
            const cost = r.output_type === 'cut' && totalCutWeight > 0 ? newTotalCost * ((r.weight || 0) / totalCutWeight) : 0;
            updOut.run(yp, cost, r.id);
          }
        }
      });
      txn();
    }

    // Replace outputs if provided — always against the CURRENT (possibly
    // just-updated) gross weight and total cost.
    if (Array.isArray(outputs)) {
      const basis = db.prepare(`
        SELECT bb.gross_weight, bb.total_cost, rm.unit AS source_unit
        FROM butchering_batches bb JOIN raw_materials rm ON rm.id = bb.source_material_id
        WHERE bb.id = ?
      `).get(id) as any;
      const unitOf = db.prepare('SELECT unit FROM raw_materials WHERE id = ?');
      const txn = db.transaction(() => {
        db.prepare('DELETE FROM butchering_outputs WHERE batch_id = ?').run(id);
        const ins = db.prepare(`
          INSERT INTO butchering_outputs (id, batch_id, output_type, material_id, waste_category,
                                          weight, cost_allocated, yield_pct, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        // First pass: compute total cut weight (waste is excluded from cost basis)
        const cuts: any[] = [];
        const wastes: any[] = [];
        for (const o of outputs) {
          const w = Number(o.weight) || 0;
          if (w <= 0) continue;
          if (o.output_type === 'cut') {
            cuts.push({ ...o, weight: w });
          } else if (o.output_type === 'waste') {
            wastes.push({ ...o, weight: w });
          }
        }
        // Cost allocation: pro-rata by NORMALIZED weight across CUTS only (waste
        // absorbs no cost). Each cut's weight is in ITS material's recipe unit —
        // raw proration handed a 3500 g line 350× the cost of a 10 kg line.
        // Non-convertible units (pcs vs kg) fall back to the raw weight; that is
        // the best available basis and matches the page's Cost column.
        for (const c of cuts) {
          c._n = c.weight * (wtFactor((unitOf.get(c.material_id) as any)?.unit, basis.source_unit) ?? 1);
        }
        const totalCutWeight = cuts.reduce((a, c) => a + c._n, 0);
        for (const c of cuts) {
          // yield_pct is stored NORMALIZED (source-unit basis) — the page and
          // yield report display it verbatim, no client-side rescale.
          const yieldPct = basis.gross_weight > 0 ? (c._n / basis.gross_weight) * 100 : 0;
          const cost = totalCutWeight > 0 ? basis.total_cost * (c._n / totalCutWeight) : 0;
          ins.run(generateId(), id, 'cut', c.material_id, null, c.weight, cost, yieldPct, c.notes || '');
        }
        for (const w of wastes) {
          const yieldPct = basis.gross_weight > 0 ? (w.weight / basis.gross_weight) * 100 : 0;
          ins.run(generateId(), id, 'waste', null, w.waste_category || 'other', w.weight, 0, yieldPct, w.notes || '');
        }
      });
      txn();
    }

    // Close action: post inventory transactions and lock the batch
    if (action === 'close') {
      const fresh = db.prepare(`
        SELECT bb.*, rm.unit AS source_unit, rm.name AS source_name
        FROM butchering_batches bb JOIN raw_materials rm ON rm.id = bb.source_material_id
        WHERE bb.id = ?
      `).get(id) as any;
      const outs = db.prepare(`
        SELECT bo.*, rm.unit AS material_unit
        FROM butchering_outputs bo LEFT JOIN raw_materials rm ON rm.id = bo.material_id
        WHERE bo.batch_id = ?
      `).all(id) as any[];
      if (outs.length === 0) return Response.json({ error: 'Cannot close empty batch — add outputs first' }, { status: 400 });
      // Gap check MIRRORS the page's reconciliation strip: weights normalized
      // into the source unit; non-convertible lines excluded from the sum. A raw
      // sum here made any mixed-unit batch fail closing (3500 g read as 3500 kg)
      // while the on-screen strip said it reconciled.
      const totalOut = outs.reduce((a, o) => {
        const k = wtFactor(o.output_type === 'waste' ? fresh.source_unit : (o.material_unit || fresh.source_unit), fresh.source_unit);
        return k == null ? a : a + (Number(o.weight) || 0) * k;
      }, 0);
      const gapPct = fresh.gross_weight > 0 ? Math.abs(fresh.gross_weight - totalOut) / fresh.gross_weight : 1;
      if (gapPct > RECONCILE_TOLERANCE) {
        return Response.json({
          error: `Reconciliation gap is ${(gapPct * 100).toFixed(2)}% (must be ≤ ${RECONCILE_TOLERANCE * 100}%). Re-weigh and adjust before closing.`,
        }, { status: 400 });
      }

      // DEPARTMENT-HELD CARCASS — REFUSE, do not transform.
      //
      // Since the department-inventory cutover, a carcass issued on a
      // requisition has ALREADY left central: applyIssueDelta debited
      // raw_materials.current_stock at issue and credited the receiving
      // department's ledger. The grams are on the kitchen's shelf. Closing a
      // batch on it would then (1) debit central a SECOND time for the whole
      // gross weight — the same gram removed twice, which is exactly the
      // invariant this cutover exists to protect — and (2) credit the cuts
      // into the CENTRAL pool, which is not the pool that holds the carcass.
      // Two wrong numbers and no screen showing either.
      //
      // v1 refuses instead of posting a department-side transform (debit the
      // carcass from the department, credit the cuts back to the same
      // department). That transform is a real feature, and a real SECOND
      // movement path with its own negative-balance and reversal questions; it
      // does not belong inside a cutover. Do NOT "simplify" this into a clamp,
      // a partial debit, or a silent central debit "because the batch is
      // already reconciled" — the honest answer is that the goods must come
      // back to the store before the store can break them down.
      //
      // WHAT IT READS: the LEDGER, via deptOnHand — never
      // department_materials.on_hand, which is a maintained cache and not a
      // truth. A never-counted department still HOLDS whatever the ledger says
      // moved in, so movementsSince is the fallback: onHand is NULL by design
      // for that pair, and treating NULL as 0 would wave the carcass straight
      // through the guard on day one, before any cutover count exists.
      // Inactive departments are included deliberately — deactivating a
      // department does not empty its shelf.
      const HOLD_EPS = 1e-6;
      const allDepts = db.prepare('SELECT id, name FROM departments').all() as Array<{ id: string; name: string }>;
      const holdMap = deptOnHandBulk(db, allDepts.map(d => d.id), [fresh.source_material_id]);
      const holders = allDepts
        .map(d => {
          const h = holdMap.get(deptKey(d.id, fresh.source_material_id));
          return { name: d.name, qty: h ? (h.onHand ?? h.movementsSince) : 0 };
        })
        .filter(h => h.qty > HOLD_EPS)
        .sort((a, b) => b.qty - a.qty);
      if (holders.length > 0) {
        const unit = fresh.source_unit || '';
        const who = holders.map(h => `${h.name} (${Number(h.qty.toFixed(3))}${unit ? ' ' + unit : ''})`).join(', ');
        return Response.json({
          error: `This carcass is currently held by ${who}. Butchering from department stock is not supported yet — return it to the store first.`,
        }, { status: 409 });
      }

      // ── THE DENOMINATOR COMES FROM DATA, NEVER FROM A LITERAL ──────────────
      // Both audit notes written below used to end in a hardcoded "/kg". Weights
      // in this module are stored in each material's OWN RECIPE unit (see the
      // header, and page.tsx's fmtWt, which already labels from data), and
      // butchering_batches.cost_per_unit is a snapshot of that material's
      // raw_materials.average_price — Rs per RECIPE unit — taken at POST. So the
      // literal was a real misstatement, not a cosmetic one: MUTTON BHEJA is
      // g/kg/pack 1000 at average_price 0.12, and the note stamped "₹0.12/kg" onto
      // the central inventory_transactions row for a rate that is ₹0.12/g = ₹120/kg
      // — 1000x, in the line the store reads back. MUTTON PAYA is 'pcs' at ₹75 and
      // read "₹75/kg" for a rate that is per piece.
      // These strings are the LABEL only; no stored number changes. When the unit
      // is unknown the denominator is dropped rather than guessed — an unlabelled
      // rate is honest, a wrongly labelled one is not.
      const srcRateUnit = String(fresh.source_unit || '').trim();
      // rate-basis: recipe — cost_per_unit is average_price snapshotted at POST.
      const srcRateLabel = `₹${fresh.cost_per_unit}${srcRateUnit ? '/' + srcRateUnit : ''}`;

      const txn = db.transaction(() => {
        // ── THE STORE MUST HOLD THE CARCASS. BOTH HALVES, OR NEITHER. ────────
        //
        // A close posts TWO stock legs that are one physical fact: a carcass is
        // broken down INTO its cuts. The debit and the credits are the same
        // grams, named twice. Until this floor existed neither leg had a central
        // balance check, and MEASURED on a copy of the live db — probe source at
        // 0 kg, gross 10, cuts 6 + 3, waste 1 — the close answered HTTP 200 and
        // wrote: source 0 -> -10, and cuts 50 -> 56 and 7 -> 10. The negative is
        // the lesser half of that. The worse half is that 9 kg of SALEABLE cuts
        // entered the store's pool from a carcass no purchase ever paid for: the
        // book was credited stock that does not exist, at a cost basis
        // (₹222.22/kg) pro-rated off a ₹2,000 total that was never spent.
        //
        // WHY THIS REFUSES RATHER THAN CLAMPS. The owner's rule is that an
        // UNATTENDED path (a PO receipt, a QC sign-off, a cascade with nobody
        // there) must clamp and record the shortfall, because destroying a
        // correct delivery to prevent a bad debit is the worse outcome. This
        // path is the opposite case on every count: PUT action='close' is a
        // person pressing Close on the /butchering batch modal, nothing
        // physically arrived, there is no host transaction to roll back, and
        // refusing destroys NOTHING — the batch stays 'open' with every output
        // weight he just entered still stored (the outputs block above commits
        // separately), so he can receive the carcass and close again. The page
        // shows this sentence and keeps the modal open (page.tsx saveAndAction:
        // `if (!r.ok) { setError(j.error); return; }` — no onClose()).
        //
        // SO THIS IS NOT A MISSING CALL TO clampCentralDelta(). That helper
        // (src/lib/central-debit-clamp.ts) is the ONE implementation of the
        // unattended side and names butchering as a lane that must call it
        // rather than grow a rival — but its own header scopes itself out of
        // attended paths ("THIS FILE IS NOT FOR THOSE PATHS"), which is the side
        // this close is on, with assertCentralIssue and POST /api/grn. Nothing
        // below is a second clamp; it is a refusal, and its comparison is that
        // file's planCentralDebit — the one rule every central floor asks — not
        // a fourth figure.
        //
        // AND WHY NOT CLAMP EITHER HALF, which is the trap here:
        //   · Clamp the DEBIT alone and the credits still post in full. That is
        //     strictly worse than the negative it removes: the book then looks
        //     consistent while being wrong by the whole output weight, with no
        //     negative balance left for /inventory or fix-negative-stock to show.
        //   · Clamp BOTH pro-rata (debit what is there, scale the cuts to match)
        //     and the store records a breakdown nobody performed. The ≤1.5%
        //     reconciliation gap checked earlier in this handler was agreed
        //     against the FULL gross weight; a scaled close would store cut
        //     weights, yield_pct and cost_allocated
        //     off a basis that never existed, silently replacing the operator's
        //     own scale readings. A carcass is not divisible that way either —
        //     you cannot break down 60% of each cut from 4 kg of a 10 kg goat.
        // The "issue the lines that can be issued, hold the short one" rule does
        // not reach here: the cuts are not neighbouring lines that happen to
        // share a gesture, they ARE the source line's grams. There is no
        // neighbour to spare.
        //
        // READ INSIDE THIS TRANSACTION, immediately before the debit, for the
        // same reason the issue floor is (src/lib/issue-stock.ts
        // assertCentralIssue): a balance read earlier is a snapshot, and a
        // snapshot races. Do not hoist this read out to sit beside the
        // department guard, and do not move the credit loop above it.
        //
        // UNITS: gross_weight and current_stock are BOTH in the source
        // material's own recipe unit (see the file header, and the DENOMINATOR
        // note just above), so this compares two numbers on one basis. There is
        // deliberately NO packFactor here — adding one would be the second
        // conversion this project keeps getting burned by.
        //
        // THE PREDICATE IS THE ONE EVERY CENTRAL FLOOR USES — planCentralDebit
        // (src/lib/central-debit-clamp.ts), which assertNoNegativeStock in
        // grn-reversal.ts now asks too. Gross weight and balance are compared on
        // the house 6-dp grid. So a breakdown of everything the store holds is
        // correct work, passes and lands on exactly 0; float noise and a 6-dp
        // display rounding are not treated as a shortfall; and a real shortfall
        // — down to a milligram, one grid step — is refused.
        const onHand = Number(
          (db.prepare(`SELECT COALESCE(current_stock, 0) AS s FROM raw_materials WHERE id = ?`)
            .get(fresh.source_material_id) as any)?.s,
        ) || 0;
        // THE ONE RULE NOW, NOT A COPY OF IT. `r6(onHand − gross) < −1e-9` let a
        // carcass 4e-7 over the balance through (r6 rounds −4e-7 to −0) and then
        // subtracted the full gross: current_stock −4e-7. planCentralDebit
        // (src/lib/central-debit-clamp.ts) judges on the same 6-dp grid, still
        // refuses the measured 1-mg-short carcass (it lands on the NEXT grid
        // point), and says what to subtract — the balance itself on a
        // breakdown of everything, so the landing is exactly 0.
        const carcassPlan = planCentralDebit(onHand, Number(fresh.gross_weight) || 0);
        if (!carcassPlan.fits) {
          // RECIPE UNITS IN THE MESSAGE, matching the department-held refusal
          // above and matching the screen: /butchering/page.tsx
          // renders every weight through fmtWt(v, source_material_unit) and does
          // not import packFactor at all, so `unit` is the unit the operator
          // typed the gross weight in. Two refusals in one gesture quoting
          // different bases for the same material would be worse than either.
          const unit = fresh.source_unit ? ' ' + fresh.source_unit : '';
          // PRINTED AT THE PRECISION THE FLOOR JUDGES AT (6dp, r6 above), with
          // trailing zeros dropped, so 10 prints "10 kg" and not "10.000000 kg".
          // The page's fmtWt is 3dp and that is right for a weight column, but a
          // REFUSAL that rounds its two figures to the same number tells the
          // storekeeper nothing: at 3dp a balance of 9.999999 against a 10 kg
          // gross read "holds only 10 kg, so a 10 kg carcass cannot be broken
          // down". Measured, then fixed — the message has to show the gap it is
          // refusing over.
          const qty = (n: number) => `${Number(n.toFixed(6))}${unit}`;
          // max(0, …): a balance already sitting below zero reads as "holds
          // none", never as a negative allowance — and never gets printed back
          // at the operator as "holds only -10 kg". The branch is holdsAny()
          // (src/lib/central-debit-clamp.ts) — the one "does it hold any" test
          // every floor shares: a grid step or more.
          //
          // THE BALANCE IS PRINTED ON THE SAME GRID THAT TEST READS (round 7):
          // fmtGridQty, which snaps through qtyGrid, not `qty` (toFixed). At an
          // exact half-grid tie the two disagree — 5e-7 is stored as 4.99…e-7,
          // toFixed(6) prints 0 while holdsAny is true — and this sentence read
          // "holds only 0 kg" (measured). Printed this way it can never say
          // "holds only 0" about a balance the test says is there, nor "holds
          // none" about one that is.
          const available = Math.max(0, onHand);
          const name = fresh.source_name || 'this carcass';
          throw new CarcassShort(
            (holdsAny(available)
              ? `The central store holds only ${fmtGridQty(available)}${unit} of ${name}, so a ${qty(fresh.gross_weight)} carcass cannot be broken down.`
              : `The central store holds none of ${name}, so a ${qty(fresh.gross_weight)} carcass cannot be broken down.`)
            + ` Nothing was posted and the batch is still open — receive the carcass, correct the gross weight, or record a closing count, then close again.`,
          );
        }

        // 1. Debit source carcass stock — CENTRAL only, and only reachable
        //    because the guards proved that no department holds this carcass and
        //    that the central store does.
        //    carcassPlan.debit, not gross_weight: identical except on a breakdown
        //    of everything the store holds, where it is the balance itself and the
        //    write lands on exactly 0 (under one 6-dp step from gross_weight). The
        //    movement row carries the same figure so it reconciles to the column.
        db.prepare(`UPDATE raw_materials SET current_stock = COALESCE(current_stock, 0) - ? WHERE id = ?`)
          .run(carcassPlan.debit, fresh.source_material_id);
        db.prepare(`
          INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, outlet_id)
          VALUES (?, ?, 'butchering_input', ?, ?, ?, ?)
        `).run(generateId(), fresh.source_material_id, -carcassPlan.debit, fresh.id,
                `Carcass breakdown ${fresh.batch_id} @ ${srcRateLabel}`, fresh.outlet_id || null);

        // 2. Credit each cut
        for (const o of outs) {
          if (o.output_type !== 'cut' || !o.material_id) continue;
          db.prepare(`UPDATE raw_materials SET current_stock = COALESCE(current_stock, 0) + ? WHERE id = ?`)
            .run(o.weight, o.material_id);
          // cost_allocated is a RUPEE VALUE (a pro-rata slice of batch total_cost,
          // basis-invariant); o.weight is this CUT material's own recipe unit, the
          // same number credited to its current_stock two lines up. So the quotient
          // is Rs per the CUT's recipe unit — o.material_unit, joined in above —
          // and not per kg. A 500 g cut costing ₹280 is ₹0.56/g, which the old
          // literal published as "₹0.56/kg".
          // rate-basis: recipe — value ÷ recipe-unit weight, both off this row.
          const unitCost = o.weight > 0 ? o.cost_allocated / o.weight : 0;
          const cutRateUnit = String(o.material_unit || '').trim();
          const cutRateLabel = `₹${unitCost.toFixed(2)}${cutRateUnit ? '/' + cutRateUnit : ''}`;
          db.prepare(`
            INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, outlet_id)
            VALUES (?, ?, 'butchering_output', ?, ?, ?, ?)
          `).run(generateId(), o.material_id, o.weight, fresh.id,
                  `Cut from ${fresh.batch_id} (${o.yield_pct.toFixed(1)}% yield, ${cutRateLabel})`, fresh.outlet_id || null);
        }

        // 3. Log waste rows against the source material
        for (const o of outs) {
          if (o.output_type !== 'waste') continue;
          const reason = o.waste_category === 'spoilage' ? 'spoilage' : 'other';
          db.prepare(`
            INSERT INTO wastages (id, date, material_id, quantity, reason, recorded_by, notes, outlet_id)
            VALUES (?, date('now'), ?, ?, ?, ?, ?, ?)
          `).run(generateId(), fresh.source_material_id, o.weight, reason, me.email,
                  `Butchering ${fresh.batch_id}: ${o.waste_category}`, fresh.outlet_id || null);
        }

        // 4. Close the batch
        db.prepare(`UPDATE butchering_batches SET status = 'closed', closed_at = datetime('now') WHERE id = ?`).run(id);
      });
      // The carcass floor throws from inside txn(), which unwinds every leg
      // above — no debit, no credits, no waste rows, batch still 'open'. It gets
      // the department guard's 409 rather than the catch-all 500 at the bottom
      // of this handler, because it is a refusal the storekeeper can act on and
      // not a fault. Anything else still propagates.
      try {
        txn();
      } catch (e: any) {
        if (e instanceof CarcassShort) {
          return Response.json({ error: e.message, code: 'carcass_short' }, { status: 409 });
        }
        throw e;
      }
    }

    if (action === 'cancel') {
      db.prepare(`UPDATE butchering_batches SET status = 'cancelled', closed_at = datetime('now') WHERE id = ?`).run(id);
    }

    const out = db.prepare('SELECT * FROM butchering_batches WHERE id = ?').get(id);
    return Response.json({ batch: out });
  } catch (e: any) {
    console.error('[/api/butchering PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    const batch = db.prepare('SELECT * FROM butchering_batches WHERE id = ?').get(id) as any;
    if (!batch) return Response.json({ error: 'Not found' }, { status: 404 });
    if (batch.status !== 'open') {
      return Response.json({ error: 'Only open batches can be deleted (use cancel for closed)' }, { status: 400 });
    }
    if (batch.created_by !== me.email && me.role !== 'admin') {
      return Response.json({ error: 'Only the creator or admin can delete' }, { status: 403 });
    }
    db.prepare('DELETE FROM butchering_batches WHERE id = ?').run(id);
    return Response.json({ success: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
