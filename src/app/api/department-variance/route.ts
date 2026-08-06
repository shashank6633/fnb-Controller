import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { cutoverAt, deptKey, deptOnHandBulk, type DeptOnHandResult } from '@/lib/dept-ledger';
import { resolveDeptSet } from '@/lib/dept-stock';
import { isStoreMappedMaterial } from '@/lib/store-engine';

/**
 * DEPARTMENT variance — what a kitchen was given, what its recipes say it used,
 * and what it actually has on the shelf.
 *
 * This is the other half of the report pair. /api/variance-report answers "of
 * everything the CENTRAL STORE took in, how much is still on the central
 * shelf?" — goods issued to a department have LEFT that store. THIS route picks
 * the grams up on the other side of the handover and follows them to the pan.
 *
 * ── THE ONE SENTENCE THAT DEFINES THE PAGE ─────────────────────────────────
 * A number appears in the Difference column ONLY when the report can be held to
 * it. Everywhere else it prints a dash and a plain-English state, because the
 * alternative — "issued minus consumed = loss" on every row — would accuse the
 * building of losing 89% of its stock on day one, and the cause would be a DATA
 * gap, not a theft.
 *
 * MEASURED, TODAY, ON THIS DATABASE (re-measure before you argue with it):
 *   · 700 materials have ever been issued to a department on the qualifying
 *     rail (non-party, quantity_issued > 0, not rejected, requisition not
 *     cancelled / chef-rejected). 701 counting every requisition line ever.
 *   · 75 of them appear in ANY recipe attached to a LIVE menu item.
 *   · 4 of 19 departments have a mapped station carrying a recipe at all
 *     (Continental, Pan Asian, Indian, Tandoori).
 *   · Akan Main Kitchen — 4,335 issued lines, the single busiest receiver in
 *     the building — has NO station pointing at it. Every one of its rows must
 *     therefore read `station_unmapped`, NOT a loss figure. That is the
 *     acceptance test for this file.
 * Those counts ride in `coverage` on every response so a UI physically cannot
 * render the table without the caveat beside it.
 *
 * ── FOUR RULES A FUTURE ENGINEER WILL WANT TO "SIMPLIFY". DO NOT ───────────
 *  1. THE UNMAPPED-STATION SKIP. A department nothing maps to gets `difference:
 *     null, difference_state: 'station_unmapped'`. There is no fallback to a
 *     parent department, no "probably the main kitchen", and above all no
 *     issued-minus-consumed figure "just so the column isn't empty". Recipe
 *     consumption never debited that department (applyDeduct recorded a
 *     consumption_skip instead), so its ledger holds issues and no usage:
 *     subtracting them would print the department's entire intake as loss.
 *  2. THE NEGATIVE / MISSING BALANCE IS REPORTED, NEVER FLOORED. `null` means
 *     "not counted yet" and must stay null — not 0, which reads as an empty
 *     shelf. A negative balance means the ledger says more left than arrived;
 *     that is a real signal (a missed issue, a mis-sized recipe) and clamping
 *     it at zero deletes the only evidence of it.
 *  3. THE LIQUOR CARVE-OUT. Store-mapped materials (TGBCL / store_stock_ledger)
 *     are dropped from the row set entirely, exactly as they are skipped by the
 *     central debit at issue and by applyDeduct at consumption. They never
 *     entered the department raw-material rail, so a department "variance" on a
 *     bottle would be a variance against a holding that does not exist. The
 *     payload says so in `excludes` rather than leaving the omission silent.
 *  4. THE DIFFERENCE IS MEASURED AGAINST THE COUNT'S OWN BASELINE, not against
 *     today's balance. See THE DIFFERENCE below — `balance − last_count` is not
 *     a variance, it is just the movement that happened after the count.
 *
 * ── THE WINDOW ─────────────────────────────────────────────────────────────
 * Everything here starts at settings.dept_ledger_cutover_at. No cutover
 * stamped → 400, because with no opening balances every column would be a
 * movement total masquerading as a position. Pre-cutover requisition history is
 * NOT backfilled (decision D) and is NOT summed into anything; it is reported
 * once, as a labelled count, in `coverage.pre_cutover_excluded_lines`, so the
 * 14k historic lines do not silently vanish from the owner's mental model.
 *
 * ── THE BALANCE COMES FROM dept-ledger, NOT FROM HERE ──────────────────────
 * `ledger_balance` is deptOnHandBulk()'s onHand verbatim — the ONE definition
 * of a department balance in the codebase. This route deliberately does not
 * re-derive it, however tempting it looks sitting next to a bucket scan that
 * already has every row in hand: two derivations of one number is how a kitchen
 * ends up holding 4,000 g on one screen and −1,000 g on another.
 *
 * The bucket columns (issued in / consumption / wastage / …) are a MOVEMENT
 * BREAKDOWN over the cutover window, which is a different window from the
 * balance's whenever a recount has re-based the material. That is not a bug and
 * must not be "fixed" by re-anchoring the buckets: the owner asked for both
 * "what moved since we started" and "what is there now". Each row therefore
 * carries `recount_rebased` and `reconciles` so a screen can say which it is
 * looking at instead of quietly presenting numbers that do not add up.
 *
 * ── THE DIFFERENCE ─────────────────────────────────────────────────────────
 *   expected_at_count = prior_anchor_qty
 *                     + Σ ledger movement in (max(prior_anchor_at, cutover), count_at]
 *   difference        = expected_at_count − counted        (+ = short, − = surplus)
 *
 * prior_anchor is the baseline that was in force BEFORE the count being judged:
 * the newest earlier count AT OR AFTER THE CUTOVER, or the cutover opening row,
 * whichever is later. Not the count itself — a count cannot be its own baseline,
 * and using today's balance (which anchors ON that count) would make every
 * difference equal the movement recorded after it. A count taken BEFORE the
 * cutover is not eligible either: the window below starts at the cutover, so
 * anchoring on a pre-cutover figure would quietly re-import the un-backfilled
 * history the whole design excludes. When no eligible baseline exists the row
 * reports `no_opening` and no number: a first-ever count establishes a baseline,
 * it does not test one.
 *
 * Populated ONLY when a physical count exists AND the material is
 * recipe-reachable from a station mapped to that department — recipe-reachable
 * meaning it is an ingredient (or sub-recipe ingredient, `is_default = 1`, the
 * same filter applyDeduct uses) of a recipe on a LIVE menu item at one of those
 * stations. If nothing on the menu can consume it there, "unexplained" would
 * mean "we never told the system what this is for".
 *
 * THE WORDS loss, shrinkage, theft AND pilferage DO NOT APPEAR IN THIS PAYLOAD,
 * on purpose, and should not appear on the page either. The column is a
 * difference until the recipe coverage is good enough to call it anything else.
 *
 * ── GATE ───────────────────────────────────────────────────────────────────
 * isManagement (admin | manager | head of department), matching the other
 * variance surfaces. Note isManagement ⊂ canSeeAllDeptStock, so no second
 * per-department scope check is needed: everyone who gets past the gate is
 * already entitled to every department.
 *
 * NOT OUTLET-FILTERED, deliberately. deptOnHandBulk does not filter by outlet,
 * and a report that filtered its counts differently from the balance it prints
 * would be a second truth in the same table. Departments carry no outlet_id.
 *
 * Query params:
 *   department_id  — one id or a CSV list. A MAIN department expands to its
 *                    sub-departments, each reported on its OWN anchor (never
 *                    re-anchored across the set). Omitted = every department
 *                    with ledger movement or a count.
 *   category       — raw_materials.category filter.
 *   material_id    — drill down to one material.
 *   state          — return only rows in this difference_state.
 */

