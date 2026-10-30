import type Database from 'better-sqlite3';
import { lineFactor } from '@/lib/issue-stock';
import { packFactor, shownPurchaseQty, type PackMeta } from '@/lib/pack-units';
import { planCentralDebit, qtyGrid, type ShownAs } from '@/lib/central-debit-clamp';
import { PARTY_TRANSFER_TYPES_SQL } from '@/lib/movement-record';
import { routedColSql } from '@/lib/routed-schema';
import { isStoreMappedMaterial } from '@/lib/store-engine';
// THE WORDS, ONE COPY (round 3): the store desk and the Process window print
// through the same module, so a row's cell, hover, pre-check and this
// sentence never say the same fact two ways.
import {
  promisePU, promiseFig, promiseFigPU, promiseIsAre, promiseHasHave, isAreShown, hasHaveShown,
  noneFreeWords as sharedNoneFreeWords, apportionShown,
} from '@/lib/party-promise-words';

/**
 * PARTY GOODS HANDED OVER BUT STILL ON THE CENTRAL BOOKS (owner ruling #86a,
 * "Show + refuse", 2026-10-28 — the FUEL incident, REQ-2026-1388 / 1389).
 *
 * WHY THIS EXISTS. Issuing a PARTY line records the hand-over and moves no
 * stock: the central store's books drop only when the requisition's whole
 * store part is done, in one transfer (party-fulfillment.ts header;
 * issue-stock.ts checkCentralIssue returns skipReason 'party' for the internal
 * rail, and applyIssueDelta debits nothing for a party line). So between the
 * hand-over and that transfer the goods are physically gone from the shelf but
 * still counted in raw_materials.current_stock — and nothing held them back
 * from the next party: the last FUEL was issued on REQ-1388, then issued again
 * on REQ-1389 off an "In store 1" that already belonged to REQ-1388.
 *
 * THIS MODULE ONLY READS. It is a SEPARATE pre-check: THE RULE
 * (central-debit-clamp.ts), its mirror desk-rule.ts, checkCentralIssue /
 * planCentralDebit and party-fulfillment.ts are untouched. It CALLS
 * planCentralDebit (unchanged) so that "does it fit" is decided by the one
 * rule every floor shares — the shown-figure rule included — never by a second
 * comparison (the rival-helper trap).
 *
 * A CLAIM — what one open party requisition holds that has not left the books:
 *   · requisitions.purpose = 'party' and status chef_approved | mgmt_approved |
 *     store_processed (open — a fulfilled one has moved, a cancelled one never
 *     will; that stranded case is a separate, known owner question);
 *   · requisition_items.quantity_issued > 0, converted LINE → RECIPE with the
 *     floor's own lineFactor (never a second pack conversion);
 *   · minus what that requisition's party transfer rows already moved for the
 *     material (inventory_transactions type party_issue | party_consumption,
 *     reference_id = the requisition id), handed to its lines in the same walk
 *     order the transfer uses (party-fulfillment.ts "A SECOND CALL MOVES ONLY
 *     WHAT HAS NOT MOVED");
 *   · EXCLUDED, because the transfer never takes them off central:
 *       - a Kitchen-routed line (rulings #45/#74, routed_department_id set),
 *       - a store-mapped (liquor) material (store-engine isStoreMappedMaterial —
 *         the same mapping checkCentralIssue reads as skipReason 'store_mapped'),
 *       - a line whose unit cannot be resolved (lineFactor needsReview — the
 *         transfer declines it as 'unit_review'; nobody can convert it, and
 *         guessing is the 750x trap).
 * This is the verified prod_sql of the investigation (wi5h3i0e4.output), in
 * code; it differs only where that SQL already flagged a line "UNIT REVIEW -
 * transfer skips this line" (excluded here, for the reason above).
 *
 * OLDEST FIRST (ruling #80's default for short stock between parties: the
 * oldest keeps its claim). A claim's age is when its line was first handed
 * over — the first `at` in issue_history (an undo blanks it, so a re-issue is a
 * new claim), else issued_at, else the requisition's own stamps.
 *
 * UNITS: RECIPE units carry the decision; every *_purchase figure is the same
 * quantity ÷ packFactor (the owner's purchase-unit-first display rule).
 */

