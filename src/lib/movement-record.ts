/**
 * THE MOVEMENT RECORD — the eight fields every stock movement must carry.
 * ============================================================================
 *
 * OWNER'S REQUIREMENT (2026-09-10): every store-level movement is a SEPARATE
 * TRANSACTION identifying
 *
 *      1. item              5. destination location
 *      2. quantity          6. movement type
 *      3. unit of measure   7. transaction date
 *      4. source location   8. responsible user
 *
 * Three tables carry stock movements in this app and NONE of them carried all
 * eight before this module:
 *
 *   · store_stock_ledger              — the STORE rail (liquor store, floor bars)
 *   · department_material_transactions — the DEPARTMENT rail (kitchen, bar)
 *   · inventory_transactions          — the CENTRAL GROCERY rail
 *
 * This module is the ONE place that decides what those eight fields mean, so
 * the three rails answer the same question the same way and the movements
 * register (/inventory/movements) can union them without inventing anything.
 *
 * ── WHAT IS ADDITIVE, AND WHY THAT MATTERS ─────────────────────────────────
 * Every column this module writes was added by ALTER TABLE with a DEFAULT ('',
 * or 0 for pack_size). A row written before this change therefore reads back
 * with blank movement fields and its ORIGINAL columns untouched — which is
 * exactly what every deployed reader selects. Nothing here changes a quantity,
 * a sign, a cost, a balance or an ordering key. The arithmetic is deployed and
 * correct; this is about the RECORD, not the arithmetic.
 *
 * ── FIELD 3, THE UNIT OF MEASURE: WHICH UNIT, AND WHY ──────────────────────
 * `uom` stores the material's RECIPE unit as it stood AT THE MOMENT OF THE
 * MOVEMENT — because the recipe unit is the unit the `quantity` column is
 * actually in, on all three tables, by the pack-size convention this codebase
 * runs on (see [[project_fnb_unit_convention]]):
 *
 *      purchase rows are entered in PURCHASE units, but store/dept/central
 *      movement quantities are ALWAYS recorded in RECIPE units (× pack_size),
 *      and unit_cost / average_price are ALWAYS ₹ per RECIPE unit.
 *
 * A number without its unit is how the 5,000× errors happened here before (see
 * [[project_fnb_lpp_mixed_basis]]: 105 raw_materials rows with a
 * last_purchase_price in the wrong basis, up to 5,000× off). The unit was never
 * WRONG on these rows — it was ABSENT, and re-derived at read time from
 * raw_materials.unit. That works until somebody edits a material's unit, at
 * which point every historical row for it silently re-means: a ledger row that
 * recorded 750 ml becomes 750 "bottles" with no edit to the row and no trace.
 *
 * So all three unit facts are SNAPSHOT onto the row and never read back from
 * raw_materials for a historical figure:
 *   · uom          — the recipe unit `quantity` is in           (e.g. 'ml')
 *   · purchase_uom — the purchase unit the same qty converts to (e.g. 'Bottle')
 *   · pack_size    — recipe units per purchase unit             (e.g. 750)
 * With those three the row is self-describing: it renders in either basis
 * (the house PURCHASE-unit display law, [[project_fnb_purchase_unit_display]])
 * without a join, and a later edit to the material cannot re-mean it.
 *
 * pack_size 0 means "not snapshot" (a pre-change row) — readers must fall back
 * to the live material, exactly as they do today. It never means "pack of 0".
 *
 * ── FIELDS 4 & 5, SOURCE AND DESTINATION ───────────────────────────────────
 * Locations in this app are heterogeneous: a store_locations row, a departments
 * row, the central grocery (which is not a row at all — it IS
 * raw_materials.current_stock), a vendor, or a non-place that stock legitimately
 * ends at (eaten, wasted, written off against a count). One TEXT column cannot
 * carry that, and two id columns cannot either, so each end is a typed triple:
 *
 *      <side>_kind   one of MOVEMENT_PARTY_KINDS — what sort of place it is
 *      <side>_id     the store/department id when kind is 'store'|'department';
 *                    the vendor id when known; '' otherwise
 *      <side>_name   the human label SNAPSHOT at movement time
 *
 * `_name` is snapshot for the same reason `uom` is: a store or a department can
 * be renamed, and a movement register that silently rewrites where last April's
 * goods went is not a record. Readers show `_name`; `_id` is for filtering and
 * joining to the CURRENT entity.
 *
 * ── FIELD 7, THE TRANSACTION DATE ──────────────────────────────────────────
 * Two facts, not one, and this codebase used to keep only a mangled version of
 * the second:
 *
 *   · txn_date    — the BUSINESS date the movement happened (YYYY-MM-DD, IST).
 *                   This is the owner's "transaction date". Backdating sets it.
 *   · recorded_at — when the row was actually WRITTEN. Immutable.
 *
 * `created_at` keeps its deployed meaning and its deployed value untouched,
 * because the balance arithmetic and every ledger reader order and window on
 * it. What it could NOT do is be two things at once: four writers backdate a
 * purchase by UPDATE-ing created_at AFTER the insert (stores procure,
 * procure-bulk, procure-bill, variance-approval), which moves the row to the
 * right business date and destroys "when was this recorded" in the same
 * statement. recorded_at is stamped here, at insert, and no backdater touches
 * it — so an entry made three weeks late is now visibly an entry made three
 * weeks late, without changing where it sorts.
 *
 * ── FIELD 8, THE RESPONSIBLE USER ──────────────────────────────────────────
 * From the SESSION, never from the request body. The routes already resolve
 * getCurrentUser(); what was missing was (a) a column at all on
 * inventory_transactions and (b) any refusal when a writer left it blank. Both
 * choke points now REFUSE a blank actor.
 *
 * Machine-initiated movements are the honest exception and are recorded as
 * such, with the SYSTEM_ACTOR_PREFIX: the KOT-completion sweep runs on a timer
 * with no session at all, and writing a person's name on it would be a lie.
 * `system:kot-sweep` is a true answer; '' is not, and neither is 'admin'.
 */

