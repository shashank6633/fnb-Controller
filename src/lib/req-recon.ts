/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REQUESTED → ORDERED → RECEIVED, ITEM BY ITEM, FOR A DEPARTMENT AND A PERIOD
 * (owner's request, 2026-11-09; his model: "October 2026 kitchen requests and
 * receipts", a Google-Sheet export). SERVER ONLY (better-sqlite3, xlsx).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE OWNER'S WORDS: "I need a Report Like this for the Selected Date or
 * Monthly report Where i can do Reconcilation over a period of a time Where
 * Kitchen Requested Items Vs Purchase Vs Received."
 *
 * HIS FOUR DECISIONS (all picked as recommended, 2026-11-09):
 *   1. Columns Requested → Ordered → Received, short / extra at each step and
 *      ₹ at each step (₹ Requested is an estimate and says so).
 *   2. Matched BY ITEM: each column counts the documents DATED in the period
 *      (requisition date, PO date, receipt / purchase date), with a drill-down
 *      to the documents behind every figure. Ordered and Received are whole-
 *      outlet totals; other departments' requests for the same item are named.
 *   3. A department picker — default Kitchen (with its sections), any other
 *      main department, or All — off the real departments table.
 *   4. Management + store manager, with an Excel download.
 *
 * WHERE EACH FIGURE COMES FROM — and which helper it goes through, because
 * every one of these has a trap that has bitten this codebase before:
 *
 *   REQUESTED  requisition_items.quantity_requested, which is stored in the
 *              LINE's own unit (Option B). Converted with lineFactor()
 *              (issue-stock.ts, THE line rule) and packFactor() (pack-units.ts)
 *              — summed in recipe units and converted to the purchase unit
 *              ONCE per item (pack-units' "never sum qty_purchase" rule). A
 *              blank unit on a packed item is read as the purchase unit — the
 *              conversion audit's canon for legacy blank lines — and the line
 *              says so; a unit that is neither the purchase nor the recipe unit
 *              cannot be converted and is left out, also said on the row.
 *              A line counts for ITS OWN department (requisition_items
 *              .department_id, else the header's — LINE_DEPT_SQL): one party
 *              requisition can hold lines for several departments.
 *
 *   ORDERED    purchase_order_items.quantity × unit_price — a PO is quoted in
 *              PURCHASE units at ₹/purchase unit (the 69509d3 / f0c9be1 rule).
 *              "Is this PO line spoken for?" and "what arrived on it?" go
 *              through po-receipts.ts (claimJoin / liveValueSql), never a
 *              hand-written GRN join against a PO.
 *
 *   RECEIVED   `purchases` rows, read through purchaseReportBase() — the
 *              Purchase Report's OWN FROM / WHERE (ruling 115). Received ₹ for
 *              an item is therefore the very SUM(p.total_price) the Purchase
 *              Report's Item-wise table prints as Spend for the same dates, by
 *              construction. A PO delivery counts ONCE: the receive route writes
 *              one purchases row per accepted line, and the GRN line beside it
 *              is the same goods, never added again. A voided GRN deletes its
 *              purchases rows (grn-reversal.ts), and a delivery held for the
 *              kitchen's QC has none yet (grn-qc.ts) — so neither is in
 *              Received; held ones are shown separately, read off the GRN line
 *              with the VALUE predicate's complement (never spelling the status).
 *
 *   ₹ RATE     for the Requested ESTIMATE only: this period's received ₹ / qty,
 *              else this period's ordered ₹ / qty, else closing-valuation.ts's
 *              latest-purchase rate (rateMap → materialRate). NOT its average-
 *              cost fallback (see the note at the rate below) and NEVER
 *              raw_materials.last_purchase_price, which is stored in mixed
 *              bases (project_fnb_lpp_mixed_basis). No rate → blank.
 *
 * WHAT IS DELIBERATELY NOT HERE: no quantity is ever added ACROSS items (2 kg +
 * 3 BTL is nothing), so every total on the page and in the file is in ₹; and
 * nothing is written — every statement below is a SELECT.
 */
import * as XLSX from 'xlsx';
import type DatabaseT from 'better-sqlite3';
import { getDb } from '@/lib/db';
import type { SessionUser } from '@/lib/auth';
import { packFactor, type PackMeta } from '@/lib/pack-units';
import { lineFactor } from '@/lib/issue-stock';
import { claimJoin, liveValueSql, isReceiptHeldForQc } from '@/lib/po-receipts';
import { storeStageCheck } from '@/lib/po-helpers';
import { purchaseReportBase, purchaseReportSummarySql } from '@/lib/purchase-report-base';
import { withGrnCharges } from '@/lib/purchase-charges';
import { materialRate, rateMap } from '@/lib/closing-valuation';
import { fmtIST } from '@/lib/format-date';
import {
  RATE_BASIS_WORDS, RULE_REQUESTED, RULE_ORDERED, RULE_RECEIVED, RULE_VALUES, RULE_SHARED, NO_RATE_WORDS_SHORT,
  humanDate, periodWords, deptViewWords,
  type ReqReconItem, type ReqReconOther, type ReqReconTotals, type ReqReconCounts, type ReqReconDept,
  type ReqReconResponse, type ReqReconDetail, type ReqReconRequestRow, type ReqReconPoRow,
  type ReqReconReceiptRow, type ReqReconRateBasis,
} from '@/lib/req-recon-types';

type Db = DatabaseT.Database;

/**
 * WHO MAY READ THIS REPORT (owner, 2026-11-09): management — the Admin and
 * Manager tiers — and the store manager (is_store_manager, the user's own flag
 * or the role's, as getCurrentUser resolves it). Anyone else, an HOD on the
 * staff tier included, is refused. Fails closed: no user, no access.
 */
export function canReadReqRecon(me: Pick<SessionUser, 'role' | 'is_store_manager'> | null): boolean {
  if (!me) return false;
  return me.role === 'admin' || me.role === 'manager' || me.is_store_manager === true;
}

export interface ReqReconFilters {
  from: string;
  to: string;
  /** A department id (main or section — its whole subtree counts), or '' for All departments. */
  departmentId: string;
}

/* ═══════════════════════════════ small helpers ═════════════════════════════ */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
/** Quantities: float noise off, 6 dp kept (the screen prints 3). */
const q6 = (v: number): number => {
  const r = Math.round((Number(v) || 0) * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};
/**
 * Money, float noise off but a genuine fraction of a paisa KEPT (6 dp) — the
 * same choice purchase-itemwise.ts makes, for the same reason: a line of
 * quantity × rate can be 83.325, and rounding each item to the paisa before
 * adding would let the total drift a paisa away from the Purchase Report's own
 * SUM. Screens and the Excel number format show two decimals.
 */
const m6 = (v: number): number => q6(v);
/** Paise, for comparing two money figures. */
const paise = (v: number): number => Math.round((Number(v) || 0) * 100);
const str = (v: unknown): string => String(v ?? '').trim();
const chunk = <T,>(arr: readonly T[], n = 400): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const hasTable = (db: Db, name: string): boolean =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

/* ═══════════════════════════════ departments ═══════════════════════════════ */

interface DeptNode { id: string; name: string; parent_id: string; is_active: boolean }

function loadDepartments(db: Db): Map<string, DeptNode> {
  const rows = db.prepare(`SELECT id, name, parent_id, is_active FROM departments`).all() as Record<string, unknown>[];
  const m = new Map<string, DeptNode>();
  for (const r of rows) {
    m.set(String(r.id), {
      id: String(r.id), name: str(r.name) || '(unnamed department)',
      parent_id: str(r.parent_id), is_active: num(r.is_active) === 1,
    });
  }
  return m;
}

/** The top of a department's parent chain (an orphaned section is its own main, as in dept-hierarchy.ts). */
function mainOf(depts: Map<string, DeptNode>, id: string): DeptNode | null {
  let cur = depts.get(id) || null;
  for (let i = 0; cur && i < 20; i++) {
    const parent = cur.parent_id ? depts.get(cur.parent_id) : undefined;
    if (!parent || parent.id === cur.id) return cur;
    cur = parent;
  }
  return cur;
}

/** The department and every section under it, at any depth. */
function subtree(depts: Map<string, DeptNode>, rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  for (const d of depts.values()) {
    let cur: DeptNode | undefined = d;
    for (let i = 0; cur && i < 20; i++) {
      if (cur.id === rootId) { out.add(d.id); break; }
      cur = cur.parent_id ? depts.get(cur.parent_id) : undefined;
    }
  }
  return out;
}

/**
 * A department as the wire carries it. has_sections is asked through subtree()
 * — the very rule build() uses to decide which requests a view of it counts —
 * so "with its sections" is printed exactly when a view really takes in a
 * section's requests.
 */
function deptOut(depts: Map<string, DeptNode>, d: DeptNode): ReqReconDept {
  return { id: d.id, name: d.name, is_active: d.is_active, has_sections: subtree(depts, d.id).size > 1 };
}

/** Main departments for the picker, by name. */
export function mainDepartments(db: Db = getDb()): ReqReconDept[] {
  const depts = loadDepartments(db);
  return [...depts.values()]
    .filter(d => !d.parent_id || !depts.has(d.parent_id) || d.parent_id === d.id)
    .map(d => deptOut(depts, d))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/** The default department: the main department named "Kitchen", else All (''). Never a hard-coded id. */
export function defaultDepartmentId(db: Db = getDb()): string {
  const k = mainDepartments(db).find(d => d.name.trim().toLowerCase() === 'kitchen');
  return k ? k.id : '';
}

/** null when the id is not a department. */
export function findDepartment(db: Db, id: string): ReqReconDept | null {
  const depts = loadDepartments(db);
  const d = depts.get(id);
  return d ? deptOut(depts, d) : null;
}

/* ═══════════════════════════════ materials / people ════════════════════════ */

interface Mat {
  id: string; name: string; sku: string; category: string;
  unit: string; purchase_unit: string; pack_size: number; average_price: number;
}

function loadMaterials(db: Db, ids: Iterable<string>): Map<string, Mat> {
  const list = [...new Set([...ids].filter(Boolean))];
  const m = new Map<string, Mat>();
  for (const part of chunk(list)) {
    const rows = db.prepare(`
      SELECT id, name, sku, category, unit, purchase_unit, pack_size, average_price
        FROM raw_materials WHERE id IN (${part.map(() => '?').join(',')})
    `).all(...part) as Record<string, unknown>[];
    for (const r of rows) {
      m.set(String(r.id), {
        id: String(r.id), name: str(r.name), sku: str(r.sku), category: str(r.category),
        unit: str(r.unit), purchase_unit: str(r.purchase_unit), pack_size: num(r.pack_size) || 1,
        average_price: num(r.average_price),
      });
    }
  }
  return m;
}

const metaOf = (m: Mat | undefined): PackMeta =>
  m ? { unit: m.unit, purchase_unit: m.purchase_unit, pack_size: m.pack_size } : {};
/** The purchase unit every quantity on a row is in (the material's, else its recipe unit). */
const unitOf = (m: Mat | undefined, fallback = ''): string => (m ? (m.purchase_unit || m.unit) : '') || fallback;
/** The Purchase Report's own label for a purchases row whose material record is gone. */
const unlinkedName = (id: string) => `(material not linked · id ${id || '?'})`;

/**
 * Who raised a requisition, as a NAME. requisitions.drafted_by holds the
 * raiser's login (an email on app-made requisitions). The login itself is
 * never printed when it looks like an email or a phone number — the report and
 * its Excel file carry names only.
 */
function raiserResolver(db: Db): (login: unknown) => string {
  const rows = db.prepare(`SELECT email, name, is_active FROM users`).all() as Record<string, unknown>[];
  const byLogin = new Map<string, { name: string; active: boolean }>();
  for (const r of rows) {
    const k = str(r.email).toLowerCase();
    const name = str(r.name);
    if (!k || !name) continue;
    const prev = byLogin.get(k);
    const active = num(r.is_active) === 1;
    if (!prev || (!prev.active && active)) byLogin.set(k, { name, active });
  }
  return (login: unknown) => {
    const raw = str(login);
    if (!raw) return '—';
    const hit = byLogin.get(raw.toLowerCase());
    if (hit) return hit.name;
    if (raw.includes('@') || /\d{7,}/.test(raw.replace(/[\s()+-]/g, ''))) return 'Unknown user';
    return raw;
  };
}

/* ═══════════════════════════════ status words ══════════════════════════════ */

// chef_approved is deliberately NOT in this map — see reqStatusLabeller below.
const REQ_STATUS_WORDS: Record<string, string> = {
  submitted: 'With HOD', mgmt_approved: 'With Store',
  chef_rejected: 'Rejected by HOD', rejected: 'Rejected', store_processed: 'Issued (partial)',
  fulfilled: 'Fulfilled', cancelled: 'Cancelled',
};
const PO_STATUS_WORDS: Record<string, string> = {
  pending: 'Awaiting approval', pending_reapproval: 'Awaiting re-approval', approved: 'Approved',
  received: 'Received', rejected: 'Rejected', cancelled: 'Cancelled',
};
const words = (map: Record<string, string>, s: string) =>
  map[s] || (s ? s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : '—');

/**
 * A requisition's status in words, PER LINE (data-r1). chef_approved (HOD
 * approved) is "With Store" or "With Mgmt" depending on where it really sits,
 * and that is the server's own question: storeStageCheck (po-helpers.ts, the
 * store inbox's rule — GET /api/requisitions?inbox=store). An internal
 * requisition never had a Mgmt gate, so at chef_approved it is with the store
 * under either setting; a party one waits for Mgmt only while the admin's
 * require_mgmt_approval setting is on ('1'; off is the default). That is the
 * word the store's desk (/store-requisitions) and /party-approvals print for
 * the same requisition. The drill-down and the Excel Requests sheet both print
 * this one label.
 */
function reqStatusLabeller(db: Db): (status: string, purpose: string) => string {
  const atStore = storeStageCheck(db);
  return (status, purpose) => (status === 'chef_approved'
    ? (atStore(status, purpose) ? 'With Store' : 'With Mgmt')
    : words(REQ_STATUS_WORDS, status));
}

/* ═══════════════════════════════ the window's documents ════════════════════ */

interface ReqLine {
  line_id: string; material_id: string; qty: number; line_unit: string; approved_qty: number | null;
  req_id: string; req_number: string; date: string; status: string; party: boolean;
  /** The status in words, from reqStatusLabeller (where an HOD-approved requisition really sits). */
  status_label: string;
  department_id: string; raised_by: string;
  counted: boolean; note: string;
  /** Recipe-unit quantity; null = the unit cannot be converted. */
  recipe: number | null;
  unit_assumed: boolean;
}

interface PoLine {
  id: string; po_id: string; material_id: string; qty: number; rate: number; vendor: string;
  po_number: string; date: string; status: string;
  counted: boolean; closed: boolean; note: string;
}

interface Booked {
  id: string; date: string; vendor: string; bill_no: string; invoice_id: string;
  grn_id: string; grn_no: string; po_no: string; material_id: string;
  qty: number; rate: number; value: number;
}

interface GrnLine {
  kind: 'held' | 'void' | 'rejected';
  material_id: string; date: string; grn_number: string; vendor: string; bill_no: string; po_no: string;
  qty: number; rejected_qty: number; rate: number; value: number;
}

interface Window {
  reqs: ReqLine[];
  pos: PoLine[];
  booked: Booked[];
  grnLines: GrnLine[];
  /** grn_id|material_id → rejected qty on the live receipt (attached to the first booked row). */
  rejectedByGrnMat: Map<string, number>;
  mats: Map<string, Mat>;
}

/** HOW A REQUISITION LINE IS COUNTED — the rule printed as RULE_REQUESTED. */
function classifyRequest(status: string, isRejected: boolean, storeRejected: boolean, qty: number): { counted: boolean; note: string } {
  if (status === 'cancelled') return { counted: false, note: 'Requisition cancelled' };
  if (status === 'chef_rejected' || status === 'rejected') return { counted: false, note: 'Requisition rejected by the HOD' };
  if (isRejected) return { counted: false, note: 'Line rejected by the HOD' };
  // Measured 2026-11-09: the Recaho-imported lines (REQ-IMP-…) carry
  // quantity_requested 0 and only an issued quantity — 1,003 of April 2026's
  // 4,229 lines. Nothing was asked on record, so nothing is counted; the line
  // is still listed in the drill-down so it can be seen.
  if (!(qty > 0)) return { counted: false, note: 'No quantity asked on this line' };
  if (storeRejected) return { counted: true, note: 'Store marked that it could not supply the rest of this line' };
  return { counted: true, note: '' };
}

function lineToRecipe(qty: number, lineUnit: string, m: Mat | undefined): { recipe: number | null; assumed: boolean } {
  const meta = metaOf(m);
  const { factor, needsReview } = lineFactor(lineUnit, meta);
  if (!needsReview) return { recipe: qty * factor, assumed: false };
  // lineFactor refuses a blank unit on a packed item rather than MOVE STOCK on a
  // guess. A report moves nothing, and the conversion audit's canon is that a
  // blank (legacy) line was entered in the PURCHASE unit — so it is read that
  // way, and the row says so. Any other unrecognised unit stays unconverted.
  if (lineUnit.trim() === '') return { recipe: qty * packFactor(meta), assumed: true };
  return { recipe: null, assumed: false };
}

/**
 * WHICH DEPARTMENT A REQUISITION LINE IS FOR: the LINE's own department, else
 * the header's. A requisition raised for "Multiple departments" (a party one)
 * holds lines for several departments, and its header only carries the FIRST
 * line's (api/requisitions POST: "each item must carry its own department_id";
 * the header is "the first item's dept"). Reading the header put a party's Bar
 * lines under the Kitchen (checker r1). Same rule, NULLIF/TRIM guard included,
 * as dept-requested-items.ts ("LINE OWNERSHIP"). `ri` / `r` are the aliases of
 * requisition_items / requisitions in the statement it is used in.
 */
const LINE_DEPT_SQL = `COALESCE(NULLIF(TRIM(ri.department_id), ''), r.department_id)`;

function loadWindow(db: Db, f: ReqReconFilters, materialId?: string): Window {
  const P = [f.from, f.to];
  const mid = (materialId || '').trim();
  const raiser = raiserResolver(db);
  const statusLabel = reqStatusLabeller(db);

  // ── requisition lines (drafts were never sent — not shown at all) ──
  // department_id is the LINE's department (LINE_DEPT_SQL): it decides which
  // view counts the line, the "other departments" note, and the drill-down's
  // and the Excel Requests sheet's department names.
  const reqRaw = db.prepare(`
    SELECT ri.id AS line_id, ri.material_id, COALESCE(ri.quantity_requested, 0) AS qty,
           COALESCE(ri.unit, '') AS line_unit, ri.chef_approved_qty,
           COALESCE(ri.is_rejected, 0) AS is_rejected, COALESCE(ri.store_rejected, 0) AS store_rejected,
           r.id AS req_id, r.req_number, r.date, COALESCE(r.status, '') AS status,
           COALESCE(r.purpose, '') AS purpose, COALESCE(${LINE_DEPT_SQL}, '') AS department_id, r.drafted_by
      FROM requisition_items ri
      JOIN requisitions r ON r.id = ri.req_id
     WHERE r.date >= ? AND r.date <= ? AND COALESCE(r.status, '') <> 'draft'
       ${mid ? 'AND ri.material_id = ?' : ''}
     ORDER BY r.date, r.req_number, ri.created_at, ri.id
  `).all(...P, ...(mid ? [mid] : [])) as Record<string, unknown>[];

  // ── PO lines (drafts were never raised — not shown at all) ──
  const poRaw = db.prepare(`
    SELECT poi.id, poi.po_id, poi.material_id, COALESCE(poi.quantity, 0) AS qty, COALESCE(poi.unit_price, 0) AS rate,
           COALESCE(NULLIF(TRIM(poi.vendor), ''), NULLIF(TRIM(po.vendor), ''), '') AS vendor,
           COALESCE(poi.vendor_id, po.vendor_id) AS vendor_id,
           po.po_number, po.date, COALESCE(po.status, '') AS status
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.po_id
     WHERE po.date >= ? AND po.date <= ? AND COALESCE(po.status, '') <> 'draft'
       ${mid ? 'AND poi.material_id = ?' : ''}
     ORDER BY po.date, po.po_number, poi.rowid
  `).all(...P, ...(mid ? [mid] : [])) as Record<string, unknown>[];

  // CLAIM: PO lines in the window a live (not voided) receipt has spoken for —
  // a line on hold for QC IS spoken for (po-receipts.ts). Needed for the
  // vendor-closed rule, which only releases a line nothing arrived on.
  const claimed = new Set<string>((db.prepare(`
    SELECT DISTINCT gi.po_item_id AS id
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.po_id
      JOIN goods_receipt_note_items gi ON gi.po_item_id = poi.id
      ${claimJoin({ poIdCol: 'poi.po_id' })}
     WHERE po.date >= ? AND po.date <= ?
  `).all(...P) as Record<string, unknown>[]).map(r => String(r.id)));

  let closures: Record<string, unknown>[] = [];
  if (hasTable(db, 'po_vendor_closures')) {
    closures = db.prepare(`
      SELECT c.po_id, c.vendor_id, COALESCE(c.vendor_name, '') AS vendor_name
        FROM po_vendor_closures c
        JOIN purchase_orders po ON po.id = c.po_id
       WHERE po.date >= ? AND po.date <= ?
    `).all(...P) as Record<string, unknown>[];
  }
  const closedOn = (poId: string, vendorId: string, vendor: string) => closures.some(c =>
    String(c.po_id) === poId
    && ((vendorId && str(c.vendor_id) === vendorId) || (!!vendor && str(c.vendor_name).toLowerCase() === vendor.toLowerCase())));

  // ── RECEIVED: the Purchase Report's own rows (ruling 115 base) ──
  const { base, params } = purchaseReportBase({ from: f.from, to: f.to, materialId: mid });
  const bookedRaw = db.prepare(withGrnCharges(`
    SELECT p.id, p.date, COALESCE(TRIM(p.vendor), '') AS vendor,
           COALESCE(TRIM(p.bill_no), '') AS bill_no, COALESCE(TRIM(p.invoice_id), '') AS invoice_id,
           TRIM(COALESCE(p.grn_id, '')) AS grn_id,
           CASE WHEN TRIM(COALESCE(p.grn_id, '')) = '' THEN ''
                ELSE COALESCE((SELECT TRIM(gx.grn_number) FROM goods_receipt_notes gx WHERE gx.id = TRIM(p.grn_id)), '') END AS grn_no,
           CASE WHEN TRIM(COALESCE(p.grn_id, '')) = '' THEN ''
                ELSE COALESCE((SELECT TRIM(px.po_number) FROM goods_receipt_notes gx
                                 JOIN purchase_orders px ON px.id = gx.po_id
                                WHERE gx.id = TRIM(p.grn_id)), '') END AS po_no,
           COALESCE(p.material_id, '') AS material_id,
           COALESCE(p.quantity, 0) AS qty, COALESCE(p.unit_price, 0) AS rate, COALESCE(p.total_price, 0) AS value
    ${base}
    ORDER BY p.date, p.created_at, p.id
  `)).all(...params) as Record<string, unknown>[];

  // ── GRN lines NOT booked: held for QC, or voided (the VALUE predicate's complement) ──
  const offBook = db.prepare(`
    SELECT gi.material_id, g.date, COALESCE(TRIM(g.grn_number), '') AS grn_number,
           COALESCE(TRIM(g.vendor), '') AS vendor, COALESCE(TRIM(g.invoice_number), '') AS bill_no,
           COALESCE((SELECT TRIM(px.po_number) FROM purchase_orders px WHERE px.id = g.po_id), '') AS po_no,
           g.status, COALESCE(gi.quantity_received, 0) AS received, COALESCE(gi.quantity_accepted, 0) AS accepted,
           COALESCE(gi.quantity_rejected, 0) AS rejected, COALESCE(gi.unit_price, 0) AS rate
      FROM goods_receipt_note_items gi
      JOIN goods_receipt_notes g ON g.id = gi.grn_id
     WHERE g.date >= ? AND g.date <= ? AND NOT (${liveValueSql('g')})
       ${mid ? 'AND gi.material_id = ?' : ''}
     ORDER BY g.date, g.grn_number, gi.created_at, gi.id
  `).all(...P, ...(mid ? [mid] : [])) as Record<string, unknown>[];

  // ── live receipts turned away IN FULL: a GRN line with nothing accepted and no booked row ──
  const turnedAway = db.prepare(`
    SELECT gi.material_id, g.date, COALESCE(TRIM(g.grn_number), '') AS grn_number,
           COALESCE(TRIM(g.vendor), '') AS vendor, COALESCE(TRIM(g.invoice_number), '') AS bill_no,
           COALESCE((SELECT TRIM(px.po_number) FROM purchase_orders px WHERE px.id = g.po_id), '') AS po_no,
           COALESCE(gi.quantity_rejected, 0) AS rejected, COALESCE(gi.unit_price, 0) AS rate
      FROM goods_receipt_note_items gi
      ${claimJoin()}
     WHERE g.date >= ? AND g.date <= ? AND ${liveValueSql('g')}
       AND COALESCE(gi.quantity_rejected, 0) > 0 AND COALESCE(gi.quantity_accepted, 0) <= 0
       AND NOT EXISTS (SELECT 1 FROM purchases px WHERE px.grn_id = g.id AND px.material_id = gi.material_id)
       ${mid ? 'AND gi.material_id = ?' : ''}
     ORDER BY g.date, g.grn_number, gi.created_at, gi.id
  `).all(...P, ...(mid ? [mid] : [])) as Record<string, unknown>[];

  // Material ids in play → their pack meta, names and units.
  const ids = new Set<string>();
  for (const r of reqRaw) ids.add(str(r.material_id));
  for (const r of poRaw) ids.add(str(r.material_id));
  for (const r of bookedRaw) ids.add(str(r.material_id));
  for (const r of offBook) ids.add(str(r.material_id));
  for (const r of turnedAway) ids.add(str(r.material_id));
  const mats = loadMaterials(db, ids);

  const reqs: ReqLine[] = reqRaw.map(r => {
    const m = mats.get(str(r.material_id));
    const lineUnit = str(r.line_unit);
    const cls = classifyRequest(str(r.status), num(r.is_rejected) === 1, num(r.store_rejected) === 1, num(r.qty));
    const conv = lineToRecipe(num(r.qty), lineUnit, m);
    const approved = r.chef_approved_qty == null ? null : num(r.chef_approved_qty);
    return {
      line_id: String(r.line_id), material_id: str(r.material_id), qty: num(r.qty), line_unit: lineUnit,
      approved_qty: approved,
      req_id: String(r.req_id), req_number: str(r.req_number), date: str(r.date), status: str(r.status),
      party: str(r.purpose).toLowerCase() === 'party',
      // The raw purpose, as every other caller of storeStageCheck passes it.
      status_label: statusLabel(str(r.status), str(r.purpose)),
      department_id: str(r.department_id), raised_by: raiser(r.drafted_by),
      counted: cls.counted, note: cls.note, recipe: conv.recipe, unit_assumed: conv.assumed,
    };
  });

  const pos: PoLine[] = poRaw.map(r => {
    const status = str(r.status);
    const id = String(r.id);
    let counted = true; let closed = false; let note = '';
    if (status === 'cancelled') { counted = false; note = 'Order cancelled'; }
    else if (status === 'rejected') { counted = false; note = 'Order rejected'; }
    else if (!claimed.has(id) && closedOn(str(r.po_id), str(r.vendor_id), str(r.vendor))) {
      counted = false; closed = true;
      note = 'Vendor closed on this order before anything arrived';
    }
    return {
      id, po_id: str(r.po_id), material_id: str(r.material_id), qty: num(r.qty), rate: num(r.rate),
      vendor: str(r.vendor) || '(no vendor)', po_number: str(r.po_number), date: str(r.date), status,
      counted, closed, note,
    };
  });

  const booked: Booked[] = bookedRaw.map(r => ({
    id: String(r.id), date: str(r.date), vendor: str(r.vendor) || '(no vendor)', bill_no: str(r.bill_no),
    invoice_id: str(r.invoice_id), grn_id: str(r.grn_id), grn_no: str(r.grn_no), po_no: str(r.po_no),
    material_id: str(r.material_id), qty: num(r.qty), rate: num(r.rate), value: num(r.value),
  }));

  const grnLines: GrnLine[] = [];
  for (const r of offBook) {
    const held = isReceiptHeldForQc(r.status);
    const qty = held ? num(r.received) : num(r.accepted);
    grnLines.push({
      kind: held ? 'held' : 'void', material_id: str(r.material_id), date: str(r.date),
      grn_number: str(r.grn_number), vendor: str(r.vendor) || '(no vendor)', bill_no: str(r.bill_no), po_no: str(r.po_no),
      qty, rejected_qty: held ? 0 : num(r.rejected), rate: num(r.rate), value: qty * num(r.rate),
    });
  }
  for (const r of turnedAway) {
    grnLines.push({
      kind: 'rejected', material_id: str(r.material_id), date: str(r.date),
      grn_number: str(r.grn_number), vendor: str(r.vendor) || '(no vendor)', bill_no: str(r.bill_no), po_no: str(r.po_no),
      qty: 0, rejected_qty: num(r.rejected), rate: num(r.rate), value: 0,
    });
  }

  // Rejected at the door on a receipt that DID book something: read off the
  // live GRN lines of the booked rows' own receipts.
  const rejectedByGrnMat = new Map<string, number>();
  const grnIds = [...new Set(booked.map(b => b.grn_id).filter(Boolean))];
  for (const part of chunk(grnIds)) {
    const rows = db.prepare(`
      SELECT gi.grn_id, gi.material_id, SUM(COALESCE(gi.quantity_rejected, 0)) AS rejected
        FROM goods_receipt_note_items gi
        ${claimJoin()}
       WHERE gi.grn_id IN (${part.map(() => '?').join(',')}) AND ${liveValueSql('g')}
       GROUP BY gi.grn_id, gi.material_id
    `).all(...part) as Record<string, unknown>[];
    for (const r of rows) {
      const rej = num(r.rejected);
      if (rej > 0) rejectedByGrnMat.set(`${str(r.grn_id)}|${str(r.material_id)}`, rej);
    }
  }

  return { reqs, pos, booked, grnLines, rejectedByGrnMat, mats };
}

/* ═══════════════════════════════ the item rows ═════════════════════════════ */

interface Acc {
  material_id: string;
  reqRecipe: number; reqLines: number; reqUnconverted: number; reqAssumed: number;
  ordQty: number; ordValue: number; ordLines: number; closedQty: number; closedLines: number;
  recQty: number; recValue: number; recLines: number;
  heldQty: number; heldValue: number; heldLines: number;
  others: Map<string, { recipe: number; converted: number; lines: number }>;
}

const newAcc = (id: string): Acc => ({
  material_id: id, reqRecipe: 0, reqLines: 0, reqUnconverted: 0, reqAssumed: 0,
  ordQty: 0, ordValue: 0, ordLines: 0, closedQty: 0, closedLines: 0,
  recQty: 0, recValue: 0, recLines: 0, heldQty: 0, heldValue: 0, heldLines: 0, others: new Map(),
});

interface Built {
  department: ReqReconDept | null;
  items: ReqReconItem[];
  totals: ReqReconTotals;
  counts: ReqReconCounts;
  purchase_report_booked: number;
  matches_purchase_report: boolean | null;
  win: Window;
  inView: (deptId: string) => boolean;
  depts: Map<string, DeptNode>;
}

function build(db: Db, f: ReqReconFilters, materialId?: string): Built {
  const depts = loadDepartments(db);
  const deptId = (f.departmentId || '').trim();
  const dept = deptId ? depts.get(deptId) || null : null;
  if (deptId && !dept) throw new Error('Department not found');
  const scope = dept ? subtree(depts, dept.id) : null;
  const inView = (id: string) => !scope || scope.has(id);

  const win = loadWindow(db, f, materialId);
  const acc = new Map<string, Acc>();
  const get = (id: string) => { let a = acc.get(id); if (!a) { a = newAcc(id); acc.set(id, a); } return a; };

  // Requested — the department in view; other departments' counted lines are noted.
  const reqIds = new Set<string>();
  let requestLines = 0; let unconverted = 0; let assumed = 0;
  for (const r of win.reqs) {
    if (!r.counted) continue;
    if (inView(r.department_id)) {
      const a = get(r.material_id);
      // A line in a unit that cannot be converted still makes the row (so the
      // owner sees it), but it is not a counted line: not in the quantity, not
      // in "request lines", exactly as its drill-down row says.
      if (r.recipe == null) { a.reqUnconverted++; unconverted++; continue; }
      a.reqLines++; requestLines++;
      reqIds.add(r.req_id);
      a.reqRecipe += r.recipe;
      if (r.unit_assumed) { a.reqAssumed++; assumed++; }
    }
  }
  // Rows of a department view = the items that department asked for.
  const rowIds = new Set<string>(scope ? [...acc.keys()] : []);
  if (scope) {
    for (const r of win.reqs) {
      if (!r.counted || inView(r.department_id) || !rowIds.has(r.material_id)) continue;
      const main = mainOf(depts, r.department_id);
      const key = main ? main.name : '(department not found)';
      const a = get(r.material_id);
      const o = a.others.get(key) || { recipe: 0, converted: 0, lines: 0 };
      o.lines++;
      if (r.recipe != null) { o.recipe += r.recipe; o.converted++; }
      a.others.set(key, o);
    }
  }

  // Ordered / Received / Held — whole outlet, item by item.
  const poIds = new Set<string>();
  let poLines = 0; let closedLines = 0;
  for (const p of win.pos) {
    if (scope && !rowIds.has(p.material_id)) continue;
    // A cancelled or rejected order line adds nothing and makes no row of its own.
    if (!p.counted && !p.closed) continue;
    const a = get(p.material_id);
    if (p.counted) { a.ordQty += p.qty; a.ordValue += p.qty * p.rate; a.ordLines++; poLines++; poIds.add(p.po_id); }
    else { a.closedQty += p.qty; a.closedLines++; closedLines++; }
  }
  let heldLines = 0;
  for (const g of win.grnLines) {
    if (g.kind !== 'held') continue;
    if (scope && !rowIds.has(g.material_id)) continue;
    const a = get(g.material_id);
    a.heldQty += g.qty; a.heldValue += g.value; a.heldLines++; heldLines++;
  }

  // RECEIVED, by item, through the Purchase Report's own base and its own
  // by_item arithmetic: SUM(p.quantity), SUM(p.total_price), COUNT(*) GROUP BY
  // p.material_id. Not re-added in JS — the same statement shape the Purchase
  // Report's Item-wise table runs, so the figures are its figures.
  const { base, params } = purchaseReportBase({ from: f.from, to: f.to, materialId: (materialId || '').trim() });
  const recRows = db.prepare(withGrnCharges(`
    SELECT COALESCE(p.material_id, '') AS material_id,
           COALESCE(SUM(p.quantity), 0) AS qty, COALESCE(SUM(p.total_price), 0) AS spend, COUNT(*) AS n
    ${base} GROUP BY p.material_id
  `)).all(...params) as Record<string, unknown>[];
  let receiptLines = 0;
  for (const r of recRows) {
    const id = str(r.material_id);
    if (scope && !rowIds.has(id)) continue;
    const a = get(id);
    a.recQty += num(r.qty); a.recValue += num(r.spend); a.recLines += num(r.n); receiptLines += num(r.n);
  }

  // The Purchase Report's booked total for the same dates, ALL items — its own statement.
  const fullBase = purchaseReportBase({ from: f.from, to: f.to });
  const summary = db.prepare(withGrnCharges(purchaseReportSummarySql(fullBase.base))).get(...fullBase.params) as Record<string, unknown> | undefined;
  const purchaseReportBooked = m6(num(summary?.total_spend));

  // Fallback rates (only for items with nothing received or ordered in the window).
  let lastRates: Map<string, { unit_price: number; date: string }> | null = null;

  const items: ReqReconItem[] = [];
  for (const a of acc.values()) {
    if (scope && !rowIds.has(a.material_id)) continue;
    const m = win.mats.get(a.material_id);
    const pf = packFactor(metaOf(m));
    const requested = q6(a.reqRecipe / pf);
    const ordered = q6(a.ordQty);
    const received = q6(a.recQty);

    let rate: number | null = null; let basis: ReqReconRateBasis | null = null; let asOf: string | null = null;
    if (received > 0 && a.recValue > 0) { rate = a.recValue / a.recQty; basis = 'received'; }
    else if (ordered > 0 && a.ordValue > 0) { rate = a.ordValue / a.ordQty; basis = 'ordered'; }
    else {
      // closing-valuation's FIRST source only — the latest purchases.unit_price
      // (₹ per purchase unit by canon). Its second source, average cost, is not
      // used: on never-bought items average_price is held per kg against a gram
      // stock unit often enough (MAKHANA - FOXNUT: 355.51 × pack 1,000 =
      // ₹3,55,510 per kg, measured 2026-11-09) that the estimate would be
      // confidently wrong. No purchase → no rate → blank, and counted as such.
      // An id with no item record still has its purchases looked up (pack 1, as
      // its quantities are), so "no purchase of it at a price is on record" —
      // what the page says of a blank rate — is true of every blank row.
      if (!lastRates) lastRates = rateMap(db);
      const last = lastRates.get(a.material_id);
      if (last) {
        const mr = materialRate(db, m || { id: a.material_id }, last);
        if (mr.source === 'last_purchase' && mr.ratePerPurchaseUnit > 0) {
          rate = mr.ratePerPurchaseUnit; basis = 'last_purchase'; asOf = mr.asOf || null;
        }
      }
    }
    // Rounded to the paisa PER ITEM, exactly as the screen prints each row
    // (fmtINR: Math.round(x × 100) / 100 of this same 6-dp figure), so the rows
    // as printed add up to the total printed under them and on the card
    // (screen-r1: they drifted 1–7 paise apart). This estimate is tied to no
    // ledger, so no sub-paisa fraction needs keeping. ₹ Ordered and ₹ Received
    // keep theirs (m6), because ₹ Received must equal the Purchase Report's own
    // SUM to the paisa; the page says so when their rows drift.
    const requestedValue = rate == null ? null : paise(m6(requested * rate)) / 100;

    const others: ReqReconOther[] = [...a.others.entries()]
      .map(([department, o]) => ({ department, qty: o.converted > 0 ? q6(o.recipe / pf) : null, lines: o.lines }))
      .sort((x, y) => x.department.localeCompare(y.department));

    items.push({
      material_id: a.material_id,
      item: m ? (m.name || unlinkedName(a.material_id)) : unlinkedName(a.material_id),
      sku: m?.sku || '', category: m?.category || '', unit: unitOf(m), unlinked: !m,
      requested_qty: requested, requested_lines: a.reqLines,
      requested_unconverted: a.reqUnconverted, requested_unit_assumed: a.reqAssumed,
      ordered_qty: ordered, ordered_value: m6(a.ordValue), ordered_lines: a.ordLines,
      closed_qty: q6(a.closedQty), closed_lines: a.closedLines,
      received_qty: received, received_value: m6(a.recValue), received_lines: a.recLines,
      held_qty: q6(a.heldQty), held_value: m6(a.heldValue), held_lines: a.heldLines,
      rate: rate == null ? null : Math.round(rate * 10000) / 10000, rate_basis: basis, rate_as_of: asOf,
      requested_value: requestedValue,
      ordered_minus_requested: q6(ordered - requested),
      received_minus_ordered: q6(received - ordered),
      others,
    });
  }
  items.sort((x, y) => x.item.localeCompare(y.item, 'en', { sensitivity: 'base' }) || x.material_id.localeCompare(y.material_id));

  const totals: ReqReconTotals = {
    requested_value: m6(items.reduce((s, i) => s + (i.requested_value ?? 0), 0)),
    items_without_rate: items.filter(i => i.requested_qty > 0 && i.requested_value == null).length,
    ordered_value: m6(items.reduce((s, i) => s + i.ordered_value, 0)),
    received_value: m6(items.reduce((s, i) => s + i.received_value, 0)),
    held_value: m6(items.reduce((s, i) => s + i.held_value, 0)),
  };
  const counts: ReqReconCounts = {
    items: items.length,
    requisitions: reqIds.size,
    request_lines: requestLines,
    purchase_orders: poIds.size,
    po_lines: poLines,
    receipt_lines: receiptLines,
    held_lines: heldLines,
    closed_lines: closedLines,
    shared_items: items.filter(i => i.others.length > 0).length,
    unconverted_lines: unconverted,
    unit_assumed_lines: assumed,
  };

  return {
    department: dept ? deptOut(depts, dept) : null,
    items, totals, counts,
    purchase_report_booked: purchaseReportBooked,
    // Only an all-items view can be held to the Purchase Report's period total.
    matches_purchase_report: dept || materialId ? null : paise(totals.received_value) === paise(purchaseReportBooked),
    win, inView, depts,
  };
}

/** The report for a period and department. SELECT only — the caller owns the access gate. */
export function getReqRecon(f: ReqReconFilters, dbArg?: Db): ReqReconResponse {
  const db = dbArg || getDb();
  const b = build(db, f);
  return {
    from: f.from, to: f.to,
    department: b.department,
    departments: mainDepartments(db),
    items: b.items, totals: b.totals, counts: b.counts,
    purchase_report_booked: b.purchase_report_booked,
    matches_purchase_report: b.matches_purchase_report,
  };
}

/* ═══════════════════════════════ the documents behind an item ══════════════ */

function requestRows(b: Built, materialIds: Set<string> | null): (ReqReconRequestRow & { material_id: string })[] {
  const out: (ReqReconRequestRow & { material_id: string })[] = [];
  for (const r of b.win.reqs) {
    if (materialIds && !materialIds.has(r.material_id)) continue;
    const inView = b.inView(r.department_id);
    // Another department's line is shown only when it is counted for that
    // department — it explains a shared item; a rejected one there explains nothing.
    if (!inView && !r.counted) continue;
    const m = b.win.mats.get(r.material_id);
    const own = b.depts.get(r.department_id);
    const main = mainOf(b.depts, r.department_id);
    const pf = packFactor(metaOf(m));
    const notes: string[] = [];
    if (!inView) notes.push('Another department’s request');
    else if (r.note) notes.push(r.note);
    if (r.recipe == null) notes.push(`“${r.line_unit}” cannot be converted to ${unitOf(m, 'the purchase unit')}`);
    else if (r.unit_assumed) notes.push(`No unit recorded on the line — read as ${unitOf(m, 'the purchase unit')}`);
    const approvedDiffers = r.approved_qty != null && Math.abs(r.approved_qty - r.qty) > 1e-9;
    out.push({
      material_id: r.material_id,
      date: r.date, req_number: r.req_number,
      department: own ? own.name : '(department not found)',
      main_department: main ? main.name : '(department not found)',
      raised_by: r.raised_by, party: r.party,
      status_label: r.status_label,
      // '' when the line recorded no unit — the screen and the file say so rather than print one.
      qty: q6(r.qty), line_unit: r.line_unit,
      qty_purchase: r.recipe == null ? null : q6(r.recipe / pf),
      approved_qty: approvedDiffers ? q6(r.approved_qty as number) : null,
      counted: inView && r.counted && r.recipe != null,
      note: notes.join(' · '),
      in_view: inView,
    });
  }
  return out;
}

function poRows(db: Db, b: Built, materialIds: Set<string> | null): (ReqReconPoRow & { material_id: string })[] {
  const lines = b.win.pos.filter(p => !materialIds || materialIds.has(p.material_id));
  const ids = lines.map(p => p.id);

  // VALUE: what was accepted against each PO line so far — live receipts, held
  // ones excluded (a held line has accepted nothing yet), any receipt date.
  const got = new Map<string, number>();
  for (const part of chunk(ids)) {
    const rows = db.prepare(`
      SELECT gi.po_item_id AS id, SUM(COALESCE(gi.quantity_accepted, 0)) AS acc
        FROM purchase_order_items poi
        JOIN goods_receipt_note_items gi ON gi.po_item_id = poi.id
        ${claimJoin({ poIdCol: 'poi.po_id' })}
       WHERE poi.id IN (${part.map(() => '?').join(',')}) AND ${liveValueSql('g')}
       GROUP BY gi.po_item_id
    `).all(...part) as Record<string, unknown>[];
    for (const r of rows) got.set(String(r.id), num(r.acc));
  }

  // Which requisitions each PO line was raised for: a merged PO's link rows,
  // the store's "also raise a PO" tick (purchase_order_items.req_item_id), and
  // the older one-requisition PO header (purchase_orders.requisition_id, when
  // that requisition asked for this item). Each names the department of the
  // requisition LINE it is linked to (LINE_DEPT_SQL), never the header's — a
  // party requisition's Bar line under a Kitchen header is the Bar's.
  const forLine = new Map<string, Set<string>>();
  const add = (poItemId: string, reqNo: string, deptId: string) => {
    if (!reqNo) return;
    const d = b.depts.get(deptId);
    const s = forLine.get(poItemId) || new Set<string>();
    s.add(d ? `${reqNo} (${d.name})` : reqNo);
    forLine.set(poItemId, s);
  };
  const haveLinks = hasTable(db, 'po_requisition_lines');
  for (const part of chunk(ids)) {
    const ph = part.map(() => '?').join(',');
    if (haveLinks) {
      // The link row's own department (written from the line when the PO was
      // merged) stands in only if the line itself is gone.
      for (const r of db.prepare(`
        SELECT prl.po_item_id, r.req_number,
               COALESCE(NULLIF(TRIM(ri.department_id), ''), NULLIF(TRIM(prl.department_id), ''), r.department_id) AS department_id
          FROM po_requisition_lines prl
          JOIN requisitions r ON r.id = prl.requisition_id
          LEFT JOIN requisition_items ri ON ri.id = prl.req_item_id
         WHERE prl.po_item_id IN (${ph})
      `).all(...part) as Record<string, unknown>[]) add(String(r.po_item_id), str(r.req_number), str(r.department_id));
    }
    for (const r of db.prepare(`
      SELECT poi.id AS po_item_id, r.req_number, ${LINE_DEPT_SQL} AS department_id
        FROM purchase_order_items poi
        JOIN requisition_items ri ON ri.id = poi.req_item_id
        JOIN requisitions r ON r.id = ri.req_id
       WHERE poi.id IN (${ph})
    `).all(...part) as Record<string, unknown>[]) add(String(r.po_item_id), str(r.req_number), str(r.department_id));
    // The PO header names a requisition, not a line: the line is that
    // requisition's line for this item (one material = one line).
    for (const r of db.prepare(`
      SELECT poi.id AS po_item_id, r.req_number, ${LINE_DEPT_SQL} AS department_id
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.po_id
        JOIN requisitions r ON r.id = po.requisition_id
        JOIN requisition_items ri ON ri.req_id = r.id AND ri.material_id = poi.material_id
       WHERE poi.id IN (${ph}) AND (poi.req_item_id IS NULL OR TRIM(poi.req_item_id) = '')
    `).all(...part) as Record<string, unknown>[]) add(String(r.po_item_id), str(r.req_number), str(r.department_id));
  }

  return lines.map(p => ({
    material_id: p.material_id,
    date: p.date, po_number: p.po_number, vendor: p.vendor,
    qty: q6(p.qty), rate: p.rate, value: m6(p.qty * p.rate),
    status_label: words(PO_STATUS_WORDS, p.status),
    counted: p.counted, note: p.note,
    received_on_line: q6(got.get(p.id) || 0),
    raised_for: [...(forLine.get(p.id) || [])].sort().join(', '),
  }));
}

function receiptRows(b: Built, materialIds: Set<string> | null): (ReqReconReceiptRow & { material_id: string })[] {
  const out: (ReqReconReceiptRow & { material_id: string })[] = [];
  const seen = new Set<string>();
  for (const r of b.win.booked) {
    if (materialIds && !materialIds.has(r.material_id)) continue;
    // A receipt's rejected quantity is printed once, on its first booked row.
    const key = `${r.grn_id}|${r.material_id}`;
    let rejected = 0;
    if (r.grn_id && !seen.has(key)) { rejected = b.win.rejectedByGrnMat.get(key) || 0; seen.add(key); }
    out.push({
      material_id: r.material_id, kind: 'booked',
      date: r.date, grn_number: r.grn_no, invoice_id: r.invoice_id, bill_no: r.bill_no, po_number: r.po_no,
      vendor: r.vendor, qty: q6(r.qty), rejected_qty: q6(rejected), rate: r.rate, value: m6(r.value),
      counted: true,
      status_label: r.grn_no ? (r.po_no ? 'Booked — goods receipt on a PO' : 'Booked — goods receipt') : 'Booked — direct purchase entry',
    });
  }
  for (const g of b.win.grnLines) {
    if (materialIds && !materialIds.has(g.material_id)) continue;
    out.push({
      material_id: g.material_id, kind: g.kind,
      date: g.date, grn_number: g.grn_number, invoice_id: '', bill_no: g.bill_no, po_number: g.po_no,
      vendor: g.vendor, qty: q6(g.qty), rejected_qty: q6(g.rejected_qty), rate: g.rate, value: m6(g.value),
      counted: false,
      status_label: g.kind === 'held' ? 'Held for the kitchen’s quality check — not booked yet'
        : g.kind === 'void' ? 'Receipt voided'
        : 'Turned away at delivery — nothing booked',
    });
  }
  out.sort((x, y) => x.date.localeCompare(y.date) || x.grn_number.localeCompare(y.grn_number));
  return out;
}

/** The documents behind one item, for the period and department. SELECT only. */
export function getReqReconDetail(f: ReqReconFilters, materialId: string, dbArg?: Db): ReqReconDetail {
  const db = dbArg || getDb();
  const b = build(db, f, materialId);
  const only = new Set([materialId]);
  const item = b.items.find(i => i.material_id === materialId) || null;
  const m = b.win.mats.get(materialId) || loadMaterials(db, [materialId]).get(materialId);
  const strip = <T extends { material_id: string }>(rows: T[]): Omit<T, 'material_id'>[] =>
    rows.map(({ material_id: _m, ...rest }) => { void _m; return rest; });
  return {
    from: f.from, to: f.to, department: b.department, item,
    item_name: m ? (m.name || unlinkedName(materialId)) : unlinkedName(materialId),
    unit: unitOf(m),
    requests: strip(requestRows(b, only)),
    purchase_orders: strip(poRows(db, b, only)),
    receipts: strip(receiptRows(b, only)),
  };
}

/* ═══════════════════════════════ the Excel file ════════════════════════════ */

const MONEY_FMT = '#,##0.00';
const QTY_FMT = '#,##0.###';
const QTY_WHOLE_FMT = '#,##0';
const RATE_FMT = '#,##0.00##';
const DATE_FMT = 'dd-mmm-yyyy';

/**
 * A quantity cell's number format, chosen PER VALUE. The screen prints a
 * quantity with up to 3 decimals, and so does '#,##0.###' — but when no decimal
 * digit is left to print it leaves a bare point: "8.", "0.", "-9.", "1,000."
 * (checker r1). So a quantity that is whole at 3 decimals gets '#,##0', and
 * only a real fraction gets '#,##0.###'. "Whole at 3 decimals" is decided as a
 * spreadsheet rounds for display — on the 15-significant-digit value, half away
 * from zero (1.9995 → 2) — so a fraction is never handed a format that would
 * print it as "2.". A non-zero quantity too small to show at 3 decimals keeps
 * General (no format), so it prints as itself rather than "0" or "-0".
 */
function qtyFormat(v: number): string | null {
  const thousandths = Math.round(Number((Math.abs(v) * 1000).toPrecision(15)));
  if (thousandths === 0) return v === 0 ? QTY_WHOLE_FMT : null;
  return thousandths % 1000 === 0 ? QTY_WHOLE_FMT : QTY_FMT;
}

/** "2026-10-01" → the Excel day number, in UTC so no time zone can move it. */
function excelDate(ymd: string): number | string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return safeText(ymd || '');
  return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** Formula-injection guard, as on every other export: = + - @ tab CR lead → apostrophe. */
function safeText(s: string): string {
  const v = String(s ?? '');
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

type Fmt = 'text' | 'date' | 'money' | 'qty' | 'rate' | 'plain';
interface SheetCol { header: string; fmt: Fmt; wch: number }

function dataSheet(cols: SheetCol[], rows: (string | number | null)[][]): XLSX.WorkSheet {
  const aoa: (string | number | null)[][] = [cols.map(c => c.header), ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let r = 1; r <= rows.length; r++) {
    cols.forEach((c, ci) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c: ci })];
      if (!cell || cell.t !== 'n') return;
      if (c.fmt === 'money') cell.z = MONEY_FMT;
      else if (c.fmt === 'qty') { const z = qtyFormat(Number(cell.v)); if (z) cell.z = z; }
      else if (c.fmt === 'rate') cell.z = RATE_FMT;
      else if (c.fmt === 'date') cell.z = DATE_FMT;
    });
  }
  ws['!cols'] = cols.map(c => ({ wch: c.wch }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length), c: cols.length - 1 } }) };
  return ws;
}