const EPS_GRID = 0; // compare on the 6-dp grid: qtyGrid(x) > 0 means "something".
const r6 = (n: number): number => {
  const v = Math.round((Number(n) || 0) * 1e6) / 1e6;
  return v === 0 ? 0 : v;
};

export interface PartyClaimLine {
  req_id: string;
  req_number: string;
  event_name: string;
  event_date: string;
  department: string;
  req_item_id: string;
  /** Handed over, not yet moved off the central books — RECIPE units. */
  pending_recipe: number;
  /** The same, in the material's PURCHASE unit (÷ packFactor), 6 dp. */
  pending_purchase: number;
  purchase_unit: string;
  /** When this claim began: the line's FIRST hand-over (see OLDEST FIRST). */
  issued_at: string;
  /** The line's latest hand-over (requisition_items.issued_at). */
  last_issued_at: string;
}

export interface PartyClaim {
  /** Sum of `lines` — RECIPE units. */
  pending_recipe: number;
  /** Oldest first. */
  lines: PartyClaimLine[];
}

interface ClaimRow {
  req_id: string; req_number: string; event_name: string; event_date: string;
  req_created_at: string; req_processed_at: string; department: string;
  req_item_id: string; material_id: string; line_unit: string | null;
  quantity_issued: number; issued_at: string | null; issue_history: string | null;
  material_name: string; unit: string | null; purchase_unit: string | null; pack_size: number | null;
}

/** A timestamp as epoch ms, for ordering only. SQLite's datetime('now') has no
 *  zone and a space where ISO has 'T'; both are UTC. Unparseable → NaN. */
function tsMs(s: unknown): number {
  const t = String(s ?? '').trim();
  if (!t) return NaN;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t) ? `${t.replace(' ', 'T')}Z` : t;
  return Date.parse(iso);
}

/** The first hand-over of the line as it stands (issue_history's earliest `at`). */
function claimStart(row: Pick<ClaimRow, 'issue_history' | 'issued_at' | 'req_processed_at' | 'req_created_at'>): string {
  let first = '';
  let firstMs = Infinity;
  try {
    const h = JSON.parse(String(row.issue_history || '[]'));
    if (Array.isArray(h)) {
      for (const e of h) {
        const ms = tsMs(e?.at);
        if (Number.isFinite(ms) && ms < firstMs) { firstMs = ms; first = String(e.at); }
      }
    }
  } catch { /* malformed history — fall through to the columns */ }
  if (first) return first;
  return String(row.issued_at || row.req_processed_at || row.req_created_at || '');
}

const purchaseUnitOf = (m: PackMeta): string => promisePU(m);

function inChunks<T>(xs: T[], n = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Per requisition + material: what its party transfer rows already moved
 *  (RECIPE units, sign flipped — the rows are debits). Same probe as
 *  party-fulfillment.ts selMovedByMat. */
function movedByReqMat(db: Database.Database, reqIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of inChunks([...new Set(reqIds)])) {
    if (part.length === 0) continue;
    const rows = db.prepare(`
      SELECT reference_id AS req_id, material_id, COALESCE(SUM(-quantity), 0) AS moved
        FROM inventory_transactions
       WHERE type IN (${PARTY_TRANSFER_TYPES_SQL})
         AND reference_id IN (${part.map(() => '?').join(',')})
       GROUP BY reference_id, material_id
    `).all(...part) as Array<{ req_id: string; material_id: string; moved: number }>;
    for (const r of rows) out.set(`${r.req_id}|${r.material_id}`, Math.max(0, Number(r.moved) || 0));
  }
  return out;
}

/** Store-mapped (liquor) materials never move on central — cached per call. */
function storeMappedProbe(db: Database.Database): (materialId: string) => boolean {
  const seen = new Map<string, boolean>();
  return (materialId: string) => {
    const k = String(materialId);
    let v = seen.get(k);
    if (v === undefined) {
      try { v = isStoreMappedMaterial(db, k); } catch { v = false; }
      seen.set(k, v);
    }
    return v;
  };
}

/**
 * Every OPEN party requisition's claim on central, per material (see the
 * header for exactly what counts). `materialIds` narrows the read; omitted =
 * every material. `excludeReqId` leaves one requisition's own claim out (the
 * "promised ELSEWHERE" question). Lines are oldest first.
 */