import type Database from 'better-sqlite3';

/* ────────────────────────────────────────────────────────────────────────────
 * PARTIES — the vocabulary of "where did it come from / go to"
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Closed vocabulary for src_kind / dst_kind. Closed on purpose: an open string
 * is what `inventory_transactions.type` already is, and that column has three
 * observed values in the database and nine more that only exist in code, with
 * nothing to tell you which is which.
 *
 * Five are PLACES stock can sit:
 *   central     the central grocery — raw_materials.current_stock itself
 *   store       a store_locations row (LIQUOR STORE, a floor bar)
 *   department  a departments row (Kitchen, Bar)
 *   vendor      outside the building, upstream
 *   production  a kitchen production batch / butchering yield
 *
 * Four are SINKS — real ends of a movement that are not places, and must not be
 * dressed up as one. Stock that reaches these does not sit anywhere afterwards:
 *   consumption  served, sold, poured, or eaten at an event
 *   wastage      spoiled / written off
 *   staff_meal   cooked for staff
 *   external     anything genuinely outside the model (last resort; say why in notes)
 *
 * Two are ANCHORS — one end of a movement that has no counterparty at all:
 *   opening      the cutover: stock that existed before the system did
 *   adjustment   a correction against a physical count. The counterparty is not
 *                a place; it is the difference between the book and the shelf.
 *                Naming it honestly is the point — a variance posted as a
 *                "transfer from external" invents a movement that never happened.
 */
export const MOVEMENT_PARTY_KINDS = [
  'central', 'store', 'department', 'vendor', 'production',
  'consumption', 'wastage', 'staff_meal', 'external',
  'opening', 'adjustment',
] as const;
export type MovementPartyKind = (typeof MOVEMENT_PARTY_KINDS)[number];

/** One end of a movement. `id` is only meaningful for store/department/vendor. */
export interface MovementParty {
  kind: MovementPartyKind;
  /** store_locations.id | departments.id | vendors.id — '' for kinds that have none. */
  id?: string;
  /** Human label, SNAPSHOT at movement time. Falls back to the kind's own label. */
  name?: string;
}

/** Default display label per kind, used when a caller supplies no name. */
const KIND_LABEL: Record<MovementPartyKind, string> = {
  central: 'Central Store',
  store: 'Store',
  department: 'Department',
  vendor: 'Vendor',
  production: 'Production',
  consumption: 'Consumed / Served',
  wastage: 'Wastage',
  staff_meal: 'Staff Meal',
  external: 'External',
  opening: 'Opening Balance',
  adjustment: 'Stock Correction',
};

