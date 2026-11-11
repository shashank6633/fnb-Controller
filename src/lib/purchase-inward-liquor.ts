/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PURCHASE INWARD — THE "Liquor Inward" SHEET (owner ruling 127, pick 2).
 * SERVER ONLY (better-sqlite3).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE OWNER'S PICK: liquor (TGBCL) bills on a SEPARATE sheet in the same
 * columns as "Purchase Inward Data"; EXCISE = the Bar Excise Turnover Tax
 * share, "TCS + SPECIAL EXCISE CESS" its own column, MRP round-off spread per
 * line the way the Liquor Store Inward Register already does it; its total =
 * Net Indent; NEVER added into the main sheet or the Purchase Report Grand
 * Total.
 *
 * ROWS = THE LIQUOR STORE INWARD REGISTER'S OWN ROWS. A TGBCL bill writes no
 * `purchases` row (src/lib/liquor-grn.ts): its lines are store_stock_ledger
 * 'purchase' rows and its four bill-level charges one store_bill_charges row.
 * getStoreInwardRegister (src/lib/store-engine.ts) already turns those into one
 * row per line with the four charges allocated across the bill's lines (in
 * proportion to SUBTOTAL, the last line taking the paise left over). Every
 * money cell here is THAT function's figure, unchanged — nothing re-derived —
 * for the same INWARD dates (it windows on date(created_at), the date the
 * Liquor Store files the line under; txn_date / recorded_at are empty on every
 * liquor line in production and are never read). So
 *
 *     Σ TOTAL INWARD AMOUNT  =  the Liquor Store Inward Register, same dates
 *
 * by construction, and getLiquorInward() CHECKS it against the bills' own Net
 * Indent (store_bill_charges.net_indent_value), worked out independently, and
 * EXPLAINS any difference part by part (a discount or delivery typed on a line,
 * which Net Indent leaves out; a line whose bill has no Net Indent record; a
 * bill with lines on other dates). Whatever is left after that is a mismatch
 * and is reported as one.
 *
 * THE FIELDS THE REGISTER DOES NOT RETURN (the ledger id, the note that names a
 * Goods Receipt, the SKU, the exact quantity) are read by a MIRROR of its row
 * query — the same JOIN, WHERE and ORDER BY — and paired with its rows ROW BY
 * ROW, checked on invoice, date, supplier, item and subtotal before anything is
 * printed. This is the pattern src/app/api/liquor/inward-register/route.ts
 * already uses; if store-engine's query ever changes, the pairing fails and
 * the sheet says it could not be built instead of putting one line's GRN on
 * another line's row.
 *
 * ACCESS. The Purchase Report's gate (management or the finance-reports tick)
 * is the route's. On top of it, a store's liquor lines are included only for a
 * viewer who may view that store (userStoreAccess(...).can_view) — the gate the
 * Liquor Store's own Inward Register applies. Nobody sees a liquor bill here
 * that they could not already see there; a store left out is named on the
 * About sheet.
 *
 * SELECT ONLY. Nothing here writes.
 */
import type DatabaseT from 'better-sqlite3';
import type { SessionUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getStoreById, getStoreInwardRegister, userStoreAccess, type InwardRegisterRow } from '@/lib/store-engine';
import { packFactor } from '@/lib/pack-units';
import type { InwardRow, LiquorInwardSection, LiquorCheck } from '@/lib/purchase-inward';

type Viewer = Pick<SessionUser, 'id' | 'role' | 'is_head_chef' | 'is_store_manager' | 'position' | 'role_name'>;
type DbRow = Record<string, unknown>;

const str = (v: unknown): string => String(v ?? '').trim();
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
/** Whole paise — every sum is taken in paise so no float noise reaches a total. */
const paise = (v: unknown): number => Math.round(num(v) * 100);
const rupees = (p: number): number => p / 100;
/** Float noise off a quantity or a rate (rounded to a millionth), as the main sheet does. */
const clean = (v: number): number => Math.round((Number(v) || 0) * 1e6) / 1e6;