export function partyPendingClaims(
  db: Database.Database,
  opts: { materialIds?: Iterable<string>; excludeReqId?: string } = {},
): Map<string, PartyClaim> {
  const out = new Map<string, PartyClaim>();
  const mats = opts.materialIds ? [...new Set([...opts.materialIds].map(String).filter(Boolean))] : null;
  if (mats && mats.length === 0) return out;
  const exclude = opts.excludeReqId ? String(opts.excludeReqId) : '';
  const routed = routedColSql(db);
  const baseSql = `
    SELECT r.id AS req_id, r.req_number,
           COALESCE(r.event_name, '') AS event_name, COALESCE(r.event_date, '') AS event_date,
           COALESCE(r.created_at, '') AS req_created_at, COALESCE(r.store_processed_at, '') AS req_processed_at,
           COALESCE(d.name, '') AS department,
           ri.id AS req_item_id, ri.material_id, ri.unit AS line_unit,
           COALESCE(ri.quantity_issued, 0) AS quantity_issued, ri.issued_at, ri.issue_history,
           rm.name AS material_name, rm.unit, rm.purchase_unit, rm.pack_size
      FROM requisition_items ri
      JOIN requisitions r   ON r.id  = ri.req_id
      JOIN raw_materials rm ON rm.id = ri.material_id
      LEFT JOIN departments d ON d.id = COALESCE(ri.department_id, r.department_id)
     WHERE r.purpose = 'party'
       AND r.status IN ('chef_approved', 'mgmt_approved', 'store_processed')
       AND COALESCE(ri.quantity_issued, 0) > 0
       AND ${routed} = ''
       ${exclude ? 'AND r.id <> ?' : ''}`;
  const rows: ClaimRow[] = [];
  if (mats) {
    for (const part of inChunks(mats)) {
      rows.push(...(db.prepare(`${baseSql} AND ri.material_id IN (${part.map(() => '?').join(',')})
        ORDER BY ri.req_id, ri.rowid`).all(...(exclude ? [exclude] : []), ...part) as ClaimRow[]));
    }
  } else {
    rows.push(...(db.prepare(`${baseSql} ORDER BY ri.req_id, ri.rowid`).all(...(exclude ? [exclude] : [])) as ClaimRow[]));
  }
  if (rows.length === 0) return out;

  const moved = movedByReqMat(db, rows.map(r => r.req_id));
  const pool = new Map(moved);
  const mapped = storeMappedProbe(db);
  const starts = new Map<string, { ms: number; created: number; num: string }>();
  for (const row of rows) {
    const mat = String(row.material_id);
    if (mapped(mat)) continue;
    const meta = { unit: row.unit, purchase_unit: row.purchase_unit, pack_size: row.pack_size };
    const { factor, needsReview } = lineFactor(row.line_unit, meta);
    const lineRecipe = r6((Number(row.quantity_issued) || 0) * (factor || 1));
    // The moved pool is handed to the requisition's lines of this material in
    // walk order, unit-review lines included — exactly as the transfer does.
    const key = `${row.req_id}|${mat}`;
    const left = pool.get(key) || 0;
    const movedHere = Math.min(left, lineRecipe);
    pool.set(key, Math.max(0, left - movedHere));
    if (needsReview) continue;
    const pending = r6(lineRecipe - movedHere);
    if (!(qtyGrid(pending) > EPS_GRID)) continue;
    const pf = packFactor(meta);
    const start = claimStart(row);
    const line: PartyClaimLine = {
      req_id: String(row.req_id), req_number: String(row.req_number || ''),
      event_name: String(row.event_name || ''), event_date: String(row.event_date || ''),
      department: String(row.department || ''), req_item_id: String(row.req_item_id),
      pending_recipe: pending, pending_purchase: r6(pending / pf), purchase_unit: purchaseUnitOf(meta),
      issued_at: start, last_issued_at: String(row.issued_at || ''),
    };
    starts.set(line.req_item_id, { ms: tsMs(start), created: tsMs(row.req_created_at), num: line.req_number });
    const c = out.get(mat) || { pending_recipe: 0, lines: [] };
    c.lines.push(line);
    c.pending_recipe = r6(c.pending_recipe + pending);
    out.set(mat, c);
  }
  const ord = (x: number) => (Number.isFinite(x) ? x : Number.MAX_SAFE_INTEGER);
  for (const c of out.values()) {
    c.lines.sort((a, b) => {
      const A = starts.get(a.req_item_id)!; const B = starts.get(b.req_item_id)!;
      return ord(A.ms) - ord(B.ms) || ord(A.created) - ord(B.created) || A.num.localeCompare(B.num);
    });
  }
  return out;
}

