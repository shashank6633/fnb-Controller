import { getDb } from '@/lib/db';
import { getCurrentUser, canProcessAsStore, isManagement } from '@/lib/auth';
import { allowedDeptIds, canSeeAllDeptStock } from '@/lib/dept-stock';
import { NOT_STORE_MAPPED_SQL } from '@/lib/dept-requested-items';
import {
  assertReversible, deptKey, deptOnHandBulk, isDeptReversalBlocked,
} from '@/lib/dept-ledger';
import { packFactor, fmtQtyNum, dualQty, type PackMeta } from '@/lib/pack-units';
import {
  alreadyReturnedByGrnItem, checkReturnWindow, vendorReturnCandidates,
  type ReturnWindowCheck,
} from '@/lib/returns';

/**
 * THE TWO RETURN PICKERS. Read-only. Requirements 72 and 77.
 *
 *   GET /api/returns/sources?mode=vendor    → GRN LINES a vendor return can be raised against
 *   GET /api/returns/sources?mode=internal  → what a department can actually give back
 *
 * ── NOTHING HERE MOVES STOCK, AND NOTHING BEFORE STORE ACCEPT DOES ────────
 * This route only answers "what could you put on a ticket?". Raising the
 * ticket does not move a gram; neither does the HOD approving it. The grams
 * move at exactly ONE point in the whole module — inside the store-verify
 * transaction, on the lines the store ACCEPTS, through
 * acceptInternalReturnLine() / acceptVendorReturnLine() in src/lib/return-stock.ts.
 * Every quantity below is therefore a FORECAST, not a reservation: two tickets
 * can be drafted against the same 5 kg and the second Accept will correctly
 * refuse. Do not "helpfully" decrement anything from here.
 *
 * ── THE TWO MODES DO OPPOSITE THINGS TO CENTRAL STOCK ─────────────────────
 * This is why they are two modes and not one list with a flag on each row:
 *
 *   mode=vendor    goods go BACK OUT to the supplier. On Accept,
 *                  raw_materials.current_stock goes DOWN and there is no
 *                  department leg at all. The grams leave the building.
 *                  Anchored on a GRN LINE, because that is the only place a
 *                  real PO No., GRN No. and rate live together.
 *
 *   mode=internal  goods come back from a DEPARTMENT to the central store. On
 *                  Accept the department goes DOWN and current_stock goes UP.
 *                  The grams never left the building. There is no GRN and no
 *                  PO — see the auto-fill note below.
 *
 * Requirement 76's words — "added back to Store stock" — describe the INTERNAL
 * shape and only the internal shape. A vendor return that credited central
 * would invent inventory that is physically on a lorry back to the supplier.
 *
 * ── WHY mode=vendor RETURNS GRN LINES AND NEVER MATERIALS ─────────────────
 * Requirement 72 asks for PO No. and GRN No. to be auto-filled. The temptation
 * is to take the material and look up "its" GRN. Measured on the live database
 * (2026-08-07), Sugar alone arrived on FIVE GRNs — GRN-2026-0002 (₹100, no PO),
 * -0003 (₹50, no PO), -0004 (₹200, PO-2026-0002), -0009 (₹60, no PO) and -0010
 * (₹10, no PO). Defaulting to the newest would file the return at ₹10 against
 * no purchase order when the goods may well have come in at ₹200 on
 * PO-2026-0002: a credit note wrong by twenty times, with the wrong PO printed
 * on it. So this route hands back all five as five separate rows and makes the
 * user CHOOSE. It never collapses them and never guesses.
 *
 * 9 of the 29 live GRNs have no PO at all (ad-hoc cash receipts). Those rows
 * carry po_number: '' and the UI must print it BLANK. A blank is honest; a
 * nearest match is a fabrication that ends up on a vendor's credit note.
 *
 * ── WHY mode=internal HAS NO PO/GRN AND NO SUB-DEPARTMENT ROLL-UP ─────────
 * department_material_transactions carries neither grn_id nor purchase_id, and
 * 2,134 of 2,165 purchases rows have no grn_id, so there is no chain to walk
 * back from a department's grams to a receipt. The internal ticket's PO/GRN
 * fields stay blank by design.
 *
 * The roll-up matters more. Every other department surface expands a MAIN
 * department into its sub-departments (resolveDeptSet). This one deliberately
 * does NOT. A return posts one ledger row against ONE department_id, and
 * assertReversible caps it against that ONE (department, material) pair. If the
 * picker summed three sub-kitchens into one number, it would offer a quantity
 * the Accept transaction is guaranteed to refuse. The picker must promise
 * exactly what the mover will honour, so it is scoped to the single department
 * the ticket will name; a main department's sub-departments are listed
 * alongside so the user can go and pick the right one.
 *
 * ── NEVER COUNTED IS NOT ZERO ─────────────────────────────────────────────
 * dept-stock.ts settled this and this route repeats it rather than re-deciding:
 * a (department, material) pair with no closing count and no cutover opening
 * row reports on_hand NULL and never_counted TRUE — never 0. A plausible wrong
 * number is worse than a blank. The returnable figure for such a pair falls
 * back to the signed ledger sum, which is exactly what assertReversible falls
 * back to, so the picker and the mover agree.
 *
 * ── LIQUOR IS NOT RETURNABLE THROUGH HERE, IN EITHER MODE ─────────────────
 * Store-mapped materials live on the TGBCL rail (store_stock_ledger /
 * store_locations); centralFlowBlock already keeps them out of every central
 * purchase/GRN/issue path, and return-stock.ts refuses them at the mover. The
 * exclusion is applied here too so the user is never offered a line that the
 * Accept would throw on. Internal mode uses the shared NOT_STORE_MAPPED_SQL
 * fragment (one set-based NOT EXISTS, not N lookups); vendor mode inherits the
 * same carve-out from vendorReturnCandidates.
 *
 * ── UNITS AND MONEY ───────────────────────────────────────────────────────
 * Owner rule: every Purchase / Inventory figure LEADS with the PURCHASE unit.
 * The two modes arrive in different bases and mixing them up is the 750x class
 * of error, so the conversion is done once, in the right direction, per mode:
 *   vendor   goods_receipt_note_items.quantity_accepted is ALREADY purchase
 *            units (kg / BTL) by canon — it must NOT be run through
 *            toPurchaseQty a second time. purchaseDisplay() below takes a
 *            purchase-basis number and only derives the recipe HINT.
 *   internal the department ledger and current_stock are RECIPE units (g / ml),
 *            so those go through dualQty(), which applies the both-halves
 *            pack guard (pack_size > 1 AND unit !== purchase_unit — PICKLED
 *            GINGER 1.5KG, kg/kg pack 1.5, must not convert).
 * unit_price is passed through untouched and is Rs per PURCHASE unit by canon,
 * matching the purchase-unit quantity beside it. This route multiplies no rate
 * by any quantity: valuing a return is the ticket's and the report's job, and
 * doing it in a picker would be a basis question a picker has no business
 * answering. raw_materials.last_purchase_price is never read — mixed basis.
 */