/** The exact note liquor-grn.ts receiveLiquorGrn writes on every ledger line: `Goods Receipt ${grnNumber} · ${pinv}`. */
const GRN_NOTE_RE = /^Goods Receipt (GRN-\d{4}-\d+) · (PINV-\d{4}-L\d+)$/;

/** A person's name fit to print: never an email or a phone number (as the main sheet). */
function printableName(v: unknown): string {
  const s = str(v);
  if (!s || s.includes('@') || /\d{7,}/.test(s.replace(/[\s\-()+]/g, ''))) return '';
  return s;
}

/**
 * The register's row query, mirrored: the SAME FROM / JOIN / WHERE / ORDER BY as
 * getStoreInwardRegister in src/lib/store-engine.ts, plus the columns it does
 * not return. Kept textually beside that function's contract on purpose — see
 * the header.
 */
const MIRROR_SQL = `
  SELECT l.id, l.rowid AS rid, substr(l.created_at, 1, 10) AS inward_date, TRIM(l.ref) AS invoice_ref,
         l.supplier, l.quantity, l.unit_cost, l.notes, l.created_at,
         rm.name AS item, rm.sku, rm.unit, rm.purchase_unit, rm.pack_size
  FROM store_stock_ledger l
  JOIN raw_materials rm ON rm.id = l.material_id
  WHERE l.store_id = ? AND l.txn_type = 'purchase'
    AND date(l.created_at) >= date(?) AND date(l.created_at) <= date(?)
  ORDER BY l.created_at DESC, l.rowid DESC
`;

interface ChargesRow {
  invoice_ref: string;
  invoice_value: number;
  mrp_rounding: number;
  excise_turnover_tax: number;
  special_excise_cess: number;
  tcs: number;
  net_indent_value: number;
  c_date: string;
  c_time: string;
  created_by: string;
}

/** A section that could not be built: the sheet and the About sheet say so; the main sheet is unaffected. */
export function liquorInwardFailed(message: string): LiquorInwardSection {
  return {
    rows: [], ids: [], total: 0, register_total: 0, net_indent: 0, bills: 0,
    stores: [], withheld: [], checks: [], explained: [], residual: 0, orphan_lines: 0,
    ok: false, error: message || 'unknown error',
  };
}

/**
 * The "Liquor Inward" rows for an INWARD DATE window, for the stores this
 * viewer may view, with the Net Indent check. SELECT only.
 */
