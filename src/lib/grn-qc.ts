import type Database from 'better-sqlite3';
import { generateId, updateMaterialPrice, logAuditEvent } from './db';
import { centralFlowBlock } from './store-engine';
import { getCentralStoreCutoverDate } from './central-cutover';
import { packFactor } from './pack-units';
import { mainDeptOf } from './dept-hierarchy';
import { fulfilRequisitionFromPo } from './po-requisition-fulfil';
import type { SessionUser } from './auth';

/* ══════════════════════════════════════════════════════════════════════════
 * THE KITCHEN QC GATE — stock moves only after the checking department signs.
 *
 * SERVER ONLY. Imports better-sqlite3 through ./db; never import from a
 * "use client" file.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * The owner, 2026-08-21: "We have issues after taking the stock … the next day
 * the kitchen staff says the Quality is not good etc and we cant return the
 * items to vendors as it is taken by us and we said ok."
 *
 * Both receiving routes used to bump raw_materials.current_stock INSIDE the
 * transaction that inserts the GRN — src/app/api/grn/route.ts and
 * src/app/api/purchase-orders/[id]/receive/route.ts. The goods were ours the
 * instant Save returned. The six qc_* booleans on the GRN header did not help:
 * they are optional (`qc_quality ? 1 : 0`), they are ticked by the SAME person
 * doing the inward, and across all 29 live GRNs SUM(qc_quality) = 0 — the
 * checklist has never been ticked once. A receiver self-certifying their own
 * receipt is not a check.
 *
 * ── THE RULE THIS FILE IMPLEMENTS ──────────────────────────────────────────
 * A GRN whose lines include a material in a QC-required category is recorded
 * with status 'awaiting_qc' and NO stock movement at all. The kitchen or bar
 * signs it off PER LINE, and that sign-off is what inwards it — while the
 * vendor's truck is still at the bay and refusing a crate is real leverage.
 *
 * ── ONE HELPER, BOTH ROUTES ────────────────────────────────────────────────
 * The two receiving routes are 710 and 1,950 lines of separately-evolved,
 * heavily-commented code, and 20 of the 29 live GRNs come through the PO one.
 * Gating only the ad-hoc form would leave the main road open, and copying the
 * decision into both is how they drift. So exactly two things are shared here
 * and nothing is duplicated:
 *
 *   resolveQcRequirement()  — the GATE. Both routes call it before their
 *                             transaction and branch on one boolean.
 *   decideGrnQc()           — the APPLY. The single writer of the deferred
 *                             stock movement, used by BOTH the sign-off and
 *                             the override.
 *
 * What is NOT moved into this file is each route's own inline stock bump for
 * the ungated case. Those are pre-existing, battle-tested code paths with
 * subtly different purchases-row shapes (net-of-discount rate, per-line vendor,
 * back-correction wording); rewriting them to route through here would be a
 * refactor of the two most dangerous files in the app for no behavioural gain.
 * They are GUARDED, not rewritten — an ungated GRN takes byte-identical code.
 *
 * ── WHAT quantity_accepted MEANS WHILE A GRN WAITS, AND WHY ────────────────
 * THIS IS THE CRUX. Both routes derive `rejected = max(0, received - accepted)`
 * and default `accepted = received` AT INSERT. Under deferral neither of the
 * two obvious values is harmless:
 *
 *   accepted = received  → every downstream reader values and counts goods
 *     nobody has accepted. Two are dangerous rather than merely wrong:
 *     src/lib/returns.ts:374 offers a line for VENDOR RETURN on
 *     `quantity_accepted > 0`, and settling that return debits central stock
 *     (src/lib/return-stock.ts) that was never credited — it would take the
 *     goods out of some OTHER receipt's balance. src/lib/purchase-log.ts:744
 *     would book the value with no purchases mirror and report the delivery as
 *     billed-but-never-booked, which is indistinguishable from a real defect.
 *
 *   accepted = 0 (CHOSEN) → both of those close on their own, with no edit to
 *     either file: the returns candidate filter excludes it, and purchase-log
 *     values it at ₹0 on both rails so the reconciliation still agrees.
 *
 * So while a GRN waits, quantity_accepted and quantity_rejected are BOTH 0.
 * Zero accepted is NOT a rejection — it is the ABSENCE OF A DECISION, and
 * status = 'awaiting_qc' is what says so. Read one without the other and you
 * will misreport the delivery.
 *
 * THE CONSEQUENCE THIS BUYS, stated rather than hidden: the store no longer
 * declares an accepted quantity on a gated GRN. `received` is what came off the
 * truck; acceptance is the checking department's word. A receiver who tries to
 * pre-reject part of a gated line is REFUSED with the remedy (short-receive it,
 * or let the kitchen reject it) — see storePreRejectBlock() below. That is the
 * owner's decision 4 enforced rather than merely described.
 *
 * ── THE GRN IS THE UNIT: A MIXED DELIVERY WAITS AS A WHOLE ─────────────────
 * Asked explicitly, and answered explicitly. A GRN carrying 20 grocery lines
 * and one crate of tomatoes waits in full; it does NOT part-inward the grocery.
 * Three reasons, in order of weight:
 *
 *   1. IDEMPOTENCY. The whole-GRN rule lets "applied exactly once" be a single
 *      conditional UPDATE taken as the first statement of one transaction —
 *      the pattern this codebase already relies on twice (receive/route.ts's
 *      `WHERE status='approved'` claim, and the void's `WHERE status<>'void'`).
 *      Part-inwarding makes it a per-line proof against a per-line applied
 *      flag, which is a materially weaker guarantee for a stock bump.
 *   2. THE VOID PATH WOULD MISREAD IT. DELETE /api/grn/[id] refuses a receipt
 *      whose accepted-line count does not equal its linked cost-row count
 *      (grn/[id]/route.ts:636) — a half-applied GRN fails that check and gets a
 *      message about predating purchases.grn_id, which is a lie.
 *   3. THERE IS ALREADY A LEVER, and it produces the more honest record. If the
 *      dry goods genuinely must not wait, the storekeeper splits the delivery
 *      into two GRNs — two bills, two documents. The PO route has supported
 *      exactly this since multi-vendor receiving (`line_ids`, a subset of the
 *      vendor's outstanding lines); the ad-hoc form simply saves twice.
 *
 * And the wait is minutes at the bay, not days: the entire premise is that the
 * vendor is still standing there. A delivery with NO gated line is not held at
 * all and takes precisely the code path it took before this feature existed.
 * ══════════════════════════════════════════════════════════════════════════ */

/** The GRN header status that means "recorded, not yet inwarded". */
export const QC_AWAITING = 'awaiting_qc';

/** Who a category's check belongs to. 'none' = no check, the default. */
export type QcChecker = 'none' | 'kitchen' | 'bar' | 'both';
export const QC_CHECKERS: QcChecker[] = ['none', 'kitchen', 'bar', 'both'];

/** Float slack, matching QTY_EPS in the receive route. */
const EPS = 1e-6;
const r2 = (v: number): number => Math.round((Number(v) || 0) * 100) / 100;

/** An error carrying the HTTP status it should surface as. Thrown from inside
 *  db.transaction(), where a Response cannot be returned — the shape both
 *  api/grn/[id]/route.ts and the receive route already use. */
export class QcRefused extends Error {
  httpStatus: number;
  payload?: Record<string, unknown>;
  constructor(status: number, message: string, payload?: Record<string, unknown>) {
    super(message);
    this.httpStatus = status;
    this.payload = payload;
  }
}

/**
 * THE ONE runtime normalisation for a category key.
 *
 * Byte-equivalent to catNorm() in src/lib/store-engine.ts (the SQL side) and to
 * the inline `norm()` in the qc_category_seed_v1 block of src/lib/db.ts (which
 * cannot import this file — db.ts is the bottom of the import graph). Case- and
 * separator-insensitive, and deliberately NOT stemming: 'veg', 'vegetables' and
 * 'english-vegetables' stay three distinct keys, which is exactly why the owner
 * chose a map carrying every spelling over a rename of 952 materials.
 */
export const catKeyOf = (s: unknown): string =>
  String(s ?? '').toLowerCase().trim().replace(/ /g, '').replace(/-/g, '').replace(/_/g, '');

