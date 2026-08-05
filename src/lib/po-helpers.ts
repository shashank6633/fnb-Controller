import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { centralFlowBlock } from '@/lib/store-engine';

/**
 * Shared Purchase Order helpers.
 *
 * Moved out of /api/purchase-orders/route.ts: Next.js route modules may only
 * export HTTP handlers (GET/POST/…), so the helpers shared with the
 * [id]/submit|approve|receive|reject action routes live here instead of being
 * re-exported from the route file (which fails route-module type validation).
 */

/** Role of the CURRENT SESSION, or null when there is no valid session.
 *  SECURITY: never falls back to a privileged role. The old settings-based
 *  `current_role` fallback meant a forged/expired cookie was treated as admin
 *  on every PO money/stock action — removed. Callers MUST 401 on null.
 *  Collapses 'staff' → 'manager' for the legacy two-tier PO callers. */
export async function effectiveRole(): Promise<'admin' | 'manager' | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  return user.role === 'admin' ? 'admin' : 'manager';
}
/** Back-compat shim for callers that used the old sync currentRole(db): now
 *  session-based and nullable. */
export async function currentRole(): Promise<'admin' | 'manager' | null> {
  return effectiveRole();
}

/** Gate every PO WRITE action (create / edit / delete / submit / receive /
 *  revise) with this. 'anon' → 401, 'denied' → 403, 'ok' → proceed.
 *  WHY IT EXISTS: those routes are documented "Manager OR Admin" but test
 *  `if (!(await effectiveRole()))` — and effectiveRole()/currentRole() collapse
 *  staff into 'manager' (above), so that test only asserts "has a session", not
 *  a tier. A truthiness check on effectiveRole/currentRole is never a tier check.
 *  NOT for approve/reject: those are intentionally stricter (admin-only).
 *  MEMBERSHIP: management (admin, any manager, or a HOD — the same isManagement()
 *  that gates the rest of the app's management-only surfaces) PLUS the store
 *  manager flag. That is the set /api/crm/reorder/route.ts:28 already calls "the
 *  people who raise POs today", and is_store_manager is independent of tier
 *  (auth/users + auth/roles both allow it on a 'staff' base role), so without it
 *  this would 403 the storekeeper whose job submit/receive actually is.
 *  403 COPY: say "Only Management or the Store Manager …" — "Manager or Admin"
 *  misstates the rule, since a staff-tier HOD and a storekeeper both pass.
 *  ACCEPTED RISK: isManagement passes every base_role='manager', which includes
 *  the seeded Floor Manager and Bar Manager (db.ts roles seed) — roles whose
 *  page_access carries no store page at all. They therefore also pass on receive,
 *  the irreversible one (stock bump + last_purchase_price + average_price
 *  rewrite). Deliberate: one gate for the whole PO lifecycle. If that stops being
 *  acceptable, narrow RECEIVE only, to `admin || is_store_manager`. */
export async function poWriteGate(): Promise<'anon' | 'denied' | 'ok'> {
  const user = await getCurrentUser();
  if (!user) return 'anon';
  return (isManagement(user) || user.is_store_manager) ? 'ok' : 'denied';
}

export async function effectiveActor(): Promise<string> {
  const user = await getCurrentUser();
  return user ? user.email : 'system';
}

