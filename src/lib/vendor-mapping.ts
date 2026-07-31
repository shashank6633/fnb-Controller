// TYPE-ONLY: this module never opens the database itself — every function is
// handed the caller's handle. Importing db.ts for real would run the boot
// migrations from anywhere this file is imported (including a test harness).
import type { getDb } from '@/lib/db';

/**
 * VENDOR ↔ ITEM MAPPING — the one place the rule lives.
 *
 * Owner's rule, verbatim: "Vendor mapping should be done in Vendor Items first,
 * then only Vendor Mapping will be perfect. 1 vendor may have limited items but
 * an item can have different vendors."
 *
 * So the mapping is a MANY-TO-MANY declared by hand on /vendors/materials
 * (table `vendor_materials`, seeded once from real purchase history), and a PO
 * line may only pair a vendor with an item that pair declares:
 *
 *   pick the VENDOR first  → only that vendor's mapped items are orderable
 *   pick the ITEM   first  → only vendors mapped to that item are selectable
 *
 * WHY THIS FILE EXISTS: the PO composer's dropdowns and the server-side
 * rejection must never disagree — a dropdown that offers a pair the server
 * refuses is worse than no filter at all, because the buyer only finds out
 * after typing the whole PO. Both sides read `vendor_materials` through
 * `pairRows()` below: the composer via the ?index=1 payload built from
 * `vendorMappingIndex()`, the API via `vendorMappingError()`. One SELECT, one
 * truth.
 *
 * A FILTERED <select> IS A CONVENIENCE. THE SERVER IS THE RULE. Every PO write
 * path that accepts line items calls `vendorMappingError()`.
 *
 * NOT a price list — `vendor_contracts` carries negotiated rates and validity
 * windows and is completely independent of this. Mapping says only "this vendor
 * sells this item".
 */

type DB = ReturnType<typeof getDb>;

/** Where a mapped pair came from, for the Vendor Items screen.
 *  - 'history'   → seeded once from the `purchases` table (db.ts migration)
 *  - 'contracts' → backfilled from an active vendor_contracts row (db.ts)
 *  - 'person'    → a human declared it on /vendors/materials  */
export type PairSource = 'history' | 'contracts' | 'person';

export interface VendorMaterialPair {
  vendor_id: string;
  vendor_name: string;
  vendor_is_active: number;
  material_id: string;
  material_name: string;
  material_sku: string | null;
  /** RECIPE unit (g/ml/pcs) — display only; a PO line is never expressed in it. */
  material_unit: string | null;
  /** PURCHASE unit (kg/L/BTL/CASE) — what a PO line is ordered in. */
  material_purchase_unit: string | null;
  material_pack_size: number | null;
  notes: string;
  created_at: string;
  created_by: string | null;
  source: PairSource;
}

/**
 * THE single SELECT every reader in this module goes through.
 *
 * INNER JOINs on both sides on purpose: a pair whose vendor or material row has
 * been deleted is not a usable mapping, and hiding it from the dropdown while
 * the rule still honoured it (or vice versa) is exactly the disagreement this
 * file exists to prevent.
 *
 * `vendors.is_active` is NOT filtered here. Deactivating a vendor is a
 * purchasing decision the vendor dropdown already enforces (it lists active
 * vendors only); the mapping itself survives so an existing draft that names a
 * since-retired vendor still round-trips instead of being rejected as
 * "unmapped", which would be a lie.
 */
function pairRows(db: DB, filter: { vendorId?: string; materialId?: string } = {}): VendorMaterialPair[] {
  const where: string[] = [];
  const params: any[] = [];
  if (filter.vendorId)   { where.push('vm.vendor_id = ?');   params.push(filter.vendorId); }
  if (filter.materialId) { where.push('vm.material_id = ?'); params.push(filter.materialId); }
  const rows = db.prepare(`
    SELECT vm.vendor_id, vm.material_id,
           COALESCE(vm.notes, '')      AS notes,
           vm.created_at, vm.created_by,
           v.name                      AS vendor_name,
           v.is_active                 AS vendor_is_active,
           rm.name                     AS material_name,
           rm.sku                      AS material_sku,
           rm.unit                     AS material_unit,
           COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit,
           rm.pack_size                AS material_pack_size
    FROM vendor_materials vm
    JOIN vendors       v  ON v.id  = vm.vendor_id
    JOIN raw_materials rm ON rm.id = vm.material_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY v.name, rm.name
  `).all(...params) as any[];
  return rows.map(r => ({ ...r, source: pairSource(r.created_by, r.notes) })) as VendorMaterialPair[];
}