/** One requisition holding part of a claim, as a refusal or a screen names it. */
export interface PartyBlocker {
  req_id: string;
  req_number: string;
  event_name: string;
  event_date: string;
  department: string;
  pending_recipe: number;
  pending_purchase: number;
  purchase_unit: string;
  /** When its claim began (oldest first). */
  issued_at: string;
}

/** Claim lines → one row per requisition, oldest first (first line's order). */
function byRequisition(lines: PartyClaimLine[]): PartyBlocker[] {
  const out: PartyBlocker[] = [];
  const at = new Map<string, PartyBlocker>();
  for (const l of lines) {
    const hit = at.get(l.req_id);
    if (hit) {
      hit.pending_recipe = r6(hit.pending_recipe + l.pending_recipe);
      hit.pending_purchase = r6(hit.pending_purchase + l.pending_purchase);
      continue;
    }
    const b: PartyBlocker = {
      req_id: l.req_id, req_number: l.req_number, event_name: l.event_name, event_date: l.event_date,
      department: l.department, pending_recipe: l.pending_recipe, pending_purchase: l.pending_purchase,
      purchase_unit: l.purchase_unit, issued_at: l.issued_at,
    };
    at.set(l.req_id, b);
    out.push(b);
  }
  return out;
}

interface MaterialMeta extends PackMeta {
  id: string; name: string; current_stock: number;
}
function readMaterial(db: Database.Database, materialId: string): MaterialMeta | null {
  const m = db.prepare(`
    SELECT id, name, unit, purchase_unit, pack_size, COALESCE(current_stock, 0) AS current_stock
      FROM raw_materials WHERE id = ?
  `).get(String(materialId)) as MaterialMeta | undefined;
  return m || null;
}

/** The desks' "In store" converter (pack-units.ts shownPurchaseQty), handed
 *  to planCentralDebit so a figure typed from the screen meets the same
 *  shown-figure rule every floor applies. */
function shownAsFor(meta: PackMeta): ShownAs {
  return ((q: number) => shownPurchaseQty(q, meta)) as ShownAs;
}

/** A RECIPE quantity as the storekeeper reads it: PURCHASE unit first
 *  (party-promise-words.ts promiseFig — the same string as before). */
const fig = (recipe: number, meta: PackMeta): string => promiseFig(recipe, meta);
const isAre = (recipe: number, meta: PackMeta) => promiseIsAre(recipe, meta);
const hasHave = (recipe: number, meta: PackMeta) => promiseHasHave(recipe, meta);
const reqLabel = (b: { req_number: string; event_name: string }) =>
  `${b.req_number}${b.event_name ? ` (${b.event_name})` : ''}`;
/** "REQ-x (Event, 3 CASE)" — the holder with what it holds. */
const reqLabelQty = (b: { req_number: string; event_name: string }, qty: string) =>
  `${b.req_number} (${b.event_name ? `${b.event_name}, ` : ''}${qty})`;
/** "none of it is free", or — when a crumb below one printed step is left (the
 *  desk shows it as 0) — exactly that, so the sentence never says "none" over
 *  stock the books do hold (party-promise-words.ts, shared with the pages). */
