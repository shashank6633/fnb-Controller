import type { Database } from 'better-sqlite3';
import type { SessionUser } from './auth';
import { generateId, logAuditEvent } from './db';
import {
  listStores, storeCategories, materialStoreId, getStoreById, userStoreAccess,
  postLedger, upsertBillCharges, normalizeBillCharges,
} from './store-engine';
import { packFactor, caseFactor, tripleToRecipe, fmtQtyNum } from './pack-units';
import { normalizeBillNo } from './bill-no';
import { canonNameInput } from './name-canon';
import { GrnRefused, logAuditOrThrow } from './grn-reversal';
import { planCentralDebit } from './central-debit-clamp';
import { todayIST } from './format-date';

/**
 * TGBCL LIQUOR BILLS ON THE GOODS RECEIPT SCREEN — owner rulings #83 / #84.
 *
 * A TGBCL liquor bill is typed on the regular Goods Receipt screen (GRN number
 * + our PINV like any vendor bill). On save its lines post STRAIGHT into the
 * store's own ledger — store_stock_ledger 'purchase' rows, the indent number as
 * the ref, cost per bottle, cases / bottles / loose — the way Direct Issue
 * routes perishables to the Kitchen. The bill-level TGBCL charges (MRP Rounding
 * Off, Bar Excise Turnover Tax, Special Excise Cess, TCS) are written through
 * the SAME upsertBillCharges the Liquor Store uses, in the same transaction, so
 * Invoice + charges = Net Indent and every Liquor Store report keeps working.
 *
 * ── WHAT IT NEVER WRITES, AND WHY THAT IS THE WHOLE DESIGN ────────────────
 * NO `purchases` rows and NO goods_receipt_note_items rows. 67 files read
 * `purchases` and 36 read goods_receipt_note_items; writing either would put
 * liquor into central stock, average_price, the Purchase Report and the
 * Inward Register unless every one of them were guarded. So none of them is
 * touched: no bumpStock, no inventory_transactions, no stampLastPurchase, no
 * updateMaterialPrice, no QC gate, no vendor↔item learning, no bill hand-over,
 * no petty cash. raw_materials.current_stock / average_price /
 * last_purchase_price / last_purchase_date are never written by this file —
 * recipe and pour cost stay on the Liquor Store's rate paid.
 *
 * What IS kept is the goods_receipt_notes HEADER: the GRN number (the same
 * GRN-yyyy-#### sequence), the document, and the duplicate guard. It is
 * flagged by store_dest_id (db.ts), carries its own PINV-yyyy-L#### in
 * store_invoice_id, and freezes the bill in store_bill_json at save. Readers
 * that JOIN goods_receipt_note_items exclude it by construction; the few
 * header-only readers are guarded explicitly where they live.
 *
 * ── VALUES ARE NEW BILL'S, ARITHMETIC FOR ARITHMETIC ─────────────────────
 * Same formulas as /api/stores/[id]/procure-bill (rate path) and
 * /procure-bulk (amount path): unit_cost = gross ₹/bottle ÷ packFactor (₹/case
 * ÷ caseFactor first), or amount ÷ recipe qty; per-line discount and delivery
 * are RECORDED ONLY on the ledger row and never netted into the rate; invoice
 * value = Σ of the rounded line totals; cgst / sgst are forced to 0 (liquor is
 * zero-rated on our side — its duty rides on the TGBCL charges).
 *
 * ── ONE DOOR PER INDENT ──────────────────────────────────────────────────
 * findIndentOnStoreRail refuses an indent already on the store rail by ANY
 * door — a live liquor GRN, ledger purchase rows from the old New Bill / CSV
 * rails, or a charges-only row (register uploads put the charges under the
 * header ref only). Compared in JS, case-, space- and invisible-character-
 * proof, because invoiceRefHasPurchases is TRIM/NOCASE only.
 *
 * SERVER-ONLY: imports better-sqlite3 through ./db. Never import this from a
 * 'use client' module.
 */

type AccessUser = Pick<SessionUser, 'id' | 'role' | 'is_head_chef' | 'is_store_manager' | 'position' | 'role_name'>;
type Actor = AccessUser & Pick<SessionUser, 'email'>;

/** Outcome shape every exported handler-helper returns; the route wraps it in
 *  Response.json so this module never builds an HTTP response itself. */
interface Outcome { status: number; body: Record<string, any> }

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n: number) => Math.round((Number(n) || 0) * 1e4) / 1e4;
const r6 = (n: number) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QTY_EPS = 1e-9;

/** THE indent comparison key: normalizeBillNo (invisible characters out,
 *  trimmed), then case-folded and every whitespace character removed, so
 *  "TG/123", " tg/123 ", "TG/ 123" and "TG/123<U+200B>" are one indent. Used on
 *  BOTH sides of every comparison — the stored refs are keyed the same way in
 *  JS rather than trusted to SQL TRIM/NOCASE. */
function indentKey(v: unknown): string {
  return normalizeBillNo(v).toLowerCase().replace(/\s+/g, '');
}

/** The material columns every liquor path needs (pack meta + identity). */
const MAT_COLS = `id, name, sku, category, unit, purchase_unit, pack_size, case_size`;

/** "12 btl (9,000 ml)" — purchase units FIRST, the recipe figure as the hint
 *  (owner rule: purchase units lead). A piece item with no pack conversion
 *  prints once, in its purchase unit. */
function qtyText(recipeQty: number, m: any): string {
  const pf = packFactor(m);
  const pu = String(m?.purchase_unit || m?.unit || '').trim().toLowerCase() || 'unit';
  const ru = String(m?.unit || '').trim();
  if (pf > 1) return `${fmtQtyNum(r6(recipeQty / pf))} ${pu} (${fmtQtyNum(r6(recipeQty))} ${ru})`;
  return `${fmtQtyNum(r6(recipeQty))} ${pu}`;
}

const listNames = (names: string[], max = 3) =>
  names.slice(0, max).map(n => `"${n}"`).join(', ') + (names.length > max ? ` and ${names.length - max} more` : '');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/grn?liquor_option=1 — which stores the GRN screen may offer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Active stores that own at least one category, with the caller's access and
 * the inputs the TGBCL Liquor Bill form needs. ADVISORY: the POST re-derives
 * access from the session and fails closed. recent_suppliers is only filled
 * for a store the caller may view or procure for.
 */
