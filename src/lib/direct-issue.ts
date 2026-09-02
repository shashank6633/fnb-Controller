import type Database from 'better-sqlite3';
import { postDeptLedger } from './dept-ledger';

/**
 * DIRECT ISSUE — vendor deliveries routed straight to a department.
 *
 * The owner's rule (Settings → Direct Issue): certain categories (DAIRY,
 * VEGETABLES, MEAT, …) and/or individual items are "supplied by the vendor and
 * transferred directly to the Main Kitchen" or the Bar. The central store does
 * the paperwork — GRN, vendor bill, PINV, taxes, its own 3-tick checklist —
 * but never shelves the goods.
 *
 * WHAT THIS MODULE CHANGES, AND THE ONE THING IT CHANGES:
 * For a material that resolves to a direct-issue destination, the ACCEPTED
 * quantity of a vendor receipt posts to the DEPARTMENT ledger
 * (department_material_transactions, type 'direct_receipt', RECIPE units =
 * accepted × packFactor) instead of raw_materials.current_stock. Everything
 * else is byte-identical to a central receipt:
 *   · the `purchases` cost row (PURCHASE units, net rate, PINV, taxes, charges)
 *   · the GRN document and its line rows
 *   · last_purchase_price / last_purchase_date (GROSS rate, both stamped)
 *   · updateMaterialPrice → average_price (₹/recipe-unit) — it reads
 *     `purchases`, which is unchanged, so it needs no edit at all
 * and two central-rail records are deliberately NOT written:
 *   · NO inventory_transactions 'purchase' row — that table is the CENTRAL
 *     movement log (the central variance report and the GRN void reverse from
 *     it), and central never moved
 *   · NO current_stock bump
 *
 * THE TIME-CORRECTNESS RULE. Rules affect FUTURE receipts only. Each routed
 * cost row is stamped `purchases.direct_issue_dept_id` at write time, so
 * "where did this receipt's stock go" is answered by the ROW, never by the
 * config of the day — an amend or void years later reverses the right rail
 * even if the rule has since changed or been deleted. The department ledger
 * row's reference_id is the purchases row id, tying the two records together.
 *
 * FAIL-TO-CENTRAL. If the schema is not ready (rules table missing, or the
 * purchases.direct_issue_dept_id column absent because the boot ALTER was
 * swallowed), the resolver returns NOTHING and every receipt books to central
 * exactly as before this feature existed. Routing without the marker column
 * would write department stock the reversal machinery could not find again —
 * the one direction that loses goods.
 *
 * STORE-MAPPED (LIQUOR) MATERIALS can never reach these branches: every
 * caller sits on a central receiving route behind centralFlowBlock(), which
 * refuses store-mapped lines before any stock decision. The settings API
 * additionally refuses to create rules for them.
 */

// Byte-equivalent to catKeyOf() in src/lib/grn-qc.ts and catNorm() in
// src/lib/store-engine.ts. Re-stated here rather than imported because
// grn-qc.ts imports THIS module for the QC sign-off branch — an import in the
// other direction would be a cycle. Keep the three in step.
export const diCatKey = (s: unknown): string =>
  String(s ?? '').toLowerCase().trim().replace(/ /g, '').replace(/-/g, '').replace(/_/g, '');

export interface DirectIssueTarget {
  departmentId: string;
  departmentName: string;
  /** Which rule matched. A material rule BEATS a category rule. */
  via: 'material' | 'category';
  ruleId: string;
}

/* ── schema probes, cached per Database handle ────────────────────────────── */

const schemaCache = new WeakMap<object, { rulesTable: boolean; purchasesCol: boolean }>();

