/**
 * VENDOR NAME REVIEW — owner decision 3 (2026-08-31), Liquor Reconciliation.
 *
 *   "Near-duplicate vendor names: keep them separate, raise a review FLAG only."
 *
 * Two vendor rows whose ids differ stay two vendors. When two vendor NAMES
 * differ by only a few characters (an edit distance of 3 or less), this raises
 * a review flag — a flag a person reads, NEVER a merge.
 *
 * READ-ONLY, BY DESIGN AND BY TEST. Every function here only SELECTs. Nothing
 * writes vendors, purchases, the ledger or any lq_ table; nothing re-points a
 * purchase at another vendor; nothing folds one spelling into another. The
 * vendor master and every vendor reader are untouched — this module only adds
 * a list beside them, shown on the Liquor Reconciliation page (gated with the
 * rest of the module until the owner deploys it).
 *
 * WHAT IS COMPARED. The vendor MASTER (vendors.name, one entry per id) is the
 * primary list. Free-text vendor spellings are added where one does NOT
 * exactly equal a master name — purchases.vendor, the supplier typed on a
 * store bill (store_stock_ledger.supplier), and the wine-shop names on
 * lq_retail_flags — because a typo'd spelling on a bill is the same review
 * question as two master rows. A free-text spelling identical to a master name
 * IS that vendor and is not a pair.
 *
 * THE MEASURE. Levenshtein distance on the name upper-cased with its spaces
 * collapsed — so a pair that differs only in case or spacing reads as distance
 * 0 ("case or spacing only") rather than vanishing. Two master rows with the
 * very same name under two ids are distance 0 too ("same name, two ids").
 * Everything up to LQ_VENDOR_REVIEW_MAX_DISTANCE is flagged, short names
 * included: a flag the owner dismisses costs a glance, a missed one costs a
 * duplicated vendor. Pairs are sorted closest first, so short-name noise
 * (QA LIQ / QA INJ is 3 edits in 6 letters) sits at the bottom.
 *
 * Measured on the worktree DB copy, 59 master rows: VINITH FOODS & BEVERAGES
 * PRIVATE LIMITED vs VINT FOODS & BEVERAGES PRIVATE LIMITED (distance 2, two
 * ids, both legitimate — exactly the case the decision is for), ZZTEST VENDOR
 * vs TEST VENDOR (2), ZZSeed vs ZZ Old (3), QA LIQ vs QA INJ (3).
 */

import type { Database } from 'better-sqlite3';

/** "Differ by only about 2–3 characters" — the owner's words, as a number. */
export const LQ_VENDOR_REVIEW_MAX_DISTANCE = 3;
/** The page and the CSV list at most this many pairs; the total is always reported. */
const MAX_PAIRS = 200;

export type VendorNameSource = 'vendor' | 'purchase' | 'store_bill' | 'wine_shop';

export interface VendorNameRef {
  /** Exactly as stored — never re-spelled for display. */
  name: string;
  source: VendorNameSource;
  /** vendors.id for a master row; null for a free-text spelling. */
  vendor_id: string | null;
  /** vendors.is_active for a master row; null for a free-text spelling. */
  is_active: boolean | null;
  /** How many rows carry this exact spelling: purchases for a master name or a
   *  purchases spelling, store bill lines, or wine-shop buys. */
  uses: number;
}

export type VendorPairKind =
  /** Two master rows, two ids, the very same name. */
  | 'same_name_two_ids'
  /** The names differ only in letter case or spacing. */
  | 'case_or_spacing'
  /** The names differ by 1 to MAX_DISTANCE characters. */
  | 'near_spelling';

export interface VendorNearPair {
  distance: number;
  kind: VendorPairKind;
  a: VendorNameRef;
  b: VendorNameRef;
}

export interface VendorReview {
  /** Closest first. FLAGS ONLY — nothing has been merged or changed. */
  pairs: VendorNearPair[];
  /** All flagged pairs, including any beyond the listed cap. */
  pairs_total: number;
  max_distance: number;
  scanned: { vendors: number; free_text_spellings: number };
  /** One sentence for the page and the CSV. */
  note: string;
}

/** Upper-case, spaces collapsed — what the distance is measured on. */
const normName = (s: string): string => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

/**
 * Levenshtein distance, or max + 1 as soon as it is known to exceed max (a
 * banded early exit: no pair further apart than `max` is ever reported, so
 * there is no need to finish the matrix).
 */
export function editDistanceWithin(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[lb];
}

/** A read whose table may be absent on this database (lq_retail_flags before
 *  the module's migration ran) — an absent source contributes nothing. */
function rowsOr(db: Database, sql: string): any[] {
  try { return db.prepare(sql).all() as any[]; } catch { return []; }
}