/** Seed rows were written by the db.ts migrations as created_by='system'; the
 *  two seeds are told apart by their note. Anything else was typed by a person,
 *  and their email is on the row. */
function pairSource(createdBy: string | null, notes: string): PairSource {
  if (String(createdBy || '').trim().toLowerCase() !== 'system') return 'person';
  return /contract/i.test(String(notes || '')) ? 'contracts' : 'history';
}

/** Every item this vendor is declared to supply. A VENDOR HAS A LIMITED LIST. */
export function materialsForVendor(db: DB, vendorId: string): VendorMaterialPair[] {
  const id = String(vendorId || '').trim();
  if (!id) return [];
  return pairRows(db, { vendorId: id });
}

/** Every vendor declared to supply this item. AN ITEM CAN HAVE MANY VENDORS. */
export function vendorsForMaterial(db: DB, materialId: string): VendorMaterialPair[] {
  const id = String(materialId || '').trim();
  if (!id) return [];
  return pairRows(db, { materialId: id });
}

/** The rule, as one boolean. Same SELECT as the two list functions above, so a
 *  pair the dropdown offers is a pair this accepts. */
export function isPairMapped(db: DB, vendorId: string, materialId: string): boolean {
  const v = String(vendorId || '').trim();
  const m = String(materialId || '').trim();
  if (!v || !m) return false;
  return pairRows(db, { vendorId: v, materialId: m }).length > 0;
}

/** Item ids only — for callers that just need a membership test. */
export function mappedMaterialIds(db: DB, vendorId: string): Set<string> {
  return new Set(materialsForVendor(db, vendorId).map(p => p.material_id));
}

export interface VendorMappingIndex {
  /** vendor_id → material_id[]. BOTH directions the composer needs are derived
   *  from this ONE object client-side, so the two dropdowns can never disagree
   *  with each other, and neither can disagree with the server: it is the same
   *  `vendor_materials` rows `vendorMappingError()` checks against. */
  by_vendor: Record<string, string[]>;
  /** vendor_id → name, for messages the client composes before saving. */
  vendor_names: Record<string, string>;
  pair_count: number;
  vendor_count: number;
  material_count: number;
}

/** The whole map in one payload (527 pairs today ≈ 20 KB). Cheap enough to send
 *  once when the composer opens, which is what makes both-direction filtering
 *  instant and consistent. */
export function vendorMappingIndex(db: DB): VendorMappingIndex {
  const rows = pairRows(db);
  const by_vendor: Record<string, string[]> = {};
  const vendor_names: Record<string, string> = {};
  const materials = new Set<string>();
  for (const r of rows) {
    (by_vendor[r.vendor_id] ||= []).push(r.material_id);
    vendor_names[r.vendor_id] = r.vendor_name;
    materials.add(r.material_id);
  }
  return {
    by_vendor,
    vendor_names,
    pair_count: rows.length,
    vendor_count: Object.keys(by_vendor).length,
    material_count: materials.size,
  };
}

/** Active vendors carrying no mapped item at all — the set that needs attention
 *  on the Vendor Items screen before anything can be ordered from them. */