const yesNo = (b: boolean) => (b ? 'Yes' : 'No');
const qtyWords = (n: number | null, unit: string) =>
  n == null ? 'cannot be converted' : `${n.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${unit}`.trim();

function itemNotes(i: ReqReconItem): string {
  const n: string[] = [];
  if (i.unlinked) n.push('No item record for this id — kept under the id so its money is not lost');
  if (i.requested_unconverted > 0) {
    n.push(`${i.requested_unconverted} request line${i.requested_unconverted === 1 ? '' : 's'} in a unit that cannot be converted to ${i.unit || 'the purchase unit'} — not in Requested`);
  }
  if (i.requested_unit_assumed > 0) {
    n.push(`${i.requested_unit_assumed} request line${i.requested_unit_assumed === 1 ? '' : 's'} with no unit recorded — read as ${i.unit || 'the purchase unit'}`);
  }
  if (i.requested_qty > 0 && i.rate == null) n.push(NO_RATE_WORDS_SHORT);
  return n.join(' · ');
}

/** File name: requested-vs-received_<department>_<from>_<to>.xlsx */
export function reqReconFilename(f: ReqReconFilters, dept: ReqReconDept | null): string {
  const slug = (dept ? dept.name : 'all-departments').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'department';
  return `requested-vs-received_${slug}_${f.from}_${f.to}.xlsx`;
}