/** Normalise a stored checker value; anything unrecognised reads as 'none'. */
function asChecker(v: unknown): QcChecker {
  const s = String(v ?? '').toLowerCase().trim();
  return (QC_CHECKERS as string[]).includes(s) ? (s as QcChecker) : 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CATEGORY → CHECKER MAP
// ─────────────────────────────────────────────────────────────────────────────

/** The whole map, keyed by catKeyOf(category). Missing key ⇒ 'none'. */
export function getCategoryCheckerMap(db: Database.Database): Map<string, QcChecker> {
  const out = new Map<string, QcChecker>();
  try {
    for (const r of db.prepare(`SELECT category_key, checker FROM qc_category_checkers`).all() as any[]) {
      out.set(String(r.category_key), asChecker(r.checker));
    }
  } catch {
    // Table missing on an un-migrated DB. An empty map means every category
    // reads 'none', i.e. NOTHING is gated — the same behaviour as before this
    // feature. Failing the other way (gate everything) would stop deliveries
    // because of a schema fault, which is a worse failure than not gating.
  }
  return out;
}

export interface CategoryCheckerRow {
  category: string;
  category_key: string;
  checker: QcChecker;
  /** Is there an explicit row for it, or is it falling through to 'none'? */
  assigned: boolean;
  material_count: number;
  /** Can a material in this category ever reach a central GRN at all?
   *  Store-mapped (TGBCL liquor) categories are refused by centralFlowBlock on
   *  every receiving path, so a checker set on one can never fire. Surfaced so
   *  the unassigned count does not read as "118 bar items escaping QC". */
  central_reachable: boolean;
  updated_by: string;
  updated_at: string;
  /** A few material names from this category, so an admin can SEE what a
   *  bucket actually holds before deciding it. This is not decoration: the
   *  biggest unmapped bucket in this database is literally called `other` and
   *  it contains MILK, CURD, EGGS, FRESH CREAM, CORIANDER LEAF and MINT FRESH
   *  side by side with JACK DANIELS, FIRE WOOD and GAS 19 KG — a name that
   *  tells the admin nothing and a decision ('kitchen' or 'none') that is wrong
   *  either way. See the hand-over: this needs an owner ruling, and until then
   *  the least the screen can do is show what is in the box. */
  sample_materials: string[];
}

/**
 * Every LIVE category (from raw_materials) plus any mapped key that no longer
 * has materials, with counts and the assigned/unassigned flag.
 *
 * UNASSIGNED IS THE POINT OF THIS FUNCTION. A new category defaults to 'none'
 * so it can never silently BLOCK a delivery — but it must never silently ESCAPE
 * one either, and the only way to have both is to make the gap visible. This is
 * the data behind that panel.
 */
export function listCategoryCheckers(db: Database.Database): CategoryCheckerRow[] {
  const map = new Map<string, { checker: QcChecker; updated_by: string; updated_at: string; category: string }>();
  try {
    for (const r of db.prepare(
      `SELECT category_key, category, checker, COALESCE(updated_by,'') AS updated_by, COALESCE(updated_at,'') AS updated_at
         FROM qc_category_checkers`,
    ).all() as any[]) {
      map.set(String(r.category_key), {
        checker: asChecker(r.checker), updated_by: r.updated_by, updated_at: r.updated_at,
        category: String(r.category || ''),
      });
    }
  } catch { /* un-migrated: everything reads unassigned, which is honest */ }

  // EVERY category, not only the ones with an ACTIVE material. The is_active
  // filter used to sit in the WHERE, and it made a category with no live
  // material VANISH from this screen — while resolveQcRequirement (which has no
  // is_active filter at all) would still gate it the moment one was
  // re-activated. A seasonal perishable therefore could not be assigned while
  // it was out of season and came back unassigned. material_count still counts
  // only ACTIVE materials, which is the number that means anything to an admin.
  const live = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(category), ''), 'other') AS category,
           SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS n
      FROM raw_materials
     GROUP BY COALESCE(NULLIF(TRIM(category), ''), 'other')
  `).all() as any[];

  const sampler = db.prepare(`
    SELECT name FROM raw_materials
     WHERE COALESCE(NULLIF(TRIM(category), ''), 'other') = ? AND is_active = 1
     ORDER BY name LIMIT 8
  `);

  const rows: CategoryCheckerRow[] = [];
  const seen = new Set<string>();
  for (const r of live) {
    const key = catKeyOf(r.category);
    seen.add(key);
    const m = map.get(key);
    let samples: string[] = [];
    try { samples = (sampler.all(String(r.category)) as any[]).map(x => String(x.name)); } catch { /* names are a nicety */ }
    rows.push({
      category: String(r.category),
      category_key: key,
      checker: m ? m.checker : 'none',
      assigned: !!m,
      material_count: Number(r.n) || 0,
      // centralFlowBlock takes a raw category string as well as a material id.
      central_reachable: !centralFlowBlock(db, String(r.category)),
      updated_by: m?.updated_by || '',
      updated_at: m?.updated_at || '',
      sample_materials: samples,
    });
  }
  // Mapped keys with no live materials — kept visible so a rule the admin set
  // does not vanish from the screen the moment the last material is retired.
  for (const [key, m] of map) {
    if (seen.has(key)) continue;
    rows.push({
      category: m.category || key,
      category_key: key,
      checker: m.checker,
      assigned: true,
      material_count: 0,
      central_reachable: !centralFlowBlock(db, m.category || key),
      updated_by: m.updated_by,
      updated_at: m.updated_at,
      sample_materials: [],
    });
  }
  rows.sort((a, b) => b.material_count - a.material_count || a.category.localeCompare(b.category));
  return rows;
}

/** Admin write. Upserts only the keys sent, so a partial save never clears the
 *  rest. Returns how many rows actually changed. */
export function setCategoryCheckers(
  db: Database.Database,
  updates: Array<{ category: string; checker: string }>,
  actorEmail: string,
): { updated: number; invalid: string[] } {
  const invalid: string[] = [];
  const clean: Array<{ key: string; category: string; checker: QcChecker }> = [];
  for (const u of updates) {
    const category = String(u?.category ?? '').trim();
    if (!category) continue;
    const raw = String(u?.checker ?? '').toLowerCase().trim();
    if (!(QC_CHECKERS as string[]).includes(raw)) { invalid.push(category); continue; }
    clean.push({ key: catKeyOf(category), category, checker: raw as QcChecker });
  }
  if (invalid.length) return { updated: 0, invalid };
  const ins = db.prepare(`
    INSERT INTO qc_category_checkers (category_key, category, checker, updated_by, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(category_key) DO UPDATE SET
      category = excluded.category, checker = excluded.checker,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `);
  const run = db.transaction(() => {
    let n = 0;
    for (const c of clean) { ins.run(c.key, c.category, c.checker, actorEmail); n++; }
    return n;
  });
  return { updated: run(), invalid: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE GATE — called by BOTH receiving routes, before their transaction
// ─────────────────────────────────────────────────────────────────────────────

export interface QcRequirement {
  /** Hold this GRN? */
  required: boolean;
  /** Who must sign: 'kitchen' | 'bar' | 'both' | 'none'. */
  checker: QcChecker;
  /** Distinct categories that triggered the hold, for the message + the queue. */
  categories: string[];
  /** Human sentence for the receiving route's response. '' when not required. */
  message: string;
}

/**
 * Does this set of materials need a check, and whose?
 *
 * `materialIds` MUST BE THE MATERIALS OF THE LINES THAT WILL ACTUALLY BE
 * INSERTED AS POSITIVE RECEIPTS — nothing else. Two exclusions are the caller's
 * job because only the caller knows its own line arithmetic, and BOTH of them
 * were the source of a real hole:
 *
 *   · BACK-CORRECTIONS (negative quantity) are not gated. Those lines REDUCE
 *     stock to undo an earlier over-booking; holding a reduction for a kitchen
 *     quality check is meaningless, and deferring it would leave the
 *     overstatement on the book for as long as the queue takes. Only /api/grn
 *     can produce one (the receive route refuses negatives outright,
 *     receive/route.ts:601-618).
 *
 *     THIS EXEMPTION IS PER LINE AND MUST STAY PER LINE. It used to be an
 *     `opts.hasNegativeLine` flag computed over the WHOLE payload, which turned
 *     the gate OFF FOR EVERY LINE ON THE BILL: 40 kg of asparagus, 25 kg of raw
 *     meat and one −1 kg sugar correction saved as `received`, with no hold, no
 *     bell and no queue row — reachable from the UI with one checkbox, and the
 *     exact failure the owner described. The flag is gone; there is no way to
 *     ask this function to stand down.
 *
 *   · LINES THAT WILL BE SKIPPED. /api/grn drops a line with
 *     `received === 0 && accepted === 0` before it inserts anything. Gating on
 *     its material anyway produced a GRN held with ZERO line rows, which
 *     decideGrnQc then refused to sign OR override ("has no line items"),
 *     leaving it in the queue, the bell and the escalation sweep permanently.
 *
 * 'both' means EITHER department may sign, not that two signatures are needed.
 * The map answers "who is competent to judge this category", and a second
 * mandatory signature is machinery the owner did not ask for. Flagged in the
 * hand-over notes so it can be changed to AND if that was the intent.
 */
export function resolveQcRequirement(
  db: Database.Database,
  materialIds: string[],
): QcRequirement {
  const none: QcRequirement = { required: false, checker: 'none', categories: [], message: '' };
  const ids = [...new Set(materialIds.map(m => String(m || '')).filter(Boolean))];
  if (ids.length === 0) return none;

  const map = getCategoryCheckerMap(db);
  if (map.size === 0) return none;

  const rows = db.prepare(`
    SELECT id, COALESCE(NULLIF(TRIM(category), ''), 'other') AS category
      FROM raw_materials
     WHERE id IN (${ids.map(() => '?').join(',')})
  `).all(...ids) as any[];

  const hit = new Map<string, QcChecker>();   // display category → checker
  for (const r of rows) {
    const c = asChecker(map.get(catKeyOf(r.category)));
    if (c !== 'none') hit.set(String(r.category), c);
  }
  if (hit.size === 0) return none;

  const kinds = new Set(hit.values());
  // One department across every gated line ⇒ that department. Otherwise the
  // delivery needs kitchen AND bar competence between them, and 'both' is the
  // honest label — either side may sign, per the note above.
  const checker: QcChecker = kinds.size === 1 ? [...kinds][0] : 'both';
  const categories = [...hit.keys()].sort();
  const who = checker === 'both' ? 'Kitchen or Bar' : checker === 'bar' ? 'Bar' : 'Kitchen';
  return {
    required: true,
    checker,
    categories,
    message:
      `Recorded and waiting for a quality check — no stock has been added yet. `
      + `${who} must check ${categories.join(', ')} (quality, temperature, damage) and sign off before these goods enter stock. `
      + `Keep the vendor at the bay until they do.`,
  };
}

/**
 * The store may not pre-reject on a gated GRN.
 *
 * On a held delivery the store records WHAT ARRIVED and the checking department
 * records WHAT IS ACCEPTED — that separation is the whole of the owner's
 * decision 4, and it is also what makes `quantity_accepted = 0 while waiting`
 * unambiguous. A receiver who wants to turn units away has the honest lever
 * already: short-receive them, i.e. record the smaller quantity as RECEIVED,
 * which is the true statement that the goods went back on the truck.
 *
 * Returns the refusal sentence, or null when the payload is fine. Only ever
 * fires on a GRN that is actually being held.
 */
export function storePreRejectBlock(
  lines: Array<{ material_name?: string; received: number; declaredAccepted: number }>,
): string | null {
  const bad = lines.filter(l => Number(l.declaredAccepted) < Number(l.received) - EPS);
  if (bad.length === 0) return null;
  const names = bad.slice(0, 3).map(l => l.material_name || 'a line').join(', ');
  return `This delivery needs a quality check, so the accepted quantity is the checking department's to record, not the receiving desk's `
    + `(${bad.length} line(s): ${names}${bad.length > 3 ? '…' : ''}). `
    + `Record what actually arrived — if units went back on the truck, enter the SMALLER figure as the RECEIVED quantity instead. `
    + `The kitchen rejects what it will not take, with a reason, when it signs off.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// WHO MAY SIGN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * May this user sign off a check for `checker`?
 *
 * The owner's decision 6, verbatim: "any user with access to the checking
 * department, name and time stamped. NOT HOD-only — at 6am with a truck waiting
 * that guarantees workarounds."
 *
 * There is no userIsInDepartment() in this codebase, so membership is the UNION
 * of the two mechanisms that exist — the same shape resolveRecipients() uses in
 * api/tasks/request/route.ts:
 *   · users.department_id resolved to its MAIN department (Kitchen | Bar) via
 *     mainDeptOf(); and
 *   · users.section, the functional Kitchen|Bar|Service|Maintenance|Store field
 *     the Users screen already exposes. It survives the mis-parented sub-depts
 *     (Akan Security / Service / Stationery are parented under Kitchen), so a
 *     kitchen person is section='Kitchen' regardless of which sub-dept they sit
 *     in.
 * visible_department_ids is NOT consulted: it grants VISIBILITY of another
 * department's data, which is not competence to judge its goods.
 *
 * Page access is NOT consulted either, in any form. canAccessPage fails open
 * four ways (null / [] / bad JSON / non-array) and 8 of the 9 live users have
 * page_access NULL, so "has the kitchen page" is true for almost everybody —
 * inferring duty from it would be a gate that grants itself.
 *
 * MEASURED REALITY, 2026-08-21 — READ THIS BEFORE CALLING THE GATE TOO TIGHT.
 * All 19 departments have an empty head_user_id, ALL NINE users have section = '',
 * and only three carry a department_id. Exactly ONE non-admin user resolves to a
 * main department at all (bar@akanhyd.com → Akan Bar → Bar). So on day one the
 * people who can sign a KITCHEN check are the admins and the head chefs, and
 * nobody else — which is precisely why the owner's override (decision 2) is not
 * a nicety but the working path until users.department_id / users.section is
 * backfilled. qcSignerAudit() below reports that gap so it is on screen instead
 * of being discovered at the receiving bay.
 */
export function canSignQcFor(
  db: Database.Database,
  user: SessionUser | null,
  checker: QcChecker,
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  // A head of department may sign. The escalation goes to them, but decision 6
  // says the HOD is not the ONLY one who may — not that they may not.
  if (user.is_head_chef) return true;
  if (checker === 'none') return false;

  const wanted = checker === 'both' ? ['kitchen', 'bar'] : [checker];
  const section = String(user.section || '').toLowerCase().trim();
  if (section && wanted.includes(section)) return true;
  try {
    const main = mainDeptOf(db, user.department_id);
    const name = String(main?.name || '').toLowerCase().trim();
    if (name && wanted.includes(name)) return true;
  } catch { /* unreadable department tree ⇒ no membership proven ⇒ refuse */ }
  return false;
}

/**
 * Who can actually sign today, so the gap is visible rather than discovered at
 * the bay. Read by the QC queue and the QC settings screen.
 *
 * THE NUMBER THAT MATTERS IS `kitchen_dept` / `bar_dept`, NOT `kitchen`/`bar`.
 * Every admin and every head chef already counts inside `kitchen`, so
 * `kitchen >= max(admins, hods)` ALWAYS, and the queue page's original banner
 * predicate (`kitchen <= max(admins, hods)`) could only fire in the degenerate
 * case where those sets coincide exactly — measured on this database it never
 * fired, on the full user list or the production-shaped one, which made the one
 * sentence in the app that says "set Section/Department on /users" unreachable.
 * `kitchen_dept` counts the people who can sign BECAUSE THEY ARE IN THE KITCHEN
 * — not because they are an admin or a head chef — and zero is the condition
 * worth warning about.
 *
 * `granting_departments` exists because membership resolves through
 * mainDeptOf(), which walks the parent chain — and this database parents
 * `Akan Security`, `Akan Service` and `Akan Stationery` UNDER Kitchen. A guard
 * or a waiter therefore resolves to main department Kitchen and may sign off on
 * the quality and temperature of food. That is a data error in the department
 * tree, not something this gate can guess its way around, so the tree is listed
 * for the admin to read and re-parent rather than second-guessed here.
 */
export function qcSignerAudit(db: Database.Database): {
  kitchen: number; bar: number; admins: number; hods: number; users_without_department: number;
  /** Signers who are NOT admins and NOT head chefs — the real departmental bench. */
  kitchen_dept: number; bar_dept: number;
  /** Sub-departments whose staff inherit signing rights through the parent chain. */
  granting_departments: Array<{ main: 'Kitchen' | 'Bar'; name: string; users: number }>;
} {
  const users = db.prepare(`
    SELECT u.id, u.email, u.role, u.is_head_chef, u.is_store_manager,
           u.can_approve_requisitions, u.department_id, u.section,
           u.page_access, u.visible_department_ids, u.preferred_zones,
           u.preferred_table_ids, u.name, u.position, u.role_id,
           r.base_role AS role_base, r.is_head_chef AS role_head_chef
      FROM users u LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.is_active = 1
  `).all() as any[];
  let kitchen = 0, bar = 0, admins = 0, hods = 0, noDept = 0, kitchenDept = 0, barDept = 0;
  for (const row of users) {
    const hasRole = !!row.role_id && !!row.role_base;
    // Resolve the effective tier + flag exactly as getCurrentUser() does, so
    // this count can never disagree with the gate it is describing.
    const u = {
      ...row,
      role: (hasRole ? row.role_base : row.role) || 'staff',
      is_head_chef: !!row.is_head_chef || (hasRole && !!row.role_head_chef),
      section: row.section || '',
    } as unknown as SessionUser;
    if (u.role === 'admin') admins++;
    if (u.is_head_chef) hods++;
    if (!row.department_id && !String(row.section || '').trim()) noDept++;
    if (canSignQcFor(db, u, 'kitchen')) kitchen++;
    if (canSignQcFor(db, u, 'bar')) bar++;
    // The departmental bench — the same predicate with the two blanket grants
    // (admin, head chef) taken out, which is the only count that answers
    // "could a kitchen hand sign this at 6am?"
    const blanket = u.role === 'admin' || !!u.is_head_chef;
    if (!blanket) {
      if (canSignQcFor(db, u, 'kitchen')) kitchenDept++;
      if (canSignQcFor(db, u, 'bar')) barDept++;
    }
  }

  const granting: Array<{ main: 'Kitchen' | 'Bar'; name: string; users: number }> = [];
  try {
    for (const d of db.prepare(`
      SELECT d.id, d.name,
             (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.is_active = 1) AS users
        FROM departments d
       ORDER BY d.name
    `).all() as any[]) {
      const main = mainDeptOf(db, String(d.id));
      const mname = String(main?.name || '').toLowerCase().trim();
      if (mname !== 'kitchen' && mname !== 'bar') continue;
      granting.push({
        main: mname === 'bar' ? 'Bar' : 'Kitchen',
        name: String(d.name),
        users: Number(d.users) || 0,
      });
    }
  } catch { /* unreadable tree ⇒ report none rather than guess */ }

  return {
    kitchen, bar, admins, hods, users_without_department: noDept,
    kitchen_dept: kitchenDept, bar_dept: barDept,
    granting_departments: granting,
  };
}

/** Who may release a held GRN without a check — the owner's decision 2. */
export function canOverrideQc(user: SessionUser | null): boolean {
  if (!user) return false;
  return user.role === 'admin' || user.is_head_chef;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE QUEUE + THE ESCALATION CLOCK
// ─────────────────────────────────────────────────────────────────────────────

const ESCALATION_KEY = 'qc_escalation_hours';
const ESCALATION_DEFAULT = 4;

/** Hours a GRN may sit unchecked before it is overdue. Clamped 1…168 so a typo
 *  can neither spam the bell every minute nor silence it for a month. */
export function qcEscalationHours(db: Database.Database): number {
  let raw: string | undefined;
  try {
    raw = (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(ESCALATION_KEY) as any)?.value;
  } catch { /* fall through to the default */ }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return ESCALATION_DEFAULT;
  return Math.min(168, Math.max(1, n));
}

/** Rows of the Pending Quality Checks queue, newest wait first. */
export function listPendingQc(
  db: Database.Database,
  opts: { outletId?: string | null; user?: SessionUser | null; limit?: number } = {},
): Array<Record<string, any>> {
  const where: string[] = [`g.status = ?`];
  const params: any[] = [QC_AWAITING];
  if (opts.outletId) { where.push('(g.outlet_id = ? OR g.outlet_id IS NULL)'); params.push(opts.outletId); }
  const rows = db.prepare(`
    SELECT g.id, g.grn_number, g.date, g.vendor, g.invoice_number, g.received_by,
           g.qc_checker, g.qc_escalated_at, g.created_at, g.po_id,
           po.po_number AS po_number,
           (SELECT COUNT(*) FROM goods_receipt_note_items WHERE grn_id = g.id) AS line_count,
           -- rate-basis: purchase — quantity_received is PURCHASE units and
           -- unit_price is Rs/purchase-unit on a GRN line (canon), so the two
           -- multiply. This is the BILL value of what is waiting, not a cost.
           (SELECT ROUND(SUM(quantity_received * unit_price), 2)
              FROM goods_receipt_note_items WHERE grn_id = g.id) AS held_value,
           CAST((julianday('now') - julianday(g.created_at)) * 24 AS REAL) AS waiting_hours
      FROM goods_receipt_notes g
      LEFT JOIN purchase_orders po ON po.id = g.po_id
     WHERE ${where.join(' AND ')}
     ORDER BY g.created_at ASC
     LIMIT ?
  `).all(...params, Math.min(500, Math.max(1, opts.limit ?? 200))) as any[];

  const overdueAfter = qcEscalationHours(db);
  return rows.map(r => ({
    ...r,
    waiting_hours: Math.round((Number(r.waiting_hours) || 0) * 10) / 10,
    overdue: (Number(r.waiting_hours) || 0) >= overdueAfter,
    // ADVISORY, for the page only. Every write re-derives it from the session.
    can_sign: opts.user ? canSignQcFor(db, opts.user, asChecker(r.qc_checker)) : false,
  }));
}

/**
 * Queue size for the bell. Counts what the page will actually SHOW, so the badge
 * and its destination can never disagree — the rule pendingVarianceCount()
 * documents and this copies.
 *
 * NOT filtered by who may sign. A held delivery that nobody in the building can
 * sign is the single most important row in this queue, and hiding it from the
 * people who can act on it (admin / HOD / the store person who took it in)
 * would be the feature failing silently — which, on today's data, is the likely
 * case rather than the edge case.
 */
export function pendingQcCount(db: Database.Database, outletId: string | null): number {
  try {
    const sql = outletId
      ? `SELECT COUNT(*) AS n FROM goods_receipt_notes WHERE status = ? AND (outlet_id = ? OR outlet_id IS NULL)`
      : `SELECT COUNT(*) AS n FROM goods_receipt_notes WHERE status = ?`;
    const p = outletId ? [QC_AWAITING, outletId] : [QC_AWAITING];
    return Number((db.prepare(sql).get(...p) as any)?.n || 0);
  } catch { return 0; }
}

/** Held GRNs that have waited past the escalation threshold. */
export function overdueQcCount(db: Database.Database, outletId: string | null): number {
  try {
    const hrs = qcEscalationHours(db);
    const sql = `
      SELECT COUNT(*) AS n FROM goods_receipt_notes
       WHERE status = ?
         AND (julianday('now') - julianday(created_at)) * 24 >= ?
         ${outletId ? 'AND (outlet_id = ? OR outlet_id IS NULL)' : ''}`;
    const p: any[] = outletId ? [QC_AWAITING, hrs, outletId] : [QC_AWAITING, hrs];
    return Number((db.prepare(sql).get(...p) as any)?.n || 0);
  } catch { return 0; }
}

// ─────────────────────────────────────────────────────────────────────────────
// IS THE GATE ACTUALLY ARMED? — the alarm on the fail-open direction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE GATE FAILS OPEN, ON PURPOSE, AND THAT NEEDS AN ALARM RATHER THAN A COMMENT.
 *
 * getCategoryCheckerMap() swallows a missing table, and resolveQcRequirement()
 * returns 'none' on an empty map — so a half-applied boot migration turns the
 * ENTIRE feature off silently: every delivery inwards immediately, the queue
 * reads 0 and the bell reads 0, all of which look exactly like a quiet morning.
 * The house rule that makes this dangerous is real and documented: db.ts's
 * schema block is PRAGMA-guarded and its errors are console.error only, so
 * nothing downstream ever learns.
 *
 * Failing OPEN is still the right direction — blocking every delivery at the bay
 * because of a schema fault is worse than not gating — but the state has to be
 * VISIBLE. This is the read every QC surface renders as a banner: it names the
 * missing pieces, so "the gate is not armed" is a sentence somebody sees rather
 * than something inferred weeks later from stock that keeps going bad.
 */
export interface QcSchemaHealth {
  ok: boolean;
  missing_header_columns: string[];
  missing_line_columns: string[];
  map_table_missing: boolean;
  mapped_categories: number;
  /** True when the schema is intact but every category reads 'none' — the OTHER
   *  way the gate can be silently disarmed, and the one an admin caused. */
  armed: boolean;
  message: string;
}

const QC_HEADER_COLUMNS = [
  'qc_required', 'qc_checker', 'qc_outcome', 'qc_kitchen_by', 'qc_kitchen_at',
  'qc_store_by', 'qc_store_at', 'qc_override_by', 'qc_override_at',
  'qc_override_reason', 'qc_applied_at', 'qc_escalated_at',
];
const QC_LINE_COLUMNS = ['cost_vendor', 'cost_note', 'qc_applied_at', 'gst_rate', 'cess_rate'];

export function qcSchemaHealth(db: Database.Database): QcSchemaHealth {
  const cols = (table: string): Set<string> => {
    try {
      return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => String(c.name)));
    } catch { return new Set<string>(); }
  };
  const header = cols('goods_receipt_notes');
  const line = cols('goods_receipt_note_items');
  const missing_header_columns = QC_HEADER_COLUMNS.filter(c => !header.has(c));
  const missing_line_columns = QC_LINE_COLUMNS.filter(c => !line.has(c));

  let map_table_missing = false;
  let mapped = 0;
  try {
    mapped = Number((db.prepare(
      `SELECT COUNT(*) AS n FROM qc_category_checkers WHERE LOWER(TRIM(checker)) <> 'none'`,
    ).get() as any)?.n || 0);
  } catch { map_table_missing = true; }

  const ok = missing_header_columns.length === 0 && missing_line_columns.length === 0 && !map_table_missing;
  const armed = ok && mapped > 0;
  const parts: string[] = [];
  if (map_table_missing) parts.push('the category → checker table is missing');
  if (missing_header_columns.length) parts.push(`${missing_header_columns.length} GRN column(s) missing: ${missing_header_columns.join(', ')}`);
  if (missing_line_columns.length) parts.push(`${missing_line_columns.length} GRN line column(s) missing: ${missing_line_columns.join(', ')}`);
  const message = ok
    ? (armed ? '' :
       'The quality-check gate is INSTALLED BUT NOT ARMED — no category is set to Kitchen, Bar or Both, so every delivery inwards the moment it is saved. Assign the perishable categories below.')
    : `The quality-check gate is NOT ARMED — ${parts.join('; ')}. `
      + `Every delivery is inwarding immediately and the queue will read 0 whatever arrives. `
      + `The boot migration in src/lib/db.ts did not fully apply: restart the server and check the log for "GRN QC schema".`;
  return { ok, missing_header_columns, missing_line_columns, map_table_missing, mapped_categories: mapped, armed, message };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HOLD, SEEN FROM THE OTHER RAILS THAT RE-BASE THE BOOK ONTO THE SHELF
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WAS A DELIVERY OF THIS MATERIAL SITTING UNCHECKED WHEN THE SHELF WAS COUNTED?
 *
 * THIS IS THE ONE HAZARD THE HOLD CREATES THAT IS NOT VISIBLE FROM INSIDE IT.
 * While a GRN waits, the goods are PHYSICALLY ON THE SHELF and DELIBERATELY NOT
 * ON THE BOOK. Anything that re-bases the book onto the shelf in that window
 * therefore absorbs the delivery, and the later sign-off adds it a second time:
 *
 *    07:00  GRN 100 kg tomatoes held        book 20   shelf 120
 *    22:00  closing count: physical 120, system_stock frozen at 20 → variance +100
 *    07:00+ kitchen signs off               book 120  (correct)
 *    10:00  admin approves the variance     book 120 + 100 = 220   ← 100 kg
 *                                                                    nobody bought
 *
 * approveVariance() posts the COUNT-TIME DELTA on top of whatever the book holds
 * now, and that is right for a real movement made after the count (an issue to a
 * kitchen must survive). A QC sign-off is NOT a movement after the count: it is
 * the belated booking of goods that were already on the shelf when it was
 * counted, so the delta and the sign-off describe the SAME crate.
 *
 * decideGrnQc already re-runs exactly this reasoning for the central-store
 * cutover, for exactly this reason. A closing count is the same event on a
 * smaller scale and had no guard at all.
 *
 * Returns the refusal sentence, or null when the count is clean. `countInstant`
 * is the count's own moment — pass the SQLite timestamp the caller already uses
 * so both sides compare on one clock.
 */
export function qcHoldBlockForCount(
  db: Database.Database,
  materialId: string,
  countInstant: string,
): string | null {
  const at = String(countInstant || '').trim();
  if (!at || !materialId) return null;
  try {
    const hit = db.prepare(`
      SELECT g.grn_number, g.date, g.status, g.qc_applied_at
        FROM goods_receipt_note_items gi
        JOIN goods_receipt_notes g ON g.id = gi.grn_id
       WHERE gi.material_id = ?
         AND g.status <> 'void'
         AND g.created_at <= ?
         AND (
              -- still waiting: the goods are on the shelf and off the book right now
              (g.status = ? AND gi.quantity_received > 0)
              -- or it was signed off AFTER this count was taken, so the count
              -- was measured against a book that did not yet hold them
           OR (g.qc_applied_at IS NOT NULL AND g.qc_applied_at > ? AND gi.quantity_accepted > 0)
         )
       ORDER BY g.created_at DESC
       LIMIT 1
    `).get(materialId, at, QC_AWAITING, at) as any;
    if (!hit) return null;
    const waiting = String(hit.status) === QC_AWAITING;
    return (
      `Delivery ${hit.grn_number} (${hit.date}) was still awaiting a quality check when this count was taken, so the goods were ON THE SHELF but not yet ON THE BOOK. `
      + `The counted difference already includes them, and the sign-off adds them again — approving this would credit the same delivery twice. `
      + (waiting
        ? `Clear ${hit.grn_number} on Pending Quality Checks first, then count the shelf again and approve THAT count.`
        : `${hit.grn_number} has since been signed off, so the book is already correct. Reject this count and take a fresh one.`)
    );
  } catch {
    // Un-migrated DB (no qc_applied_at / no status value): nothing can be held,
    // so nothing can overlap. Refusing here would block every approval on a
    // database that has never seen this feature.
    return null;
  }
}

/**
 * Materials with a delivery sitting unchecked right now. Read by
 * /api/inventory/fix-negative-stock, which lifts a negative central balance to
 * ZERO — an assertion that the shelf is empty. A held GRN makes that assertion
 * wrong in the one direction that costs money: central goes further negative
 * while the kitchen consumes goods the book does not yet own, so the button is
 * reached for precisely when a hold is outstanding, and the later sign-off then
 * adds the full delivery on top of the lifted zero.
 */
export function materialsAwaitingQc(db: Database.Database): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const r of db.prepare(`
      SELECT DISTINCT gi.material_id AS mid, g.grn_number
        FROM goods_receipt_note_items gi
        JOIN goods_receipt_notes g ON g.id = gi.grn_id
       WHERE g.status = ? AND gi.quantity_received > 0
    `).all(QC_AWAITING) as any[]) {
      if (!out.has(String(r.mid))) out.set(String(r.mid), String(r.grn_number));
    }
  } catch { /* un-migrated ⇒ nothing is held */ }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE APPLY — the single writer of the deferred stock movement