const noneFreeWords = (freeRecipe: number, meta: PackMeta): string => sharedNoneFreeWords(freeRecipe, meta);
function joinNames(xs: string[]): string {
  if (xs.length <= 1) return xs[0] || '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

export interface PartyIssueShortfall {
  kind: 'issue' | 'transfer';
  material_id: string;
  material: string;
  purchase_unit: string;
  recipe_unit: string;
  pack_factor: number;
  /** raw_materials.current_stock — the central books. */
  central_recipe: number; central_purchase: number;
  /** Other open party requisitions' claims counted against this one. */
  promised_elsewhere_recipe: number; promised_elsewhere_purchase: number;
  /** This requisition's own claim before the gesture (handed over, not moved). */
  own_pending_recipe: number; own_pending_purchase: number;
  /** What the gesture adds to this requisition's claim ('transfer': what the
   *  transfer would move). */
  ask_recipe: number; ask_purchase: number;
  /** central − others − own before the ask; negative when already over-promised. */
  free_recipe: number; free_purchase: number;
  /** The most the gesture may add and pass (= max(0, free)). */
  max_add_recipe: number; max_add_purchase: number;
  /** The part of the ask the books cannot cover. */
  short_recipe: number; short_purchase: number;
  /** The requisitions holding the stock, oldest first. */
  blockers: PartyBlocker[];
  /** The storekeeper's sentence. */
  message: string;
}

/**
 * Would issuing `addRecipe` more of `materialId` on PARTY requisition `reqId`
 * promise stock the central books no longer have free?
 *
 * null when
 *   central − (claims of every OTHER open party requisition — each was handed
 *   over before this press; named oldest first) − (this requisition's own claim
 *   after the add) ≥ 0,
 * decided by planCentralDebit (the shown-figure rule included: typing the free
 * figure the desk shows is accepted). Also null when NO other party
 * requisition holds any of it: then nothing is promised elsewhere and the
 * central floor of the party transfer decides, exactly as production does.
 * Also null for a store-mapped (liquor) material, which central never holds.
 *
 * The own claim after the add is max(0, issued + add − moved): a line the
 * transfer already moved and that was undone and issued again creates no new
 * claim until it passes what moved (the transfer moves only the difference).
 */
export function partyIssueShortfall(
  db: Database.Database,
  a: { reqId: string; materialId: string; addRecipe: number },
): PartyIssueShortfall | null {
  const add = r6(a.addRecipe);
  if (!(qtyGrid(add) > 0)) return null;
  const mat = readMaterial(db, a.materialId);
  if (!mat) return null;
  if (storeMappedProbe(db)(mat.id)) return null;
  const meta: PackMeta = { unit: mat.unit, purchase_unit: mat.purchase_unit, pack_size: mat.pack_size };
  const pf = packFactor(meta);

  const claim = partyPendingClaims(db, { materialIds: [mat.id] }).get(mat.id);
  const otherLines = (claim?.lines || []).filter(l => l.req_id !== String(a.reqId));
  const others = r6(otherLines.reduce((s, l) => s + l.pending_recipe, 0));
  if (!(qtyGrid(others) > 0)) return null;

  // This requisition's own claim, before and after the add, from the same
  // inputs the transfer reads (its store-served, resolvable lines of the
  // material, and what its party rows already moved).
  const { issued: ownIssued, moved: ownMoved, req_number: ownReq } = ownIssuedMoved(db, String(a.reqId), mat);
  const ownBefore = r6(Math.max(0, ownIssued - ownMoved));
  const ownAfter = r6(Math.max(0, ownIssued + add - ownMoved));
  const ask = r6(ownAfter - ownBefore);
  if (!(qtyGrid(ask) > 0)) return null;

  const central = Number(mat.current_stock) || 0;
  const free = r6(central - others - ownBefore);
  const plan = planCentralDebit(free, ask, shownAsFor(meta));
  if (plan.fits) return null;

  const blockers = byRequisition(otherLines);
  const maxAdd = r6(Math.max(0, free));
  const short = r6(Math.max(0, ask - maxAdd));
  const name = String(mat.name || 'This item');
  const ownHolds = qtyGrid(ownBefore) > 0;
  // THE HOLDERS' FIGURES ADD UP TO THE TOTAL PRINTED BESIDE THEM (round 3):
  // each rounded alone, 100 pcs + 379.99 pcs of a 48-pack printed "2.083 CASE"
  // and "7.916 CASE" under a total of 10 CASE. Largest remainder
  // (party-promise-words.ts apportionShown — the desk prints the same
  // figures); where the parts already add up, every figure is what it was.
  const ap = apportionShown([
    ...blockers.map(b => ({ key: b.req_id, recipe: b.pending_recipe })),
    ...(ownHolds ? [{ key: String(a.reqId), recipe: ownBefore }] : []),
  ], meta);
  const holders = blockers.map((b, i) => (blockers.length > 1 || ownHolds
    ? reqLabelQty(b, promiseFigPU(ap.shown[i], meta)) : reqLabel(b)));
  if (ownHolds) holders.push(`this requisition (${ownReq ? `${ownReq}, ` : ''}${promiseFigPU(ap.shown[blockers.length], meta)})`);
  const held = r6(others + ownBefore);
  // = fig(held) wherever the parts already added up.
  const heldFig = promiseFigPU(ap.total, meta);
  const H = joinNames(holders);
  const freeShown = shownPurchaseQty(maxAdd, meta);
  const noneFree = noneFreeWords(maxAdd, meta);
  let lead: string;
  if (freeShown > 0) {
    lead = `${name}: the store holds ${fig(central, meta)} on its books, but ${heldFig} of it `
      + `${isAreShown(ap.total)} already issued on ${H} and ${hasHaveShown(ap.total)} not left the books, so only `
      + `${fig(maxAdd, meta)} is free — ${fig(ask, meta)} cannot be issued on this line. Issue ${fig(maxAdd, meta)} or less, or `;
  } else if (qtyGrid(held) <= qtyGrid(central)) {
    lead = `${name}: the store's ${fig(central, meta)} ${isAre(central, meta)} already issued on ${H} and `
      + `${hasHave(central, meta)} not left the books, so ${noneFree} for this line — `;
  } else {
    lead = `${name}: the store holds ${fig(Math.max(0, central), meta)} on its books, but ${heldFig} `
      + `${isAreShown(ap.total)} already issued on ${H} and ${hasHaveShown(ap.total)} not left them, so ${noneFree} for this line — `;
  }
  const message = `${lead}receive more ${name}, or Undo it there first. Nothing was issued and the requisition is unchanged.`;
  return {
    kind: 'issue',
    material_id: mat.id, material: name, purchase_unit: purchaseUnitOf(meta), recipe_unit: String(mat.unit || ''),
    pack_factor: pf,
    central_recipe: r6(central), central_purchase: r6(central / pf),
    promised_elsewhere_recipe: others, promised_elsewhere_purchase: r6(others / pf),
    own_pending_recipe: ownBefore, own_pending_purchase: r6(ownBefore / pf),
    ask_recipe: ask, ask_purchase: r6(ask / pf),
    free_recipe: free, free_purchase: r6(free / pf),
    max_add_recipe: maxAdd, max_add_purchase: r6(maxAdd / pf),
    short_recipe: short, short_purchase: r6(short / pf),
    blockers, message,
  };
}

/** One requisition's store-served, resolvable lines of a material: issued
 *  RECIPE total (lineFactor) and what its party rows already moved. */
function ownIssuedMoved(
  db: Database.Database, reqId: string, mat: MaterialMeta,
): { issued: number; moved: number; req_number: string } {
  const rows = db.prepare(`
    SELECT ri.unit AS line_unit, COALESCE(ri.quantity_issued, 0) AS quantity_issued
      FROM requisition_items ri
     WHERE ri.req_id = ? AND ri.material_id = ? AND ${routedColSql(db)} = ''
  `).all(reqId, mat.id) as Array<{ line_unit: string | null; quantity_issued: number }>;
  let issued = 0;
  for (const r of rows) {
    const { factor, needsReview } = lineFactor(r.line_unit, mat);
    if (needsReview) continue;
    issued += (Number(r.quantity_issued) || 0) * (factor || 1);
  }
  const moved = movedByReqMat(db, [reqId]).get(`${reqId}|${mat.id}`) || 0;
  const rn = db.prepare(`SELECT req_number FROM requisitions WHERE id = ?`).get(reqId) as { req_number?: string } | undefined;
  return { issued: r6(issued), moved: r6(moved), req_number: String(rn?.req_number || '') };
}

/**
 * THE OLDEST KEEPS ITS CLAIM, AT THE TRANSFER (ruling #80's default).
 *
 * The party transfer that completes `reqId` moves its whole claim per material
 * off central, reading only the raw balance. Where an OLDER open party
 * requisition — one whose hand-over of the material came first — still holds
 * part of that balance, the transfer would take goods the older party already
 * has, and that party is then refused at its own completion (measured,
 * b_takes_first: REQ-1389 completed first and REQ-1388 was refused "FUEL: the
 * central store holds none of it"). One row per such material.
 *
 * Only where the OLDER claims are the reason: a material the books cannot
 * cover even without them is left to the transfer's own floor, unchanged
 * (its refusal, its shown-figure rule and its top-up handling). Younger
 * requisitions' claims are not protected here — they came later.
 *
 * `completes` (default true) says which gesture runs the transfer, so the
 * sentence stays true: store-issue runs it only when the issue completes the
 * store's part ("issuing this completes the store's part of …"); store-process
 * runs it on any submit that raises no PO (its step 3a), complete or not, and
 * passes false when the submit leaves a store line open ("this submit runs the
 * party transfer of …"). The decision and every figure are the same either way.
 */
export function partyTransferTakesOlderClaims(
  db: Database.Database, reqId: string, opts: { completes?: boolean } = {},
): PartyIssueShortfall[] {
  const id = String(reqId);
  const mats = (db.prepare(`SELECT DISTINCT material_id FROM requisition_items WHERE req_id = ?`).all(id) as Array<{ material_id: string }>)
    .map(r => String(r.material_id));
  if (mats.length === 0) return [];
  const claims = partyPendingClaims(db, { materialIds: mats });
  const out: PartyIssueShortfall[] = [];
  const rn = db.prepare(`SELECT req_number FROM requisitions WHERE id = ?`).get(id) as { req_number?: string } | undefined;
  const ownReq = String(rn?.req_number || '');
  for (const [matId, c] of claims) {
    const own = c.lines.filter(l => l.req_id === id);
    if (own.length === 0) continue;
    const ownRecipe = r6(own.reduce((s, l) => s + l.pending_recipe, 0));
    if (!(qtyGrid(ownRecipe) > 0)) continue;
    // Lines are oldest first, so everything before this requisition's first
    // line came earlier.
    const firstOwn = c.lines.findIndex(l => l.req_id === id);
    const olderLines = c.lines.slice(0, firstOwn).filter(l => l.req_id !== id);
    const older = r6(olderLines.reduce((s, l) => s + l.pending_recipe, 0));
    if (!(qtyGrid(older) > 0)) continue;
    const mat = readMaterial(db, matId);
    if (!mat) continue;
    const meta: PackMeta = { unit: mat.unit, purchase_unit: mat.purchase_unit, pack_size: mat.pack_size };
    const central = Number(mat.current_stock) || 0;
    const shown = shownAsFor(meta);
    if (!planCentralDebit(central, ownRecipe, shown).fits) continue;      // the transfer's own floor decides
    const free = r6(central - older);
    const plan = planCentralDebit(free, ownRecipe, shown);
    if (plan.fits) continue;
    const pf = packFactor(meta);
    const blockers = byRequisition(olderLines);
    const maxAdd = r6(Math.max(0, free));
    const short = r6(Math.max(0, ownRecipe - maxAdd));
    const name = String(mat.name || 'This item');
    // The older holders' figures add up to the older total printed (round 3,
    // largest remainder — see partyIssueShortfall).
    const ap = apportionShown(blockers.map(b => ({ key: b.req_id, recipe: b.pending_recipe })), meta);
    const H = joinNames(blockers.map((b, i) => (blockers.length > 1 ? reqLabelQty(b, promiseFigPU(ap.shown[i], meta)) : reqLabel(b))));
    const lead = opts.completes === false
      ? `${name}: this submit runs the party transfer of ${ownReq || 'this requisition'}, which `
      : `${name}: issuing this completes the store's part of ${ownReq || 'this requisition'}, and its party transfer `;
    const message = `${lead}`
      + `would then take this requisition's ${fig(ownRecipe, meta)} of ${name} off the books — but ${promiseFigPU(ap.total, meta)} of the `
      + `store's ${fig(central, meta)} ${isAreShown(ap.total)} already issued on ${H}, handed over earlier, and `
      + `${hasHaveShown(ap.total)} not left the books, so `
      + `${shownPurchaseQty(maxAdd, meta) > 0 ? `only ${fig(maxAdd, meta)} is free` : noneFreeWords(maxAdd, meta)} for this requisition. `
      + `Receive more ${name}, or Undo ${name} on one of them first. Nothing was issued and the requisition is unchanged.`;
    out.push({
      kind: 'transfer',
      material_id: mat.id, material: name, purchase_unit: purchaseUnitOf(meta), recipe_unit: String(mat.unit || ''),
      pack_factor: pf,
      central_recipe: r6(central), central_purchase: r6(central / pf),
      promised_elsewhere_recipe: older, promised_elsewhere_purchase: r6(older / pf),
      own_pending_recipe: ownRecipe, own_pending_purchase: r6(ownRecipe / pf),
      ask_recipe: ownRecipe, ask_purchase: r6(ownRecipe / pf),
      free_recipe: free, free_purchase: r6(free / pf),
      max_add_recipe: maxAdd, max_add_purchase: r6(maxAdd / pf),
      short_recipe: short, short_purchase: r6(short / pf),
      blockers, message,
    });
  }
  return out;
}

/** What one requisition line's "In store" cell needs (GET /api/requisitions?id=). */
export interface PartyPromisedView {
  /** The central books, PURCHASE units (raw_materials.current_stock ÷ pack). */
  central_purchase: number;
  /** Handed over on OTHER open party requisitions, not yet moved. */
  promised_elsewhere_recipe: number;
  promised_elsewhere_purchase: number;
  /** Those requisitions, oldest first. */
  promised_elsewhere_reqs: Array<{
    req_id: string; req_number: string; event_name: string; event_date: string; department: string;
    qty_purchase: number; qty_recipe: number; purchase_unit: string; issued_at: string;
  }>;
  /** central − promised elsewhere. SIGNED: below 0 the books are already short
   *  by that much for the other parties (show it as "short N", never as −N). */
  free_recipe: number;
  free_purchase: number;
  /** This requisition's own handed-over, not-yet-moved quantity (0 unless it
   *  is an open party requisition). */
  own_pending_recipe: number;
  own_pending_purchase: number;
  /** Of that own quantity, how much the books cannot cover once the OLDER
   *  parties' claims are honoured (ruling #80) — 0 when covered. */
  own_claim_short_recipe: number;
  own_claim_short_purchase: number;
}

/** The view for every material on one requisition, read once. */
export function partyPromisedForRequisition(
  db: Database.Database, reqId: string, materialIds: Iterable<string>,
): Map<string, PartyPromisedView> {
  const id = String(reqId);
  const mats = [...new Set([...materialIds].map(String).filter(Boolean))];
  const out = new Map<string, PartyPromisedView>();
  if (mats.length === 0) return out;
  const claims = partyPendingClaims(db, { materialIds: mats });
  const metaRows = new Map<string, MaterialMeta>();
  for (const part of inChunks(mats)) {
    for (const m of db.prepare(`
      SELECT id, name, unit, purchase_unit, pack_size, COALESCE(current_stock, 0) AS current_stock
        FROM raw_materials WHERE id IN (${part.map(() => '?').join(',')})
    `).all(...part) as MaterialMeta[]) metaRows.set(String(m.id), m);
  }
  for (const matId of mats) {
    const mat = metaRows.get(matId);
    if (!mat) continue;
    const meta: PackMeta = { unit: mat.unit, purchase_unit: mat.purchase_unit, pack_size: mat.pack_size };
    const pf = packFactor(meta);
    const central = Number(mat.current_stock) || 0;
    const lines = claims.get(matId)?.lines || [];
    const otherLines = lines.filter(l => l.req_id !== id);
    const others = r6(otherLines.reduce((s, l) => s + l.pending_recipe, 0));
    const own = r6(lines.filter(l => l.req_id === id).reduce((s, l) => s + l.pending_recipe, 0));
    const firstOwn = lines.findIndex(l => l.req_id === id);
    const older = firstOwn < 0 ? 0
      : r6(lines.slice(0, firstOwn).filter(l => l.req_id !== id).reduce((s, l) => s + l.pending_recipe, 0));
    const ownShort = own > 0 ? r6(Math.min(own, Math.max(0, older + own - Math.max(0, central)))) : 0;
    const free = r6(central - others);
    out.set(matId, {
      central_purchase: r6(central / pf),
      promised_elsewhere_recipe: others,
      promised_elsewhere_purchase: r6(others / pf),
      promised_elsewhere_reqs: byRequisition(otherLines).map(b => ({
        req_id: b.req_id, req_number: b.req_number, event_name: b.event_name, event_date: b.event_date,
        department: b.department, qty_purchase: b.pending_purchase, qty_recipe: b.pending_recipe,
        purchase_unit: b.purchase_unit, issued_at: b.issued_at,
      })),
      free_recipe: free,
      free_purchase: r6(free / pf),
      own_pending_recipe: own,
      own_pending_purchase: r6(own / pf),
      own_claim_short_recipe: ownShort,
      own_claim_short_purchase: r6(ownShort / pf),
    });
  }
  return out;
}
