import { getDb, generateId, updateMaterialPrice } from '@/lib/db';
import { readPoSnapshots, snapshotKey } from '@/lib/po-stock-snapshot';
import { centralFlowBlock, isStoreMappedMaterial } from '@/lib/store-engine';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canSeeAllDeptStock } from '@/lib/dept-stock';
import { checkPurchaseDate } from '@/lib/purchase-guard';
import { resolveVendorRef, isPairMapped } from '@/lib/vendor-mapping';
// THE DUPLICATE RULE LIVES IN ONE MODULE NOW — src/lib/line-dedupe.ts — and is
// imported by the PO routes, the bill modal AND this route. Do NOT restate any
// part of it inline here again: this file and src/app/purchases/page.tsx each
// carried their own copy of "what counts as a duplicate line", the two copies
// drifted (the modal grew a rate/brand/GST key, this route grew a same-rate
// merge), and that drift IS the bug this change closes. line-dedupe imports
// nothing, so the 'use client' bill page can import it too — keep it that way.
import { SPLIT_RATE_REMEDY } from '@/lib/line-dedupe';

/** ₹ for a human-readable note/message. */
function inr(n: number): string {
  return `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * What the mapping side of a purchase did, reported back on the POST response.
 *
 * `mapped` is the field the bill modal should branch on: FALSE means the pair
 * (this vendor, this item) is still not declared on Vendor Items, and the modal
 * should say so AFTER the successful save. It is a warning, never a refusal —
 * see the header comment on learnVendorMaterialPair().
 */
type VendorMappingOutcome = {
  status: 'learned' | 'already_mapped' | 'vendor_not_in_master' | 'no_vendor' | 'respected_removal' | 'error';
  /** Is the (vendor, item) pair declared in vendor_materials now that we are done? */
  mapped: boolean;
  vendor_id?: string;
  vendor_name?: string;
  /** Ready-to-show copy for the storekeeper. Present only when `mapped` is false
   *  AND there is something a human can act on. */
  warning?: string;
  /** Why, for the log / for a developer. */
  detail?: string;
};

/**
 * A BILL IS A FACT — THIS PATH NEVER APPLIES THE STRICT PO MAPPING RULE.
 *
 * DO NOT "align" this with /api/purchase-orders by calling vendorMappingError()
 * here. A PO is a document WE author, so refusing an undeclared (vendor, item)
 * pair costs nothing but a correction. A purchase is a bill the vendor has
 * ALREADY raised and goods already delivered — refusing it leaves a storekeeper
 * holding an invoice with nowhere to enter it, and the usual escape is to enter
 * it wrong (under another vendor, another item) rather than not at all. So an
 * unmapped pair here WARNS (the `vendor_mapping` block in the POST response,
 * which the bill modal surfaces) and always saves. The divergence is deliberate.
 *
 * What this function does instead is LEARN. Recording a purchase is the
 * strongest evidence there is that this vendor supplies this item, yet until
 * now NO purchase path wrote `vendor_materials` — the map could only grow from
 * the one-shot history seed, hand entry, or the backfill button, which is
 * exactly why it goes stale and the owner reads it as "sync not working".
 *
 * ─ IT MUST NEVER RESURRECT A DELETED MAPPING ─
 * `vendor_materials` has no tombstone: DELETE (/api/vendor-materials) removes
 * the row outright, so the SCHEMA CANNOT TELL "never mapped" FROM "unmapped on
 * purpose". This codebase already carries that bug shape once (a boot backfill
 * re-adding pairs an admin had deleted), so learning is gated on two durable
 * pieces of evidence instead of guessing:
 *
 *   1. AN ADDITIVE-ONCE MARKER. When (and ONLY when) this function creates a
 *      pair, it writes a `settings` row `vm_learned:<vendor_id>:<material_id>`.
 *      That row OUTLIVES the vendor_materials row, so a pair this code added
 *      can never be added by it a second time — once an admin deletes it, the
 *      deletion is final no matter how many more bills name that pair. Written
 *      on the learn path alone to keep this out of the generic settings KV:
 *      one row per pair ever auto-created, not one per pair ever purchased.
 *   2. PRE-SEED PURCHASE HISTORY. db.ts seeded the map once from `purchases`,
 *      so a pair that already had a purchase BEFORE that seed ran was offered
 *      to the map; if it is absent today, a human removed it. The seed instant
 *      is read back from the seeded rows' own created_at (settings has no
 *      timestamp column). If no seeded row survives, we fall back to treating
 *      ALL prior history as pre-seed — the conservative direction: skip the
 *      learn rather than risk the resurrection.
 *
 * A pair with only POST-seed history and no marker was never offered to
 * anybody, so creating it is genuinely additive.
 *
 * THE ONE CASE THE SCHEMA CANNOT SETTLE, stated rather than guessed at: a pair
 * typed BY HAND on Vendor Items, never purchased before the seed, and later
 * deleted, leaves no trace at all — a later bill for it will be learned once.
 * It is bounded to ONCE by rule 1, which is the deliberate difference from the
 * boot-backfill bug this codebase already had (that one re-added on every
 * restart). Closing it properly needs a tombstone column on vendor_materials
 * and a DELETE that writes one; that is a schema change, not a route change.
 *
 * Returns a short status for the response; never throws (the caller also wraps
 * it — a mapping problem must not roll back a recorded bill).
 */
function learnVendorMaterialPair(
  db: ReturnType<typeof getDb>,
  args: { vendorRaw: string; materialId: string; purchaseRowId: string; invoiceId: string; actor: string },
): VendorMappingOutcome {
  const materialId = String(args.materialId || '').trim();
  const rawName = String(args.vendorRaw || '').trim();
  if (!materialId || !rawName) return { status: 'no_vendor', mapped: false };

  // The SAME resolver the PO rule and the PO insert loops use — never a raw
  // name match. A bill from someone not in the Vendor master has no vendors.id
  // to map, and inventing a vendors row from a typed bill name is how the
  // master fills up with near-duplicates. Skip and say so.
  const vendor = resolveVendorRef(db, { vendor: rawName });
  if (vendor.status !== 'known' || !vendor.id) {
    return {
      status: 'vendor_not_in_master', mapped: false, detail: vendor.shown,
      warning: `The bill was saved, but "${rawName}" is not in the Vendor master, so this item could not be added to their Vendor Items list. Add the vendor under Vendors to keep vendor mapping accurate.`,
    };
  }

  const markerKey = `vm_learned:${vendor.id}:${materialId}`;

  // The common case by far: nothing to do, and nothing to warn about.
  if (isPairMapped(db, vendor.id, materialId)) {
    return { status: 'already_mapped', mapped: true, vendor_id: vendor.id, vendor_name: vendor.name };
  }

  // Copy shared by both "we are deliberately not re-adding this" outcomes: the
  // bill is recorded either way, and the only correct fix is a human decision on
  // Vendor Items — which is exactly what we must not make on their behalf.
  const removalWarning = `The bill was saved. ${vendor.name} is not mapped to supply this item, and it was NOT added back automatically because that pair was mapped before and removed. If it should be there, add it on Vendor Items (/vendors/materials?vendor=${vendor.id}).`;

  const marker = db.prepare('SELECT value FROM settings WHERE key = ?').get(markerKey) as any;
  if (marker) {
    return {
      status: 'respected_removal', mapped: false, vendor_id: vendor.id, vendor_name: vendor.name,
      warning: removalWarning,
      detail: 'this pair was mapped before and is not mapped now — treated as a deliberate removal',
    };
  }

  // The history seed's own timestamp, read off the rows it wrote. The
  // 'Backfilled from vendor_contracts' rows are a DIFFERENT migration and are
  // excluded. Sentinel '9999-12-31' = "no seeded row survives", which makes the
  // comparison below treat every prior purchase as pre-seed (skip, don't guess).
  const seed = db.prepare(`
    SELECT MIN(created_at) AS t FROM vendor_materials
    WHERE created_by = 'system' AND notes = 'seeded from purchase history'
  `).get() as any;
  const seedAt = String(seed?.t || '') || '9999-12-31';

  // Matched the way the seed matched: on the vendor NAME stored in `purchases`,
  // case/whitespace-insensitive — under BOTH the master's spelling and the
  // spelling this bill used, because the row we just wrote stores the caller's
  // string verbatim and an older row may carry either.
  const priorPreSeed = db.prepare(`
    SELECT 1 FROM purchases
    WHERE material_id = ?
      AND id <> ?
      AND LOWER(TRIM(COALESCE(vendor, ''))) IN (?, ?)
      AND COALESCE(created_at, '') < ?
    LIMIT 1
  `).get(materialId, args.purchaseRowId, vendor.name.toLowerCase(), rawName.toLowerCase(), seedAt);
  if (priorPreSeed) {
    // No marker written: this branch is deterministic (the history and the seed
    // instant do not change), so it will keep answering "removed" on its own
    // without a row per unmapped pair in the settings KV.
    return {
      status: 'respected_removal', mapped: false, vendor_id: vendor.id, vendor_name: vendor.name,
      warning: removalWarning,
      detail: 'this pair was already in purchase history when the map was seeded, so its absence is a removal',
    };
  }

  // created_by = 'system' (not the actor's email) on purpose: lib/vendor-mapping
  // pairSource() reads created_by='system' + a non-contract note as source
  // 'history', which is precisely what this is — the Vendor Items screen should
  // show it as learned from a purchase, not as somebody's hand entry. Who
  // entered the bill is kept in the note.
  // The note deliberately does NOT read exactly 'seeded from purchase history':
  // that exact string identifies the db.ts seed rows, and the seed-instant query
  // above must not start matching rows this function wrote.
  //
  // Keep these comments OUT of the template literal below. `//` is a JS comment,
  // not a SQL one — inside the string SQLite parses it as an operator and throws
  // `near "/": syntax error`, which this function catches and turns into a bland
  // status:'error'. That is exactly how the learner shipped silently broken:
  // every bill reported "saved", and not one pair was ever mapped.
  db.prepare(`
    INSERT OR IGNORE INTO vendor_materials (vendor_id, material_id, notes, created_by)
    VALUES (?, ?, ?, 'system')
  `).run(vendor.id, materialId, `learned from purchase ${args.invoiceId || '(no invoice id)'} entered by ${args.actor}`);
  // THE ADDITIVE-ONCE RECORD. Written only here, and never deleted: from now on
  // this pair is the admin's to keep or remove, and this code will not re-create
  // it. (INSERT OR IGNORE so a re-entry of the same bill cannot fail the write.)
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    .run(markerKey, new Date().toISOString());
  return { status: 'learned', mapped: true, vendor_id: vendor.id, vendor_name: vendor.name };
}

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const materialId = url.searchParams.get('material_id');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    // p.quantity is stored in PURCHASE units (kg, BTL) and p.unit_price per
    // purchase unit, so they ARE the natural display values. recipe_qty is the
    // recipe-unit equivalent (× pack_size when recipe_unit ≠ purchase_unit) for
    // the secondary "= 20,000 g" hint. total_price is the invoice amount.
    let query = `
      SELECT p.*, rm.name as material_name,
             grn.grn_number AS grn_number,
             grn.po_id      AS grn_po_id,
             rm.unit          AS material_unit,
             rm.purchase_unit AS material_purchase_unit,
             COALESCE(rm.pack_size, 1) AS material_pack_size,
             p.quantity   AS purchase_qty,
             p.unit_price AS purchase_unit_price,
             CASE WHEN COALESCE(rm.pack_size, 1) > 1
                       AND LOWER(rm.unit) <> LOWER(COALESCE(rm.purchase_unit, rm.unit))
                  THEN p.quantity * rm.pack_size
                  ELSE p.quantity
             END AS recipe_qty
      FROM purchases p
      JOIN raw_materials rm ON p.material_id = rm.id
      -- GRN number by the REAL foreign key, not by scraping notes. purchases
      -- carries grn_id and it is populated for every row that arrived through a
      -- goods receipt — both the PO-receive path and ad-hoc GRNs — which makes
      -- it the one identifier those rows always have. Invoice ID is blank on
      -- them and Bill No is blank on the ad-hoc ones. LEFT JOIN because most
      -- purchases (imports, direct bills) never touch a GRN at all and must
      -- come back with NULL rather than vanish from the list.
      LEFT JOIN goods_receipt_notes grn ON grn.id = p.grn_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (materialId) {
      query += ' AND p.material_id = ?';
      params.push(materialId);
    }
    if (from) {
      query += ' AND p.date >= ?';
      params.push(from);
    }
    if (to) {
      query += ' AND p.date <= ?';
      params.push(to);
    }

    query += ' ORDER BY p.date DESC, p.created_at DESC';

    const purchases = db.prepare(query).all(...params) as any[];

    /* RESOLVE po_id FROM THE GRN, because the stored column is usually empty.
     *
     * NOTHING WRITES purchases.po_id. All seven INSERT INTO purchases statements
     * in this codebase — PO receive, ad-hoc GRN, full bill, bulk, opening stock,
     * inward import, seed — omit the column. It is populated only by the boot
     * migration in db.ts, so a bill received since the last restart carries
     * po_id = NULL, the snapshot lookup below is never attempted, and the
     * "Stock when PO raised" cell falls to its em-dash branch. That is exactly
     * what shipped: the column read blank in production on a row whose PO No and
     * GRN No both rendered, because those two come from elsewhere — PO No is
     * parsed out of the notes text, GRN No from the grn_id foreign key.
     *
     * purchases.grn_id -> goods_receipt_notes.po_id is the honest structural
     * link and it is complete the instant a receipt is written: the receive route
     * stamps po_id onto the GRN row in the same transaction. The join is ALREADY
     * here for grn_number, so this costs one more column and no extra query.
     *
     * Resolved in JS, not as a second `AS po_id` after `p.*`: that would rely on
     * better-sqlite3 letting a later duplicate column silently overwrite an
     * earlier one, which is true today and is not a rule worth betting a stock
     * figure on.
     *
     * The stored column still wins when it is set — the boot migration's own
     * two-pass backfill (including the notes-text pass, which the GRN join
     * cannot reproduce) stays authoritative for the direct-bill rows it links.
     * This only fills in where nothing was stored.
     */
    for (const r of purchases) {
      if (!String(r?.po_id ?? '').trim() && String(r?.grn_po_id ?? '').trim()) {
        r.po_id = String(r.grn_po_id).trim();
      }
    }

    /* ATTACH THE STOCK-AT-RAISE SNAPSHOT.
     *
     * Without this the whole feature is invisible: po_line_stock_snapshots was
     * being written correctly and read by nobody, so every row on the Purchases
     * screen said "not recorded" — including POs raised minutes earlier with
     * their rows sitting on disk. readPoSnapshots was written and never called.
     *
     * ONE query for the whole page, not one per row. readPoSnapshots dedupes by
     * po_id, fetches once and filters to the exact (po_id, material_id) pairs.
     * better-sqlite3 is synchronous and this box is single-threaded, so a query
     * per row would block billing and KOT behind the report.
     *
     * A row with no po_id, or a pair with no snapshot, gets NOTHING — not a
     * zero-filled object. snapshotFromRow() on the page treats a missing
     * stock_at_po as "not recorded", which is the honest reading: we do not know
     * what the stock was, and that is different from knowing it was nil.
     */
    const snapKeys = purchases
      .filter((r) => r?.po_id && r?.material_id)
      .map((r) => ({ po_id: String(r.po_id), material_id: String(r.material_id) }));
    if (snapKeys.length > 0) {
      const snaps = readPoSnapshots(db, snapKeys);

      /* DEPARTMENT SCOPE. The stored snapshot carries a per-department breakdown,
       * and this endpoint served it to anyone: a user restricted to their own
       * department could read every other department's stock straight out of the
       * Purchases table. The live pickers honour the scope; this read did not.
       *
       * A restricted viewer gets the STORE half — which is not department data —
       * and no department figures at all, flagged dept_restricted so the page says
       * "some departments are hidden from you" rather than inventing a zero. That
       * flag already exists and snapshotFromRow() already reads it; nothing here
       * needs to guess.
       *
       * Suppressing the TOTAL as well as the per-department legs is deliberate:
       * dept_counted_qty is the sum across departments, so handing it over would
       * leak the very number the scope exists to withhold. */
      const viewer = await getCurrentUser();
      const seesAllDepts = !!viewer && canSeeAllDeptStock(viewer);

      for (const r of purchases) {
        if (!r?.po_id || !r?.material_id) continue;
        // snapshotKey(), not a hand-written template — the two must never drift.
        const hit = snaps.get(snapshotKey(String(r.po_id), String(r.material_id)));
        if (!hit) continue;
        r.stock_at_po = seesAllDepts
          ? hit
          : {
              ...hit,
              depts: [],
              dept_counted_qty: null,
              dept_counted_count: 0,
              dept_uncounted_count: 0,
              dept_restricted: true,
            };
      }
    }

    return Response.json({ purchases });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    // PRE-EXISTING GAP, closed here: this handler read the session ONLY to decide
    // the backdate exemption (`me?.role === 'admin'` below) and never rejected an
    // anonymous caller — while proxy.ts merely checks that a session cookie is
    // PRESENT, not that it is valid. So a forged cookie could POST a purchase:
    // stock bump, a purchases row, and updateMaterialPrice rewriting average_price
    // through every recipe. Mirrors the gate /api/grn already has.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const body = await request.json();
    const { material_id, vendor, brand, quantity, unit_price, date, notes,
            is_emergency, payment_mode, emergency_reason, bill_no,
            discount, delivery_charges, gst_rate, cess_rate } = body;
    // cgst/sgst ARE accepted on the wire (the bill modal computes them so it can
    // show the split before saving) and are then DISCARDED — see the derivation
    // below. Read here only to flag a client that disagrees with the server.
    const { cgst: cgstSent, sgst: sgstSent } = body;

    if (!material_id || !date) {
      return Response.json({ error: 'material_id and date are required' }, { status: 400 });
    }

    // Line sanity, NaN-safe — the same shape as /api/purchase-orders'
    // lineSanityError, minus its deliberate "a 0 rate is fine on a draft PO"
    // exception: a purchase writes STRAIGHT to stock and to updateMaterialPrice,
    // so the rate has to be real here, exactly as /api/purchase-orders/[id]/receive
    // demands on an accepted line.
    // The old `!quantity || !unit_price` test caught 0/blank/NaN but PASSED a
    // NEGATIVE number (`!(-900)` is false) and passed a non-numeric string
    // (`!'abc'` is false), which then stored total_price = NaN. A negative rate
    // reached updateMaterialPrice and gave the material a negative average_price.
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return Response.json({ error: 'quantity must be a number greater than 0 (in purchase units)' }, { status: 400 });
    }
    const px = Number(unit_price);
    if (!Number.isFinite(px) || px <= 0) {
      return Response.json({
        error: 'unit_price must be a number greater than 0 (₹ per purchase unit) — a zero or negative rate would rewrite this material\'s average price and every recipe cost built on it',
      }, { status: 400 });
    }

    // Per-line GST, as a PERCENT (5 | 12 | 18 …). ABSENT means exactly what it
    // meant before this field existed — no tax recorded, nothing else changed —
    // because the CSV importer (scripts/import-purchases.py) and any older client
    // still POST without it. A PRESENT but unusable value is rejected instead of
    // quietly zeroed: silently dropping the tax on a bill forfeits the input
    // credit, and nothing in the stored row would ever show that it went missing.
    const gstProvided = gst_rate !== undefined && gst_rate !== null && String(gst_rate).trim() !== '';
    const gstRateRaw = gstProvided ? Number(gst_rate) : 0;
    if (gstProvided && (!Number.isFinite(gstRateRaw) || gstRateRaw < 0 || gstRateRaw > 100)) {
      return Response.json({
        error: 'gst_rate must be a percentage between 0 and 100 (0 = exempt) — send no gst_rate at all to record a line with no tax',
      }, { status: 400 });
    }

    // GST COMPENSATION CESS, also a PERCENT. A SEPARATE levy from CGST/SGST —
    // 12% on aerated drinks, and tobacco at the bar — NOT a third slice of the
    // GST split, and NOT the TGBCL `special_excise_cess` column, which means
    // state excise everywhere it is read and labelled. Same absent/present
    // contract as gst_rate above, and rejected rather than zeroed for the same
    // reason. The rupees are ONLY EVER server-derived: unlike cgst/sgst there is
    // no legacy client posting a figure, so a `compensation_cess` in the body is
    // not read at all and cannot write money this row's goods value can't justify.
    const cessProvided = cess_rate !== undefined && cess_rate !== null && String(cess_rate).trim() !== '';
    const cessRateRaw = cessProvided ? Number(cess_rate) : 0;
    if (cessProvided && (!Number.isFinite(cessRateRaw) || cessRateRaw < 0 || cessRateRaw > 100)) {
      return Response.json({
        error: 'cess_rate must be a percentage between 0 and 100 (0 = none) — send no cess_rate at all to record a line with no compensation cess',
      }, { status: 400 });
    }

    // Configurable backdate window: non-admins can't save a date older than N days
    // or in the future; admins are exempt. (`me` is resolved and null-checked at
    // the top of the handler.)
    const dateCheck = checkPurchaseDate(db, date, me.role === 'admin');
    if (!dateCheck.ok) return Response.json({ error: dateCheck.error }, { status: 400 });

    // Book the purchase against the outlet the user is currently viewing, the
    // way /api/grn does. An unstamped (NULL) row is rewritten to the DEFAULT
    // outlet by the startup migration in db.ts, so a purchase entered at a
    // non-default outlet would silently land in the default outlet's reports.
    const outletId = await getCurrentOutletId();

    const material = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(material_id) as any;
    if (!material) {
      return Response.json({ error: 'Material not found' }, { status: 404 });
    }

    // Phase B store guard: store-mapped materials (liquor) must NEVER enter
    // Central Store purchases — they live in the store ledger only
    // (/api/stores/[id]/procure). Historical rows are untouched.
    const storeBlock = centralFlowBlock(db, material_id);
    if (storeBlock) return Response.json({ error: storeBlock }, { status: 400 });

    // qty/px (the validated numbers) from here down, so a numeric STRING from the
    // wire is stored as a number and can never reach the arithmetic un-coerced.
    const total_price = Math.round(qty * px * 100) / 100;
    const id = generateId();

    // Store-mapped (liquor) lines are ZERO-RATED on this path: their duty rides
    // on the TGBCL bill charges (excise / cess / TCS), not on GST. centralFlowBlock
    // above already rejects them outright today, so this is the second lock —
    // if that guard is ever relaxed for a category, a client that sent 18% must
    // still not write an input-credit figure the TGBCL charges already carry.
    const gstRate = isStoreMappedMaterial(db, material_id) ? 0 : gstRateRaw;
    // Same lock, same reason, and it matters MORE here: the TGBCL bill already
    // carries its own special cess, so a master cess% seeded onto a liquor line
    // would charge the venue the cess twice over — once in the store's excise
    // figure and once again as a compensation cess that was never levied.
    const cessRate = isStoreMappedMaterial(db, material_id) ? 0 : cessRateRaw;

    // RECORDED-ONLY discount, matching db.ts's contract: it never changes
    // unit_price/total_price, and readers compute
    //   Total Inward = total_price − discount + cgst + sgst + delivery …
    // So a caller must send `discount` ONLY when unit_price is still GROSS.
    // The bill form deliberately sends none: it nets the discount into
    // unit_price (the user's rule — a discount lowers what the goods cost),
    // so passing it here as well would subtract it twice.
    // Clamped to [0, total_price] because of that same subtraction: an
    // oversized discount (fat-fingered, or a hand-rolled API POST) would drag
    // Total Inward below zero. The bill form puts the same ceiling on its
    // bill-level discount (min(discount, subtotal)) before netting it into the
    // rate, so this is the server half of that rule. Hoisted out of the INSERT
    // because the tax below is computed on the POST-discount value and has to
    // use the SAME clamped rupees the row stores, or tax and Total Inward drift.
    const discountRecorded = Math.min(Math.max(0, Number(discount) || 0), total_price);

    // Tax is charged on the POST-DISCOUNT goods value, because that is what is
    // actually taxed. Both wire shapes land on the same base:
    //   • bill modal — discount already netted into unit_price, none sent, so
    //     total_price IS the post-discount value → taxable = total_price;
    //   • gross rate + `discount` — subtracted here.
    // Either way this is the contract's round2(line_total − discount_share).
    const taxable = Math.round((total_price - discountRecorded) * 100) / 100;
    // Whole-paise arithmetic on purpose. `taxable` is already a 2-dp rupee
    // amount, so taxable × rate IS the tax in paise (the ÷100 for percent and
    // the ×100 for paise cancel). Halving in paise keeps cgst + sgst re-adding
    // to the tax EXACTLY; halving in floats drifts a paisa and breaks the house
    // invariant tax_value = cgst + sgst that every reader re-adds. Doing the
    // percent in one step also avoids the float artifact in the naive
    // round2(taxable × rate ÷ 100): at ₹108351.75 @ 18% that writes 19503.31
    // where the true half-up value is 19503.32.
    const taxPaise  = gstRate > 0 ? Math.max(0, Math.round(taxable * gstRate)) : 0;
    const sgstPaise = Math.floor(taxPaise / 2);
    const cgstPaise = taxPaise - sgstPaise;   // odd paisa lands in CGST, per the contract
    const cgstAmt = cgstPaise / 100;
    const sgstAmt = sgstPaise / 100;

    // Compensation cess rides the SAME post-discount `taxable`, in the same
    // whole paise — and there the similarity ends. It is ONE figure, never
    // halved into a CGST/SGST pair, and it is deliberately kept OUT of
    // cgstAmt/sgstAmt: the house invariant tax_value = cgst + sgst is a
    // statement about GST alone, and folding cess into it would overstate the
    // GST claimed on a return. Readers pick cess up as its own Total Inward
    // term, exactly like the other recorded-only charges.
    const cessPaise = cessRate > 0 ? Math.max(0, Math.round(taxable * cessRate)) : 0;
    const compensationCess = cessPaise / 100;

    // The client's own cgst/sgst are never stored. This row is the input-credit
    // record, so the figure on it must follow from the goods value on the SAME
    // row — a miscalculating client, or a replayed / hand-edited payload, must
    // not be able to write a tax that doesn't. Log a real divergence so a UI
    // drift stays visible instead of being silently corrected on every bill for
    // months. Compared in INTEGER paise with a 1-paisa allowance: the client's
    // round2(taxable × rate ÷ 100) legitimately lands a paisa off on half-paisa
    // amounts (see above), and that is agreement, not drift.
    if (cgstSent !== undefined || sgstSent !== undefined) {
      const sentTax = (Number(cgstSent) || 0) + (Number(sgstSent) || 0);
      if (Math.abs(Math.round(sentTax * 100) - taxPaise) > 1) {
        console.warn(
          `[purchases] client tax ₹${sentTax.toFixed(2)} ≠ server-derived ₹${(taxPaise / 100).toFixed(2)} ` +
          `(material ${material_id}, taxable ₹${taxable.toFixed(2)} @ ${gstRate}%) — stored the derived figure`
        );
      }
    }

    // bill_no = the VENDOR's own bill number (from the "Enter Full Bill" modal).
    // Pure string ops, hoisted ABOVE the transaction because the duplicate
    // refusal below has to run before anything is written.
    const billNo = String(bill_no || '').trim();
    const vendorKey = String(vendor || '').toLowerCase().trim();

    /* ─────────────────────────────────────────────────────────────────────
     * ONE MATERIAL = ONE LINE ON A BILL — REFUSED HERE, EXACTLY LIKE A PO.
     *
     * The owner was told plainly that a split-rate bill is a real shape and
     * that this removes the path for it, and answered "YES WANT LIKE PO". So
     * identity is material_id ALONE, the same key /api/purchase-orders uses,
     * and a repeat is REFUSED — the old same-rate MERGE on this route and the
     * modal's old "keep both at a different rate" tick are both gone. The rule
     * itself lives in ONE module now (src/lib/line-dedupe.ts, imported at the
     * top of this file); what follows is only its SERVER half, because a
     * client-only rule is not a rule — the PO's strength has always been that
     * the route refuses no matter who is calling it.
     *
     * ONE REQUEST PER LINE. The bill modal POSTs each line as its own request,
     * so there is no multi-line payload to scan the way the PO routes scan
     * their items array. A duplicate is judged against what the SAME BILL —
     * (vendor, bill_no, date, outlet), the exact tuple the invoice_id block
     * below already treats as one bill — has ALREADY written.
     *
     * THE RETRY OF A HALF-FAILED SAVE LOOP is the case to hold in mind: when
     * the loop dies partway the modal re-runs it, re-posting the lines that
     * already landed. Those now 409 with "already recorded" and write NOTHING.
     * That is strictly safer than what it replaces — the old same-rate merge
     * quietly ADDED the quantity onto the existing row on every retry, doubling
     * stock with no error raised anywhere.
     *
     * NO RACE: there is no `await` between this read and the synchronous
     * better-sqlite3 insert transaction below, and better-sqlite3 is
     * synchronous, so no second request can slip between the check and the
     * write. Keep it that way — an await added in here reopens that window.
     *
     * A BLANK bill_no IS DELIBERATELY LEFT ALONE, and is the one place this
     * route does not behave like a PO. It carries no document identity: two
     * market runs for one item from one vendor on one day are two real
     * purchases, and refusing the second would destroy a fact. A PO always has
     * a document, so it has no analogue for this. Existing, documented
     * behaviour, unchanged here — and it is also what keeps
     * scripts/import-purchases.py (which sends no bill_no) working untouched.
     * ────────────────────────────────────────────────────────────────────── */
    const dupe = billNo ? db.prepare(`
      SELECT id, invoice_id, quantity, unit_price
      FROM purchases
      WHERE material_id = ?
        AND date = ?
        AND LOWER(TRIM(COALESCE(vendor, ''))) = ?
        AND LOWER(TRIM(COALESCE(bill_no, ''))) = ?
        AND COALESCE(outlet_id, '') = COALESCE(?, '')
        -- ONLY a hand-recorded vendor-bill line is judged against. Five other
        -- paths write the purchases table, and two stamp a bill_no: the PO
        -- receive MIRROR (a cost mirror of a GRN line, its quantity is the QC
        -- ACCEPTED figure and the PO⇄receipt reconciliation depends on it) and
        -- the inward-import commit. Neither mints an invoice_id, so requiring
        -- a PINV number scopes this to the two screens that record a bill by
        -- hand — this route and /api/purchases/bulk — and a hand-entered bill
        -- is never refused merely because a receipt somebody signed for at the
        -- bay happens to name the same item on the same day.
        AND COALESCE(invoice_id, '') LIKE 'PINV-%'
        -- …and only a PLAIN line. A row carrying inward-register figures this
        -- route did not write (TGBCL excise/cess, TCS, MRP round-off) or an
        -- ordered-vs-received po_qty belongs to a different flow, and refusing
        -- against it would block a line that repeats nothing a human typed on
        -- this screen.
        AND COALESCE(po_qty, 0) = 0
        AND COALESCE(special_excise_cess, 0) = 0
        AND COALESCE(tcs, 0) = 0
        AND COALESCE(mrp_round_off, 0) = 0
        -- compensation_cess is DELIBERATELY absent from those zero tests: it is
        -- a per-line share of this same bill, written by this same route, so a
        -- cess-bearing line is precisely the kind of line that must be caught.
      ORDER BY created_at ASC
      LIMIT 1
    `).get(material_id, date, vendorKey, billNo.toLowerCase(), outletId) as any : null;

    // RETURN, never throw. A throw inside the transaction below would be caught
    // by this handler's outer catch and reach the storekeeper as a bland 500 —
    // and this sentence is the whole answer they get now that the split-rate
    // path is gone, so it has to survive to the screen intact.
    if (dupe) {
      return Response.json({
        error:
          `"${material.name}" is already recorded on bill ${billNo} from ${vendor || 'this vendor'} dated ${date} — ` +
          `${dupe.quantity} @ ${inr(Number(dupe.unit_price))} (${dupe.invoice_id}). ` +
          `One item = one line on a bill, so this line was NOT saved; if you are re-trying after a failed save, ` +
          `that line is already in — take it off the bill and save the rest. ${SPLIT_RATE_REMEDY}`,
      }, { status: 409 });
    }

    // The transaction RETURNS its outcome rather than writing to an outer `let` —
    // `recordedId` is the row this line was written to, and it is what the
    // inventory ledger and the response point at.
    const insertPurchase = db.transaction(() => {
      const recordedId = id;
      let learned: VendorMappingOutcome = { status: 'no_vendor', mapped: false };

      // Create purchase record (with optional emergency / cash flags).
      // invoice_id (OUR number) is minted per vendor bill: reuse the id already
      // assigned to this (vendor, bill_no, date) so every line of one bill
      // shares it; otherwise take the next free PINV-<year>-#### number.
      let invoiceId = '';
      if (billNo) {
        const prior = db.prepare(`
          SELECT invoice_id FROM purchases
          WHERE COALESCE(invoice_id, '') <> ''
            AND LOWER(TRIM(COALESCE(vendor, ''))) = ?
            AND LOWER(TRIM(COALESCE(bill_no, ''))) = ?
            AND date = ?
          LIMIT 1
        `).get(vendorKey, billNo.toLowerCase(), date) as any;
        if (prior?.invoice_id) invoiceId = prior.invoice_id;
      }
      if (!invoiceId) {
        const yr = new Date().getFullYear();
        const last = db.prepare(
          `SELECT MAX(CAST(substr(invoice_id, length('PINV-' || ? || '-') + 1) AS INTEGER)) AS n
           FROM purchases WHERE invoice_id LIKE 'PINV-' || ? || '-%'`
        ).get(String(yr), String(yr)) as any;
        invoiceId = `PINV-${yr}-${String((Number(last?.n) || 0) + 1).padStart(4, '0')}`;
      }
      // unit_price (px) and total_price stay the GOODS figures — tax is NEVER
      // folded into them, and no "simplification" may ever add it. average_price
      // is derived from these columns and feeds every recipe cost in the app, so
      // folding GST in inflates every recipe by the tax rate, silently and
      // forever; and the tax, once inside the rate, is no longer reclaimable as
      // input credit. It belongs in cgst/sgst, which are RECORDED-ONLY columns
      // readers add back: Total Inward = total_price − discount + cgst + sgst
      // + compensation_cess + … The same holds for the cess: it is a levy paid
      // BESIDE the goods, so it stays out of the rate even though — unlike GST
      // — it is creditable only against cess output liability, never a general
      // input credit. Nothing may label it one.
      db.prepare(`
        INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes,
                               is_emergency, payment_mode, emergency_reason, invoice_id, bill_no, outlet_id,
                               discount, cgst, sgst, compensation_cess, delivery_charges, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(id, material_id, vendor || '', brand || '', qty, px, total_price, date, notes || '',
              is_emergency ? 1 : 0, payment_mode || '', emergency_reason || '', invoiceId, billNo, outletId,
              discountRecorded,
              // Server-derived halves of the tax on the post-discount value, never
              // the client's own numbers. cgstAmt + sgstAmt === the tax exactly
              // (integer paise), holding the house invariant tax_value = cgst + sgst.
              // Both are 0 when no gst_rate was sent — an older client or the CSV
              // importer writes precisely the row it wrote before this field existed.
              cgstAmt, sgstAmt,
              // Compensation cess, derived on the same base but NOT part of
              // that invariant — one figure, no halves. 0 when no cess_rate
              // was sent, so an older client or the CSV importer writes
              // precisely the row it wrote before this column existed.
              compensationCess,
              Math.max(0, Number(delivery_charges) || 0));

      // Stock is kept in RECIPE units (sales deduction, closing-stock variance
      // × average_price). quantity is entered in PURCHASE units, so multiply by
      // pack_size when recipe_unit ≠ purchase_unit — mirroring updateMaterialPrice().
      // THIS LINE'S OWN qty, always. There is no longer a branch that folds this
      // line into an existing row, so there is no longer any way to credit a
      // combined quantity here — which is exactly the doubling the old merge
      // could cause on a retry.
      const packSize = Number(material.pack_size) || 1;
      const ru = String(material.unit || '').toLowerCase().trim();
      const pu = String(material.purchase_unit || material.unit || '').toLowerCase().trim();
      const stockQty = (packSize > 1 && ru !== pu) ? qty * packSize : qty;

      // Update stock
      db.prepare(`
        UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?
      `).run(stockQty, material_id);

      // Create inventory transaction. reference_id points at the row this line
      // was written to, which is now always the row this request inserted.
      db.prepare(`
        INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at, outlet_id)
        VALUES (?, ?, 'purchase', ?, ?, ?, datetime('now'), ?)
      `).run(generateId(), material_id, stockQty, recordedId,
              `Purchase from ${vendor || 'unknown'}`,
              outletId);

      // Update material price and cascade
      updateMaterialPrice(db, material_id);

      // LEARN THE VENDOR ↔ ITEM PAIR — inside the same transaction, but wrapped:
      // a caught error does not roll a better-sqlite3 transaction back, so a
      // mapping problem can never undo a bill that is already recorded. The
      // purchase is the point of this request; the mapping is a by-product.
      try {
        const row = db.prepare('SELECT invoice_id FROM purchases WHERE id = ?').get(recordedId) as any;
        learned = learnVendorMaterialPair(db, {
          vendorRaw: String(vendor || ''),
          materialId: material_id,
          purchaseRowId: recordedId,
          invoiceId: String(row?.invoice_id || ''),
          actor: me.email,
        });
      } catch (e: any) {
        learned = { status: 'error', mapped: false, detail: String(e?.message || e) };
        console.error('[purchases] vendor↔item learning failed (purchase still recorded):', e);
      }

      return { recordedId, learned };
    });

    const { recordedId, learned } = insertPurchase();

    const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(recordedId);
    // `vendor_mapping` is the WARN half of the bill rule: once we get this far
    // the save HAS succeeded, and the client decides whether to tell the
    // storekeeper that this vendor is not declared to supply this item.
    // The four fields the old fold reported on are gone with the fold itself: a
    // duplicate is now a 409 above and never reaches this point, so a 201 here
    // always means exactly one new row. (Their only reader was the bill modal,
    // src/app/purchases/page.tsx — do not add them back to keep a toast alive.)
    return Response.json({ purchase, vendor_mapping: learned }, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