/** Stations left unmapped ON PURPOSE by the one-shot seed (src/lib/db.ts). They
 *  are still listed in `coverage.unmapped_stations` — an owner must see the
 *  whole gap — but flagged `deliberate` so "map these" advice does not point at
 *  two stations that must never be mapped:
 *    liquor  — TGBCL store rail, not a department (rule 3 above).
 *    kitchen — kot-fire.ts's blank-station sentinel AND a real department name.
 *              Mapping it debits the busiest kitchen for every station-less
 *              item in the building. */
const DELIBERATELY_UNMAPPED = new Set(['liquor', 'kitchen']);

/** 4dp on quantities, 2dp on rupees — the house rounding, same as dept-stock. */
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/* ────────────────────────────────────────────────────────────────────────────
 * THE SHARED TIME BASIS.
 *
 * These three are BYTE-FOR-BYTE COPIES of dept-ledger.ts (normTs / istDayEndUtc
 * / countAnchorAt), which are module-private there. They are duplicated here
 * only because the difference needs a count's anchor time — and dept-ledger
 * hands back the LATEST anchor, never a prior one. If you change the rule in
 * one file you MUST change it in all three (dept-ledger.ts, dept-stock.ts,
 * here) in the same commit, or a count silently moves half a day and takes a
 * night's movements with it. See "handoffs": exporting them is the real fix.
 * ──────────────────────────────────────────────────────────────────────────*/

/** 'YYYY-MM-DD HH:MM:SS'. A bare date means the START of that day. '' for junk.
 *  Ledger stamps are UTC; comparing a raw ISO 'T' stamp against a raw ledger
 *  stamp is the trap — 'T' (0x54) > ' ' (0x20) shifts a whole day. */