// ─────────────────────────────────────────────────────────────────────────────

export interface QcLineDecision {
  grn_item_id: string;
  /** Purchase units. Defaults to quantity_received. */
  accepted?: number | null;
  rejection_reason?: string;
}

export interface QcDecisionResult {
  grn_id: string;
  grn_number: string;
  outcome: 'signed' | 'override' | 'rejected';
  status: string;
  lines_applied: number;
  purchases_written: number;
  /** Post-commit updateMaterialPrice targets. The caller MUST run these. */
  materials_touched: string[];
  po_total_restamped: boolean;
  /** This apply cleared the last hold on a requisition-backed PO and ran the
   *  fulfil/party-consumption cascade. False on every other apply. */
  requisition_cascaded: boolean;
}

/**
 * SIGN OFF (or OVERRIDE) A HELD GRN AND APPLY ITS STOCK — EXACTLY ONCE.
 *
 * This is the only place the deferred writes happen, for both the sign-off and
 * the override, and for both receiving routes. It replays, from the stored rows,
 * precisely the four writes the receiving routes skipped:
 *   1. one `purchases` row per accepted line (grn_id bound)
 *   2. raw_materials.current_stock += accepted x packFactor, plus
 *      last_purchase_price / last_purchase_date
 *   3. one inventory_transactions row of type 'purchase' per cost row
 *   4. updateMaterialPrice per touched material — POST-COMMIT, by the caller
 *
 * ── APPLIED EXACTLY ONCE ───────────────────────────────────────────────────
 * The first statement of the transaction is a CONDITIONAL UPDATE that both
 * claims the row and proves it was claimable:
 *
 *     WHERE id = ? AND status = 'awaiting_qc' AND qc_applied_at IS NULL
 *
 * changes === 0 throws, which rolls back before one unit of stock has moved.
 * That single line delivers four separate guarantees:
 *   · a double-click / retry / double-submit matches nothing the second time;
 *   · two tabs racing: better-sqlite3 transactions are synchronous and this is
 *     a WRITE, so it takes SQLite's write lock — the loser sees the winner's
 *     committed status and throws (the pattern receive/route.ts:1011 uses);
 *   · A VOIDED GRN CAN NEVER BE QC-SIGNED. DELETE /api/grn/[id] sets
 *     status = 'void', which is not 'awaiting_qc', so the claim cannot match;
 *   · AND QC CAN NEVER UN-VOID ONE, because this route never writes 'void' →
 *     anything, it only ever writes 'awaiting_qc' → received/partial/rejected.
 *
 * ── THREE GUARDS THAT MUST BE RE-RUN, BECAUSE TIME HAS PASSED ──────────────
 * They were all evaluated at inward against the world as it was then:
 *   · CENTRAL-STORE CUTOVER — re-checked, BUT ONLY WHEN SOMETHING WOULD BE
 *     CREDITED. A cutover SETS current_stock to a physical count. If one was
 *     committed on or after this GRN's date, the goods were on the shelf when
 *     the shelf was counted, so the count already absorbed them and applying now
 *     would credit the same crate twice. The void path refuses for the
 *     mirror-image reason (grn/[id]/route.ts:584).
 *     A FULL REJECTION IS EXEMPT, and that exemption is load-bearing rather than
 *     a nicety: it credits nothing, so the double-count cannot arise — and
 *     without it a held receipt caught by a cutover set AFTER it was recorded
 *     has NO way out at all. Sign refuses (cutover), override refuses (same
 *     throw), and DELETE /api/grn/[id] refuses a void on the very same date test
 *     (grn/[id]/route.ts:584) — and on a PO-sourced GRN it refuses twice over.
 *     The receipt would sit in the queue for ever while the refusal told the
 *     reader to "reject the lines to clear it", which would itself have thrown.
 *     Rejecting everything is the honest end state for goods a physical count
 *     has already absorbed, and it is now the one door that stays open.
 *   · centralFlowBlock — re-checked. A material can be store-mapped between the
 *     delivery and the sign-off, and crediting central stock for a TGBCL line
 *     is exactly what that guard exists to stop.
 *   · checkPurchaseDate — DELIBERATELY NOT RE-CHECKED. That guard governs which
 *     DATE a receipt may be recorded under, and that decision was made and
 *     validated at inward; the GRN's date does not move here. Re-running it
 *     would fail a Tuesday-morning sign-off of a Monday-evening delivery on a
 *     one-day window — punishing the kitchen for the clock, on the one action
 *     this whole feature is trying to make easy.
 */