export const dynamic = 'force-dynamic';

/** Hard ceiling on rows returned, whatever the caller asks for. A picker that
 *  streams the whole material list is a hung browser, not a feature. */
const MAX_ROWS = 500;
/** How many (department, material) pairs get the EXACT reversal probe. The
 *  probe is 4 queries per pair — fine for the handful of lines a user is
 *  actually adding, wrong for a whole department's item set. */
const MAX_EXACT_PROBES = 25;

/** Comma-separated id list → clean array. */
function idList(raw: string | null): string[] {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Display for a quantity that is ALREADY in purchase units (the GRN side).
 * Deliberately NOT displayQty()/dualQty(): those take a RECIPE quantity and
 * divide by the pack factor. Feeding a purchase-basis number into them divides
 * it a second time — 4 kg of sugar rendered as "4 kg" only by luck, and as
 * "0.005 kg" the moment pack_size is 750. Here the purchase number IS the
 * primary and the recipe figure is the derived hint.
 */
function purchaseDisplay(purchaseQty: number, m: PackMeta): { primary: string; hint: string | null } {
  const pf = packFactor(m);
  const pu = String(m?.purchase_unit || m?.unit || '').trim();
  const ru = String(m?.unit || '').trim();
  const q = Number(purchaseQty) || 0;
  return {
    primary: `${fmtQtyNum(q)} ${pu}`.trim(),
    hint: pf > 1 ? `= ${fmtQtyNum(q * pf)} ${ru}`.trim() : null,
  };
}

/**
 * What Store Accept will actually allow this department to give back, RECIPE
 * units, read from the SAME guard the Accept runs (assertReversible) instead of
 * a second copy of its arithmetic. Probed with qty 0 so it is a pure read: with
 * no reqItemId the line cap is Infinity, so the answer is capDept — what the
 * department physically holds — which is the only physically meaningful cap for
 * pooled department stock with no lot tracking.
 *
 * A department sitting at a negative ledger sum makes even qty 0 throw. That is
 * not an error here, it is the answer: nothing is returnable. Caught, reported
 * as 0, never allowed to 500 a picker.
 */
function probeReturnable(db: ReturnType<typeof getDb>, deptId: string, matId: string): number {
  try {
    const chk = assertReversible(db, { departmentId: deptId, materialId: matId, qty: 0 });
    return Math.max(0, Number(chk.capDept) || 0);
  } catch (e) {
    if (isDeptReversalBlocked(e)) return Math.max(0, Number(e.available) || 0);
    throw e;
  }
}

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const url = new URL(request.url);
    const mode = (url.searchParams.get('mode') || '').trim().toLowerCase();
    const search = (url.searchParams.get('search') || '').trim().toLowerCase();
    const limitRaw = parseInt(url.searchParams.get('limit') || '', 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_ROWS) : MAX_ROWS;

    if (mode !== 'vendor' && mode !== 'internal') {
      return Response.json(
        { error: "mode must be 'vendor' (GRN lines going back to the supplier) or 'internal' (a department giving goods back to the store)" },
        { status: 400 },
      );
    }

    const db = getDb();

    /* ── VENDOR: GRN LINES. Requirement 72. ─────────────────────────────── */
    if (mode === 'vendor') {
      // Vendor rates, PO numbers and supplier bills are store/management data,
      // and a vendor return is raised over the receiving counter, not from a
      // kitchen. canProcessAsStore keeps its admin bypass here on purpose —
      // this is a READ. The physical-handover gate with no admin bypass
      // (canIssueAsStore) belongs on store-verify, where stock actually moves.
      if (!canProcessAsStore(me) && !isManagement(me)) {
        return Response.json({ error: 'Store or management permission required' }, { status: 403 });
      }

      // Default hides GRN lines whose whole accepted quantity has already come
      // back; ?include_exhausted=1 shows them (greyed) so a user hunting "why
      // can I not return this?" gets an answer instead of an empty list. Same
      // reason vendorReturnCandidates refuses to hide anything itself: a picker
      // that silently drops a row is indistinguishable from a broken one.
      const includeExhausted = url.searchParams.get('include_exhausted') === '1';

      const candidates = vendorReturnCandidates(db, {
        materialId: (url.searchParams.get('material_id') || '').trim() || undefined,
        grnId: (url.searchParams.get('grn_id') || '').trim() || undefined,
        poId: (url.searchParams.get('po_id') || '').trim() || undefined,
        vendorId: (url.searchParams.get('vendor_id') || '').trim() || undefined,
        dateFrom: (url.searchParams.get('from') || '').trim() || undefined,
        dateTo: (url.searchParams.get('to') || '').trim() || undefined,
        // Searching is the lib's LIKE over material / GRN no. / PO no. / vendor /
        // invoice no. — not re-implemented here, so the two can never disagree
        // about what "Sugar" matches.
        search: search || undefined,
        limit,
      });

      // HOW MUCH OF EACH LINE IS LEFT. The lib hands back candidates, not
      // entitlements: subtracting what has already come back is the route's job
      // and it is done here, in ONE batched query, never per row.
      //
      // returned_purchase_qty, NOT returned_recipe_qty. quantity_accepted is
      // PURCHASE units by canon; comparing it against the recipe figure
      // over-counts by the pack size — 1,000x on a 1 kg pack — and would refuse
      // every second return. Each returned row was converted back with the
      // pack_factor SNAPSHOTTED on that row, not with today's pack_size, so a
      // later Unit Audit rebase cannot retro-change what a past return took.
      const returned = alreadyReturnedByGrnItem(db, candidates.map((c) => c.grn_item_id));

      // Requirement 75's window is a per-GRN-DATE read, so memoise it by date:
      // a GRN with 20 lines is one check, not 20. Read-time only — nothing here
      // writes a PO status, and the unset default (0 days) means NO LIMIT,
      // which is exactly today's behaviour.
      const windowMemo = new Map<string, ReturnWindowCheck>();
      const windowFor = (grnDate: string) => {
        if (!windowMemo.has(grnDate)) {
          try { windowMemo.set(grnDate, checkReturnWindow(db, grnDate)); }
          catch { windowMemo.set(grnDate, { ok: true }); } // a broken window check must not hide real GRN lines
        }
        return windowMemo.get(grnDate)!;
      };

      const priced = candidates.map((c) => {
        const accepted = Number(c.quantity_accepted) || 0;
        const back = returned.get(c.grn_item_id)?.returned_purchase_qty ?? 0;
        // Clamped at 0, never negative: a line that somehow has more returned
        // than accepted is a data question, not a licence to return more.
        return { c, accepted, back, remaining: Math.max(0, accepted - back) };
      });

      const all = includeExhausted ? priced : priced.filter((p) => p.remaining > 0);

      const rows = all.slice(0, limit).map(({ c, accepted, back, remaining }) => {
        // Only the three fields packFactor actually reads. case_size is
        // deliberately not demanded of the lib: nothing here renders a
        // cases+bottles breakdown, and asking for a field to pass it through
        // unused is how contracts between files grow teeth.
        const meta: PackMeta = { unit: c.unit, purchase_unit: c.purchase_unit, pack_size: c.pack_size };
        const win = windowFor(String(c.grn_date || ''));
        return {
          // THE ANCHOR. The ticket line stores grn_item_id, and PO No. / GRN No.
          // are read back THROUGH it rather than copied twice into the line.
          grn_item_id: c.grn_item_id,
          grn_id: c.grn_id,
          grn_number: c.grn_number,
          grn_date: c.grn_date,
          invoice_number: c.invoice_number || '',
          po_item_id: c.po_item_id || '',
          // '' for the 9-of-29 ad-hoc GRNs. Print it blank. Never substitute
          // "the material's most recent PO" — that is the 20x Sugar error.
          po_id: c.po_id || '',
          po_number: c.po_number || '',
          vendor_id: c.vendor_id || '',
          vendor: c.vendor || '',

          material_id: c.material_id,
          material_name: c.material_name,
          category: c.category || '',
          unit: c.unit || '',
          purchase_unit: c.purchase_unit || c.unit || '',
          pack_size: Number(c.pack_size) || 1,
          pack_factor: packFactor(meta),

          // ALL THREE ARE PURCHASE UNITS (goods_receipt_note_items canon).
          // already_returned_qty is DERIVED by summing VERIFIED return lines,
          // not stored as a column on the GRN line: decrementing
          // quantity_accepted would change receivedPoItemIds() and therefore
          // silently reopen or close a purchase order as a side effect of a
          // returns action.
          quantity_accepted: accepted,
          already_returned_qty: back,
          remaining_qty: remaining,
          // Rs per PURCHASE unit, straight off the GRN line — the rate these
          // particular goods were actually billed at, which is the whole reason
          // the picker is anchored on a GRN line rather than on a material.
          // Passed through only; nothing in this file multiplies it.
          unit_price: Number(c.unit_price) || 0,

          display: {
            accepted: purchaseDisplay(accepted, meta),
            already_returned: purchaseDisplay(back, meta),
            remaining: purchaseDisplay(remaining, meta),
          },

          // Requirement 75. Reported per row rather than filtered out, so a
          // closed window reads as "this PO closed for returns on ..." instead
          // of a GRN mysteriously missing from the list.
          window_open: win.ok,
          window_note: win.ok ? '' : win.error,
        };
      });

      return Response.json({
        mode: 'vendor',
        rows,
        count: rows.length,
        // Two ways to be short of the whole truth: our own slice, or the lib
        // hitting the cap we handed it. Both are reported, because a picker
        // that quietly shows the first 500 of 900 GRN lines is how a user
        // concludes their receipt does not exist.
        truncated: all.length > rows.length || candidates.length >= limit,
        // Said out loud on the wire so a UI author does not have to read this
        // file to learn which way the stock goes.
        basis: 'Quantities and unit_price are PURCHASE units (kg / L / BTL and Rs per that unit). '
          + 'Accepting a vendor return DECREASES central stock — the goods leave the building. '
          + 'Stock moves only when the Store accepts the ticket.',
      });
    }

    /* ── INTERNAL: WHAT ONE DEPARTMENT CAN GIVE BACK. Requirement 77. ───── */
    const departmentId = (url.searchParams.get('department_id') || '').trim();
    if (!departmentId) {
      return Response.json({ error: 'department_id is required for mode=internal' }, { status: 400 });
    }

    const dept = db.prepare('SELECT id, name, parent_id FROM departments WHERE id = ?')
      .get(departmentId) as { id: string; name: string; parent_id: string | null } | undefined;
    if (!dept) return Response.json({ error: 'Unknown department' }, { status: 400 });

    // Same visibility rule as /api/department-stock, imported rather than
    // re-expressed so the two surfaces can never disagree about who may look at
    // a kitchen's stock.
    if (!canSeeAllDeptStock(me) && !allowedDeptIds(me).has(dept.id)) {
      return Response.json({ error: 'Not allowed for this department' }, { status: 403 });
    }

    const askedMaterials = idList(url.searchParams.get('material_id'));

    // ONE department id, never resolveDeptSet — see the roll-up note in the
    // header. deptOnHandBulk with no material filter returns every material
    // this department has ever counted or moved, which is precisely the set it
    // could return something from.
    const balances = deptOnHandBulk(db, [dept.id], askedMaterials.length ? askedMaterials : undefined);

    const idSet = new Set<string>(askedMaterials);
    for (const key of balances.keys()) {
      // deptKey() is 'departmentId|materialId'; a material id never contains a
      // pipe, and slicing past the FIRST pipe survives one that somehow does.
      const cut = key.indexOf('|');
      if (cut >= 0) idSet.add(key.slice(cut + 1));
    }

    // A pair the caller asked about that has no count, no ledger row and no
    // cache row is absent from the map entirely. It still gets a row below —
    // reported never_counted, not 0.
    //
    // NOT_STORE_MAPPED_SQL is the SET-BASED twin of canReturnMaterial(): one
    // NOT EXISTS for the whole list instead of one centralFlowBlock() lookup
    // per material. Same rule, same normalisation, same active-store carve-out
    // — it is the fragment the closing-stock surfaces already share, imported
    // rather than retyped so the two sides of the house cannot drift about
    // which materials are liquor. The mover refuses them again at Accept;
    // filtering here just means the user is never offered a line that would
    // throw.
    const ids = [...idSet].filter(Boolean);
    const mats = ids.length === 0 ? [] : db.prepare(`
      SELECT rm.id, rm.name, rm.category, rm.unit, rm.purchase_unit,
             rm.pack_size, rm.case_size, rm.is_active
        FROM raw_materials rm
       WHERE rm.id IN (SELECT value FROM json_each(?))
         AND ${NOT_STORE_MAPPED_SQL}
       ORDER BY rm.name COLLATE NOCASE
    `).all(JSON.stringify(ids)) as Array<{
      id: string; name: string; category: string; unit: string; purchase_unit: string | null;
      pack_size: number | null; case_size: number | null; is_active: number;
    }>;

    const filtered = search ? mats.filter((m) => m.name.toLowerCase().includes(search)) : mats;
    // The exact probe is worth its four queries only when the caller is asking
    // about specific lines. On a whole-department list the bulk balance is the
    // same number in every case where the ledger has no pre-cutover rows — and
    // by decision D (no backfill) it has none.
    const exact = askedMaterials.length > 0 && filtered.length <= MAX_EXACT_PROBES;

    const rows = filtered.slice(0, limit).map((m) => {
      const meta: PackMeta = {
        unit: m.unit, purchase_unit: m.purchase_unit, pack_size: m.pack_size, case_size: m.case_size,
      };
      const bal = balances.get(deptKey(dept.id, m.id));
      const neverCounted = bal ? bal.neverCounted : true;

      // RECIPE units throughout — this is the number the mover will move by.
      // NEVER COUNTED falls back to the signed movement sum rather than 0,
      // because that is exactly what assertReversible falls back to
      // (rawLedgerSum): whatever this rail has put in, minus what it took out.
      // Treating it as 0 would block every legitimate same-day give-back.
      const returnable = exact
        ? probeReturnable(db, dept.id, m.id)
        : Math.max(0, bal ? (bal.neverCounted ? bal.movementsSince : (bal.onHand ?? 0)) : 0);

      // ONE conversion, through the shared pack layer, reused by both the wire
      // shape and the rendered string — so the number the screen shows and the
      // number a client re-derives can never be two different numbers.
      const d = dualQty(returnable, meta);
      const converts = d.pack_factor > 1;

      return {
        material_id: m.id,
        material_name: m.name,
        category: m.category || '',
        unit: m.unit || '',
        purchase_unit: m.purchase_unit || m.unit || '',
        pack_size: Number(m.pack_size) || 1,
        pack_factor: packFactor(meta),
        is_active: !!m.is_active,

        // NULL, not 0, when the pair was never counted. The UI must say
        // "not counted yet" — a blank is honest, a plausible zero is not.
        on_hand: bal ? bal.onHand : null,
        never_counted: neverCounted,
        anchor_source: bal ? bal.anchorSource : 'none',
        anchor_at: bal ? bal.anchorAt : null,
        movements_since: bal ? bal.movementsSince : 0,

        // What Store Accept will allow, RECIPE units, plus its purchase-unit
        // display. returnable_exact says whether it came from the real guard
        // (assertReversible) or from the bulk balance; either way the Accept
        // re-checks inside its own transaction, because the department can
        // legitimately cook the goods between now and then.
        returnable,
        returnable_exact: exact,
        can_return: returnable > 0,
        qty: d,

        display: {
          primary: `${fmtQtyNum(converts ? d.qty_purchase : d.qty)} ${d.purchase_unit || d.unit}`.trim(),
          hint: converts ? `= ${fmtQtyNum(d.qty)} ${d.unit}`.trim() : null,
        },
      };
    });

    return Response.json({
      mode: 'internal',
      department: { id: dept.id, name: dept.name },
      scope: {
        // Stated on the wire because it is surprising: every OTHER department
        // surface rolls a main department up into its sub-departments, and this
        // one must not (see the header). If the user is looking at a main
        // department and the numbers look empty, the stock is in these.
        rolled_up: false,
        is_main_department: !dept.parent_id,
        sub_departments: !dept.parent_id
          ? (db.prepare('SELECT id, name FROM departments WHERE parent_id = ? ORDER BY name COLLATE NOCASE')
            .all(dept.id) as Array<{ id: string; name: string }>)
          : [],
      },
      rows,
      count: rows.length,
      truncated: filtered.length > rows.length,
      basis: 'on_hand, movements_since and returnable are RECIPE units (g / ml); qty and display carry the '
        + 'PURCHASE-unit figure. never_counted TRUE means no count and no opening row — on_hand is null, not 0. '
        + 'Accepting an internal return DECREASES department stock and INCREASES central stock — the goods stay '
        + 'in the building. Stock moves only when the Store accepts the ticket.',
    });
  } catch (e: any) {
    console.error('[returns sources]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