/** The workbook: Items, Requests, Purchase orders, Receipts, Summary. */
export function buildReqReconWorkbook(f: ReqReconFilters, generatedAt: Date = new Date(), dbArg?: Db): { buffer: Buffer; department: ReqReconDept | null } {
  const db = dbArg || getDb();
  const b = build(db, f);
  const ids = new Set(b.items.map(i => i.material_id));
  const byId = new Map(b.items.map(i => [i.material_id, i]));
  const mat = (id: string) => b.win.mats.get(id);
  const wb = XLSX.utils.book_new();

  // 1 ── Items: one row per item, like the owner's sheet.
  const itemCols: SheetCol[] = [
    { header: 'Item', fmt: 'text', wch: 34 },
    { header: 'SKU', fmt: 'text', wch: 11 },
    { header: 'Category', fmt: 'text', wch: 16 },
    { header: 'Purchase unit', fmt: 'text', wch: 9 },
    { header: 'Requested qty', fmt: 'qty', wch: 11 },
    { header: 'Ordered qty', fmt: 'qty', wch: 11 },
    { header: 'Ordered − Requested (qty)', fmt: 'qty', wch: 13 },
    { header: 'Received qty', fmt: 'qty', wch: 11 },
    { header: 'Received − Ordered (qty)', fmt: 'qty', wch: 13 },
    // The goods WERE delivered (the GRN's quantity_received): they are only not
    // in Received yet — as the Summary's "(delivered, not booked yet)" and the
    // screen's column tooltip say.
    { header: 'Held for QC (qty, delivered, not in Received yet)', fmt: 'qty', wch: 14 },
    { header: 'Vendor closed before delivery (qty, not in Ordered)', fmt: 'qty', wch: 16 },
    { header: 'Rate (₹ per purchase unit)', fmt: 'rate', wch: 12 },
    { header: 'Rate basis', fmt: 'text', wch: 30 },
    { header: '₹ Requested (estimate)', fmt: 'money', wch: 15 },
    { header: '₹ Ordered', fmt: 'money', wch: 14 },
    { header: '₹ Received (booked into stock)', fmt: 'money', wch: 15 },
    { header: '₹ Ordered − ₹ Requested (estimate)', fmt: 'money', wch: 15 },
    { header: '₹ Received − ₹ Ordered', fmt: 'money', wch: 15 },
    { header: '₹ Held for QC (not booked yet)', fmt: 'money', wch: 14 },
    { header: 'Also requested by other departments', fmt: 'text', wch: 34 },
    { header: 'Request lines', fmt: 'plain', wch: 8 },
    { header: 'PO lines', fmt: 'plain', wch: 8 },
    { header: 'Receipt lines', fmt: 'plain', wch: 8 },
    { header: 'Notes', fmt: 'text', wch: 40 },
  ];
  const itemRows = b.items.map(i => [
    safeText(i.item), safeText(i.sku), safeText(i.category), safeText(i.unit),
    i.requested_qty, i.ordered_qty, i.ordered_minus_requested, i.received_qty, i.received_minus_ordered,
    i.held_qty, i.closed_qty,
    i.rate, i.rate_basis ? RATE_BASIS_WORDS[i.rate_basis] + (i.rate_as_of ? ` (${humanDate(i.rate_as_of)})` : '') : 'No rate',
    i.requested_value, i.ordered_value, i.received_value,
    i.requested_value == null ? null : m6(i.ordered_value - i.requested_value),
    m6(i.received_value - i.ordered_value),
    i.held_value,
    safeText(i.others.map(o => `${o.department}: ${qtyWords(o.qty, i.unit)} (${o.lines} line${o.lines === 1 ? '' : 's'})`).join('; ')),
    i.requested_lines, i.ordered_lines, i.received_lines,
    safeText(itemNotes(i)),
  ]);
  XLSX.utils.book_append_sheet(wb, dataSheet(itemCols, itemRows), 'Items');

  // 2 ── Requests behind the rows.
  const reqCols: SheetCol[] = [
    { header: 'Date', fmt: 'date', wch: 12 },
    { header: 'Req No', fmt: 'text', wch: 15 },
    { header: 'Main department', fmt: 'text', wch: 14 },
    { header: 'Department / section', fmt: 'text', wch: 20 },
    { header: 'Raised by', fmt: 'text', wch: 18 },
    { header: 'Party', fmt: 'text', wch: 6 },
    { header: 'Item', fmt: 'text', wch: 32 },
    { header: 'SKU', fmt: 'text', wch: 11 },
    { header: 'Qty asked', fmt: 'qty', wch: 10 },
    { header: 'Unit asked in', fmt: 'text', wch: 9 },
    { header: 'Qty (purchase unit)', fmt: 'qty', wch: 11 },
    { header: 'Purchase unit', fmt: 'text', wch: 9 },
    { header: 'HOD approved qty (when changed)', fmt: 'qty', wch: 12 },
    { header: 'Status', fmt: 'text', wch: 14 },
    { header: 'Counted in Requested', fmt: 'text', wch: 10 },
    { header: 'Note', fmt: 'text', wch: 44 },
  ];
  const reqRows = requestRows(b, b.department ? ids : null)
    .filter(r => ids.has(r.material_id))
    .map(r => {
      const i = byId.get(r.material_id);
      return [
        excelDate(r.date), safeText(r.req_number), safeText(r.main_department), safeText(r.department),
        safeText(r.raised_by), r.party ? 'Party' : '', safeText(i?.item || ''), safeText(i?.sku || ''),
        r.qty, r.line_unit ? safeText(r.line_unit) : '(none recorded)', r.qty_purchase, safeText(i?.unit || unitOf(mat(r.material_id))), r.approved_qty,
        safeText(r.status_label), yesNo(r.counted), safeText(r.note),
      ];
    });
  XLSX.utils.book_append_sheet(wb, dataSheet(reqCols, reqRows), 'Requests');

  // 3 ── Purchase orders for the listed items (whole outlet).
  const poCols: SheetCol[] = [
    { header: 'Date', fmt: 'date', wch: 12 },
    { header: 'PO No', fmt: 'text', wch: 15 },
    { header: 'Vendor', fmt: 'text', wch: 26 },
    { header: 'Item', fmt: 'text', wch: 32 },
    { header: 'SKU', fmt: 'text', wch: 11 },
    { header: 'Qty', fmt: 'qty', wch: 10 },
    { header: 'Purchase unit', fmt: 'text', wch: 9 },
    { header: 'Rate (₹)', fmt: 'rate', wch: 11 },
    { header: 'Value (₹)', fmt: 'money', wch: 13 },
    { header: 'Status', fmt: 'text', wch: 16 },
    { header: 'Counted in Ordered', fmt: 'text', wch: 10 },
    { header: 'Note', fmt: 'text', wch: 40 },
    { header: 'Accepted against this line so far (qty)', fmt: 'qty', wch: 14 },
    { header: 'Raised for', fmt: 'text', wch: 36 },
  ];
  const poData = poRows(db, b, ids).map(p => {
    const i = byId.get(p.material_id);
    return [
      excelDate(p.date), safeText(p.po_number), safeText(p.vendor), safeText(i?.item || ''), safeText(i?.sku || ''),
      p.qty, safeText(i?.unit || ''), p.rate, p.value, safeText(p.status_label), yesNo(p.counted), safeText(p.note),
      p.received_on_line, safeText(p.raised_for),
    ];
  });
  XLSX.utils.book_append_sheet(wb, dataSheet(poCols, poData), 'Purchase orders');

  // 4 ── Receipts for the listed items (whole outlet).
  const recCols: SheetCol[] = [
    { header: 'Date', fmt: 'date', wch: 12 },
    { header: 'GRN No', fmt: 'text', wch: 15 },
    { header: 'Our invoice no (PINV)', fmt: 'text', wch: 15 },
    { header: 'Vendor bill no', fmt: 'text', wch: 13 },
    { header: 'PO No', fmt: 'text', wch: 15 },
    { header: 'Vendor', fmt: 'text', wch: 26 },
    { header: 'Item', fmt: 'text', wch: 32 },
    { header: 'SKU', fmt: 'text', wch: 11 },
    { header: 'Qty', fmt: 'qty', wch: 10 },
    { header: 'Rejected qty', fmt: 'qty', wch: 9 },
    { header: 'Purchase unit', fmt: 'text', wch: 9 },
    { header: 'Rate (₹)', fmt: 'rate', wch: 11 },
    { header: 'Value (₹)', fmt: 'money', wch: 13 },
    { header: 'Status', fmt: 'text', wch: 40 },
    { header: 'Counted in Received', fmt: 'text', wch: 10 },
  ];
  const recData = receiptRows(b, ids).map(r => {
    const i = byId.get(r.material_id);
    return [
      excelDate(r.date), safeText(r.grn_number), safeText(r.invoice_id), safeText(r.bill_no), safeText(r.po_number),
      safeText(r.vendor), safeText(i?.item || ''), safeText(i?.sku || ''),
      r.qty, r.rejected_qty || null, safeText(i?.unit || ''), r.rate, r.value, safeText(r.status_label), yesNo(r.counted),
    ];
  });
  XLSX.utils.book_append_sheet(wb, dataSheet(recCols, recData), 'Receipts');

  // 5 ── Summary: what the file is, the ₹ totals, the counts, and the rules.
  const t = b.totals; const c = b.counts;
  const aoa: (string | number | null)[][] = [];
  aoa.push(['Requested → Ordered → Received']);
  aoa.push(['Period', `${periodWords(f.from, f.to)} (${humanDate(f.from)} to ${humanDate(f.to)})`]);
  aoa.push(['Department', deptViewWords(b.department)]);
  aoa.push(['Generated', fmtIST(generatedAt)]);
  aoa.push([]);
  aoa.push(['Figure', '₹']);
  const moneyStart = aoa.length;
  aoa.push([`₹ Requested (estimate)${t.items_without_rate ? ` — ${t.items_without_rate} item${t.items_without_rate === 1 ? '' : 's'} with no rate not included` : ''}`, t.requested_value]);
  aoa.push(['₹ Ordered', t.ordered_value]);
  aoa.push(['₹ Received (booked into stock)', t.received_value]);
  aoa.push(['₹ Ordered − ₹ Requested (estimate)', m6(t.ordered_value - t.requested_value)]);
  aoa.push(['₹ Received − ₹ Ordered', m6(t.received_value - t.ordered_value)]);
  aoa.push(['₹ Held for QC (delivered, not booked yet)', t.held_value]);
  aoa.push([b.department
    ? 'Purchase Report — booked into stock for these dates, ALL items (for comparison; this file lists only the items this department asked for)'
    : 'Purchase Report — booked into stock for these dates, ALL items', b.purchase_report_booked]);
  const moneyEnd = aoa.length;
  if (b.matches_purchase_report != null) {
    aoa.push(['Received total matches the Purchase Report', b.matches_purchase_report ? 'Yes — to the paisa' : 'NO — please report this']);
  }
  aoa.push([]);
  aoa.push(['Count', 'Number']);
  aoa.push(['Items', c.items]);
  aoa.push(['Requisitions counted', c.requisitions]);
  aoa.push(['Request lines counted', c.request_lines]);
  aoa.push(['Purchase orders counted', c.purchase_orders]);
  aoa.push(['PO lines counted', c.po_lines]);
  aoa.push(['Purchase entries booked (receipt lines)', c.receipt_lines]);
  aoa.push(['Receipt lines held for QC', c.held_lines]);
  aoa.push(['PO lines closed before delivery (not counted)', c.closed_lines]);
  if (b.department) aoa.push(['Items also requested by other departments', c.shared_items]);
  aoa.push([]);
  aoa.push(['How this file counts']);
  for (const rule of [RULE_REQUESTED, RULE_ORDERED, RULE_RECEIVED, RULE_VALUES, RULE_SHARED]) aoa.push([rule]);
  aoa.push(['Quantities are never added across items (2 kg + 3 bottles is not 5 of anything), so the totals here are in ₹ only.']);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let r = moneyStart; r < moneyEnd; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: 1 })];
    if (cell && cell.t === 'n') cell.z = MONEY_FMT;
  }
  ws['!cols'] = [{ wch: 70 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Summary');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
  return { buffer, department: b.department };
}