function schemaReady(db: Database.Database): { rulesTable: boolean; purchasesCol: boolean } {
  const hit = schemaCache.get(db as unknown as object);
  if (hit) return hit;
  let rulesTable = false;
  let purchasesCol = false;
  try {
    rulesTable = !!db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'direct_issue_rules'`,
    ).get();
  } catch { /* unreadable ⇒ not ready */ }
  try {
    const cols = db.prepare(`PRAGMA table_info(purchases)`).all() as Array<{ name: string }>;
    purchasesCol = cols.some(c => String(c.name) === 'direct_issue_dept_id');
  } catch { /* unreadable ⇒ not ready */ }
  const out = { rulesTable, purchasesCol };
  schemaCache.set(db as unknown as object, out);
  return out;
}

/** Does `purchases` carry the destination stamp? (Read by the central
 *  variance report to build its exclusion predicate only when it can run.) */
export function purchasesHasDirectIssueCol(db: Database.Database): boolean {
  return schemaReady(db).purchasesCol;
}

/* ── the resolver ─────────────────────────────────────────────────────────── */

/**
 * material_id → destination for every FLAGGED material in the list.
 * A material with no entry books to central, exactly as before this feature.
 *
 * Item override beats category rule. A rule pointing at a department row that
 * no longer EXISTS is ignored (the goods fall back to the central shelf where
 * the storeman can see them, rather than onto the ledger of a deleted
 * department); a rule pointing at a DEACTIVATED department still routes — the
 * department's ledger still computes, and deactivation must not silently move
 * deliveries back onto a shelf the owner said they never touch.
 */
export function resolveDirectIssueBulk(
  db: Database.Database,
  materialIds: Array<string | null | undefined>,
): Map<string, DirectIssueTarget> {
  const out = new Map<string, DirectIssueTarget>();
  const ids = [...new Set(materialIds.map(x => String(x || '').trim()).filter(Boolean))];
  if (ids.length === 0) return out;

  const ready = schemaReady(db);
  if (!ready.rulesTable || !ready.purchasesCol) return out; // fail-to-central

  let rules: any[];
  try {
    rules = db.prepare(`
      SELECT r.id, r.rule_type, r.category_key, r.material_id, r.department_id,
             d.name AS department_name
      FROM direct_issue_rules r
      JOIN departments d ON d.id = r.department_id
    `).all() as any[];
  } catch {
    return out; // unreadable config ⇒ central, the pre-feature behaviour
  }
  if (rules.length === 0) return out;

  const byMaterial = new Map<string, any>();
  const byCategory = new Map<string, any>();
  for (const r of rules) {
    if (String(r.rule_type) === 'material' && r.material_id) {
      byMaterial.set(String(r.material_id), r);
    } else if (String(r.rule_type) === 'category' && r.category_key) {
      byCategory.set(String(r.category_key), r);
    }
  }
  if (byMaterial.size === 0 && byCategory.size === 0) return out;

  // Categories are only needed for ids without a material rule — but reading
  // them for all is one statement per chunk and the lists here are bill-sized.
  const catOf = new Map<string, string>();
  if (byCategory.size > 0) {
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = db.prepare(
        `SELECT id, category FROM raw_materials WHERE id IN (${chunk.map(() => '?').join(',')})`,
      ).all(...chunk) as any[];
      for (const m of rows) catOf.set(String(m.id), diCatKey(m.category));
    }
  }

  for (const id of ids) {
    const mRule = byMaterial.get(id);
    if (mRule) {
      out.set(id, {
        departmentId: String(mRule.department_id),
        departmentName: String(mRule.department_name || ''),
        via: 'material',
        ruleId: String(mRule.id),
      });
      continue;
    }
    const cRule = byCategory.get(catOf.get(id) || '');
    if (cRule) {
      out.set(id, {
        departmentId: String(cRule.department_id),
        departmentName: String(cRule.department_name || ''),
        via: 'category',
        ruleId: String(cRule.id),
      });
    }
  }
  return out;
}

/** Single-material convenience over the bulk resolver. */
export function resolveDirectIssue(db: Database.Database, materialId: string): DirectIssueTarget | null {
  return resolveDirectIssueBulk(db, [materialId]).get(String(materialId || '').trim()) || null;
}

/* ── the writer the receiving branches call ───────────────────────────────── */

export interface DirectReceiptPost {
  target: DirectIssueTarget;
  materialId: string;
  /** SIGNED, RECIPE units (accepted × packFactor). Negative = back-correction. */
  recipeQty: number;
  /** The `purchases` cost row this receipt booked — stamped with the
   *  destination and used as the ledger row's reference_id. */
  purchaseRowId: string;
  outletId?: string | null;
  user?: string;
  source: string;
  notes: string;
}

/**
 * Post one direct receipt (or its negative back-correction) to the department
 * ledger and stamp the cost row's destination. MUST run inside the caller's
 * transaction — the ledger row, the cache update and the stamp commit or roll
 * back with the receipt they describe. Throws (rolling the caller back) on a
 * zero quantity or an unknown type, exactly as postDeptLedger does.
 */
export function postDirectReceipt(db: Database.Database, p: DirectReceiptPost): void {
  const qty = Number(p.recipeQty);
  postDeptLedger(db, {
    departmentId: p.target.departmentId,
    materialId: p.materialId,
    type: qty >= 0 ? 'direct_receipt' : 'direct_receipt_reversal',
    quantity: qty,
    outletId: p.outletId ?? null,
    referenceId: p.purchaseRowId,
    source: p.source,
    notes: p.notes,
    user: p.user || '',
  });
  db.prepare(`UPDATE purchases SET direct_issue_dept_id = ? WHERE id = ?`)
    .run(p.target.departmentId, p.purchaseRowId);
}

/**
 * Post a SIGNED correction delta against an existing direct-routed cost row —
 * the bill-amendment case, where the row is already stamped and only the
 * quantity moved. Positive delta = more goods into the department
 * ('direct_receipt'), negative = goods back out ('direct_receipt_reversal').
 * A zero/negligible delta is a no-op. Runs inside the caller's transaction.
 */
export function postDirectDelta(db: Database.Database, p: {
  departmentId: string;
  materialId: string;
  /** SIGNED, RECIPE units. */
  recipeDelta: number;
  purchaseRowId: string;
  outletId?: string | null;
  user?: string;
  source: string;
  notes: string;
}): void {
  const d = Number(p.recipeDelta);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return;
  postDeptLedger(db, {
    departmentId: String(p.departmentId),
    materialId: String(p.materialId),
    type: d > 0 ? 'direct_receipt' : 'direct_receipt_reversal',
    quantity: d,
    outletId: p.outletId ?? null,
    referenceId: String(p.purchaseRowId),
    source: p.source,
    notes: p.notes,
    user: p.user || '',
  });
}

/* ── the reversal side (GRN void / bill amendment) ────────────────────────── */

/**
 * The NET recipe quantity a cost row put into (minus took back out of) its
 * department — SUM over 'direct_receipt' + 'direct_receipt_reversal' rows
 * whose reference_id is the purchases row id. This is the exact figure a void
 * must take back out: derived from the LEDGER, not recomputed from quantity ×
 * today's pack factor, for the same reason grn-reversal.ts unwinds central
 * from the RECORDED inventory_transactions row (pack_size is mutable).
 */
export function directReceiptNetPosted(db: Database.Database, purchaseRowId: string): number {
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS net
      FROM department_material_transactions
      WHERE reference_id = ? AND type IN ('direct_receipt', 'direct_receipt_reversal')
    `).get(String(purchaseRowId)) as any;
    return Number(row?.net) || 0;
  } catch {
    return 0;
  }
}