function normTs(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 00:00:00`;
  return s.slice(0, 19).replace('T', ' ');
}

/** End of an IST business day in the ledger's UTC basis. 23:59:59 IST =
 *  18:29:59 UTC the SAME calendar day, so no date rollover. */
function istDayEndUtc(date: string): string {
  return `${String(date || '').slice(0, 10)} 18:29:59`;
}

/** A count covers the shelf up to the EARLIER of its business day-end and the
 *  moment it was saved. MIN, not MAX — both directions of getting this wrong
 *  lose real movement (a 3pm count must not swallow the 5pm issue after it; a
 *  count for the 1st typed on the 5th must not swallow four days). */
function countAnchorAt(date: string, createdAt: string): string {
  const dayEnd = istDayEndUtc(date);
  const saved = normTs(createdAt);
  return saved && saved < dayEnd ? saved : dayEnd;
}

/** A baseline a difference can be measured from. */
interface Baseline {
  qty: number;
  at: string;
  source: 'count' | 'opening';
  /** Ledger rowid — only for an 'opening', to exclude the anchor row itself
   *  from its own window without relying on timestamp resolution. */
  rowid: number | null;
}

interface LedgerRow { at: string; rid: number; q: number; type: string }
interface CountRow { qty: number; at: string; date: string }

/** Movement buckets over the cutover window. Out-legs are reported as POSITIVE
 *  magnitudes (a screen column headed "Consumed" showing −4,000 reads as a
 *  credit); `net` keeps the signed arithmetic. Every ledger type lands in
 *  exactly one bucket, `other_net` included, so the breakdown always closes
 *  against `net` — an unrecognised type must show up as a number, not vanish. */
interface Buckets {
  issued_in: number;
  consumption: number;
  wastage: number;
  staff_meal: number;
  reversals_out: number;
  adjustments_net: number;
  party_net: number;
  other_net: number;
  net: number;
}
const emptyBuckets = (): Buckets => ({
  issued_in: 0, consumption: 0, wastage: 0, staff_meal: 0,
  reversals_out: 0, adjustments_net: 0, party_net: 0, other_net: 0, net: 0,
});

/** Not exported: a route module's export surface is validated by Next, and a
 *  type that only this file needs has no business widening it. */
type DifferenceState =
  | 'ok'
  | 'no_recipe'
  | 'station_unmapped'
  | 'not_counted'
  /** A count exists but nothing precedes it — a first count sets the baseline,
   *  it cannot be tested against one. Fourth state beyond the three the spec
   *  names; `difference_note` carries the plain English for any UI that only
   *  knows the first three. */
  | 'no_opening';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!isManagement(me)) {
      return Response.json({ error: 'Management only' }, { status: 403 });
    }

    const db = getDb();
    const url = new URL(request.url);
    const deptParam = (url.searchParams.get('department_id') || '').trim();
    const categoryFilter = (url.searchParams.get('category') || '').trim();
    const materialFilter = (url.searchParams.get('material_id') || '').trim();
    const stateFilter = (url.searchParams.get('state') || '').trim();

    // ── THE CUTOVER GATE ──────────────────────────────────────────────────
    // Every column on this page is defined relative to the opening balances.
    // Answering before they exist would print movement totals in positions
    // labelled "balance" and differences against a baseline of nothing.
    const floor = cutoverAt(db);
    if (!floor) {
      return Response.json({
        error: 'Department opening balances have not been recorded yet',
        detail:
          'Department variance is measured from the cutover count. Take a complete '
          + 'department closing count and record the opening balances '
          + '(Settings → Department Ledger → Cutover) before running this report.',
        cutover_at: null,
      }, { status: 400 });
    }
    // The cutover's calendar day. Declared HERE, not beside the coverage block
    // where it is also used, because the row loop needs it for the
    // pre-cutover-baseline message. One derivation, one value.
    const cutoverDate = floor.slice(0, 10);

    // ── WHICH DEPARTMENTS ─────────────────────────────────────────────────
    // A MAIN department expands to its sub-departments, but every row still
    // reports its OWN department id and its OWN anchor. Rolling several
    // sub-departments into one line would collapse their separate counts into a
    // single base — the mistake computeDeptStock takes care to avoid.
    const requested = deptParam ? deptParam.split(',').map(s => s.trim()).filter(Boolean) : [];
    let deptIds: string[];
    if (requested.length > 0) {
      const set = new Set<string>();
      for (const id of requested) for (const d of resolveDeptSet(db, id)) set.add(d);
      deptIds = [...set];
      if (deptIds.length === 0) {
        return Response.json({ error: 'Unknown department' }, { status: 404 });
      }
    } else {
      // Every department that has ledger movement or a dept-scoped count. A
      // department with neither has nothing to say yet and listing it as a page
      // of blanks buries the ones that do.
      deptIds = (db.prepare(`
        SELECT DISTINCT department_id AS id FROM department_material_transactions
         WHERE department_id IS NOT NULL AND department_id <> ''
        UNION
        SELECT DISTINCT department_id AS id FROM closing_stock
         WHERE department_id IS NOT NULL AND department_id <> ''
      `).all() as any[]).map(r => String(r.id));
    }

    const deptJson = JSON.stringify(deptIds);
    const deptNames = new Map<string, string>();
    if (deptIds.length > 0) {
      for (const d of db.prepare(`
        SELECT id, name FROM departments WHERE id IN (SELECT value FROM json_each(?))
      `).all(deptJson) as any[]) deptNames.set(String(d.id), String(d.name || ''));
    }

    // ── THE STATION → DEPARTMENT MAP ──────────────────────────────────────
    // Read straight from the owner-editable table, with the SAME qualifiers
    // resolveStationDepartment applies: an active row, a non-null department,
    // and a department that still exists. A dangling or switched-off mapping is
    // not a mapping — treating it as one is how a remap starts silently
    // attributing consumption to a department that was deleted.
    //
    // FAILS CLOSED. If station_departments is missing (migration not yet run)
    // every department reads as unmapped and every difference reads as
    // 'station_unmapped'. That is the honest answer: nothing can be attributed
    // to a kitchen the system cannot name.
    const stationsByDept = new Map<string, string[]>();
    const mappingRows: Array<{ station: string; department_id: string | null; is_active: number; dept_exists: number; note: string }> = [];
    let mappingTableReadable = true;
    try {
      const rows = db.prepare(`
        SELECT lower(trim(sd.station)) AS station,
               sd.department_id,
               COALESCE(sd.is_active, 1) AS is_active,
               (SELECT COUNT(*) FROM departments d WHERE d.id = sd.department_id) AS dept_exists,
               COALESCE(sd.note, '') AS note
          FROM station_departments sd
      `).all() as any[];
      for (const r of rows) {
        mappingRows.push({
          station: String(r.station || ''),
          department_id: r.department_id ? String(r.department_id) : null,
          is_active: Number(r.is_active) || 0,
          dept_exists: Number(r.dept_exists) || 0,
          note: String(r.note || ''),
        });
      }
    } catch {
      mappingTableReadable = false;
    }
    for (const m of mappingRows) {
      if (!m.department_id || !m.is_active || !m.dept_exists) continue;
      const list = stationsByDept.get(m.department_id) || [];
      list.push(m.station);
      stationsByDept.set(m.department_id, list);
    }

    // ── RECIPE REACHABILITY, per (department, material) ───────────────────
    // "Could a sale at a station mapped to this department ever consume this
    // material?" Mirrors applyDeduct exactly: live menu item, linked recipe,
    // is_default = 1 ingredients, sub-recipe ingredients included. If the two
    // ever diverge, this report will either hide a real difference or invent a
    // column for a material nothing can consume.
    const reachable = new Map<string, Set<string>>();
    const recipeMaterialsByStation = new Map<string, Set<string>>();
    for (const r of db.prepare(`
      SELECT DISTINCT lower(trim(mi.station)) AS station, ing.material_id AS material_id
        FROM menu_items mi
        JOIN (
              SELECT recipe_id, material_id FROM recipe_ingredients WHERE is_default = 1
              UNION
              SELECT rsr.recipe_id, sri.material_id
                FROM recipe_sub_recipes rsr
                JOIN sub_recipe_ingredients sri ON sri.sub_recipe_id = rsr.sub_recipe_id
               WHERE sri.is_default = 1
             ) ing ON ing.recipe_id = mi.recipe_id
       WHERE mi.is_active = 1 AND mi.recipe_id IS NOT NULL AND mi.recipe_id <> ''
    `).all() as any[]) {
      const st = String(r.station || '');
      const set = recipeMaterialsByStation.get(st) || new Set<string>();
      set.add(String(r.material_id));
      recipeMaterialsByStation.set(st, set);
    }
    for (const [deptId, stations] of stationsByDept) {
      const set = reachable.get(deptId) || new Set<string>();
      for (const st of stations) {
        const mats = recipeMaterialsByStation.get(st);
        if (mats) for (const m of mats) set.add(m);
      }
      reachable.set(deptId, set);
    }

    // ── THE LEDGER, ONE SCAN ──────────────────────────────────────────────
    // Buckets and expected_at_count are both derived from this. The BALANCE is
    // not — that comes from deptOnHandBulk below, which owns the definition.
    const ledgerByPair = new Map<string, LedgerRow[]>();
    const openingByPair = new Map<string, Baseline>();
    if (deptIds.length > 0) {
      for (const r of db.prepare(`
        SELECT rowid AS rid, department_id, material_id, quantity, type,
               REPLACE(SUBSTR(created_at, 1, 19), 'T', ' ') AS at
          FROM department_material_transactions
         WHERE department_id IN (SELECT value FROM json_each(?))
      `).all(deptJson) as any[]) {
        const k = deptKey(String(r.department_id), String(r.material_id));
        const row: LedgerRow = {
          at: String(r.at || ''), rid: Number(r.rid) || 0,
          q: Number(r.quantity) || 0, type: String(r.type || ''),
        };
        const list = ledgerByPair.get(k) || [];
        list.push(row);
        ledgerByPair.set(k, list);
        if (row.type === 'opening') {
          // Idempotent by contract, but take the newest defensively rather than
          // trusting that a second cutover run never happened.
          const cur = openingByPair.get(k);
          if (!cur || row.at > cur.at || (row.at === cur.at && row.rid > (cur.rowid ?? -1))) {
            openingByPair.set(k, { qty: row.q, at: row.at, source: 'opening', rowid: row.rid });
          }
        }
      }
    }

    // ── THE COUNTS ────────────────────────────────────────────────────────
    const countsByPair = new Map<string, CountRow[]>();
    if (deptIds.length > 0) {
      for (const c of db.prepare(`
        SELECT department_id, material_id, physical_stock, date, created_at
          FROM closing_stock
         WHERE department_id IN (SELECT value FROM json_each(?))
      `).all(deptJson) as any[]) {
        const k = deptKey(String(c.department_id), String(c.material_id));
        const list = countsByPair.get(k) || [];
        list.push({
          qty: Number(c.physical_stock) || 0,
          at: countAnchorAt(String(c.date || ''), String(c.created_at || '')),
          date: String(c.date || '').slice(0, 10),
        });
        countsByPair.set(k, list);
      }
      for (const list of countsByPair.values()) list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    }

    // ── THE ROW SET ───────────────────────────────────────────────────────
    const pairKeys = new Set<string>([...ledgerByPair.keys(), ...countsByPair.keys()]);

    // Material metadata for everything in play, one query.
    const matIds = [...new Set([...pairKeys].map(k => k.split('|')[1]).filter(Boolean))];
    const matMeta = new Map<string, any>();
    if (matIds.length > 0) {
      for (const m of db.prepare(`
        SELECT id, name, sku, category, unit, purchase_unit, pack_size, average_price
          FROM raw_materials WHERE id IN (SELECT value FROM json_each(?))
      `).all(JSON.stringify(matIds)) as any[]) matMeta.set(String(m.id), m);
    }

    // LIQUOR CARVE-OUT (rule 3). Memoised per CATEGORY — isStoreMappedMaterial
    // resolves an id to its category anyway, so one query per distinct category
    // instead of one per material. A failed check counts as store-mapped: we
    // cannot prove the material belongs on the department rail, and printing a
    // department variance for a bottle is not recoverable by a later count.
    const storeMappedMemo = new Map<string, boolean>();
    const storeMapped = (materialId: string, category: string | null): boolean => {
      const key = String(category ?? '').trim() || materialId;
      const cached = storeMappedMemo.get(key);
      if (cached !== undefined) return cached;
      let v = true;
      try { v = isStoreMappedMaterial(db, key); }
      catch (e) { console.error(`[department-variance] store-mapped check failed for '${key}' — excluding the row`, e); }
      storeMappedMemo.set(key, v);
      return v;
    };

    // ── THE BALANCE — deptOnHandBulk owns it. Do not re-derive. ───────────
    const balances: Map<string, DeptOnHandResult> = deptOnHandBulk(db, deptIds, matIds);

    // Distinct MATERIALS, not (dept, material) pairs. A bottle held by three
    // departments is ONE material excluded; counting pairs would report three
    // and turn a caveat the owner is meant to trust into a number that does not
    // tie to anything he can count. `liquor_rows_excluded` carries the pair
    // count alongside it so neither figure has to be inferred from the other.
    const liquorMaterials = new Set<string>();
    let liquorRowsExcluded = 0;
    const rows: any[] = [];

    for (const k of pairKeys) {
      const sep = k.indexOf('|');
      const departmentId = k.slice(0, sep);
      const materialId = k.slice(sep + 1);
      const meta = matMeta.get(materialId);
      if (!meta) continue;                                   // material deleted — nothing to report against
      if (materialFilter && materialId !== materialFilter) continue;
      if (categoryFilter && String(meta.category || '') !== categoryFilter) continue;
      if (storeMapped(materialId, meta.category)) { liquorMaterials.add(materialId); liquorRowsExcluded++; continue; }

      const ledger = ledgerByPair.get(k) || [];
      const counts = countsByPair.get(k) || [];
      const opening = openingByPair.get(k) || null;

      // Buckets over the cutover window. 'opening' rows are the BASE, never a
      // movement — excluded from every bucket and from `net`.
      const b = emptyBuckets();
      for (const row of ledger) {
        if (row.type === 'opening') continue;
        if (!(row.at > floor)) continue;
        b.net += row.q;
        switch (row.type) {
          case 'issued':         b.issued_in       += row.q;  break;
          case 'consumption':    b.consumption     += -row.q; break;
          case 'wastage':        b.wastage         += -row.q; break;
          case 'staff_meal':     b.staff_meal      += -row.q; break;
          case 'issue_reversal': b.reversals_out   += -row.q; break;
          case 'adjustment':
          case 'adjusted':       b.adjustments_net += row.q;  break;   // 'adjusted' = the legacy spelling, read-only
          case 'received':
          case 'consumed':
          case 'returned':       b.party_net       += row.q;  break;   // party rail, own lifecycle
          default:               b.other_net       += row.q;  break;   // unknown type — visible, never dropped
        }
      }

      const bal = balances.get(k);
      const ledgerBalance = bal ? bal.onHand : null;
      const anchorSource = bal ? bal.anchorSource : 'none';
      const lastCount = counts.length > 0 ? counts[counts.length - 1] : null;

      // Does the movement breakdown explain the balance? It does when the
      // balance still anchors on the opening row; a recount re-bases the
      // balance and the two windows part company. Reported, not hidden — a
      // column set that does not add up with no explanation on the row is how a
      // report loses the owner's trust.
      const recountRebased = anchorSource === 'count';
      const reconciles = ledgerBalance !== null && opening !== null && !recountRebased
        ? Math.abs((opening.qty + b.net) - ledgerBalance) < 1e-6
        : null;

      // ── THE DIFFERENCE ──────────────────────────────────────────────────
      const mappedStations = stationsByDept.get(departmentId) || [];
      const recipeReachable = (reachable.get(departmentId) || new Set<string>()).has(materialId);

      let state: DifferenceState;
      let note: string;
      let difference: number | null = null;
      let expectedAtCount: number | null = null;

      if (mappedStations.length === 0) {
        state = 'station_unmapped';
        note = mappingTableReadable
          ? 'No station is mapped to this department yet, so recipe consumption never reaches it. '
            + 'Map its stations in Settings before reading a difference here.'
          : 'The station-to-department map is unavailable, so no consumption can be attributed.';
      } else if (!recipeReachable) {
        state = 'no_recipe';
        note = 'No live menu item at this department’s stations has a recipe using this material, '
          + 'so the system has no expected usage to compare against.';
      } else if (!lastCount) {
        state = 'not_counted';
        note = 'No physical count has been recorded for this material in this department yet.';
      } else {
        // prior baseline = the newest thing in force BEFORE the count being
        // judged. A count cannot be its own baseline (rule 4).
        //
        // A PRE-CUTOVER COUNT IS NOT A BASELINE ON THIS RAIL — do not relax the
        // `>= floor` test to "any earlier count", however much it would fill in
        // the Difference column. The movement window below is floored at the
        // cutover (as it must be: the 14k historic issued lines were never
        // backfilled, decision D). Pairing a baseline taken BEFORE that floor
        // with a window that starts AT it silently asserts that the excluded
        // history is accounted for, and prints the gap between the two as a
        // difference against the kitchen. It also makes this route's own
        // `pre_cutover_included_in_any_column: false` a lie. A count from
        // before the cutover is still shown as `last_count`, because it is real
        // and the owner should see it — it just cannot anchor an expectation.
        // The cutover `opening` row is exempt by construction: it IS the floor's
        // baseline, whatever its exact stamp relative to the settings value.
        let prior: Baseline | null = null;
        for (let i = counts.length - 2; i >= 0; i--) {
          if (counts[i].at < lastCount.at && counts[i].at >= floor) {
            prior = { qty: counts[i].qty, at: counts[i].at, source: 'count', rowid: null };
            break;
          }
        }
        if (opening && opening.at <= lastCount.at) {
          // Later wins; on an exact tie the COUNT wins — a recount is the
          // owner's re-basing tool and must override a cutover opening, never
          // the other way round (same rule as dept-ledger's anchor pick).
          if (!prior || opening.at > prior.at) prior = opening;
        }

        if (!prior) {
          state = 'no_opening';
          // Say WHICH of the two reasons it is. "No baseline" sends an owner
          // looking for a count that is sitting right there on the row.
          const hadPreCutoverCount = counts.some(c => c.at < floor);
          note = hadPreCutoverCount
            ? `The only earlier count for this material here predates the cutover (${cutoverDate}), `
              + 'and pre-cutover history is not part of this ledger. Record a cutover opening balance, '
              + 'or take a fresh count — the next count after one of those will produce a difference.'
            : 'This is the first recorded baseline for this material here — there is nothing '
              + 'earlier to measure it against. The next count will produce a difference.';
        } else {
          const windowFrom = prior.at > floor ? prior.at : floor;
          const tieRowid = prior.source === 'opening' && windowFrom === prior.at ? prior.rowid : null;
          let moved = 0;
          for (const row of ledger) {
            if (row.type === 'opening') continue;            // a base, never a movement
            if (row.at > lastCount.at) continue;             // after the count — not its business
            const inWindow = row.at > windowFrom
              || (tieRowid !== null && row.at === windowFrom && row.rid > tieRowid);
            if (!inWindow) continue;
            moved += row.q;
          }
          expectedAtCount = r4(prior.qty + moved);
          // + = counted SHORT of what the ledger expects. - = surplus. No
          // absolute value and no floor: a surplus is as much a signal as a
          // shortfall (an unrecorded issue, an over-sized recipe).
          difference = r4(expectedAtCount - lastCount.qty);
          state = 'ok';
          note = '';
        }
      }

      if (stateFilter && state !== stateFilter) continue;

      const price = Number(meta.average_price) || 0;
      rows.push({
        department_id: departmentId,
        department_name: deptNames.get(departmentId) || '',
        material_id: materialId,
        material_name: String(meta.name || ''),
        material_sku: String(meta.sku || ''),
        category: String(meta.category || ''),
        // RECIPE unit — every quantity below is in it. The purchase unit rides
        // along so a screen can present the owner's preferred basis without
        // re-reading raw_materials.
        unit: String(meta.unit || ''),
        purchase_unit: String(meta.purchase_unit || ''),
        pack_size: Number(meta.pack_size) || 1,
        // ₹ per RECIPE unit. average_price, never last_purchase_price — that
        // column is stored in mixed bases and is up to 5,000x off on 105 rows.
        average_price: price,

        opening: opening ? r4(opening.qty) : null,
        opening_at: opening ? opening.at : null,

        issued_in: r4(b.issued_in),
        consumption: r4(b.consumption),
        wastage: r4(b.wastage),
        staff_meal: r4(b.staff_meal),
        reversals_out: r4(b.reversals_out),
        adjustments_net: r4(b.adjustments_net),
        party_net: r4(b.party_net),
        other_net: r4(b.other_net),
        net_movement_since_cutover: r4(b.net),

        ledger_balance: ledgerBalance,
        balance_value: ledgerBalance === null ? null : r2(ledgerBalance * price),
        anchor_source: anchorSource,
        anchor_qty: bal ? bal.anchorQty : null,
        anchor_at: bal ? bal.anchorAt : null,
        balance_window_from: bal ? bal.windowFrom : floor,
        never_counted: bal ? bal.neverCounted : true,
        recount_rebased: recountRebased,
        reconciles,

        last_count: lastCount ? r4(lastCount.qty) : null,
        last_count_date: lastCount ? lastCount.date : null,
        last_count_at: lastCount ? lastCount.at : null,

        expected_at_count: expectedAtCount,
        difference,
        difference_value: difference === null ? null : r2(difference * price),
        difference_state: state,
        difference_note: note,
        difference_available: state === 'ok',

        recipe_reachable: recipeReachable,
        mapped_stations: mappedStations,
      });
    }

    rows.sort((a, b2) =>
      String(a.department_name).localeCompare(String(b2.department_name))
      || Math.abs(Number(b2.difference_value) || 0) - Math.abs(Number(a.difference_value) || 0)
      || String(a.material_name).localeCompare(String(b2.material_name)));

    // ── COVERAGE — the caveat travels with the data ───────────────────────
    // Every number here is measured on this database at request time, never
    // hardcoded. A UI cannot render the table without it, which is the point:
    // the difference column is only as meaningful as the recipe and mapping
    // coverage underneath it.
    //
    // The two "issued" figures differ by their qualifiers and both are given so
    // the number is reproducible instead of arguable:
    //   materials_issued      the department rail's own rule — non-party,
    //                         quantity_issued > 0, line not rejected,
    //                         requisition not cancelled / chef-rejected (700).
    //   materials_issued_all  every requisition line ever, no qualifiers (701).
    const q = (sql: string, ...p: any[]): number => {
      try { return Number((db.prepare(sql).get(...p) as any)?.n) || 0; } catch { return 0; }
    };
    const ISSUE_QUALIFIERS = `
      JOIN requisitions r ON r.id = ri.req_id
      WHERE r.status NOT IN ('cancelled','chef_rejected')
        AND COALESCE(r.purpose,'internal') <> 'party'
        AND ri.quantity_issued > 0
        AND COALESCE(ri.is_rejected,0) = 0
        AND COALESCE(ri.store_rejected,0) = 0`;

    const materialsIssued = q(`SELECT COUNT(DISTINCT ri.material_id) AS n FROM requisition_items ri ${ISSUE_QUALIFIERS}`);
    const materialsIssuedAll = q('SELECT COUNT(DISTINCT material_id) AS n FROM requisition_items WHERE quantity_issued > 0');
    const materialsWithRecipe = q(`
      SELECT COUNT(*) AS n FROM (
        SELECT DISTINCT ing.material_id
          FROM menu_items mi
          JOIN (
                SELECT recipe_id, material_id FROM recipe_ingredients WHERE is_default = 1
                UNION
                SELECT rsr.recipe_id, sri.material_id
                  FROM recipe_sub_recipes rsr
                  JOIN sub_recipe_ingredients sri ON sri.sub_recipe_id = rsr.sub_recipe_id
                 WHERE sri.is_default = 1
               ) ing ON ing.recipe_id = mi.recipe_id
         WHERE mi.is_active = 1 AND mi.recipe_id IS NOT NULL AND mi.recipe_id <> ''
      )`);
    const departmentsTotal = q('SELECT COUNT(*) AS n FROM departments');
    // Reachable = has an active mapped station that carries at least one live
    // recipe material. A mapping to a station with nothing cookable on it is
    // not consumption coverage.
    let departmentsReachable = 0;
    for (const [, set] of reachable) if (set.size > 0) departmentsReachable++;

    // Pre-cutover requisition history: counted, labelled, and summed into
    // NOTHING (decision D). Bounded by the requisition date against the cutover
    // day, the same bound dept-stock.ts uses for its pre_cutover column.
    const preCutoverLines = q(
      `SELECT COUNT(*) AS n FROM requisition_items ri ${ISSUE_QUALIFIERS} AND DATE(r.date) < ?`,
      cutoverDate,
    );

    // Stations with no usable mapping. Two populations, both real:
    //   · a row in station_departments that is null / inactive / dangling;
    //   · a station live on the menu with no row at all.
    const unmappedDetail: Array<{ station: string; reason: string; note: string; deliberate: boolean; menu_items: number; skipped_since_cutover: number }> = [];
    const menuStationCounts = new Map<string, number>();
    for (const r of db.prepare(`
      SELECT lower(trim(station)) AS station, COUNT(*) AS n
        FROM menu_items WHERE is_active = 1 GROUP BY lower(trim(station))
    `).all() as any[]) menuStationCounts.set(String(r.station || ''), Number(r.n) || 0);

    // What the gap has actually cost in visibility since the cutover. Guarded:
    // consumption_skips arrives with the cutover migration and a report must
    // still answer on a database where it has not landed.
    const skipsByStation = new Map<string, number>();
    let skipsTotal = 0;
    try {
      for (const r of db.prepare(`
        SELECT lower(trim(station)) AS station, COUNT(*) AS n
          FROM consumption_skips WHERE created_at > ? GROUP BY lower(trim(station))
      `).all(floor) as any[]) {
        const n = Number(r.n) || 0;
        skipsByStation.set(String(r.station || ''), n);
        skipsTotal += n;
      }
    } catch { /* table not present yet — report zero skips rather than 500 */ }

    const seen = new Set<string>();
    for (const m of mappingRows) {
      if (m.department_id && m.is_active && m.dept_exists) continue;
      seen.add(m.station);
      unmappedDetail.push({
        station: m.station,
        reason: !m.department_id ? 'unmapped' : (!m.dept_exists ? 'dangling' : 'inactive'),
        note: m.note,
        deliberate: DELIBERATELY_UNMAPPED.has(m.station),
        menu_items: menuStationCounts.get(m.station) || 0,
        skipped_since_cutover: skipsByStation.get(m.station) || 0,
      });
    }
    for (const [station, n] of menuStationCounts) {
      if (!station || seen.has(station)) continue;
      if (mappingRows.some(m => m.station === station)) continue;
      unmappedDetail.push({
        station, reason: mappingTableReadable ? 'no_mapping_row' : 'map_unavailable', note: '',
        deliberate: DELIBERATELY_UNMAPPED.has(station),
        menu_items: n, skipped_since_cutover: skipsByStation.get(station) || 0,
      });
    }
    unmappedDetail.sort((a, b3) => b3.menu_items - a.menu_items || a.station.localeCompare(b3.station));

    const stateCounts: Record<string, number> = {
      ok: 0, no_recipe: 0, station_unmapped: 0, not_counted: 0, no_opening: 0,
    };
    for (const r of rows) stateCounts[r.difference_state] = (stateCounts[r.difference_state] || 0) + 1;

    return Response.json({
      cutover_at: floor,
      filters: {
        department_id: requested.length > 0 ? requested : null,
        departments_resolved: deptIds,
        category: categoryFilter || null,
        material_id: materialFilter || null,
        state: stateFilter || null,
      },
      coverage: {
        cutover_at: floor,
        materials_issued: materialsIssued,
        materials_issued_all: materialsIssuedAll,
        materials_with_recipe: materialsWithRecipe,
        departments_total: departmentsTotal,
        departments_consumption_reachable: departmentsReachable,
        unmapped_stations: unmappedDetail.map(u => u.station),
        unmapped_station_detail: unmappedDetail,
        station_map_available: mappingTableReadable,
        consumption_skips_since_cutover: skipsTotal,
        pre_cutover_excluded_lines: preCutoverLines,
        pre_cutover_included_in_any_column: false,
        liquor_materials_excluded: liquorMaterials.size,
        liquor_rows_excluded: liquorRowsExcluded,
        rows_total: rows.length,
        rows_by_state: stateCounts,
      },
      excludes: {
        liquor:
          'Store-mapped (TGBCL) materials are excluded entirely. They live on the store rail '
          + '(store_stock_ledger) and never enter a department’s raw-material holding, so a '
          + 'department variance against them would measure a holding that does not exist.',
        pre_cutover:
          `Requisition issues before ${cutoverDate} are NOT backfilled and are not part of any `
          + 'column here. Department balances start from the counted opening. '
          + `${preCutoverLines} historic issued line(s) are excluded.`,
        parties:
          'Party fulfilment keeps its own rail; its movements appear only in the party_net column.',
      },
      notes: {
        difference:
          'Difference = expected at the count − counted. Positive means the department counted '
          + 'less than the ledger expects; negative means more. It is populated only where a '
          + 'physical count exists AND a live recipe at a mapped station can consume the material.',
        buckets:
          'The movement columns cover the window since the cutover. ledger_balance is anchored on '
          + 'the latest count when one exists, so on a re-counted row (recount_rebased) the two do '
          + 'not add up — by design.',
      },
      rows,
    });
  } catch (e: any) {
    console.error('[department-variance]', e);
    return Response.json({ error: e?.message || 'Department variance failed' }, { status: 500 });
  }
}