export function liquorGrnStores(db: Database, user: AccessUser | null | undefined) {
  const out: {
    id: string; name: string; code: string; can_view: boolean; can_procure: boolean;
    categories: string[]; recent_suppliers: string[];
  }[] = [];
  const supStmt = db.prepare(`
    SELECT TRIM(supplier) AS s, MAX(created_at) AS last
      FROM store_stock_ledger
     WHERE store_id = ? AND txn_type = 'purchase' AND TRIM(COALESCE(supplier, '')) <> ''
     GROUP BY LOWER(TRIM(supplier))
     ORDER BY last DESC
     LIMIT 30
  `);
  for (const s of listStores(db)) {
    if (!s.is_active) continue;
    const categories = storeCategories(db, s.id);
    if (categories.length === 0) continue;
    const access = userStoreAccess(db, user, s.id);
    const recent = (access.can_view || access.can_procure)
      ? (supStmt.all(s.id) as { s: string }[]).map(r => r.s)
      : [];
    out.push({
      id: s.id, name: s.name, code: s.code,
      can_view: access.can_view, can_procure: access.can_procure,
      categories, recent_suppliers: recent,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Line classification — which door does this bill belong to?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Splits a POST /api/grn payload by the store that owns each line's material
 * (materialStoreId — the store_category_map rule every guard uses). A line
 * whose material does not exist is neither: the central path 404s it exactly
 * as before, and the liquor path names it.
 * `store_ids.size === 0` ⇒ a Central Store bill, unchanged in every respect.
 */
export function classifyGrnLines(db: Database, items: any[]) {
  const store_ids = new Set<string>();
  const liquorLines: { index: number; item: any; material: any; store_id: string }[] = [];
  const centralLines: { index: number; item: any; material: any }[] = [];
  const missingLines: { index: number; item: any; material_id: string }[] = [];
  const names = new Map<string, string>();
  const matStmt = db.prepare(`SELECT ${MAT_COLS} FROM raw_materials WHERE id = ?`);
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const mid = String(item?.material_id || '').trim();
    const mat = mid ? (matStmt.get(mid) as any) : undefined;
    if (!mat) { missingLines.push({ index, item, material_id: mid }); return; }
    names.set(String(mat.id), String(mat.name || ''));
    const sid = materialStoreId(db, mat);
    if (sid) { store_ids.add(sid); liquorLines.push({ index, item, material: mat, store_id: sid }); }
    else centralLines.push({ index, item, material: mat });
  });
  return { store_ids, liquorLines, centralLines, missingLines, names };
}

// ─────────────────────────────────────────────────────────────────────────────
// The cross-rail indent duplicate guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this indent already on `storeId`'s rail, by any door? Checked in this
 * order so the most specific sentence wins: a live liquor GRN, then ledger
 * purchase rows (old New Bill / CSV, before the switch-over), then a
 * charges-only row. Voided liquor GRNs do not block — their rows and charges
 * were removed by the void, and the indent is free to be entered again.
 */
export function findIndentOnStoreRail(db: Database, storeId: string, indentNo: string): {
  where: 'grn' | 'ledger' | 'charges'; date: string; message: string;
  grn_id?: string; grn_number?: string;
} | null {
  const key = indentKey(indentNo);
  if (!key || !storeId) return null;
  const shown = normalizeBillNo(indentNo);
  const storeName = getStoreById(db, storeId)?.name || 'the store';

  const grns = db.prepare(`
    SELECT id, grn_number, date, invoice_number FROM goods_receipt_notes
     WHERE COALESCE(store_dest_id, '') = ? AND COALESCE(status, '') <> 'void'
     ORDER BY created_at ASC
  `).all(storeId) as any[];
  const g = grns.find(r => indentKey(r.invoice_number) === key);
  if (g) {
    return {
      where: 'grn', date: String(g.date || ''), grn_id: String(g.id), grn_number: String(g.grn_number),
      message: `Indent ${shown} is already recorded on ${g.grn_number} (${g.date}) — its bottles are already in ${storeName}, so it was not saved again. If that entry was wrong, an admin can void ${g.grn_number} and the bill can then be entered again.`,
    };
  }

  const refs = db.prepare(`
    SELECT ref, MIN(substr(created_at, 1, 10)) AS d FROM store_stock_ledger
     WHERE store_id = ? AND txn_type = 'purchase' AND TRIM(COALESCE(ref, '')) <> ''
     GROUP BY ref
  `).all(storeId) as any[];
  const hits = refs.filter(r => indentKey(r.ref) === key);
  if (hits.length > 0) {
    const d = hits.map(h => String(h.d || '')).sort()[0];
    return {
      where: 'ledger', date: d,
      message: `Indent ${shown} was already recorded in ${storeName} on ${d} (Inventory → Liquor Store, before liquor bills moved to Goods Receipt). Its bottles are already in stock, so it was not saved again.`,
    };
  }

  const charges = db.prepare(`
    SELECT invoice_ref, date, substr(created_at, 1, 10) AS c FROM store_bill_charges WHERE store_id = ?
  `).all(storeId) as any[];
  const ch = charges.find(r => indentKey(r.invoice_ref) === key);
  if (ch) {
    const d = String(ch.date || ch.c || '');
    return {
      where: 'charges', date: d,
      message: `Indent ${shown} already has TGBCL charges recorded in ${storeName} (${d}), so it was not saved again.`,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/grn — the liquor branch
// ─────────────────────────────────────────────────────────────────────────────

interface PreparedLine {
  index: number; material: any;
  cases: number; bottles: number; loose: number;
  recipe_qty: number; unit_cost: number; line_total: number;
  rate_basis: 'bottle' | 'case' | 'amount'; rate_entered: number;
  discount: number; delivery_charges: number;
  batch_no: string; expiry_date: string;
}

/**
 * The whole liquor branch of POST /api/grn: every refusal (in the contract's
 * order a → k, nothing written), then ONE synchronous transaction — GRN
 * header, one ledger 'purchase' row per line, upsertBillCharges (always, even
 * with four zero charges, so every liquor GRN has its Net Indent row), and the
 * frozen bill document. Synchronous from the duplicate check to the commit:
 * there is no await anywhere in here, so no second request can slip between
 * the check and the write (better-sqlite3 runs the closure uninterrupted).
 */
export function receiveLiquorGrn(db: Database, args: {
  me: Actor; body: any; items: any[];
  cls: ReturnType<typeof classifyGrnLines>;
  outletId: string | null; date: string; vendor: string; invoiceNumber: string;
  paidInCash: boolean; noBill: boolean;
}): Outcome {
  const { me, body: b, cls, outletId } = args;
  const date = String(args.date || '').trim();
  const storeIds = Array.from(cls.store_ids);

  // A bill sent AS a liquor bill whose items no longer belong to any store
  // (a category mapping removed while the form was open) must not fall
  // through to the Central Store path — it would book central stock and the
  // average price from a form the user filled in as a liquor bill.
  if (storeIds.length === 0) {
    if (cls.centralLines.length === 0 && cls.missingLines.length > 0) {
      const m = cls.missingLines[0];
      return { status: 404, body: { error: `Line ${m.index + 1}: material not found (${m.material_id || 'no material_id sent'}). Nothing was saved.` } };
    }
    return { status: 400, body: {
      error: `None of these items belongs to a store location (Settings → Store Locations → categories), so this can't be saved as a TGBCL liquor bill. Central Store items are entered on Enter Vendor Bill. Nothing was saved.`,
    } };
  }

  // a. A mixed bill — two doors, two receipts.
  if (cls.centralLines.length > 0) {
    const store = getStoreById(db, storeIds[0]);
    const sName = store?.name || 'store location';
    return { status: 400, body: {
      mixed_bill: true,
      error: `This bill mixes ${sName} items (${listNames(cls.liquorLines.map(l => l.material.name))}) with Central Store items (${listNames(cls.centralLines.map(l => l.material.name))}). They are recorded through two different doors, so save them as two receipts: the liquor lines on Goods Receipt → TGBCL Liquor Bill, the rest on Enter Vendor Bill. Nothing was saved.`,
    } };
  }
  // b. Lines owned by more than one store.
  if (storeIds.length > 1) {
    const names = storeIds.map(id => getStoreById(db, id)?.name || id);
    return { status: 400, body: {
      error: `These items belong to different store locations (${names.join(', ')}) — enter one store's bill at a time. Nothing was saved.`,
    } };
  }
  const storeId = storeIds[0];
  const store = getStoreById(db, storeId);
  const sName = store?.name || 'store location';

  // c. A liquor bill sent through the central form.
  if (b?.liquor !== true) {
    const ns = cls.liquorLines.map(l => String(l.material.name || ''));
    const one = ns.length === 1;
    return { status: 400, body: {
      liquor_bill_required: true,
      error: `${listNames(ns)} ${one ? 'is a' : 'are'} ${sName} item${one ? '' : 's'}. Liquor bills are entered on Goods Receipt → TGBCL Liquor Bill (cases / bottles / loose and the TGBCL charges) — the bottles go straight into ${sName}. Nothing was saved.`,
    } };
  }
  // d. The form's store and the items' store must agree.
  const sentStore = String(b?.store_id || '').trim();
  if (sentStore && sentStore !== storeId) {
    const sent = getStoreById(db, sentStore)?.name || `"${sentStore}"`;
    return { status: 400, body: { error: `These items belong to ${sName}, not ${sent}. Nothing was saved.` } };
  }
  // e. The store is live and the caller may procure for it.
  if (!store || !store.is_active || !userStoreAccess(db, me, storeId).can_procure) {
    return { status: 403, body: {
      error: `You are not authorised to receive into ${sName} (Settings → Store Locations → user access, 'procure'). Nothing was saved.`,
    } };
  }
  // f. Petty cash — the store rail has no cash-box entry.
  if (args.paidInCash) {
    return { status: 400, body: {
      cash_denied: true,
      error: 'A liquor bill can\'t be recorded as a petty-cash purchase — the Liquor Store rail has no cash-box entry. Untick "Paid in cash from petty cash". Nothing was saved.',
    } };
  }
  // g. The indent number is the bill's identity on the store rail.
  const indentNo = normalizeBillNo(args.invoiceNumber);
  if (args.noBill || !indentNo) {
    return { status: 400, body: {
      error: `A TGBCL liquor bill needs its indent / invoice number — it is how ${sName}, its reports and the duplicate check find the bill. Nothing was saved.`,
    } };
  }
  // h. The receipt date — a real calendar date, and never ahead of today
  //    (admins too: checkPurchaseDate exempts admins, and a future-dated
  //    ledger row would put bottles in the store before they arrived).
  if (!DATE_RE.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    return { status: 400, body: { error: 'A valid date (YYYY-MM-DD) is required.' } };
  }
  if (date > todayIST()) {
    return { status: 400, body: {
      error: `A liquor bill can't be dated ${date} — that is after today. Use the day the bottles arrived. Nothing was saved.`,
    } };
  }
  // i. The supplier — the store's reports group bills by it.
  let supplier = canonNameInput(args.vendor);
  const vendorId = String(b?.vendor_id || '').trim();
  if (vendorId) {
    const v = db.prepare('SELECT id, name FROM vendors WHERE id = ?').get(vendorId) as any;
    if (!v) return { status: 400, body: { error: 'Unknown vendor' } };
    if (!supplier) supplier = canonNameInput(v.name);
  }
  if (!supplier) {
    return { status: 400, body: { error: `Enter the supplier — ${sName}'s reports group bills by it. Nothing was saved.` } };
  }

  // The four bill-level charges. MRP Rounding Off is SIGNED (a TGBCL indent
  // often rounds DOWN); the three levies may not be negative. Refused rather
  // than silently zeroed (normalizeBillCharges clamps), so the stored bill is
  // the bill that was typed.
  const rawCharges = (b?.liquor_charges && typeof b.liquor_charges === 'object') ? b.liquor_charges : {};
  const CHARGE_LABEL: Record<string, string> = {
    mrp_rounding: 'MRP Rounding Off', excise_turnover_tax: 'Bar Excise Turnover Tax',
    special_excise_cess: 'Special Excise Cess', tcs: 'TCS',
  };
  for (const k of Object.keys(CHARGE_LABEL)) {
    const v = rawCharges[k];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      return { status: 400, body: { error: `${CHARGE_LABEL[k]} must be a number. Nothing was saved.` } };
    }
    if (k !== 'mrp_rounding' && n < 0) {
      return { status: 400, body: { error: `${CHARGE_LABEL[k]} can't be negative — only MRP Rounding Off can be. Nothing was saved.` } };
    }
  }
  const charges = normalizeBillCharges(rawCharges);

  // j. Every line, validated before anything is written.
  if (cls.missingLines.length > 0) {
    const m = cls.missingLines[0];
    return { status: 404, body: { error: `Line ${m.index + 1}: material not found (${m.material_id || 'no material_id sent'}). Nothing was saved.` } };
  }
  const num = (v: any) => (v === undefined || v === null || String(v).trim() === '') ? 0 : Number(v);
  const prepared: PreparedLine[] = [];
  for (const l of [...cls.liquorLines].sort((x, y) => x.index - y.index)) {
    const it = l.item || {};
    const mat = l.material;
    const at = `Line ${l.index + 1} (${mat.name})`;
    const bad = (msg: string): Outcome => ({ status: 400, body: { error: `${at}: ${msg}. Nothing was saved.`, line: l.index + 1 } });
    if (materialStoreId(db, mat) !== storeId) return bad(`it is not a ${sName} item`);
    const cases = num(it.cases), bottles = num(it.bottles), loose = num(it.loose);
    if (![cases, bottles, loose].every(v => Number.isFinite(v))) return bad('cases, bottles and loose must be numbers');
    if (cases < 0 || bottles < 0 || loose < 0) return bad('quantities must be 0 or more');
    const pf = packFactor(mat);
    const cf = caseFactor(mat);
    const pu = String(mat.purchase_unit || mat.unit || 'units');
    // tripleToRecipe silently drops a loose figure on a piece item and reads a
    // "case" on an item with no case size as ONE purchase unit. Either would
    // book a quantity nobody typed, so both are refused with the fix named.
    if (cases > 0 && cf <= 1) return bad(`this item has no case size set, so ${fmtQtyNum(cases)} case(s) can't be converted to ${pu} — enter the ${pu} count (or set the case size on the item first)`);
    if (loose > 0 && pf <= 1) return bad(`this item is counted in whole ${pu} — it has no loose measure`);
    const recipeQty = tripleToRecipe(cases, bottles, loose, mat);
    if (!(recipeQty > 0)) return bad('enter a quantity — cases, bottles and/or loose');

    const up = num(it.unit_price);
    const am = num(it.amount);
    if (!Number.isFinite(up) || up < 0) return bad('the rate must be a number of 0 or more');
    if (!Number.isFinite(am) || am < 0) return bad('the line amount must be a number of 0 or more');
    let unitCost = 0;
    let rateBasis: PreparedLine['rate_basis'] = 'bottle';
    let rateEntered = 0;
    if (up > 0) {
      if (it.per_case === true && cf <= 1) {
        return bad(`a rate per case was entered, but this item has no case size set — enter the rate per ${pu}`);
      }
      // rate-basis: purchase — ₹ per CASE ÷ (bottles per case) = ₹ per bottle
      // (the PURCHASE unit); the ÷ packFactor below takes it to ₹/recipe unit.
      const perBottle = it.per_case === true ? up / cf : up;
      // rate-basis: recipe — ₹ per purchase unit ÷ recipe units per purchase
      // unit = ₹ per RECIPE unit, the basis store_stock_ledger.unit_cost holds
      // (procure-bill:120-123 byte-for-byte).
      unitCost = pf > 1 ? perBottle / pf : perBottle;
      rateBasis = it.per_case === true ? 'case' : 'bottle';
      rateEntered = up;
    } else if (am > 0) {
      // rate-basis: recipe — line ₹ ÷ recipe-unit qty = ₹ per recipe unit
      // (procure-bulk:221-223).
      unitCost = am / recipeQty;
      rateBasis = 'amount';
      rateEntered = am;
    } else {
      return bad('enter the rate per bottle (or per case) or the line amount');
    }
    // rate-basis: recipe — recipe-unit qty × ₹ per recipe unit.
    const lineTotal = r2(recipeQty * unitCost);
    const discRaw = num(it.discount);
    const delRaw = num(it.delivery_charges);
    if (!Number.isFinite(discRaw) || discRaw < 0) return bad('the discount must be a number of 0 or more');
    if (!Number.isFinite(delRaw) || delRaw < 0) return bad('delivery charges must be a number of 0 or more');
    prepared.push({
      index: l.index, material: mat, cases, bottles, loose,
      recipe_qty: recipeQty, unit_cost: unitCost, line_total: lineTotal,
      rate_basis: rateBasis, rate_entered: rateEntered,
      // Recorded only, exactly as New Bill records it — clamped to the line's
      // own goods value, never netted into unit_cost.
      discount: r2(Math.min(discRaw, lineTotal)), delivery_charges: r2(delRaw),
      batch_no: String(it.batch_no || '').trim().slice(0, 120),
      expiry_date: String(it.expiry_date || '').trim().slice(0, 40),
    });
  }
  if (prepared.length === 0) {
    return { status: 400, body: { error: 'items array required' } };
  }

  // k. One door per indent — a HARD refusal; confirm_duplicate_bill has no
  //    effect here. Re-checked inside the transaction below.
  const dup = findIndentOnStoreRail(db, storeId, indentNo);
  if (dup) {
    return { status: 409, body: {
      error: dup.message, duplicate_indent: true,
      ...(dup.grn_number ? { existing_grn_number: dup.grn_number } : {}),
    } };
  }

  const invoiceValue = r2(prepared.reduce((s, p) => s + p.line_total, 0));
  const storeSigned = !!(b?.qc_expiry && b?.qc_weight && b?.qc_invoice_match);
  const grnId = generateId();
  let grnNumber = '';
  let pinv = '';
  const ledgerIds: string[] = [];
  let billCharges: ReturnType<typeof upsertBillCharges> | null = null;
  let billDoc: any = null;

  try {
    db.transaction(() => {
      // 1. The duplicate guard again, inside the write lock.
      const again = findIndentOnStoreRail(db, storeId, indentNo);
      if (again) {
        throw new GrnRefused(409, again.message, {
          duplicate_indent: true, ...(again.grn_number ? { existing_grn_number: again.grn_number } : {}),
        });
      }
      // 2. The GRN number (grn/route.ts:1602-1605, the same sequence) and our
      //    liquor PINV series (PINV-yyyy-L####, the grn/route.ts:1787 year
      //    convention). Minted here, inside the transaction, so two saves in
      //    this process can never take the same number.
      const yr = date.slice(0, 4);
      const lastGrn = db.prepare(`SELECT grn_number FROM goods_receipt_notes WHERE grn_number LIKE 'GRN-' || ? || '-%' ORDER BY grn_number DESC LIMIT 1`).get(yr) as any;
      const nextNum = lastGrn?.grn_number ? parseInt(String(lastGrn.grn_number).split('-').pop() || '0', 10) + 1 : 1;
      grnNumber = `GRN-${yr}-${String(nextNum).padStart(4, '0')}`;
      const y = String(new Date().getFullYear());
      const lastL = db.prepare(`
        SELECT MAX(CAST(substr(store_invoice_id, length('PINV-' || ? || '-L') + 1) AS INTEGER)) AS n
          FROM goods_receipt_notes WHERE store_invoice_id LIKE 'PINV-' || ? || '-L%'
      `).get(y, y) as any;
      pinv = `PINV-${y}-L${String((Number(lastL?.n) || 0) + 1).padStart(4, '0')}`;

      // 3. The header — the document, the GRN number and the guard. Never held
      //    for QC (status 'received', qc_required 0): QC is a Central Store gate.
      db.prepare(`
        INSERT INTO goods_receipt_notes
          (id, grn_number, date, po_id, vendor_id, vendor, invoice_number, invoice_date,
           received_by, qc_by, status, notes, outlet_id,
           qc_quality, qc_temperature, qc_expiry, qc_damage, qc_weight, qc_invoice_match,
           qc_required, qc_checker, qc_outcome, qc_store_by, qc_store_at,
           created_at, store_dest_id, store_invoice_id, store_bill_json)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'received', ?, ?, 0, 0, ?, 0, ?, ?, 0, '', '',
                ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, datetime('now'), ?, ?, '')
      `).run(
        grnId, grnNumber, date, vendorId || null, supplier, indentNo, String(b?.invoice_date || '').trim(),
        me.email, String(b?.qc_by || '').trim(), String(b?.notes || ''), outletId,
        b?.qc_expiry ? 1 : 0, b?.qc_weight ? 1 : 0, b?.qc_invoice_match ? 1 : 0,
        storeSigned ? me.email : '', storeSigned ? 1 : 0,
        storeId, pinv,
      );

      // 4. One store-ledger 'purchase' row per line, dated the GRN date
      //    (procure-bill:140-142's backdate, verbatim).
      const backdate = db.prepare(`
        UPDATE store_stock_ledger SET created_at = ? || ' ' || strftime('%H:%M:%S', 'now') WHERE id = ?
      `);
      for (const p of prepared) {
        const id = postLedger(db, {
          store_id: storeId, material_id: String(p.material.id), txn_type: 'purchase',
          quantity: p.recipe_qty, unit_cost: p.unit_cost, batch_no: p.batch_no,
          supplier, vendor_id: vendorId, expiry_date: p.expiry_date,
          ref: indentNo, notes: `Goods Receipt ${grnNumber} · ${pinv}`, created_by: me.email,
          discount: p.discount, cgst: 0, sgst: 0, delivery_charges: p.delivery_charges,
        });
        backdate.run(date, id);
        ledgerIds.push(id);
      }

      // 5. The TGBCL charges — ALWAYS, so every liquor GRN has its Net Indent
      //    row (and any hook that lives inside upsertBillCharges fires for it).
      billCharges = upsertBillCharges(db, {
        store_id: storeId, invoice_ref: indentNo, supplier, date,
        invoice_value: invoiceValue, charges, created_by: me.email,
      });

      // 6. The bill document, frozen. Written once, never edited.
      billDoc = {
        v: 1, store_id: storeId, store_name: sName, pinv, indent_no: indentNo,
        supplier, vendor_id: vendorId, date,
        posted_at: new Date().toISOString(), posted_by: me.email,
        lines: prepared.map((p, i) => {
          const pf = packFactor(p.material);
          return {
            ledger_id: ledgerIds[i], material_id: String(p.material.id), material_name: String(p.material.name || ''),
            category: String(p.material.category || ''), unit: String(p.material.unit || ''),
            purchase_unit: String(p.material.purchase_unit || p.material.unit || ''),
            pack_factor: pf, case_factor: caseFactor(p.material),
            cases: p.cases, bottles: p.bottles, loose: p.loose,
            recipe_qty: p.recipe_qty,
            purchase_qty: r6(p.recipe_qty / pf),
            rate_basis: p.rate_basis, rate_entered: p.rate_entered,
            // rate-basis: purchase — ₹ per recipe unit × recipe units per
            // purchase unit = ₹ per bottle (display copy; money uses unit_cost).
            rate_per_bottle: r4(p.unit_cost * pf),
            unit_cost: p.unit_cost, line_total: p.line_total,
            discount: p.discount, delivery_charges: p.delivery_charges,
            batch_no: p.batch_no, expiry_date: p.expiry_date,
          };
        }),
        charges: {
          mrp_rounding: billCharges.mrp_rounding, excise_turnover_tax: billCharges.excise_turnover_tax,
          special_excise_cess: billCharges.special_excise_cess, tcs: billCharges.tcs,
        },
        invoice_value: billCharges.invoice_value, net_indent_value: billCharges.net_indent_value,
      };
      db.prepare(`UPDATE goods_receipt_notes SET store_bill_json = ? WHERE id = ?`).run(JSON.stringify(billDoc), grnId);
    })();
  } catch (e: any) {
    if (e instanceof GrnRefused) return { status: e.httpStatus, body: { error: e.message, ...(e.payload || {}) } };
    throw e;
  }

  const bc = billCharges as unknown as ReturnType<typeof upsertBillCharges>;
  // Best-effort, AFTER the commit: the bill is the money-critical write. Carries
  // store_id at the top level of after_json so the Liquor Store Audit report
  // (stores/[id]/reports 'audit') lists it, and entity goods_receipt_note so
  // the GRN's own admin history shows it.
  logAuditEvent(db, {
    event_type: 'store.procure_grn',
    entity_type: 'goods_receipt_note',
    entity_id: grnId,
    actor_email: me.email,
    outlet_id: outletId,
    after: {
      store_id: storeId, store: sName, grn_number: grnNumber, pinv, invoice_ref: indentNo,
      supplier, vendor_id: vendorId, date,
      lines: billDoc.lines.map((l: any) => ({
        ledger_id: l.ledger_id, material_id: l.material_id, material: l.material_name,
        cases: l.cases, bottles: l.bottles, loose: l.loose,
        recipe_qty: l.recipe_qty, recipe_unit: l.unit, purchase_qty: l.purchase_qty,
        rate_per_bottle: l.rate_per_bottle, unit_cost: l.unit_cost, line_total: l.line_total,
        discount: l.discount, delivery_charges: l.delivery_charges,
        batch_no: l.batch_no, expiry_date: l.expiry_date,
      })),
      total_value: invoiceValue,
      bill_charges: bc,
    },
    note: `${sName}: bill ${indentNo} from ${supplier} on Goods Receipt ${grnNumber} · ${pinv} — ${prepared.length} line(s), ₹${invoiceValue} (Net Indent ₹${bc.net_indent_value})`,
  });

  const grn = db.prepare('SELECT * FROM goods_receipt_notes WHERE id = ?').get(grnId) as any;
  if (grn) delete grn.store_bill_json;
  return { status: 201, body: {
    success: true, liquor: true,
    grn_id: grnId, grn_number: grnNumber, invoice_id: pinv, grn,
    store: { id: storeId, name: sName },
    posted: prepared.length,
    lines: billDoc.lines.map((l: any) => ({
      material_id: l.material_id, material_name: l.material_name, ledger_id: l.ledger_id,
      recipe_qty: l.recipe_qty, purchase_qty: l.purchase_qty, rate_per_bottle: l.rate_per_bottle,
      unit_cost: l.unit_cost, line_total: l.line_total,
    })),
    invoice_value: invoiceValue,
    bill_charges: bc,
    materials_touched: 0, store_blocked: [], qc_required: false, qc_status: 'received',
    vendor_mapping: [], paid_in_cash: false,
  } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the frozen document back
// ─────────────────────────────────────────────────────────────────────────────

/** grn.liquor on the detail read: the frozen bill document plus store_dest_id.
 *  null on a central receipt. A document that cannot be parsed degrades to a
 *  flagged empty shell rather than 500-ing the whole detail read. */
export function readStoreBill(grn: any): Record<string, any> | null {
  const dest = String(grn?.store_dest_id || '').trim();
  if (!dest) return null;
  try {
    const doc = JSON.parse(String(grn?.store_bill_json || ''));
    if (doc && typeof doc === 'object') return { ...doc, store_dest_id: dest };
  } catch { /* fall through */ }
  return {
    v: 0, unreadable: true, store_dest_id: dest, store_id: dest, store_name: '',
    pinv: String(grn?.store_invoice_id || ''), indent_no: String(grn?.invoice_number || ''),
    lines: [], charges: { mrp_rounding: 0, excise_turnover_tax: 0, special_excise_cess: 0, tcs: 0 },
    invoice_value: 0, net_indent_value: 0,
  };
}

/** row.liquor on the list read — just what a list row prints. null on a
 *  central receipt. Parsed in JS (try/catch), never with SQL json_extract. */
export function summariseStoreBill(grn: any): {
  store_id: string; store_name: string; pinv: string; line_count: number;
  invoice_value: number; net_indent_value: number;
} | null {
  const dest = String(grn?.store_dest_id || '').trim();
  if (!dest) return null;
  let doc: any = null;
  try { doc = JSON.parse(String(grn?.store_bill_json || '')); } catch { doc = null; }
  return {
    store_id: dest,
    store_name: String(doc?.store_name || ''),
    pinv: String(doc?.pinv || grn?.store_invoice_id || ''),
    line_count: Array.isArray(doc?.lines) ? doc.lines.length : 0,
    invoice_value: Number(doc?.invoice_value) || 0,
    net_indent_value: Number(doc?.net_indent_value) || 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/grn/[id] — void a liquor GRN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Take a liquor bill's bottles back out of the store and remove its TGBCL
 * charges, keeping the header and the frozen document (struck through) — the
 * way a central void keeps its line items. ONE transaction; every refusal
 * throws and rolls the claim back. REFUSES, never clamps: postLedger has no
 * lower bound, so a void after bottles moved to a floor bar (or were counted)
 * would otherwise drive the store negative or rewrite a counted book.
 * No central writes, no updateMaterialPrice — this rail never touched them.
 */
export function voidLiquorGrn(db: Database, args: { grn: any; me: Actor; reason: string }): Outcome {
  const { grn, me } = args;
  const reason = String(args.reason || '').trim();
  const grnId = String(grn.id);
  const storeId = String(grn.store_dest_id || '').trim();
  const store = getStoreById(db, storeId);
  const sName = store?.name || 'the store';
  const removed: { material_id: string; material_name: string; recipe_qty: number; purchase_qty: number }[] = [];
  try {
    db.transaction(() => {
      // 1. Claim — the write lock and the replay guard in one statement.
      const claim = db.prepare(`
        UPDATE goods_receipt_notes
           SET status = 'void', voided_at = datetime('now'), voided_by = ?, void_reason = ?
         WHERE id = ? AND status <> 'void'
      `).run(me.email, reason, grnId);
      if (claim.changes === 0) {
        throw new GrnRefused(409, `${grn.grn_number} is already voided. Nothing was reversed a second time.`, { code: 'already_void' });
      }

      // 2. The rows this bill posted, by id, exactly as it recorded them.
      let doc: any = null;
      try { doc = JSON.parse(String(grn.store_bill_json || '')); } catch { doc = null; }
      const lines: any[] = Array.isArray(doc?.lines) ? doc.lines : [];
      const mismatch = () => new GrnRefused(409,
        `The ${sName} rows this bill posted no longer match what it recorded, so reversing them could take out the wrong bottles. Nothing was changed. Correct it with an Adjustment on Inventory → Liquor Store.`,
        { code: 'store_rows_mismatch' });
      if (!doc || lines.length === 0) {
        throw new GrnRefused(409,
          `The bill document saved on ${grn.grn_number} can't be read, so the ${sName} rows it posted can't be identified and nothing can safely be taken back out. Nothing was changed. Correct it with an Adjustment on Inventory → Liquor Store.`,
          { code: 'store_bill_unreadable' });
      }
      const rowStmt = db.prepare(`SELECT * FROM store_stock_ledger WHERE id = ?`);
      const ledgerRows: any[] = [];
      const seen = new Set<string>();
      for (const l of lines) {
        const lid = String(l?.ledger_id || '');
        if (!lid || seen.has(lid)) throw mismatch();
        seen.add(lid);
        const row = rowStmt.get(lid) as any;
        if (!row
            || String(row.store_id) !== storeId
            || String(row.material_id) !== String(l.material_id)
            || String(row.txn_type) !== 'purchase'
            || Math.abs((Number(row.quantity) || 0) - (Number(l.recipe_qty) || 0)) > QTY_EPS) {
          throw mismatch();
        }
        ledgerRows.push(row);
      }

      // 3. Per material: the store must still hold what this bill added.
      const posted = new Map<string, number>();
      for (const r of ledgerRows) posted.set(String(r.material_id), (posted.get(String(r.material_id)) || 0) + Number(r.quantity));
      const matStmt = db.prepare(`SELECT ${MAT_COLS} FROM raw_materials WHERE id = ?`);
      const onHandStmt = db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM store_stock_ledger WHERE store_id = ? AND material_id = ?`);
      for (const [mid, q] of posted) {
        const mat = (matStmt.get(mid) as any) || { name: mid };
        const onHand = Number((onHandStmt.get(storeId, mid) as any)?.q) || 0;
        if (!planCentralDebit(onHand, q).fits) {
          throw new GrnRefused(409,
            `Voiding ${grn.grn_number} would take ${qtyText(q, mat)} of ${mat.name} back out of ${sName}, but ${sName} now holds ${qtyText(onHand, mat)}: ${qtyText(q - onHand, mat)} have already moved (to a floor bar, a sale or an adjustment). Nothing was changed. Correct the stock with an Adjustment on Inventory → Liquor Store, or bring the bottles back to ${sName} first.`,
            { code: 'store_moved', material_id: mid });
        }
      }

      // 4. A count on or after the bill already includes these bottles.
      //    A read failure is a refusal: "cannot prove it was not counted".
      for (const mid of posted.keys()) {
        let counted: any;
        try {
          counted = db.prepare(`
            SELECT date FROM store_closing_counts
             WHERE store_id = ? AND material_id = ? AND date >= ?
             ORDER BY date ASC LIMIT 1
          `).get(storeId, mid, String(grn.date || ''));
        } catch (e: any) {
          throw new GrnRefused(409,
            `Cannot confirm whether ${sName} has counted these items since ${grn.date} (${e?.message || 'closing counts unreadable'}). Refusing rather than take bottles out of a counted book. Nothing was changed.`,
            { code: 'store_counted' });
        }
        if (counted) {
          const mat = (matStmt.get(mid) as any) || { name: mid };
          throw new GrnRefused(409,
            `${sName} counted ${mat.name} on ${counted.date}, on or after this bill — that count already includes these bottles, so voiding now would take them out of a counted book. Nothing was changed. Correct it with an Adjustment on Inventory → Liquor Store.`,
            { code: 'store_counted', material_id: mid });
        }
      }

      // 5. Remove the rows and the charges row (exactly one expected).
      const indent = String(grn.invoice_number || '').trim();
      const chargeRows = db.prepare(`
        SELECT * FROM store_bill_charges WHERE store_id = ? AND TRIM(invoice_ref) = ? COLLATE NOCASE
      `).all(storeId, indent) as any[];
      if (chargeRows.length !== 1) {
        throw new GrnRefused(409,
          `The TGBCL charges row for indent ${indent} on ${sName} can't be identified uniquely (${chargeRows.length} found), so the bill can't be reversed cleanly. Nothing was changed.`,
          { code: 'store_charges_unidentifiable' });
      }
      const del = db.prepare(`DELETE FROM store_stock_ledger WHERE id = ?`);
      for (const r of ledgerRows) {
        if (del.run(r.id).changes !== 1) throw mismatch();
      }
      db.prepare(`DELETE FROM store_bill_charges WHERE id = ?`).run(chargeRows[0].id);

      for (const r of ledgerRows) {
        const mat = (matStmt.get(String(r.material_id)) as any) || {};
        removed.push({
          material_id: String(r.material_id), material_name: String(mat.name || ''),
          recipe_qty: Number(r.quantity), purchase_qty: r6(Number(r.quantity) / packFactor(mat)),
        });
      }

      // 6. The record — the ONLY copy of the rows just deleted. Verified, or
      //    the whole void rolls back.
      const header = { ...grn };
      delete header.store_bill_json;
      logAuditOrThrow(db, {
        event_type: 'store.procure_grn_void',
        entity_type: 'goods_receipt_note',
        entity_id: grnId,
        actor_email: me.email,
        outlet_id: grn.outlet_id ?? null,
        before: { grn: header, store_bill: doc, ledger_rows: ledgerRows, bill_charges_row: chargeRows[0] },
        after: { status: 'void', store_id: storeId, store: sName, bottles_removed: removed, charges_removed: true },
        note: `Voided ${grn.grn_number} (${sName} indent ${indent})${reason ? ` — ${reason}` : ''}: ${removed.length} ledger row(s) and the TGBCL charges removed`,
      }, `the bottles and TGBCL charges this void removes from ${sName}`);
    })();
  } catch (e: any) {
    if (e instanceof GrnRefused) {
      return { status: e.httpStatus, body: { error: e.message, refused: true, liquor: true, ...(e.payload || {}), ...(e.code ? { code: e.code } : {}) } };
    }
    throw e;
  }
  return { status: 200, body: {
    success: true, voided: true, liquor: true,
    grn_number: grn.grn_number,
    store: { id: storeId, name: sName },
    bottles_removed: removed,
    notice: `The bill document is kept (struck through). Its bottles were taken back out of ${sName} and its TGBCL charges removed; the indent number can now be entered again.`,
  } };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/grn/liquor-match — the forgiving TGBCL CSV matcher (read-only)
// ─────────────────────────────────────────────────────────────────────────────

type SkipKind = 'missing' | 'not_found' | 'wrong_store' | 'invalid' | 'duplicate' | 'other_bill';

/**
 * procure-bulk:117-237's matching, verbatim in its rules — SKU (lower/trim)
 * first, else name; the material must belong to THIS store; cases / bottles /
 * loose ≥ 0 with a recipe qty > 0; unit_price > 0 wins (per_case ÷ caseFactor),
 * else amount > 0, else invalid — MINUS its ledger line-dedupe (one door per
 * indent makes it moot) and PLUS:
 *   · 'duplicate'  — the material is already on the bill (exclude_material_ids)
 *                    or earlier in this file: one item, one line;
 *   · 'other_bill' — the row carries an inward number for a different indent:
 *                    a Goods Receipt is one indent;
 *   · two refusals tripleToRecipe would otherwise hide: cases on an item with
 *     no case size, loose on a piece item;
 *   · a line note when the sheet carries CGST/SGST (liquor carries no GST).
 * WRITES NOTHING. The matched lines go back to the form; the save is POST
 * /api/grn like any manual liquor bill.
 */
export function matchLiquorCsvRows(db: Database, args: {
  storeId: string; storeName: string; rows: any[]; invoiceRef?: string; excludeMaterialIds?: string[];
}) {
  const { storeId, storeName } = args;
  const rows = Array.isArray(args.rows) ? args.rows : [];
  const num = (v: any) => (v === undefined || v === null || String(v).trim() === '') ? 0 : Number(v);
  const mats = db.prepare(`SELECT ${MAT_COLS} FROM raw_materials`).all() as any[];
  const byName = new Map<string, any>();
  const bySku = new Map<string, any>();
  for (const m of mats) {
    byName.set(String(m.name || '').toLowerCase().trim(), m);
    const s = String(m.sku || '').toLowerCase().trim();
    if (s) bySku.set(s, m);
  }
  // The bill's indent: what the form sent, else the sheet's own first inward
  // number (the form fills a blank indent box from the sheet).
  const firstInward = rows.map(r => normalizeBillNo(r?.inward_no)).find(Boolean) || '';
  const indentNo = normalizeBillNo(args.invoiceRef) || firstInward;
  const indentK = indentKey(indentNo);
  const excluded = new Set((Array.isArray(args.excludeMaterialIds) ? args.excludeMaterialIds : []).map(x => String(x || '')));
  const seenRow = new Map<string, number>();     // material_id → the row it was matched on

  const lines: any[] = [];
  const skipped_rows: any[] = [];
  const skip = (row: any, i: number, kind: SkipKind, reason: string) => {
    skipped_rows.push({
      row: i + 1,
      item_name: String(row.item_name || '').trim(), sku: String(row.sku || '').trim(),
      cases: row.cases ?? '', bottles: row.bottles ?? '', loose: row.loose ?? '',
      unit_price: row.unit_price ?? '', amount: row.amount ?? '',
      batch_no: String(row.batch_no || '').trim(), expiry_date: String(row.expiry_date || '').trim(),
      date: String(row.date || '').trim(), inward_no: String(row.inward_no || '').trim(),
      kind, reason,
    });
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const name = String(row.item_name || '').trim();
    const sku = String(row.sku || '').trim();
    if (!name && !sku) { skip(row, i, 'missing', 'No item name or SKU on this row.'); continue; }
    const rowInward = normalizeBillNo(row.inward_no);
    if (rowInward && indentK && indentKey(rowInward) !== indentK) {
      skip(row, i, 'other_bill', `belongs to indent ${rowInward} — a Goods Receipt is one indent; upload it as its own bill`);
      continue;
    }
    const mat = (sku && bySku.get(sku.toLowerCase())) || byName.get(name.toLowerCase());
    if (!mat) { skip(row, i, 'not_found', `Material not found: "${name || sku}" — name/SKU must match a Raw Material.`); continue; }
    if (materialStoreId(db, mat) !== storeId) {
      skip(row, i, 'wrong_store',
        `"${mat.name}" is not a ${storeName} material — its category "${mat.category}" is not mapped to this store (Settings → Store Locations).`);
      continue;
    }
    if (excluded.has(String(mat.id))) {
      skip(row, i, 'duplicate', `${mat.name}: already on this bill — one item, one line: add the quantities into one row`);
      continue;
    }
    if (seenRow.has(String(mat.id))) {
      skip(row, i, 'duplicate', `${mat.name}: already on this bill (row ${seenRow.get(String(mat.id))}) — one item, one line: add the quantities into one row`);
      continue;
    }
    const cases = num(row.cases), bottles = num(row.bottles), loose = num(row.loose);
    if (![cases, bottles, loose].every(v => Number.isFinite(v) && v >= 0)) {
      skip(row, i, 'invalid', `${mat.name}: cases/bottles/loose must be numbers ≥ 0.`); continue;
    }
    const pf = packFactor(mat);
    const cf = caseFactor(mat);
    const pu = String(mat.purchase_unit || mat.unit || 'units');
    if (cases > 0 && cf <= 1) {
      skip(row, i, 'invalid', `${mat.name}: this item has no case size set, so the sheet's ${fmtQtyNum(cases)} case(s) can't be converted to ${pu} — put the ${pu} count in the bottles column (or set the case size on the item first).`);
      continue;
    }
    if (loose > 0 && pf <= 1) {
      skip(row, i, 'invalid', `${mat.name}: this item is counted in whole ${pu} — it has no loose measure.`); continue;
    }
    const recipeQty = tripleToRecipe(cases, bottles, loose, mat);
    if (!(recipeQty > 0)) { skip(row, i, 'invalid', `${mat.name}: enter a quantity (cases / bottles / loose).`); continue; }

    const perCase = row.per_case === true || ['1', 'true', 'yes', 'y'].includes(String(row.per_case ?? '').toLowerCase().trim());
    const rawPrice = num(row.unit_price);
    const amount = num(row.amount);
    let unitPrice: number | null = null;
    let amountOut: number | null = null;
    let unitCost = 0;
    let lineTotal = 0;
    if (rawPrice > 0) {
      if (perCase && cf <= 1) {
        skip(row, i, 'invalid', `${mat.name}: the rate is per case, but this item has no case size set — give the rate per ${pu}.`); continue;
      }
      // rate-basis: purchase — ₹ per case ÷ bottles per case = ₹ per bottle.
      const perBottle = perCase ? rawPrice / cf : rawPrice;
      // rate-basis: recipe — ₹ per bottle ÷ recipe units per bottle.
      unitCost = pf > 1 ? perBottle / pf : perBottle;
      // rate-basis: recipe — recipe-unit qty × ₹ per recipe unit.
      lineTotal = r2(recipeQty * unitCost);
      unitPrice = perBottle;
    } else if (amount > 0) {
      // rate-basis: recipe — line ₹ ÷ recipe-unit qty.
      unitCost = amount / recipeQty;
      lineTotal = r2(amount);
      amountOut = amount;
    } else {
      skip(row, i, 'invalid', `${mat.name}: enter a unit price OR a line amount.`); continue;
    }
    const notes: string[] = [];
    const cg = num(row.cgst), sg = num(row.sgst);
    if ((Number.isFinite(cg) && cg !== 0) || (Number.isFinite(sg) && sg !== 0)) {
      notes.push('CGST/SGST in the sheet are not recorded — liquor carries no GST');
    }
    const disc = num(row.discount), del = num(row.delivery_charges);
    seenRow.set(String(mat.id), i + 1);
    lines.push({
      row: i + 1, material_id: String(mat.id), material_name: String(mat.name || ''), sku: String(mat.sku || ''),
      category: String(mat.category || ''), unit: String(mat.unit || ''),
      purchase_unit: String(mat.purchase_unit || mat.unit || ''), pack_factor: pf, case_factor: cf,
      cases, bottles, loose, recipe_qty: recipeQty,
      unit_price: unitPrice, per_case: false, amount: amountOut,
      unit_cost: unitCost, line_total: lineTotal,
      discount: Number.isFinite(disc) && disc > 0 ? r2(Math.min(disc, lineTotal)) : 0,
      delivery_charges: Number.isFinite(del) && del > 0 ? r2(del) : 0,
      batch_no: String(row.batch_no || '').trim(), expiry_date: String(row.expiry_date || '').trim(),
      notes,
    });
  }
  return { indent_no: indentNo, lines, skipped_rows };
}