export function decideGrnQc(
  db: Database.Database,
  opts: {
    grnId: string;
    actorEmail: string;
    mode: 'sign' | 'override';
    /** sign mode. Lines omitted default to fully accepted. */
    lines?: QcLineDecision[];
    /** sign mode: the three checks the checking department owns. */
    ticks?: { quality?: boolean; temperature?: boolean; damage?: boolean };
    /** override mode: mandatory, >= 5 chars. */
    overrideReason?: string;
  },
): QcDecisionResult {
  const { grnId, actorEmail, mode } = opts;

  const grn = db.prepare(`SELECT * FROM goods_receipt_notes WHERE id = ?`).get(grnId) as any;
  if (!grn) throw new QcRefused(404, 'No such receipt.');
  if (String(grn.status) === 'void') {
    throw new QcRefused(409,
      `${grn.grn_number} was voided${grn.voided_by ? ' by ' + grn.voided_by : ''} and can never be signed off. A voided bill records goods that were un-received; signing it would credit stock for a receipt that no longer exists.`);
  }
  if (String(grn.status) !== QC_AWAITING) {
    throw new QcRefused(409,
      `${grn.grn_number} is not waiting for a quality check (it is "${grn.status}"${grn.qc_applied_at ? `, inwarded on ${grn.qc_applied_at} UTC` : ''}). Nothing was applied a second time.`);
  }

  // ── THE RECEIVER MAY NOT BE THE CHECKER ─────────────────────────────────
  // The premise of this whole feature, in the file header: "A receiver
  // self-certifying their own receipt is not a check." Nothing enforced it —
  // canSignQcFor() returns true for role === 'admin' before any department
  // test, and ALL 29 live GRNs carry received_by = 'admin@local', who IS an
  // admin. So the one person who does every inward could save a held delivery
  // and sign its kitchen check himself three ticks later, producing a row
  // BYTE-IDENTICAL to a real kitchen sign-off and invisible on the override
  // report. That is the owner's original complaint reproduced with more
  // machinery.
  //
  // A HARD BLOCK WITH NO ESCAPE GETS WORKED AROUND (the owner's decision 2), so
  // this is not a dead end: the OVERRIDE is the door, and it is the honest one —
  // it demands a written reason, marks the bill permanently, and puts it on a
  // report somebody reads. Refusing the SIGN and offering the OVERRIDE is
  // exactly the trade the owner already approved for the no-kitchen-available
  // case, which is what "the receiver is the only person here" actually is.
  //
  // Compared case-insensitively on the email, the only identity both rows carry.
  const receiverEmail = String(grn.received_by || '').trim().toLowerCase();
  if (mode === 'sign' && receiverEmail && receiverEmail === String(actorEmail || '').trim().toLowerCase()) {
    throw new QcRefused(403,
      `You recorded ${grn.grn_number} at the receiving bay, so you cannot also be the person who checks it — that is the whole point of holding it. `
      + `Ask ${String(grn.qc_checker || 'kitchen') === 'bar' ? 'bar' : 'kitchen'} staff to sign it off. `
      + `If nobody is available, an admin or head chef can release it with a written reason — that is recorded permanently and appears on the override report.`,
      { self_sign_blocked: true, received_by: grn.received_by });
  }

  const items = db.prepare(`
    SELECT gi.*, rm.name AS material_name, rm.unit AS rm_unit,
           rm.purchase_unit AS rm_purchase_unit, COALESCE(rm.pack_size, 1) AS rm_pack_size
      FROM goods_receipt_note_items gi
      LEFT JOIN raw_materials rm ON rm.id = gi.material_id
     WHERE gi.grn_id = ?
  `).all(grnId) as any[];
  // A HELD GRN WITH NO LINES MUST STILL HAVE A WAY OUT. This used to throw, and
  // the throw was permanent: sign refused, override refused, and only an admin
  // void could clear it — so a non-admin store person could not undo their own
  // mistake, while the row sat in the queue, the bell and the escalation sweep
  // for ever. resolveQcRequirement's caller no longer creates one (skipped
  // lines are excluded from the gate), but a row born before that fix, or by
  // any other route, still has to be closeable. Nothing to credit ⇒ everything
  // below is a no-op and the receipt closes as 'rejected', which is the truth:
  // no goods were ever recorded on it.

  // ── Resolve each line's decision BEFORE the transaction ────────────────────
  const byId = new Map<string, QcLineDecision>();
  for (const l of opts.lines || []) {
    if (l?.grn_item_id) byId.set(String(l.grn_item_id), l);
  }
  const unknown = [...byId.keys()].filter(k => !items.some(i => String(i.id) === k));
  if (unknown.length) {
    throw new QcRefused(400, `${unknown.length} line(s) sent are not on ${grn.grn_number}. Reload the page.`);
  }

  interface Resolved {
    item: any; received: number; accepted: number; rejected: number; reason: string;
    /** A negative (back-correction) line: passed through unjudged. */
    correction?: boolean;
  }
  const resolved: Resolved[] = [];
  for (const it of items) {
    const received = Number(it.quantity_received) || 0;

    // ── A BACK-CORRECTION LINE PASSES THROUGH UNJUDGED ──────────────────────
    // POST /api/grn now refuses to put one on a held bill at all (a correction
    // must apply NOW, which is the whole reason the gate exempts it), so this
    // is the SAFETY NET for a row that already exists — and it closes a receipt
    // that was otherwise stranded for ever.
    //
    // MEASURED, on a copy of the live database: a bill of 40 kg asparagus and a
    // −1 kg sugar correction saved as ONE held GRN, and every exit refused. The
    // negative line's accepted defaults to its received, which is negative, so
    // sign threw "Accepted quantity on Sugar must be zero or more" — and so did
    // OVERRIDE, which reaches this same loop. Neither an admin nor a head chef
    // could clear it; it sat in the queue, the bell and the escalation sweep,
    // and the 40 kg of asparagus stayed off the book with it.
    //
    // There is nothing to judge on a reduction: no goods arrived, so quality,
    // temperature and damage are not questions, and a kitchen cannot "reject"
    // an undo. It is applied verbatim — accepted = received, rejected = 0, no
    // reason required — and any line decision sent for it is ignored rather
    // than obeyed, exactly as an override ignores line decisions.
    if (received < -EPS) {
      resolved.push({ item: it, received, accepted: received, rejected: 0, reason: '', correction: true });
      continue;
    }

    // OVERRIDE ACCEPTS WHAT ARRIVED. The owner's decision 2 is "release it
    // without QC", not "release part of it" — a partial release is a QC
    // judgement, which is precisely what the override says nobody made.
    const d = mode === 'override' ? undefined : byId.get(String(it.id));
    const accepted = (mode === 'override' || d?.accepted == null) ? received : Number(d.accepted);
    if (!Number.isFinite(accepted) || accepted < 0) {
      throw new QcRefused(400, `Accepted quantity on "${it.material_name || it.material_id}" must be zero or more.`);
    }
    if (accepted > received + EPS) {
      throw new QcRefused(400,
        `Accepted (${accepted}) is more than was received (${received}) on "${it.material_name || it.material_id}". You cannot accept goods the delivery note says never arrived.`);
    }
    const rejected = Math.max(0, r2(received - accepted));
    const reason = String(d?.rejection_reason ?? '').trim();
    // ACCOUNTABILITY IS THE POINT. Turning units away without saying why leaves
    // the receiving-variance report unable to tell a vendor quality problem
    // from a counting error, and gives the vendor nothing to answer for. Same
    // 3-character bar and the same shape as the PO deviation gate.
    if (rejected > EPS && reason.length < 3 && mode === 'sign') {
      throw new QcRefused(400,
        `Say why ${rejected} of "${it.material_name || it.material_id}" is being turned away (at least 3 characters) — the reason goes on the receiving-variance report and is what the vendor is answerable to.`);
    }
    resolved.push({ item: it, received, accepted, rejected, reason });
  }

  // POSITIVE lines only. Every question below — "did anything enter stock, so
  // must the three checks be affirmed", "would a cutover double-count this",
  // "is the outcome signed or rejected" — is a question about GOODS ARRIVING. A
  // back-correction credits nothing; letting its negative into this sum could
  // drag a genuine sign-off under zero and report it as a full rejection.
  const totalAccepted = resolved.reduce((s, r) => s + (r.correction ? 0 : r.accepted), 0);
  const corrections = resolved.filter(r => r.correction).length;

  // ── Mode-specific preconditions ────────────────────────────────────────────
  const overrideReason = String(opts.overrideReason ?? '').trim();
  if (mode === 'override') {
    if (overrideReason.length < 5) {
      throw new QcRefused(400,
        'A written reason is required to inward goods without a kitchen check — it is stamped on this bill permanently and appears on the override report.');
    }
  } else {
    // THE TICKS ARE THE SIGNATURE. The owner: "after Kitchen Staff Checks the
    // Quality, Temperature and damage and If they say ok then only the Stock
    // should get inwarded". So a sign-off that puts ANY goods into stock must
    // affirm all three. If a check failed, that is a REJECTION (accepted <
    // received, with the reason) — not a sign-off with a box left blank, which
    // is exactly the "ticked by nobody, means nothing" state the six legacy
    // booleans are in today.
    // A FULL rejection is exempt: you cannot affirm the quality of goods you
    // refused, and requiring it would leave a bad delivery stuck in the queue.
    if (totalAccepted > EPS) {
      const t = opts.ticks || {};
      const missing = [
        !t.quality && 'quality (look / smell / feel)',
        !t.temperature && 'temperature within range',
        !t.damage && 'no visible damage / leak / pest',
      ].filter(Boolean) as string[];
      if (missing.length) {
        throw new QcRefused(400,
          `Confirm every check before these goods enter stock — still unconfirmed: ${missing.join('; ')}. `
          + `If one of them failed, reject the affected quantity with a reason instead of signing.`,
          { missing_checks: missing });
      }
    }
  }

  // ── Guards that must be re-run because time has passed ─────────────────────
  // GATED ON `totalAccepted > EPS` — see the header. A rejection credits
  // nothing, and it is the ONLY door left open on a receipt a cutover has
  // overtaken (sign, override and void all refuse on this same date test), so
  // the refusal below can honestly name it as the remedy.
  const cutover = getCentralStoreCutoverDate(db);
  if (cutover && totalAccepted > EPS && String(grn.date) <= String(cutover)) {
    throw new QcRefused(409,
      `${grn.grn_number} is dated ${grn.date}, on or before the central-store cutover (${cutover}). The cutover re-set on-hand stock to a physical count, and these goods were on the shelf when that count was taken — adding them now would credit the same delivery twice. Reject every line (accepted 0, with a reason) to clear this receipt, and correct the stock with an adjustment if it is genuinely short.`);
  }
  const nowBlocked: string[] = [];
  for (const r of resolved) {
    // ABS, so a back-correction is checked too: debiting central stock for a
    // material that has since moved onto the TGBCL store ledger is the same
    // two-truths-for-one-bottle error as crediting it.
    if (Math.abs(r.accepted) <= EPS) continue;
    if (!r.item.rm_unit && !r.item.material_name) {
      throw new QcRefused(409,
        `The material behind one line of ${grn.grn_number} no longer exists in the master, so its stock cannot be credited. Reject that line, or restore the material.`);
    }
    const msg = centralFlowBlock(db, String(r.item.material_id || ''));
    if (msg) nowBlocked.push(`${r.item.material_name || r.item.material_id}: ${msg}`);
  }
  if (nowBlocked.length) {
    throw new QcRefused(409,
      `${nowBlocked.length} line(s) on ${grn.grn_number} have been moved onto a store ledger since this delivery was recorded, so they can no longer be inwarded into Central stock: ${nowBlocked.join(' | ')}`);
  }

  // ── The outcome ────────────────────────────────────────────────────────────
  // 'rejected' means GOODS WERE TURNED AWAY. A receipt that carried only a
  // back-correction had nothing to turn away, so it signs.
  const outcome: 'signed' | 'override' | 'rejected' =
    mode === 'override' ? 'override'
      : (totalAccepted > EPS || (corrections > 0 && resolved.every(r => r.correction)) ? 'signed' : 'rejected');
  // Header status uses the SAME rule the originating route uses, so a GRN that
  // came through QC is indistinguishable on /grn from one that did not:
  //   ad-hoc  → 'partial' when any line has a rejected quantity
  //   PO      → 'partial' when any line is rejected OR short-received
  // Nothing accepted at all is 'rejected', a status the schema already carries.
  const anyRejected = resolved.some(r => r.rejected > EPS);
  const anyShort = !!grn.po_id
    && resolved.some(r => !r.correction
      && Number(r.item.quantity_received) < Number(r.item.quantity_ordered) - EPS);
  // A receipt that carries ONLY a correction (no goods at all) is not a
  // rejection — nothing was turned away. It is 'received': the movement it
  // describes has been applied in full.
  const nextStatus = totalAccepted <= EPS
    ? (corrections > 0 && !anyRejected ? 'received' : 'rejected')
    : ((anyRejected || anyShort) ? 'partial' : 'received');

  const result: QcDecisionResult = {
    grn_id: grnId,
    grn_number: String(grn.grn_number),
    outcome,
    status: nextStatus,
    lines_applied: 0,
    purchases_written: 0,
    materials_touched: [],
    po_total_restamped: false,
    requisition_cascaded: false,
  };
  const touched = new Set<string>();

  const txn = db.transaction(() => {
    // ── 1. CLAIM FIRST. The write lock, the replay guard and the void
    //       interlock, in one statement. Nothing above this line has written.
    const isKitchenSide = mode === 'sign';
    // ── AN OVERRIDE LEAVES NO CHECK MARKS BEHIND ────────────────────────────
    // The three kitchen ticks and qc_by are now WRITTEN ON BOTH PATHS, not just
    // on the sign path. On an override they are written to 0 / '' — because
    // that is what an override says: nobody judged these goods.
    //
    // They used to be left as stored (`ELSE qc_quality`), and the create route
    // stored whatever the receiving desk had ticked. So a clerk who ticked all
    // three at the bay, on a delivery that was then RELEASED WITHOUT A CHECK,
    // produced a permanent row reading qc_outcome='override' AND
    // qc_quality=1 — and src/app/grn/print/[id]/page.tsx prints those ticks and
    // a "QC verified by" signature line. The paper certified a check the
    // database itself says never happened. /api/grn now also refuses to store
    // them on a held receipt, so this is the second of two locks.
    const clearTicks = mode === 'override';
    const claim = db.prepare(`
      UPDATE goods_receipt_notes
         SET status = ?,
             qc_outcome = ?,
             qc_applied_at = datetime('now'),
             qc_kitchen_by = CASE WHEN ? = 1 THEN ? ELSE qc_kitchen_by END,
             qc_kitchen_at = CASE WHEN ? = 1 THEN datetime('now') ELSE qc_kitchen_at END,
             qc_by         = ?,
             qc_quality     = ?,
             qc_temperature = ?,
             qc_damage      = ?,
             qc_override_by     = CASE WHEN ? = 1 THEN qc_override_by ELSE ? END,
             qc_override_at     = CASE WHEN ? = 1 THEN qc_override_at ELSE datetime('now') END,
             qc_override_reason = CASE WHEN ? = 1 THEN qc_override_reason ELSE ? END
       WHERE id = ? AND status = ? AND qc_applied_at IS NULL
    `).run(
      nextStatus, outcome,
      isKitchenSide ? 1 : 0, actorEmail,
      isKitchenSide ? 1 : 0,
      // qc_by is the LEGACY single signature the print sheet and the detail
      // panel already render. Mirrored from the kitchen signer so both keep
      // showing a name without either surface having to learn a new column —
      // and BLANKED on an override, so the sheet prints "QC by: —".
      clearTicks ? '' : actorEmail,
      clearTicks ? 0 : ((opts.ticks?.quality && totalAccepted > EPS) ? 1 : 0),
      clearTicks ? 0 : ((opts.ticks?.temperature && totalAccepted > EPS) ? 1 : 0),
      clearTicks ? 0 : ((opts.ticks?.damage && totalAccepted > EPS) ? 1 : 0),
      isKitchenSide ? 1 : 0, actorEmail,
      isKitchenSide ? 1 : 0,
      isKitchenSide ? 1 : 0, overrideReason,
      grnId, QC_AWAITING,
    );
    if (claim.changes === 0) {
      throw new QcRefused(409,
        `${grn.grn_number} was already dealt with while this page was open — its stock has not been added a second time. Reload the queue.`);
    }

    const upLine = db.prepare(`
      UPDATE goods_receipt_note_items
         SET quantity_accepted = ?, quantity_rejected = ?, rejection_reason = ?
       WHERE id = ? AND grn_id = ?
    `);
    // ── THE TAX FOLLOWS THE ACCEPTED QUANTITY ────────────────────────────
    // Both receiving routes tax the ACCEPTED value, never the received one —
    // a rejected unit was never accepted, so no input credit is claimable on
    // it. At inward a held line's accepted EQUALS its received (the store may
    // not pre-reject a gated line), so the ₹ recorded then is the ₹ for the
    // whole delivery. A kitchen rejection makes that figure too big, and an
    // over-claimed input credit is the kind of error an auditor finds, not the
    // kind that washes out.
    // Re-derived from gi.gst_rate / gi.cess_rate — the PERCENTS stored on the
    // line for exactly this purpose — with the SAME arithmetic both routes
    // use, to the paisa: taxable = r2(accepted x rate - discount_share),
    // taxPaise = round(taxable x gst%), sgst = floor(tax/2), cgst = tax - sgst
    // (odd paisa to CGST), and cess on the GROSS pre-discount value, never
    // halved and never folded into cgst + sgst. Reverse-engineering the rate
    // out of the stored rupees was the alternative and it is unstable at low
    // values and undefined on a zero taxable.
    // ONLY WHEN SOMETHING WAS ACTUALLY REJECTED. On a full accept the stored
    // figures are already exactly these, and a needless rewrite is a diff on
    // the bill document for no gain — the same "don't re-derive what did not
    // change" rule the net-rate substitution below follows.
    const upLineTax = db.prepare(`
      UPDATE goods_receipt_note_items
         SET cgst = ?, sgst = ?, compensation_cess = ?
       WHERE id = ? AND grn_id = ?
    `);
    // ONE INSERT for both origins. The ad-hoc route omits discount /
    // delivery_charges and lets the column defaults (0) apply, and the PO route
    // binds `discount` to the literal 0 with the reduction already inside
    // unit_price — so binding 0 for discount here is byte-identical to both,
    // and delivery_charges carries the PO path's allocated share (0 on ad-hoc).
    const insPurchase = db.prepare(`
      INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes,
                             bill_no, is_emergency, payment_mode, emergency_reason, outlet_id,
                             discount, delivery_charges, grn_id, created_at)
      VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, 0, '', '', ?, 0, ?, ?, datetime('now'))
    `);
    const bumpStock = db.prepare(`
      UPDATE raw_materials
         SET current_stock = current_stock + ?, last_purchase_price = ?,
             last_purchase_date = ?, updated_at = datetime('now')
       WHERE id = ?
    `);
    const insTx = db.prepare(`
      INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at, outlet_id)
      VALUES (?, ?, 'purchase', ?, ?, ?, datetime('now'), ?)
    `);
    const stampLine = db.prepare(`UPDATE goods_receipt_note_items SET qc_applied_at = datetime('now') WHERE id = ?`);

    const poNumber = grn.po_id
      ? String((db.prepare(`SELECT po_number FROM purchase_orders WHERE id = ?`).get(grn.po_id) as any)?.po_number || '')
      : '';

    for (const r of resolved) {
      upLine.run(r.accepted, r.rejected, r.reason, r.item.id, grnId);

      const gross = Number(r.item.unit_price) || 0;
      const discShare = Number(r.item.discount) || 0;
      const delivShare = Number(r.item.delivery_charges) || 0;

      // Tax re-derivation — see upLineTax above. Runs on rejected lines too,
      // INCLUDING a fully-rejected one (accepted 0 ⇒ ₹0 tax), which is why it
      // sits before the `accepted <= EPS` continue.
      const gstRate  = Number(r.item.gst_rate) || 0;
      const cessRate = Number(r.item.cess_rate) || 0;
      // ── THE MANUAL-TAX LINE, WHICH THE RATE PATH CANNOT SEE ──────────────
      // `gst_rate: ''` is a live option on the ad-hoc form — "Manual (type the ₹
      // yourself)" — and /api/grn then stores the typed rupees with gst_rate 0
      // (grn/route.ts). On such a line the percent re-derivation below never
      // fires, so a rejection of 40 of 100 left the FULL ₹ tax standing against
      // 60% of the goods: exactly the over-claimed input credit the block exists
      // to prevent, on the one line shape it could not read.
      // There is no rate to recompute from, so the only honest operation is to
      // scale the recorded rupees by the same ratio the goods moved by. Guarded
      // on received > 0 (a zero-received line has no ratio) and applied only
      // when something was actually typed.
      const manualCgst = Number(r.item.cgst) || 0;
      const manualSgst = Number(r.item.sgst) || 0;
      const manualCess = Number(r.item.compensation_cess) || 0;
      const hasManualTax = (manualCgst + manualSgst + manualCess) > 0;
      if (r.rejected > EPS && gstRate <= 0 && cessRate <= 0 && hasManualTax && r.received > EPS) {
        const ratio = Math.max(0, Math.min(1, r.accepted / r.received));
        upLineTax.run(r2(manualCgst * ratio), r2(manualSgst * ratio), r2(manualCess * ratio), r.item.id, grnId);
      } else if (r.rejected > EPS && (gstRate > 0 || cessRate > 0)) {
        // rate-basis: purchase — quantity_accepted is PURCHASE units and
        // unit_price is Rs/purchase-unit on a GRN line (canon).
        const grossTax  = r2((r.accepted > 0 ? r.accepted : 0) * gross);
        const taxable   = r2(grossTax - discShare);
        const taxPaise  = gstRate > 0 ? Math.max(0, Math.round(taxable * gstRate)) : 0;
        const sgstPaise = Math.floor(taxPaise / 2);
        const cgstPaise = taxPaise - sgstPaise;   // odd paisa lands in CGST
        const cessPaise = cessRate > 0 ? Math.max(0, Math.round(grossTax * cessRate)) : 0;
        upLineTax.run(cgstPaise / 100, sgstPaise / 100, cessPaise / 100, r.item.id, grnId);
      }

      // ABS: a back-correction has a NEGATIVE accepted and must still be
      // applied — it is the reversal of an earlier over-booking, and skipping it
      // here would leave that overstatement on the book for ever while the
      // receipt closed as if everything had been dealt with. Only a genuinely
      // zero line is skipped.
      if (Math.abs(r.accepted) <= EPS) continue;
      // rate-basis: purchase — quantity_accepted is PURCHASE units and
      // unit_price is Rs/purchase-unit on a GRN line (canon), so the product is
      // this line's goods value in rupees.
      const grossTotal = r2(r.accepted * gross);

      // ── THE NET RATE, and why it is re-derived rather than stored ──────────
      // On the PO path purchases.unit_price is NET of the bill discount, because
      // updateMaterialPrice averages ONLY SUM(qty x unit_price)/SUM(qty) and the
      // owner's ruling is that a discount must reduce cost. The receive route
      // computes that net rate before its transaction, from an allocation that
      // no longer exists by sign-off time — but the ALLOCATED SHARE does: it is
      // stored on this GRN line as gi.discount, which is the bill document.
      // Substituted ONLY when a share was actually allocated, mirroring
      // receive/route.ts:1259 — with no discount the re-derivation can differ
      // from the typed rate in the third decimal, and a receive with no bill
      // charges must write exactly the row it always wrote.
      //
      // A QC REJECTION DOES NOT RE-CUT THE VENDOR'S DISCOUNT. The share stays as
      // recorded on the line (it is what the bill says), so a part-accepted line
      // carries the whole of its share against a smaller quantity. Where that
      // would push the rate to or below zero the GROSS rate is used instead:
      // a zero or negative unit_price cascades a "free" ingredient through
      // average_price into every recipe, which is the one outcome worse than
      // over-stating the cost by a few rupees.
      // `r.accepted > 0` guards the division as well as the intent: on a
      // back-correction the quotient would flip sign and hand updateMaterialPrice
      // a negative unit_price, which is the "free ingredient cascaded into every
      // recipe" outcome this block exists to avoid. A correction books at the
      // gross rate, exactly as the ungated path books it.
      const canNet = discShare > 0 && r.accepted > EPS;
      const netCandidate = canNet ? r2((grossTotal - discShare) / r.accepted) : gross;
      const netPrice = (canNet && netCandidate > 0) ? netCandidate : gross;
      const netTotal = (canNet && netCandidate > 0) ? r2(grossTotal - discShare) : grossTotal;

      const purchaseId = generateId();
      insPurchase.run(
        purchaseId, r.item.material_id,
        // Stored at inward: the PO path books each line against its OWN line
        // vendor, which on a mixed PO is not the GRN header vendor.
        String(r.item.cost_vendor || grn.vendor || ''),
        r.accepted, netPrice, netTotal, grn.date,
        // Stored at inward too: purchase-log.ts parses this sentence with an
        // anchored regex, so it must be the exact string the receiving route
        // would have written. Never re-composed here.
        String(r.item.cost_note || ''),
        String(grn.invoice_number || '').trim(),
        grn.outlet_id, delivShare, grnId,
      );
      // ── Unit-basis boundary (CORE CONVENTION) ────────────────────────────
      // GRN quantities are PURCHASE units; current_stock and
      // inventory_transactions are RECIPE units. packFactor() applies the
      // pack multiplier under exactly the both-halves guard the two receiving
      // routes apply inline (pack_size > 1 AND recipe unit <> purchase unit).
      const stockQty = r.accepted * packFactor({
        pack_size: r.item.rm_pack_size, unit: r.item.rm_unit, purchase_unit: r.item.rm_purchase_unit,
      } as any);
      // last_purchase_price keeps the GROSS rate on BOTH paths — it is the
      // vendor's list rate and it seeds the next PO's rate; seeding it net
      // would ratchet the ordered rate down every cycle (receive/route.ts:1370).
      bumpStock.run(stockQty, gross, grn.date, r.item.material_id);
      insTx.run(
        generateId(), r.item.material_id, stockQty, purchaseId,
        poNumber ? `PO ${poNumber} received via GRN ${grn.grn_number}` : `Ad-hoc GRN ${grn.grn_number}`,
        grn.outlet_id,
      );
      stampLine.run(r.item.id);
      touched.add(String(r.item.material_id));
      result.lines_applied++;
      result.purchases_written++;
    }

    // ── purchase_orders.total_cost — kept true after a QC rejection ──────────
    // The receive route stamps total_cost at completion from the quantities the
    // RECEIVER declared. Under deferral those are 0 until sign-off, so on a
    // closed PO the column is wrong in both directions until every one of its
    // GRNs has been through here: too low while a sibling GRN still waits, too
    // high once this one rejects part of a line. Re-derived from the stored GRN
    // rows on every apply, which self-heals — the last GRN to clear lands the
    // right figure.
    // ONLY on a PO that is already 'received'. While it is still 'approved' this
    // column means WHAT WAS ORDERED (recalcTotal is its only other writer) and
    // every reader assumes exactly that — see receive/route.ts:1444.
    if (grn.po_id) {
      const po = db.prepare(`SELECT id, status, requisition_id, outlet_id FROM purchase_orders WHERE id = ?`)
        .get(grn.po_id) as any;
      if (po && String(po.status) === 'received') {
        const net = Number((db.prepare(`
          SELECT COALESCE(SUM(ROUND(gi.quantity_accepted * gi.unit_price, 2) - gi.discount), 0) AS net
            FROM goods_receipt_note_items gi
            JOIN goods_receipt_notes g ON g.id = gi.grn_id
           WHERE g.po_id = ? AND g.status <> 'void'
        `).get(grn.po_id) as any)?.net) || 0;
        db.prepare(`UPDATE purchase_orders SET total_cost = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(r2(net), grn.po_id);
        result.po_total_restamped = true;

        // ── THE REQUISITION CASCADE, WHEN THE LAST HOLD CLEARS ─────────────
        // receive/route.ts fires this when a PO COMPLETES with no held GRN. The
        // other order — the PO completes while a delivery is still waiting — has
        // to fire here, or a party requisition raised against a perishable PO
        // would never fulfil and its consumption would never be booked.
        // The claim at the top of this transaction has already flipped THIS GRN
        // out of 'awaiting_qc', so this count is the SIBLINGS still waiting.
        // Fires only at zero: the party branch deducts stock for the whole
        // event, and doing that while another delivery sits un-inwarded would
        // consume goods that were never added.
        // Safe if it somehow runs twice — see the two replay guards documented
        // in src/lib/po-requisition-fulfil.ts. `actorEmail` is the QC SIGNER
        // here, which is the truth about who released the goods.
        if (po.requisition_id) {
          const stillHeld = Number((db.prepare(
            `SELECT COUNT(*) AS n FROM goods_receipt_notes WHERE po_id = ? AND status = ?`,
          ).get(grn.po_id, QC_AWAITING) as any)?.n || 0);
          if (stillHeld === 0) {
            fulfilRequisitionFromPo(db, {
              requisitionId: String(po.requisition_id),
              poOutletId: po.outlet_id ?? null,
              actorEmail,
            });
            result.requisition_cascaded = true;
          }
        }
      }
    }

    // The trail. logAuditEvent is best-effort by design and that is right here:
    // unlike grn.void — where the audit row is the ONLY copy of cost rows about
    // to be deleted — nothing is destroyed by an apply, and the permanent record
    // the owner asked for (qc_outcome / qc_override_by / qc_override_reason) is
    // a COMMITTED COLUMN on the row above, written in this same transaction. The
    // override report reads that column, not this event.
    logAuditEvent(db, {
      event_type: mode === 'override' ? 'grn.qc.override'
        : (outcome === 'rejected' ? 'grn.qc.reject' : 'grn.qc.sign'),
      entity_type: 'goods_receipt_note',
      entity_id: grnId,
      actor_email: actorEmail,
      outlet_id: grn.outlet_id ?? null,
      before: { status: QC_AWAITING, qc_checker: grn.qc_checker, qc_categories: grn.qc_required ? 1 : 0 },
      after: {
        status: nextStatus, qc_outcome: outcome,
        lines: resolved.map(r => ({
          material_id: r.item.material_id, material: r.item.material_name,
          received: r.received, accepted: r.accepted, rejected: r.rejected, reason: r.reason,
        })),
        override_reason: mode === 'override' ? overrideReason : undefined,
      },
      note: mode === 'override'
        ? `INWARDED WITHOUT KITCHEN QC — ${grn.grn_number} released by ${actorEmail}: ${overrideReason}`
        : `${grn.grn_number} quality check ${outcome} by ${actorEmail}`
          + (anyRejected ? ` — ${resolved.filter(r => r.rejected > EPS).length} line(s) part-rejected` : ''),
    });
  });
  txn();

  result.materials_touched = [...touched];
  return result;
}

/** Run the weighted-average + recipe re-cost cascade a decision left pending.
 *  MUST be called AFTER the transaction commits — updateMaterialPrice does its
 *  own writes and cascades through every sub-recipe and recipe. A failure here
 *  must NOT surface as an error on an apply that has already committed, which is
 *  the rule DELETE /api/grn/[id] documents for the same call. */
export function runQcPriceCascade(db: Database.Database, materialIds: string[]): string[] {
  const failed: string[] = [];
  for (const mid of materialIds) {
    try { updateMaterialPrice(db, mid); }
    catch (e) { failed.push(mid); console.error('[grn-qc] updateMaterialPrice failed for', mid, e); }
  }
  return failed;
}
