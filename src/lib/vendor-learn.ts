// TYPE-ONLY on db.ts, exactly like src/lib/vendor-mapping.ts: this module never
// opens the database itself — every function is handed the caller's handle, so
// importing it cannot run the boot migrations from a test harness.
import type { getDb } from '@/lib/db';
import { resolveVendorRef, isPairMapped, type VendorRefLike } from '@/lib/vendor-mapping';

type DB = ReturnType<typeof getDb>;

/**
 * VENDOR ↔ ITEM LEARNING — THE WRITE SIDE OF vendor-mapping.ts, IN ONE PLACE.
 *
 * ── WHY THIS IS ITS OWN MODULE AND NOT A COPY IN EACH ROUTE ──────────────────
 * This function lived as a private function inside src/app/api/purchases/route.ts
 * and was reachable from exactly one screen: the "Enter Full Bill" modal. That
 * modal now records a GOODS RECEIPT instead of a bare purchase (POST /api/grn),
 * so the learner had to reach the GRN route or die with the form.
 *
 * There were three ways to do that and only one of them is safe:
 *   ✗ copy it into api/grn/route.ts — this codebase has already been burnt by
 *     exactly that: the old single-line "Add Purchase" button wrote the same
 *     `purchases` row by a second route, the two copies drifted, and the
 *     CASE/BTL entry-mode bug had to be fixed TWICE, once per form. The owner
 *     removed that button for that reason. Do not recreate it here.
 *   ✗ export it from api/purchases/route.ts — Next.js App Router validates the
 *     exported members of a `route.ts`; an extra export is a build-time type
 *     error, not a clever shortcut.
 *   ✓ lift it into src/lib, unchanged, and have BOTH routes import the one copy.
 *
 * It is NOT folded into src/lib/vendor-mapping.ts because that module is the
 * READ/VALIDATE side ("the one place the rule lives") and is imported by page
 * code; this is the only thing in the system that WRITES `vendor_materials`
 * automatically, and the resurrection guard below is the whole of its risk.
 * Keeping the writer separate keeps that risk in one readable file.
 *
 * THE BEHAVIOUR IS UNCHANGED FROM THE ORIGINAL, to the character, except for
 * one additive field: `vendorId`, so a caller that already holds a vendors.id
 * (the GRN header does) resolves by id rather than by re-matching a typed name.
 * resolveVendorRef() prefers the id and returns the master row's OWN spelling
 * for both halves, which is the identity every downstream reader keys on.
 */

/**
 * What the mapping side of a purchase did, reported back on the POST response.
 *
 * `mapped` is the field a bill form should branch on: FALSE means the pair
 * (this vendor, this item) is still not declared on Vendor Items, and the form
 * should say so AFTER the successful save. It is a warning, never a refusal —
 * see the header comment on learnVendorMaterialPair().
 */
export type VendorMappingOutcome = {
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
  /** Which line the warning is about, when a caller learns a whole bill at once
   *  (the GRN route does). Never read by the rule itself. */
  material_id?: string;
  material_name?: string;
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
 * which the bill form surfaces) and always saves. The divergence is deliberate.
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
 * ─ A GOODS RECEIPT IS THE SAME FACT AS A PURCHASE, HELD OR NOT ─
 * POST /api/grn calls this for every receivable line, INCLUDING the lines of a
 * receipt the Kitchen QC gate is holding. The evidence being recorded is "this
 * vendor delivered this item", and the truck has already been. Whether the
 * kitchen later accepts or rejects the goods changes the STOCK, not who
 * supplied them. `purchaseRowId` is '' on a held line (no `purchases` row
 * exists yet); the pre-seed history probe below then excludes nothing, which
 * errs toward SKIPPING the learn — the safe direction.
 *
 * Returns a short status for the response; never throws (callers also wrap it —
 * a mapping problem must not roll back a recorded bill or receipt).
 */
export function learnVendorMaterialPair(
  db: DB,
  args: {
    vendorRaw: string;
    /** vendors.id when the caller already has one (the GRN header does).
     *  Optional: resolveVendorRef falls back to a name match. */
    vendorId?: string;
    materialId: string;
    purchaseRowId: string;
    invoiceId: string;
    actor: string;
  },
): VendorMappingOutcome {
  const materialId = String(args.materialId || '').trim();
  const rawName = String(args.vendorRaw || '').trim();
  const rawId = String(args.vendorId || '').trim();
  if (!materialId || (!rawName && !rawId)) return { status: 'no_vendor', mapped: false };

  // The SAME resolver the PO rule and the PO insert loops use — never a raw
  // name match. A bill from someone not in the Vendor master has no vendors.id
  // to map, and inventing a vendors row from a typed bill name is how the
  // master fills up with near-duplicates. Skip and say so.
  const ref: VendorRefLike = { vendor_id: rawId || undefined, vendor: rawName || undefined };
  const vendor = resolveVendorRef(db, ref);
  if (vendor.status !== 'known' || !vendor.id) {
    return {
      status: 'vendor_not_in_master', mapped: false, detail: vendor.shown,
      warning: `The bill was saved, but "${rawName || rawId}" is not in the Vendor master, so this item could not be added to their Vendor Items list. Add the vendor under Vendors to keep vendor mapping accurate.`,
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