/** Prefix marking an actor that is a machine, not a person. See field 8 above. */
export const SYSTEM_ACTOR_PREFIX = 'system:';

/** True when `actor` is a machine actor rather than a signed-in person. */
export function isSystemActor(actor: unknown): boolean {
  return String(actor || '').startsWith(SYSTEM_ACTOR_PREFIX);
}

export const CENTRAL_PARTY: MovementParty = Object.freeze({ kind: 'central', id: '', name: 'Central Store' });

/** Normalise a party (or nothing) into the three columns that get stored. */
export function partyCols(p: MovementParty | null | undefined, fallback?: MovementParty): {
  kind: string; id: string; name: string;
} {
  const use = p || fallback;
  if (!use) return { kind: '', id: '', name: '' };
  const kind = String(use.kind || '').trim() as MovementPartyKind;
  if (!(MOVEMENT_PARTY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`movement-record: unknown party kind '${String(use.kind)}'`);
  }
  return {
    kind,
    id: String(use.id || '').trim(),
    name: String(use.name || '').trim() || KIND_LABEL[kind],
  };
}

/** Build a `store` party, snapshotting the store's CURRENT name. */
export function storeParty(db: Database.Database, storeId: string): MovementParty {
  const id = String(storeId || '').trim();
  let name = '';
  try {
    const r = db.prepare('SELECT name FROM store_locations WHERE id = ?').get(id) as { name?: string } | undefined;
    name = String(r?.name || '').trim();
  } catch { /* store_locations missing on a very old db — kind + id still stand */ }
  return { kind: 'store', id, name: name || id };
}

/** Build a `department` party, snapshotting the department's CURRENT name. */
export function deptParty(db: Database.Database, departmentId: string): MovementParty {
  const id = String(departmentId || '').trim();
  let name = '';
  try {
    const r = db.prepare('SELECT name FROM departments WHERE id = ?').get(id) as { name?: string } | undefined;
    name = String(r?.name || '').trim();
  } catch { /* departments missing — kind + id still stand */ }
  return { kind: 'department', id, name: name || id };
}

/** Build a `vendor` party from whatever the writer has (a name, an id, or both). */
export function vendorParty(name?: unknown, id?: unknown): MovementParty {
  const n = String(name || '').trim();
  return { kind: 'vendor', id: String(id || '').trim(), name: n || 'Vendor' };
}

/* ────────────────────────────────────────────────────────────────────────────
 * UNITS — the snapshot that stops a number from re-meaning itself
 * ──────────────────────────────────────────────────────────────────────────*/

export interface UnitSnapshot {
  /** RECIPE unit — the unit `quantity` is stored in. */
  uom: string;
  /** PURCHASE unit the same quantity converts to at pack_size. */
  purchase_uom: string;
  /** Recipe units per purchase unit. 0 = unknown (never "a pack of zero"). */
  pack_size: number;
}

const BLANK_UNITS: UnitSnapshot = Object.freeze({ uom: '', purchase_uom: '', pack_size: 0 });

/**
 * Read a material's unit facts to snapshot onto a movement row.
 *
 * Never throws: a movement must not fail because the unit lookup did. A miss
 * returns blanks, which read back exactly like a pre-change row and send every
 * reader down the same live-material fallback it already has.
 */
