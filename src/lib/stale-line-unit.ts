/**
 * STALE LINE UNIT — owner ruling 128, "Block it + stop new ones".
 *
 * A requisition line's unit is STALE exactly when the server's own converter
 * refuses it: issue-stock.ts lineFactor(line unit, material).needsReview, the
 * check that makes checkCentralIssue skip with 'unit_review' and applyIssueDelta
 * record 0 and move no stock. In plain words: the material is PACKED
 * (packFactor > 1: pack_size > 1 and the recipe unit differs from the purchase
 * unit) and the line's unit, lower-cased and trimmed, is blank or is neither the
 * material's purchase unit nor its recipe unit. Example: YELLOW CHEDDAR is g,
 * bought in kg, x1000 — a 'PKT' or blank line is stale, a 'kg' or 'g' line is
 * not. On an unpacked material no line unit is ever stale. There is no kg<->g or
 * L<->ml conversion in the rule.
 *
 * WHICH SIDE OF THE WIRE:
 *   · Server code (routes, libs that hold the db) calls issue-stock.ts
 *     lineUnitNeedsReview(lineUnit, {unit, purchase_unit, pack_size}) — that
 *     IS lineFactor().needsReview.
 *   · Pages cannot import issue-stock.ts (it imports the database). They call
 *     isStaleLineUnit below, which is desk-rule.ts deskLineBasis(l) === null —
 *     the desks' tested transcription of lineFactor, null exactly where
 *     lineFactor says needsReview. This file adds no rule of its own.
 *
 * WHAT TO PASS isStaleLineUnit: the LINE's stored unit (requisition_items.unit
 * — never a unit the form would stamp) and the material's current unit,
 * purchase unit and pack size. material_pack_size MUST be supplied: a missing
 * pack size reads as 1, and nothing is stale on an unpacked material. Either
 * the raw raw_materials.purchase_unit or the payloads' usual
 * COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) gives the server's
 * answer, with one exception: a purchase_unit made only of spaces. The server
 * reads that as a blank purchase unit (packed, so 'kg' lines are refused) while
 * the COALESCE form turns it into the recipe unit (unpacked, nothing stale).
 * Both local database copies hold 0 such rows (measured 2026-11-11).
 *
 * Pure: imports only ./desk-rule (which imports only ./pack-units). Safe for
 * client and server.
 */
import { deskLineBasis, type DeskLineUnits } from './desk-rule';

/** The owner's words, without the remedy: "unit doesn't match this item". */
export const STALE_UNIT_SHORT = "unit doesn't match this item";
/** Same, capitalised for the start of a title or remark. */
export const STALE_UNIT_TITLE_SHORT = `U${STALE_UNIT_SHORT.slice(1)}`;
/** The owner's sentence: "unit doesn't match this item — reject and raise again". */
export const STALE_UNIT_WORDS = `${STALE_UNIT_SHORT} — reject and raise again`;
/** Same, capitalised: "Unit doesn't match this item — reject and raise again". */
export const STALE_UNIT_TITLE = `${STALE_UNIT_TITLE_SHORT} — reject and raise again`;

/**
 * Is this line's unit stale? deskLineBasis(l) === null, i.e. issue-stock.ts
 * lineFactor().needsReview for the same line and material (see the header for
 * what to pass). Client-safe.
 */
export function isStaleLineUnit(l: DeskLineUnits): boolean {
  return deskLineBasis(l) === null;
}

/**
 * A stale line's quantity AS STORED, in its own unit: "2 PKT", "2,640 PKT",
 * "2" for a blank unit. Byte-for-byte the needsReview branch of issue-stock.ts
 * fmtLineQtyPU, so a screen prints exactly what the server's sentences print.
 * Never converts: nobody can say what a stale unit is in grams or kilos.
 */
export function fmtStoredLineQty(lineQty: number, lineUnit: string | null | undefined): string {
  const lu = String(lineUnit ?? '').trim();
  return `${(Math.round((Number(lineQty) || 0) * 1e6) / 1e6).toLocaleString('en-IN', { maximumFractionDigits: 6 })}${lu ? ` ${lu}` : ''}`;
}

/** The three unit names a stale-line sentence quotes, trimmed, case as stored.
 *  buy = the purchase unit, falling back to the recipe unit when blank. */
export interface StaleUnitNames { line: string; buy: string; use: string }

export function staleUnitNames(
  lineUnit: string | null | undefined,
  meta: { unit?: string | null; purchase_unit?: string | null },
): StaleUnitNames {
  const use = String(meta.unit ?? '').trim();
  const buy = String(meta.purchase_unit ?? '').trim() || use;
  return { line: String(lineUnit ?? '').trim(), buy, use };
}

/**
 * The facts sentence that follows the owner's words:
 *   "The line says PKT; this item is bought in kg and used in g."
 *   "The line has no unit; this item is bought in kg and used in g."
 * Pass the line's stored unit and the material's unit / purchase unit (raw or
 * the payloads' COALESCE form — both read the same here).
 */
export function staleUnitFacts(
  lineUnit: string | null | undefined,
  meta: { unit?: string | null; purchase_unit?: string | null },
): string {
  const { line, buy, use } = staleUnitNames(lineUnit, meta);
  const head = line ? `The line says ${line}` : 'The line has no unit';
  const item = buy && use && buy.toLowerCase() !== use.toLowerCase()
    ? `this item is bought in ${buy} and used in ${use}`
    : use ? `this item is used in ${use}`
      : buy ? `this item is bought in ${buy}`
        : 'this item has no unit set';
  return `${head}; ${item}.`;
}