export function recalcTotal(db: ReturnType<typeof getDb>, poId: string) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(total_price), 0) AS t FROM purchase_order_items WHERE po_id = ?
  `).get(poId) as any;
  db.prepare(`UPDATE purchase_orders SET total_cost = ?, updated_at = datetime('now') WHERE id = ?`).run(r.t, poId);
}

/** Is the admin approval step switched ON? Reads `po_require_admin_approval`
 *  from the settings KV (same table as the `po_send_to_vendor` toggle).
 *  THE RULE, one sentence, shared with the client: TRIM the stored value and
 *  compare to "0" — only "0" (padding allowed) turns approval off, so a MISSING
 *  row, a blank or any garbage value still requires approval.
 *  The Purchasing settings page applies that exact expression
 *  (`String(value ?? '').trim() !== '0'`, settings/purchasing/page.tsx) so its
 *  "Admin approval is OFF" banner can never contradict what this enforces. The
 *  `??` fallbacks are spelled differently ('1' here, '' there) only because each
 *  side's "nothing was read" sentinel differs; neither equals "0", so both read a
 *  missing row as required. The `.trim()` is what keeps them in step: without it
 *  a hand-edited/migrated " 0 " read OFF in the UI while this still enforced ON.
 *  FAIL-SAFE: any throw (table missing on an un-migrated DB, locked file) also
 *  returns true. Approval is a spend control — a failed read must never be the
 *  thing that silently lets a PO skip it. */
export function requiresAdminApproval(db: ReturnType<typeof getDb>): boolean {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get('po_require_admin_approval') as
      | { value?: string }
      | undefined;
    return String(r?.value ?? '1').trim() !== '0';
  } catch {
    return true;
  }
}

/** Zero-rate gate. Returns null when every line has a usable rate, else the
 *  ready-to-return error message naming the offending material.
 *  A 0/blank rate is legal on a DRAFT on purpose (Smart Reorder drafts a line
 *  whose ₹/purchase-unit is not known yet — see lineSanityError in
 *  /api/purchase-orders/route.ts), but the last decision gate before the vendor
 *  ships must refuse it: [id]/receive rejects a 0 rate on every line it books (a
 *  ₹0 purchases row makes updateMaterialPrice wipe the material's average_price
 *  to 0 and cascade a "free" ingredient through every recipe), so leaving it to
 *  receive strands goods the warehouse is already holding.
 *  SHARED ON PURPOSE: this lives here, not inline in [id]/approve, because when
 *  `po_require_admin_approval` is off the submit path auto-approves and never
 *  reaches that route — both paths must run this or turning the switch off would
 *  remove the only thing standing between a ₹0 draft and the books.
 *  DIAGNOSIS ONLY, NO REMEDY: the message is shared by [id]/approve (where the
 *  fix is reject → revise → re-submit) and [id]/submit's auto-approve (where the
 *  txn rolled back and the PO never left draft, so there is nothing to reject).
 *  Each caller appends its own remedy sentence; naming one here made the other
 *  path hand out two contradictory instructions in a single alert.
 *  SCOPE = the lines receive can actually book: same JOIN, and store-mapped lines
 *  are skipped exactly as receive skips them (centralFlowBlock → `receivable`).
 *  Still a deliberate SUPERSET in the one direction that cannot be mirrored:
 *  receive only enforces the rate where accepted > 0, and whether a line will be
 *  fully rejected at QC is unknowable here, so a line that ends up rejected in
 *  full must still carry a real rate to get past this.
 *  Number.isFinite first — a bare `<= 0` is false for NaN. */
export function zeroRateBlocker(db: ReturnType<typeof getDb>, poId: string): string | null {
  const rateLines = db.prepare(`
    SELECT poi.material_id, poi.unit_price, rm.name AS material_name,
           COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit
    FROM purchase_order_items poi
    JOIN raw_materials rm ON rm.id = poi.material_id
    WHERE poi.po_id = ?
  `).all(poId) as any[];
  for (const line of rateLines) {
    // Store-mapped (liquor) lines never enter Central purchases: receive filters
    // them out before pricing anything, so their rate cannot reach
    // updateMaterialPrice and blocking on one only strands the PO — PUT
    // /api/purchase-orders 400s on any payload naming a store-mapped material,
    // so the draft could be neither approved nor edited, only deleted.
    // FAIL-CLOSED: if the store lookup throws, treat the line as receivable and
    // hold it to the rate rule.
    let storeMapped = false;
    try {
      storeMapped = centralFlowBlock(db, String(line.material_id || '')) !== null;
    } catch {
      storeMapped = false;
    }
    if (storeMapped) continue;
    const px = Number(line.unit_price);
    if (!Number.isFinite(px) || px <= 0) {
      // Unit label = the PURCHASE unit: a PO line's rate is ₹ per purchase
      // unit (canon), so "₹/kg" here, never the recipe unit.
      const unit = String(line.material_purchase_unit || '').trim() || 'unit';
      return `Missing or zero rate on "${line.material_name}" (${px}). Receiving this PO would rewrite the material's average price, so the line needs a real ₹/${unit}.`;
    }
  }
  return null;
}

/* THE DUPLICATE-LINE RULE NOW LIVES IN ONE MODULE: @/lib/line-dedupe.
 * PoLineLike, lineKey, lineQty, lineLabel, duplicateLineError and
 * mergeDuplicateLines moved there VERBATIM (bodies, message strings and their
 * doc comments — read them there, they are not duplicated here).
 *
 * WHY IT MOVED: "Enter Full Bill" (src/app/purchases/page.tsx) is a 'use client'
 * component and can never import this file — po-helpers pulls in @/lib/db, i.e.
 * better-sqlite3, a native addon that must not reach the browser bundle. So the
 * bill modal RESTATED the rule inline, the two copies drifted (the mirror grew a
 * rate/GST/brand merge key and a "Keep both" escape hatch the PO never had), and
 * that drift is the whole reason for this ticket. line-dedupe imports NOTHING,
 * so both sides can now import the SAME rule.
 * DO NOT RESTATE THE RULE INLINE AGAIN — anywhere. Restating it is the bug.
 * And never let line-dedupe import po-helpers: one-way dependency only, or the
 * client bundle picks up the native driver through the back door.
 *
 * THIS IS A RE-EXPORT, NOT A WRAPPER, ON PURPOSE. `export … from` binds the very
 * same function objects and declarations, so the signature of duplicateLineError,
 * the `<T extends PoLineLike>` generic on mergeDuplicateLines and every emitted
 * message string are identical BY CONSTRUCTION — there is no second declaration
 * that can drift. A wrapper would re-declare all three and could. The callers
 * below still import from '@/lib/po-helpers' and were not touched:
 *   api/purchase-orders/route.ts (:484, :605)
 *   api/purchase-orders/[id]/edit-approved/route.ts (:181)
 *   api/requisitions/[id]/store-process/route.ts (:212)
 *   lib/crm-reorder-po.ts (:157) */
export { duplicateLineError, mergeDuplicateLines } from '@/lib/line-dedupe';