/** The direct-routed cost rows of a GRN (optionally one material's), with the
 *  department each was stamped for. Empty when the marker column is absent. */
export function directRowsForGrn(
  db: Database.Database,
  grnId: string,
  materialId?: string,
): Array<{ id: string; material_id: string; direct_issue_dept_id: string }> {
  if (!schemaReady(db).purchasesCol) return [];
  try {
    return db.prepare(`
      SELECT id, material_id, direct_issue_dept_id
      FROM purchases
      WHERE grn_id = ? ${materialId ? 'AND material_id = ?' : ''}
        AND COALESCE(direct_issue_dept_id, '') <> ''
    `).all(...(materialId ? [grnId, materialId] : [grnId])) as any[];
  } catch {
    return [];
  }
}

/**
 * Take a voided/removed cost row's goods back OUT of its department. Posts a
 * 'direct_receipt_reversal' for the net quantity the row put in; a no-op when
 * the net is already zero. Runs inside the caller's transaction. The
 * department balance MAY go negative — the goods may already be cooked — and
 * that is surfaced by the department variance report, exactly as a
 * post-consumption central void surfaces on the central count; blocking the
 * void here would leave a deleted bill's stock standing forever instead.
 */
export function reverseDirectReceiptRow(
  db: Database.Database,
  row: { id: string; material_id: string; direct_issue_dept_id: string },
  opts: { user?: string; notes: string; outletId?: string | null; source: string },
): number {
  const net = directReceiptNetPosted(db, row.id);
  if (Math.abs(net) < 1e-9) return 0;
  postDeptLedger(db, {
    departmentId: String(row.direct_issue_dept_id),
    materialId: String(row.material_id),
    type: net > 0 ? 'direct_receipt_reversal' : 'direct_receipt',
    quantity: -net,
    outletId: opts.outletId ?? null,
    referenceId: String(row.id),
    source: opts.source,
    notes: opts.notes,
    user: opts.user || '',
  });
  return -net;
}

/* ── shared receipt-side price stamp ──────────────────────────────────────── */

/**
 * The half of the receiving routes' bumpStock a direct-issue line KEEPS:
 * last_purchase_price (the GROSS ₹/purchase-unit list rate that seeds the next
 * PO) and last_purchase_date — with NO current_stock movement.
 */
export function stampLastPurchase(
  db: Database.Database,
  materialId: string,
  grossPrice: number,
  date: string,
): void {
  db.prepare(`
    UPDATE raw_materials
       SET last_purchase_price = ?, last_purchase_date = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(grossPrice, date, materialId);
}