export function getLiquorInward(
  f: { from: string; to: string },
  viewer: Viewer,
  dbArg?: DatabaseT.Database,
): LiquorInwardSection {
  const db = dbArg || getDb();
  const { from, to } = f;

  // One read transaction: the register, its mirror and the charges are read
  // from the same snapshot.
  return db.transaction((): LiquorInwardSection => {
    // Every store with a liquor purchase line in the window (no JOIN here, so a
    // line whose item is gone is still counted below).
    const storeIds = (db.prepare(`
      SELECT DISTINCT store_id FROM store_stock_ledger
       WHERE txn_type = 'purchase' AND date(created_at) >= date(?) AND date(created_at) <= date(?)
    `).all(from, to) as { store_id: string }[]).map(r => str(r.store_id));

    const stores = storeIds
      .map(id => ({ id, name: str(getStoreById(db, id)?.name) || `store ${id}` }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));

    const grnStmt = db.prepare(`
      SELECT g.id, g.grn_number, g.store_invoice_id, g.received_by,
             strftime('%Y-%m-%d', g.created_at, '+330 minutes') AS g_date,
             strftime('%H:%M',    g.created_at, '+330 minutes') AS g_time
        FROM goods_receipt_notes g
       WHERE g.grn_number = ? AND COALESCE(g.store_dest_id, '') = ? AND COALESCE(g.store_invoice_id, '') = ?
         AND COALESCE(g.status, '') <> 'void'
       LIMIT 2
    `);
    // THE ONE user whose login (or id) this is — the main sheet's rule.
    const nameStmt = db.prepare(`
      SELECT CASE WHEN COUNT(*) = 1 THEN MAX(TRIM(u.name)) END AS name FROM users u
       WHERE TRIM(COALESCE(?, '')) <> ''
         AND (LOWER(TRIM(u.email)) = LOWER(TRIM(?)) OR u.id = TRIM(?))
    `);
    const nameOf = (login: unknown): string => {
      const s = str(login);
      if (!s) return '';
      return printableName((nameStmt.get(s, s, s) as { name: string | null } | undefined)?.name);
    };
    // A bill's lines dated OUTSIDE the window (for the explanation only).
    const outsideStmt = db.prepare(`
      SELECT TRIM(l.ref) AS invoice_ref, l.quantity, l.unit_cost
        FROM store_stock_ledger l
        JOIN raw_materials rm ON rm.id = l.material_id
       WHERE l.store_id = ? AND l.txn_type = 'purchase'
         AND NOT (date(l.created_at) >= date(?) AND date(l.created_at) <= date(?))
    `);

    type Built = { row: InwardRow; id: string; order: [string, string, string, string, string, number] };
    const built: Built[] = [];
    const withheld: string[] = [];
    const storeOut: LiquorInwardSection['stores'] = [];
    let registerTotalP = 0;
    let orphanLines = 0;
    // Bill-level sums over the bills the sheet's lines belong to.
    let niP = 0, ivP = 0, ettP = 0, tcsSecP = 0, mrpP = 0;
    // Line-level sums for the explanation.
    let discP = 0, delivP = 0, gstP = 0, noRecordP = 0, outsideP = 0;
    let billCount = 0;

    for (const st of stores) {
      if (!userStoreAccess(db, viewer, st.id).can_view) { withheld.push(st.name); continue; }

      orphanLines += num((db.prepare(`
        SELECT COUNT(*) AS n FROM store_stock_ledger l
          LEFT JOIN raw_materials rm ON rm.id = l.material_id
         WHERE l.store_id = ? AND l.txn_type = 'purchase' AND rm.id IS NULL
           AND date(l.created_at) >= date(?) AND date(l.created_at) <= date(?)
      `).get(st.id, from, to) as { n: number }).n);

      // THE MONEY: the Liquor Store Inward Register, as it stands.
      const reg: InwardRegisterRow[] = getStoreInwardRegister(db, st.id, from, to);
      const mir = db.prepare(MIRROR_SQL).all(st.id, from, to) as DbRow[];

      // THE PAIRING, row by row.
      const aligned = mir.length === reg.length && mir.every((m, i) => {
        const r = reg[i];
        return String(m.invoice_ref ?? '') === String(r.invoice_ref ?? '')
          && String(m.inward_date ?? '') === String(r.inward_date ?? '')
          && String(m.supplier || '') === String(r.supplier || '')
          && String(m.item || '') === String(r.item || '')
          && paise(num(m.quantity) * num(m.unit_cost)) === paise(r.subtotal);
      });
      if (!aligned) {
        throw new Error(`the ${st.name} lines could not be paired with the Liquor Store Inward Register (its query has changed)`);
      }

      // The bill charges, keyed EXACTLY as getBillChargesForStore keys them
      // (trimmed, lower-cased; same SELECT order, so the same row wins a clash).
      const charges: Record<string, ChargesRow> = {};
      for (const c of db.prepare(`
        SELECT invoice_ref, invoice_value, mrp_rounding, excise_turnover_tax, special_excise_cess, tcs, net_indent_value,
               strftime('%Y-%m-%d', created_at, '+330 minutes') AS c_date,
               strftime('%H:%M',    created_at, '+330 minutes') AS c_time,
               created_by
        FROM store_bill_charges WHERE store_id = ?
      `).all(st.id) as ChargesRow[]) {
        charges[String(c.invoice_ref || '').trim().toLowerCase()] = c;
      }

      // The register's own bill key: lower(TRIM(ref)).
      const keyOf = (ref: unknown) => String(ref || '').toLowerCase();
      const keysHere = new Set<string>();
      let storeTotalP = 0;

      reg.forEach((r, i) => {
        const m = mir[i];
        const key = keyOf(r.invoice_ref);
        keysHere.add(key);
        const bc = charges[key];

        // A line keyed on Goods Receipt: its note names the GRN and our PINV.
        // Printed only when that GRN exists for THIS store with THAT PINV.
        let grn: DbRow | null = null;
        const note = GRN_NOTE_RE.exec(str(m.notes));
        if (note) {
          const hits = grnStmt.all(note[1], st.id, note[2]) as DbRow[];
          if (hits.length === 1) grn = hits[0];
        }

        // CREATED: the Goods Receipt entry; for a bill entered on the Liquor
        // Store page before liquor moved to Goods Receipt, when its TGBCL
        // charges were first saved (the ledger's own created_at was rewritten
        // to the bill date there, so it is not when it was keyed in).
        const created_date = grn ? str(grn.g_date) : (bc ? str(bc.c_date) : '');
        const created_time = grn ? str(grn.g_time) : (bc ? str(bc.c_time) : '');
        const created_by = grn ? nameOf(grn.received_by) : (bc ? nameOf(bc.created_by) : '');

        // Quantity and rate in the purchase unit, the register's own formula
        // (bottles = qty ÷ pack, rate = ₹/recipe unit × pack) without its
        // 2-decimal rounding, so INWARD QTY × RATE gives SUBTOTAL.
        const pf = packFactor({ pack_size: num(m.pack_size), unit: str(m.unit), purchase_unit: str(m.purchase_unit) });
        const q = num(m.quantity);
        const c = num(m.unit_cost);
        const inward_qty = clean(pf > 1 ? q / pf : q);
        const rate = clean(pf > 1 ? c * pf : c);

        const row: InwardRow = {
          created_date,
          created_time,
          po_id: '',
          po_date: '',
          inward_id: grn ? str(grn.grn_number) : '',
          invoice_id: str(r.invoice_ref),
          inward_date: str(r.inward_date),
          supplier: str(r.supplier),
          category: str(r.category).toUpperCase(),
          item_id: str(m.sku),
          item_name: str(r.item),
          po_qty: null,
          inward_qty,
          variance: null,
          purchase_unit: str(r.purchase_unit),
          rate,
          subtotal: num(r.subtotal),
          discount: num(r.discount),
          cgst: num(r.cgst),
          sgst: num(r.sgst),
          cess: null,
          excise: num(r.excise_turnover_tax),
          delivery: num(r.delivery_charges),
          tcs_spl: rupees(paise(r.tcs) + paise(r.special_excise_cess)),
          mrp_round_off: num(r.mrp_round_off),
          total_inward: num(r.total_inward_amount),
          invoice_url: '',
          paid: null,
          balance: null,
          created_by,
          pinv: grn ? str(grn.store_invoice_id) : '',
        };
        built.push({
          row,
          id: str(m.id),
          order: [st.name.toLowerCase(), row.inward_date, row.supplier.toLowerCase(), row.invoice_id.toLowerCase(), str(m.created_at), num(m.rid)],
        });

        storeTotalP += paise(r.total_inward_amount);
        discP += paise(r.discount);
        delivP += paise(r.delivery_charges);
        gstP += paise(r.cgst) + paise(r.sgst);
        if (!bc) noRecordP += paise(r.subtotal);
      });

      // Bill-level figures, once per bill that has a Net Indent record.
      let billsHere = 0;
      for (const key of keysHere) {
        billsHere++;
        const bc = charges[key];
        if (!bc) continue;
        niP += paise(bc.net_indent_value);
        ivP += paise(bc.invoice_value);
        ettP += paise(bc.excise_turnover_tax);
        tcsSecP += paise(bc.tcs) + paise(bc.special_excise_cess);
        mrpP += paise(bc.mrp_rounding);
      }
      if (keysHere.size > 0) {
        for (const o of outsideStmt.all(st.id, from, to) as DbRow[]) {
          const k = keyOf(o.invoice_ref);
          if (keysHere.has(k) && charges[k]) outsideP += paise(num(o.quantity) * num(o.unit_cost));
        }
      }
      billCount += billsHere;
      registerTotalP += reg.reduce((t, r) => t + paise(r.total_inward_amount), 0);
      if (reg.length > 0) storeOut.push({ name: st.name, rows: reg.length, bills: billsHere, total: rupees(storeTotalP) });
    }

    // Date, then store, supplier, bill, then the order the lines were entered in.
    built.sort((a, b) => {
      const [sa, da, va, ia, ca, ra] = a.order;
      const [sb, db2, vb, ib, cb, rb] = b.order;
      return da.localeCompare(db2) || sa.localeCompare(sb) || va.localeCompare(vb)
        || ia.localeCompare(ib) || ca.localeCompare(cb) || ra - rb;
    });
    const rows = built.map(b => b.row);
    const sumP = (k: keyof InwardRow) => rows.reduce((t, r) => t + paise(r[k]), 0);
    const totalP = sumP('total_inward');

    // TOTAL − NET INDENT, part by part. Each part is exact arithmetic of the
    // register's own formula; whatever is left over is not explained.
    const parts: LiquorInwardSection['explained'] = [
      { label: 'discount typed on the lines (Net Indent leaves it out)', amount: rupees(-discP) },
      { label: 'delivery charges typed on the lines (Net Indent leaves them out)', amount: rupees(delivP) },
      { label: 'CGST + SGST typed on the lines (Net Indent leaves them out)', amount: rupees(gstP) },
      { label: 'lines whose bill number has no Net Indent record (their SUBTOTAL)', amount: rupees(noRecordP) },
      { label: 'lines of these bills dated outside these dates (their bill\'s TGBCL charges all sit on the lines inside, as on the Liquor Store Inward Register)', amount: rupees(-outsideP) },
    ].filter(p => paise(p.amount) !== 0);
    const residualP = totalP - niP - parts.reduce((t, p) => t + paise(p.amount), 0);

    const check = (figure: string, fileP: number, reportP: number, explainedP: number): LiquorCheck => ({
      figure,
      file: rupees(fileP),
      report: rupees(reportP),
      state: fileP === reportP ? 'equal' : (fileP === reportP + explainedP && residualP === 0 ? 'explained' : 'mismatch'),
    });
    const subtotalExplainedP = noRecordP - outsideP;
    const checks: LiquorCheck[] = rows.length === 0 ? [] : [
      check('SUBTOTAL — invoice value of the bills', sumP('subtotal'), ivP, subtotalExplainedP),
      check('EXCISE — Bar Excise Turnover Tax', sumP('excise'), ettP, 0),
      check('TCS + SPECIAL EXCISE CESS', sumP('tcs_spl'), tcsSecP, 0),
      check('MRP ROUND OFF — MRP Rounding Off', sumP('mrp_round_off'), mrpP, 0),
      check('TOTAL INWARD AMOUNT — Net Indent', totalP, niP, totalP - niP - residualP),
      check('TOTAL INWARD AMOUNT — Liquor Store Inward Register', totalP, registerTotalP, 0),
    ];

    return {
      rows,
      ids: built.map(b => b.id),
      total: rupees(totalP),
      register_total: rupees(registerTotalP),
      net_indent: rupees(niP),
      bills: billCount,
      stores: storeOut,
      withheld,
      checks,
      explained: parts,
      residual: rupees(residualP),
      orphan_lines: orphanLines,
      ok: checks.every(c => c.state !== 'mismatch'),
    };
  })();
}