/**
 * Every near-duplicate vendor-name pair, flag-only. Pure read.
 */
export function vendorNameReview(db: Database, opts?: { maxDistance?: number }): VendorReview {
  const max = Math.max(0, Math.floor(Number(opts?.maxDistance ?? LQ_VENDOR_REVIEW_MAX_DISTANCE)));

  // Uses per exact purchases spelling — read once, for master names and
  // free-text spellings alike.
  const purchaseUses = new Map<string, number>();
  for (const r of rowsOr(db, `
    SELECT TRIM(vendor) AS name, COUNT(*) AS n FROM purchases
    WHERE TRIM(COALESCE(vendor, '')) != '' GROUP BY TRIM(vendor)
  `)) purchaseUses.set(String(r.name), Number(r.n) || 0);
  // And per exact store-bill spelling: a TGBCL bill entered on Goods Receipt
  // writes no purchases row, only store-ledger lines under its supplier, so a
  // depot vendor used on every liquor bill would otherwise read "0 uses".
  const storeUses = new Map<string, number>();
  for (const r of rowsOr(db, `
    SELECT TRIM(supplier) AS name, COUNT(*) AS n FROM store_stock_ledger
    WHERE txn_type = 'purchase' AND TRIM(COALESCE(supplier, '')) != '' GROUP BY TRIM(supplier)
  `)) storeUses.set(String(r.name), Number(r.n) || 0);

  const refs: VendorNameRef[] = [];
  const masterNames = new Set<string>();
  for (const v of rowsOr(db, `SELECT id, name, is_active FROM vendors WHERE TRIM(COALESCE(name, '')) != '' ORDER BY name, id`)) {
    const name = String(v.name).trim();
    masterNames.add(name);
    refs.push({
      name, source: 'vendor', vendor_id: String(v.id),
      is_active: v.is_active == null ? null : Number(v.is_active) === 1,
      uses: (purchaseUses.get(name) ?? 0) + (storeUses.get(name) ?? 0),
    });
  }
  const vendorCount = refs.length;

  // Free-text spellings that are NOT a master name, first source wins for a
  // spelling that appears in more than one place (it is one spelling).
  const seenFree = new Set<string>();
  const addFree = (source: VendorNameSource, rows: any[]) => {
    for (const r of rows) {
      const name = String(r.name ?? '').trim();
      if (!name || masterNames.has(name) || seenFree.has(name)) continue;
      seenFree.add(name);
      refs.push({ name, source, vendor_id: null, is_active: null, uses: Number(r.n) || 0 });
    }
  };
  addFree('purchase', [...purchaseUses].map(([name, n]) => ({ name, n })));
  addFree('store_bill', [...storeUses].map(([name, n]) => ({ name, n })));
  addFree('wine_shop', rowsOr(db, `
    SELECT TRIM(shop_name) AS name, COUNT(*) AS n FROM lq_retail_flags
    WHERE TRIM(COALESCE(shop_name, '')) != '' GROUP BY TRIM(shop_name)
  `));

  const norm = refs.map(r => normName(r.name));
  const pairs: VendorNearPair[] = [];
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      const a = refs[i], b = refs[j];
      // The same spelling twice is one name — unless both are MASTER rows,
      // where it is two ids under one name, which is exactly a review case.
      if (a.name === b.name && !(a.source === 'vendor' && b.source === 'vendor')) continue;
      const d = editDistanceWithin(norm[i], norm[j], max);
      if (d > max) continue;
      const kind: VendorPairKind = d > 0 ? 'near_spelling'
        : (a.name === b.name ? 'same_name_two_ids' : 'case_or_spacing');
      pairs.push({ distance: d, kind, a, b });
    }
  }
  pairs.sort((x, y) => x.distance - y.distance
    || (y.a.name.length + y.b.name.length) - (x.a.name.length + x.b.name.length)
    || x.a.name.localeCompare(y.a.name) || x.b.name.localeCompare(y.b.name));

  const total = pairs.length;
  return {
    pairs: pairs.slice(0, MAX_PAIRS),
    pairs_total: total,
    max_distance: max,
    scanned: { vendors: vendorCount, free_text_spellings: refs.length - vendorCount },
    note: total === 0
      ? `No two vendor names are within ${max} character${max === 1 ? '' : 's'} of each other.`
      : `${total} pair${total === 1 ? '' : 's'} of vendor names differ by ${max} character${max === 1 ? '' : 's'} or fewer. `
        + 'This is a review flag only (owner decision 3): nothing has been merged or changed, and two vendors with '
        + 'different ids stay two vendors. Check each pair; if one really is a duplicate, correct it on the Vendors page.',
  };
}