export function vendorsWithNoItems(db: DB): Array<{ id: string; name: string }> {
  return db.prepare(`
    SELECT v.id, v.name
    FROM vendors v
    WHERE v.is_active = 1
      AND NOT EXISTS (SELECT 1 FROM vendor_materials vm WHERE vm.vendor_id = v.id)
    ORDER BY v.name
  `).all() as Array<{ id: string; name: string }>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * SERVER-SIDE ENFORCEMENT
 * ──────────────────────────────────────────────────────────────────────────── */

/** A PO line as far as the mapping rule cares. Every field optional/unknown
 *  because this runs on the RAW payload, alongside lineSanityError and
 *  duplicateLineError, before anything has been shape-validated. */
export type MappedLineLike = {
  material_id?: unknown;
  vendor_id?: unknown;
  vendor?: unknown;
};

/** Anything that names a vendor: a PO line, or a PO header. */
export type VendorRefLike = {
  vendor_id?: unknown;
  vendor?: unknown;
};

/**
 * A vendor reference resolved to the MASTER ROW — the one identity.
 *
 * WHY THIS TYPE EXISTS: the rule used to resolve a line id-first while the
 * insert stored `String(it.vendor)` verbatim, so a payload carrying vendor_id X
 * with the name of vendor Y was CHECKED against X and STORED as Y. Everything
 * downstream of the PO keys on the stored NAME — receive groups by it
 * (`lineVendorName`), `purchases.vendor` records it, `po_vendor_bills` files the
 * bill under it — so that PO would have been received, stocked and paid under a
 * pairing the rule never saw. The fix is that both the check and the insert go
 * through `resolveVendorRef()` and use what it returns: `id` AND `name` off the
 * same master row, never the caller's spelling of either.
 */
export interface ResolvedVendor {
  /** 'empty'   — the ref carried neither an id nor a name (see the inheritance
   *              note on `vendorMappingError`).
   *  'known'   — it resolved to a `vendors` row: `id` and `name` are that row's.
   *  'unknown' — it named someone no master row matches; nothing to check. */
  status: 'empty' | 'known' | 'unknown';
  /** vendors.id. Null unless status === 'known'. */
  id: string | null;
  /** vendors.name spelled EXACTLY as the master row spells it — the string that
   *  must be stored, because it is the join key for every reader downstream.
   *  '' unless status === 'known'. */
  name: string;
  /** What the caller actually sent (name preferred), for error messages only. */
  shown: string;
}

const EMPTY_VENDOR: ResolvedVendor = { status: 'empty', id: null, name: '', shown: '' };

/** The resolver with its two statements prepared once — the rule calls it per
 *  line, and the PO insert loops call it per line too. */
export function vendorResolver(db: DB): (ref: VendorRefLike | null | undefined) => ResolvedVendor {
  const byId = db.prepare('SELECT id, name FROM vendors WHERE id = ?');
  // Same tie-break as everywhere else in this module: prefer an active row, then
  // the shortest name. The PO insert loops used a bare `LIMIT 1` with no ORDER
  // BY, which could pick a DIFFERENT row than this one for a duplicated vendor
  // name — one more way the checked identity and the stored identity drifted.
  const byName = db.prepare('SELECT id, name FROM vendors WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) ORDER BY is_active DESC, LENGTH(name) ASC LIMIT 1');
  return (ref) => {
    const rawId   = String(ref?.vendor_id ?? '').trim();
    const rawName = String(ref?.vendor ?? '').trim();
    if (!rawId && !rawName) return EMPTY_VENDOR;
    // ID FIRST, name second — and whichever one resolves, the row it resolves to
    // is the answer for BOTH fields. An id that resolves therefore overrides a
    // conflicting name rather than sitting beside it.
    const row = (rawId ? byId.get(rawId) as any : null)
             || (rawName ? byName.get(rawName) as any : null);
    const shown = rawName || rawId;
    if (!row) return { status: 'unknown', id: null, name: '', shown };
    return { status: 'known', id: String(row.id), name: String(row.name ?? '').trim(), shown };
  };
}

/** One-shot form of `vendorResolver` for callers outside a loop. */
export function resolveVendorRef(db: DB, ref: VendorRefLike | null | undefined): ResolvedVendor {
  return vendorResolver(db)(ref);
}

/** What a line carrying NO vendor of its own will actually be filed under. */
type InheritedVendor =
  | { kind: 'none' }                        // nothing to inherit — see Smart Reorder
  | { kind: 'vendor'; vendor: ResolvedVendor }
  | { kind: 'mixed'; count: number };       // the PO spans several vendors

/**
 * THE VENDOR A BLANK LINE INHERITS.
 *
 * A blank line vendor is not "no vendor" by the time it costs money. At receive
 * the line collapses to the PO HEADER vendor —
 *   `lineVendorName = (it.vendor && trim) || po.vendor || ''`
 *   (api/purchase-orders/[id]/receive) —
 * and that name is what groups the delivery, what `po_vendor_bills` files the
 * bill under, and what lands in `purchases.vendor`. So the pair to check is
 * (header vendor, this item), not "nothing".
 *
 * But the header the line inherits is NOT necessarily the header on the request:
 * `deriveHeaderVendor()` REWRITES it from the line vendors inside the same
 * transaction as the insert. This mirrors that derivation:
 *   - exactly one distinct line vendor → the header becomes that vendor
 *   - several                          → the header becomes "Mixed (N vendors)",
 *                                        which is not a vendor at all
 *   - none                             → the header is left alone, so the ref the
 *                                        caller passes is what the line inherits
 * `headerIsFinal` turns the mirror off, for the one caller that is NOT rewriting
 * the item set (a header-only PUT never calls deriveHeaderVendor).
 *
 * A line whose vendor is 'unknown' is counted here but is refused by the rule
 * itself a moment later, so it can never reach storage down either path.
 */
function inheritedVendorFor(
  list: readonly (MappedLineLike | null | undefined)[],
  resolve: (ref: VendorRefLike | null | undefined) => ResolvedVendor,
  headerVendor: VendorRefLike | null | undefined,
  headerIsFinal: boolean,
): InheritedVendor {
  if (!headerIsFinal) {
    const seen = new Map<string, ResolvedVendor>();
    for (const it of list) {
      const v = resolve(it);
      if (v.status === 'empty') continue;
      const key = v.status === 'known' ? `id:${v.id}` : `raw:${v.shown.toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, v);
    }
    if (seen.size === 1) return { kind: 'vendor', vendor: [...seen.values()][0] };
    if (seen.size > 1)   return { kind: 'mixed', count: seen.size };
  }
  const hdr = resolve(headerVendor);
  return hdr.status === 'empty' ? { kind: 'none' } : { kind: 'vendor', vendor: hdr };
}

const VENDOR_ITEMS_PAGE = '/vendors/materials';

/**
 * THE RULE. Returns null when every line's (vendor, item) pair is declared,
 * else the ready-to-return 400 message naming the vendor, the item, and the fix.
 *
 * STRICT, and deliberately so — the owner chose strict. An unmapped pair is
 * refused outright rather than warned about, because the warning would be read
 * by the one person who is standing at a delivery and has no reason to doubt a
 * dropdown. Every refusal therefore has to carry its own way out, which is why
 * these messages name the exact screen and (where it helps) the vendors that DO
 * supply the item.
 *
 * A LINE WITH NO VENDOR IS NOT AN UNCHECKED LINE. It used to be skipped, which
 * was a hole straight through the rule: at receive a blank line falls back to
 * the PO HEADER vendor and is stocked and billed under that name, so an unmapped
 * pair could walk in on a blank line and never be looked at. Such a line is now
 * checked against the vendor it will actually inherit — see
 * `inheritedVendorFor()` for how that vendor is worked out, and note that the
 * mixed-vendor PO has no answer to inherit at all.
 *
 * SMART REORDER STILL WORKS. Its unassigned draft (lib/crm-reorder-po) has a
 * blank vendor on every line AND a blank PO header — there is no header vendor
 * for those lines to collapse to, at receive or here, so there is no pair to
 * check and they are skipped exactly as before. The distinction is not "does the
 * line name a vendor" but "will this line be filed under one": the blank line
 * that is refused is the one sitting under a header vendor that would silently
 * adopt it. Its per-vendor drafts name the vendor on every line and were never
 * in this branch.
 *
 * WHAT IS DELIBERATELY NOT CHECKED:
 *  - A blank material_id is skipped — lineSanityError owns "pick an item", and
 *    the composer opens with one empty row. (A null/undefined entry is skipped
 *    the same way, which is how a caller passes a subset of the lines while
 *    keeping the 1-based numbering of the whole PO.)
 *  - Prices, contracts and quantities. Mapping says "sells", never "at what".
 *
 * Line numbers are 1-based and match lineSanityError / duplicateLineError, so
 * every PO error the buyer can see counts the rows the same way.
 */
export function vendorMappingError(
  db: DB,
  items: readonly (MappedLineLike | null | undefined)[] | null | undefined,
  opts?: {
    /** The PO header vendor as the request leaves it — what a line carrying no
     *  vendor of its own falls back to. Omit only when there is genuinely no
     *  header (then blank lines stay skipped). */
    headerVendor?: VendorRefLike | null;
    /** Set by a caller that is NOT rewriting the item set, so
     *  `deriveHeaderVendor()` will not run and `headerVendor` is literally the
     *  header the lines are left inheriting. */
    headerIsFinal?: boolean;
  },
): string | null {
  const list = Array.isArray(items) ? items : [];
  const resolve = vendorResolver(db);
  const materialById = db.prepare('SELECT id, name, sku FROM raw_materials WHERE id = ?');
  const inherited = inheritedVendorFor(list, resolve, opts?.headerVendor, !!opts?.headerIsFinal);

  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const n = i + 1;
    const materialId = String(it?.material_id ?? '').trim();
    if (!materialId) continue;                       // lineSanityError owns this

    // ONE resolver, shared with the POST/PUT insert loops, so the rule is applied
    // to the vendor the row will actually be STORED against — id first, else the
    // master row whose name matches, and the master's own spelling either way.
    const own = resolve(it);
    const isInherited = own.status === 'empty';

    if (isInherited && inherited.kind === 'none') continue;   // nothing to inherit — see above
    if (isInherited && inherited.kind === 'mixed') {
      return `Line ${n}: this line has no vendor of its own, and the PO covers ${inherited.count} vendors — so there is no header vendor for it to fall back to, and receiving would file it under "Mixed (${inherited.count} vendors)", which is nobody. Set the vendor on this line.`;
    }
    const vendor = isInherited ? (inherited as { kind: 'vendor'; vendor: ResolvedVendor }).vendor : own;
    // Said on every refusal below, because the buyer never typed this vendor on
    // this line and would otherwise not know where the name came from.
    const inheritNote = isInherited
      ? ` (This line has no vendor of its own, so it is received under the PO's vendor${vendor.status === 'known' ? `, ${vendor.name}` : ''} — set a vendor on the line to file it elsewhere.)`
      : '';

    if (vendor.status === 'unknown') {
      // An id/name that resolves to nothing cannot be checked against a mapping,
      // and every vendor-keyed join downstream (contracts, history, terms) is
      // already broken for it. Say which one, and where vendors come from.
      return `Line ${n}: "${vendor.shown}" is not in the Vendor master, so its item list cannot be checked. Pick the vendor from the dropdown, or add them under Vendors first.${inheritNote}`;
    }

    const supplied = materialsForVendor(db, vendor.id!);
    const mat = materialById.get(materialId) as any;
    const itemLabel = mat ? `${mat.name}${mat.sku ? ` (${mat.sku})` : ''}` : materialId;

    if (supplied.length === 0) {
      // THE EMPTY-MAP CASE. 17 of 55 vendors are here today (the history seed
      // could only cover the 38 that have actually invoiced us), so this is the
      // message a buyer is most likely to hit — it must read as a setup step,
      // not as a fault.
      return `Line ${n}: ${vendor.name} has no items mapped yet, so nothing can be ordered from them. Open Vendor Items (${VENDOR_ITEMS_PAGE}?vendor=${vendor.id}), add the items ${vendor.name} supplies, then save this PO again.${inheritNote}`;
    }

    if (!supplied.some(p => p.material_id === materialId)) {
      const alternatives = vendorsForMaterial(db, materialId)
        .filter(p => p.vendor_is_active)
        .map(p => p.vendor_name);
      const who = alternatives.length
        ? ` ${alternatives.length === 1 ? 'The mapped vendor for it is ' : 'Mapped vendors for it: '}${alternatives.slice(0, 4).join(', ')}${alternatives.length > 4 ? `, +${alternatives.length - 4} more` : ''}.`
        : ' No vendor is mapped to this item yet.';
      return `Line ${n}: ${vendor.name} is not mapped to supply "${itemLabel}".${who} Either pick a vendor that supplies it, or add the item to ${vendor.name} on Vendor Items (${VENDOR_ITEMS_PAGE}?vendor=${vendor.id}).${inheritNote}`;
    }
  }
  return null;
}