export function unitSnapshot(db: Database.Database, materialId: string): UnitSnapshot {
  const id = String(materialId || '').trim();
  if (!id) return BLANK_UNITS;
  try {
    const r = db.prepare(
      'SELECT unit, purchase_unit, pack_size FROM raw_materials WHERE id = ?',
    ).get(id) as { unit?: string; purchase_unit?: string; pack_size?: number } | undefined;
    if (!r) return BLANK_UNITS;
    const uom = String(r.unit || '').trim();
    const pu = String(r.purchase_unit || '').trim();
    const ps = Number(r.pack_size);
    return {
      uom,
      // purchase_unit is backfilled from `unit` at boot, so equal strings are
      // the norm and mean "no pack conversion" — kept verbatim, not blanked,
      // so the row states its purchase basis rather than implying one.
      purchase_uom: pu || uom,
      pack_size: Number.isFinite(ps) && ps > 0 ? ps : 0,
    };
  } catch {
    return BLANK_UNITS;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * DATES
 * ──────────────────────────────────────────────────────────────────────────*/

/** Today in IST as YYYY-MM-DD. Server-side twin of format-date's todayIST(). */
export function todayISTDate(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Coerce whatever a writer has into a business date (YYYY-MM-DD, IST).
 * Accepts 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM:SS', an ISO string or a Date.
 * Anything unparseable falls back to today — a blank business date on a row
 * that HAS one is worse than an approximate one, and the true recording moment
 * is preserved separately in recorded_at either way.
 */
export function businessDate(v?: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return todayISTDate();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  return todayISTDate();
}

/** Immutable insert stamp for recorded_at — 'YYYY-MM-DD HH:MM:SS' UTC, matching created_at's shape. */
export function recordedNow(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE MOVEMENT COLUMNS
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * The eleven columns added to all three movement tables (twelve on
 * inventory_transactions, which also gained `created_by` — it had NO actor
 * column at all, across 34 writers).
 */
export const MOVEMENT_COLUMNS = [
  'uom', 'purchase_uom', 'pack_size',
  'src_kind', 'src_id', 'src_name',
  'dst_kind', 'dst_id', 'dst_name',
  'txn_date', 'recorded_at',
] as const;

const colsCache = new WeakMap<object, Map<string, Set<string>>>();

/**
 * Columns present on `table`, cached per (db, table).
 *
 * Why this exists rather than trusting the migration: the ALTERs run in
 * initDb(), and a db handle opened against a file that has not been migrated
 * yet (a restored backup, a test fixture, the boot order in scripts/) would
 * otherwise take every INSERT down with "no such column". Same defence
 * dept-ledger's traceCols() already uses for its four trace columns.
 */
export function tableCols(db: Database.Database, table: string): Set<string> {
  let perDb = colsCache.get(db as unknown as object);
  if (!perDb) { perDb = new Map(); colsCache.set(db as unknown as object, perDb); }
  const hit = perDb.get(table);
  if (hit) return hit;
  const found = new Set<string>();
  try {
    for (const c of db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>) {
      found.add(String(c.name));
    }
  } catch { /* table missing — the caller's INSERT surfaces it */ }
  perDb.set(table, found);
  return found;
}

export interface MovementFields {
  materialId: string;
  /** Signed quantity — only its SIGN is read here, to orient src/dst. Never stored by this helper. */
  quantity: number;
  src: MovementParty;
  dst: MovementParty;
  /** Business date; defaults to today (IST). */
  txnDate?: unknown;
}

/**
 * Produce the (names, values) to append to an INSERT for the movement columns
 * this table actually has. Returns empty arrays when the table has none, so a
 * caller on an unmigrated database writes exactly the row it wrote before.
 */
export function movementCols(
  db: Database.Database,
  table: string,
  f: MovementFields,
): { names: string[]; values: Array<string | number> } {
  const have = tableCols(db, table);
  const u = unitSnapshot(db, f.materialId);
  const src = partyCols(f.src);
  const dst = partyCols(f.dst);
  const all: Record<string, string | number> = {
    uom: u.uom,
    purchase_uom: u.purchase_uom,
    pack_size: u.pack_size,
    src_kind: src.kind, src_id: src.id, src_name: src.name,
    dst_kind: dst.kind, dst_id: dst.id, dst_name: dst.name,
    txn_date: businessDate(f.txnDate),
    recorded_at: recordedNow(),
  };
  const names: string[] = [];
  const values: Array<string | number> = [];
  for (const c of MOVEMENT_COLUMNS) {
    // have.size === 0 means the PRAGMA itself failed; append nothing rather
    // than guess, and let the caller's own column list stand.
    if (have.size > 0 && have.has(c)) { names.push(c); values.push(all[c]); }
  }
  return { names, values };
}

/**
 * Orient a movement around a fixed home rail.
 *
 * Every row on a single-location table has ONE end that is always the table's
 * own rail (central for inventory_transactions, the store for
 * store_stock_ledger, the department for department_material_transactions) and
 * one end that is the counterparty. Which side is which is decided by the SIGN
 * of the quantity, which is already the deployed convention on all three:
 *
 *      quantity > 0  →  goods came IN   →  dst = home,        src = counterparty
 *      quantity < 0  →  goods went OUT  →  src = home,        dst = counterparty
 *
 * This is the whole reason 30-odd writers did not each have to learn a source
 * and a destination: they know their own rail and their counterparty, and the
 * sign they already write settles the rest.
 */
export function orient(
  home: MovementParty,
  counterparty: MovementParty,
  quantity: number,
): { src: MovementParty; dst: MovementParty } {
  return Number(quantity) >= 0
    ? { src: counterparty, dst: home }
    : { src: home, dst: counterparty };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL RAIL CHOKE POINT
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * `inventory_transactions.type` had NO closed vocabulary, no CHECK and no
 * validating function — 34 raw INSERT sites each free to invent a string. This
 * is the vocabulary those 34 sites actually write, collected and documented.
 * It is deliberately NOT enforced as a hard reject: an unknown type is recorded
 * and warned about rather than thrown, because refusing one here would fail a
 * purchase or a settle for a reporting concern. Every reader that buckets by
 * type already has a catch-all.
 *
 * `counterparty` is the DEFAULT other end when a writer names none — chosen so
 * that a site nobody has revisited still records something true rather than
 * blank. A writer that knows better (which department, which store, which
 * vendor) passes its own and overrides this.
 */
export const CENTRAL_TXN_TYPES: Record<string, { doc: string; counterparty: MovementPartyKind }> = {
  purchase:            { doc: 'Vendor receipt into the central store',        counterparty: 'vendor' },
  vendor_return:       { doc: 'Goods returned to the vendor',                 counterparty: 'vendor' },
  requisition_issue:   { doc: 'Issued to a department on a requisition',      counterparty: 'department' },
  transfer:            { doc: 'Moved to / from another store location',       counterparty: 'store' },
  sale:                { doc: 'Recipe consumption against a sale',           counterparty: 'consumption' },
  nc:                  { doc: 'Non-chargeable / complimentary consumption',   counterparty: 'consumption' },
  party_issue:         { doc: 'Issued to a party / event',                    counterparty: 'consumption' },
  party_consumption:   { doc: 'Consumed at a party / event',                  counterparty: 'consumption' },
  party_return:        { doc: 'Party leftovers returned to the central store', counterparty: 'consumption' },
  consumption:         { doc: 'Consumed',                                     counterparty: 'consumption' },
  wastage:             { doc: 'Spoilage written off',                         counterparty: 'wastage' },
  staff_meal:          { doc: 'Cooked for staff',                             counterparty: 'staff_meal' },
  staff_meal_issue:    { doc: 'Issued for a staff meal',                      counterparty: 'staff_meal' },
  staff_meal_return:   { doc: 'Staff-meal leftovers returned',                counterparty: 'staff_meal' },
  // Butchering is a CONVERSION, not a loss: a carcass leaves as one material
  // and comes back as several cuts. Both legs face 'production' so the pair
  // reads as one event on the register instead of a write-off plus a windfall.
  butchering_input:    { doc: 'Carcass consumed by a butchering breakdown',    counterparty: 'production' },
  butchering_output:   { doc: 'Cut yielded by a butchering breakdown',         counterparty: 'production' },
  production:          { doc: 'Kitchen production batch',                     counterparty: 'production' },
  adjustment:          { doc: 'Correction against a physical count',          counterparty: 'adjustment' },
  opening:             { doc: 'Opening balance at cutover',                   counterparty: 'opening' },
};

export interface CentralTxnEntry {
  materialId: string;
  /** Free-form by history; see CENTRAL_TXN_TYPES. */
  type: string;
  /** SIGNED, RECIPE units. Positive = into the central store. */
  quantity: number;
  referenceId?: string | null;
  notes?: string;
  outletId?: string | null;
  /** The OTHER end. Omit and the type's default kind is used. */
  counterparty?: MovementParty;
  /**
   * THIS row's own end — the place the goods actually left or entered.
   * Defaults to CENTRAL_PARTY, which is right for every writer that moves
   * central grocery stock, and is why 30-odd of them pass nothing here.
   *
   * It exists because ONE family of rows on this table is not a central
   * movement at all: recipe consumption against a sale ('sale' / 'nc'). By the
   * owner's ruling of 2026-09-10 a sale debits the DEPARTMENT that cooked the
   * dish — never central, never a store — yet the audit row is still written
   * here, on every branch, because the variance reports read it. Orienting
   * those rows around central made each one assert that the central store lost
   * goods it still holds: a register filtered for Central Store outflows listed
   * movements central never made.
   *
   * So the consuming rail names itself: the department when one was debited,
   * and an honest "nothing was booked" party (with the reason in its name) when
   * the deduction was skipped. See deductInventoryForSale in src/lib/db.ts.
   *
   * It does NOT change what the row means to any deployed reader: type,
   * quantity, sign, reference and notes are untouched, and every report buckets
   * on those.
   */
  home?: MovementParty;
  /** Business date of the movement. Defaults to today (IST). */
  txnDate?: unknown;
  /**
   * FIELD 8. Session email, or a `system:` actor for machine-initiated
   * movements. REFUSED IF BLANK — see the throw below.
   */
  actor: string;
  /** Explicit created_at, for writers that already control it (backdated imports). */
  createdAt?: string;
  /**
   * Pre-minted row id. Three writers (issue-stock, return-stock, liquor-retail)
   * generate the transaction id BEFORE the insert because they return it or
   * store it as a cross-reference; passing it here keeps those links intact.
   * Omit and one is generated.
   */
  id?: string;
}

/**
 * Append one central-store movement row carrying all eight fields.
 *
 * THE ONLY WAY inventory_transactions SHOULD BE WRITTEN. Before this, 34 raw
 * INSERTs each named their own column list; four of the eight fields had no
 * column to write to and the fifth (responsible user) did not exist at all.
 *
 * Returns the new row id.
 */
export function postCentralTxn(db: Database.Database, e: CentralTxnEntry): string {
  const materialId = String(e.materialId || '').trim();
  if (!materialId) throw new Error('postCentralTxn: materialId is required');
  const type = String(e.type || '').trim();
  if (!type) throw new Error('postCentralTxn: type is required');
  const qty = Number(e.quantity);
  if (!Number.isFinite(qty)) throw new Error('postCentralTxn: quantity must be a finite number');

  // FIELD 8, ENFORCED. A blank actor is how this table ended up with 2,430 rows
  // and no way to ask who moved any of them. A machine writer passes
  // `system:<rail>`; it is a true answer and it is not blank.
  const actor = String(e.actor || '').trim();
  if (!actor) {
    throw new Error(
      `postCentralTxn: an actor is required (movement '${type}', material ${materialId}). ` +
      `Pass the SESSION user's email, or '${SYSTEM_ACTOR_PREFIX}<rail>' for a machine-initiated movement. ` +
      `Never a client-supplied name.`,
    );
  }

  const spec = CENTRAL_TXN_TYPES[type];
  if (!spec) {
    console.warn(
      `[movement-record] central txn type '${type}' is not in CENTRAL_TXN_TYPES — recorded, ` +
      `but it will land in every report's catch-all bucket. Add it there if it is meant to exist.`,
    );
  }
  const counterparty: MovementParty = e.counterparty
    || { kind: (spec?.counterparty || 'external') as MovementPartyKind };
  // Central is the DEFAULT home, not an assumption: see `home` on the entry.
  const { src, dst } = orient(e.home || CENTRAL_PARTY, counterparty, qty);

  const have = tableCols(db, 'inventory_transactions');
  const names = ['id', 'material_id', 'type', 'quantity', 'reference_id', 'notes', 'created_at'];
  const id = String(e.id || '').trim() || crypto.randomUUID();
  const vals: Array<string | number | null> = [
    id, materialId, type, qty, e.referenceId ?? null, String(e.notes || ''),
    // created_at keeps its deployed meaning and its deployed default. Only a
    // writer that already controlled it (a backdated import) passes one.
    String(e.createdAt || '').trim() || recordedNow(),
  ];
  if (have.size === 0 || have.has('outlet_id')) { names.push('outlet_id'); vals.push(e.outletId ?? null); }
  if (have.has('created_by')) { names.push('created_by'); vals.push(actor); }

  const mv = movementCols(db, 'inventory_transactions', {
    materialId, quantity: qty, src, dst, txnDate: e.txnDate,
  });
  names.push(...mv.names);
  vals.push(...mv.values);

  db.prepare(
    `INSERT INTO inventory_transactions (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  ).run(...vals);
  return id;
}
