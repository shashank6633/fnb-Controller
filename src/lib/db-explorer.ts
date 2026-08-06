/**
 * The engine behind the admin-only Database page (/api/admin/database).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS FILE IS ALLOWED TO DO
 * ------------------------------------------------------------------------
 * READ. Nothing else. There is no INSERT, UPDATE, DELETE or DDL anywhere in
 * this module, and there is no code path that can produce one: every handle it
 * opens is `{ readonly: true }`, so SQLite itself refuses a write even if every
 * string check above it were wrong.
 *
 * The one write the FEATURE performs — the audit row required by control F —
 * lives in the route, not here, and goes through db.ts's `logAuditEvent` like
 * every other privileged action in the app. Do not add a write to this file to
 * "save a hop"; the whole point of this module is that it is provably incapable
 * of one.
 *
 * ------------------------------------------------------------------------
 * TWO HANDLES, TWO JOBS — DO NOT COLLAPSE THEM
 * ------------------------------------------------------------------------
 * 1. `metaDb()` — an in-process, memoised, READONLY handle. It is used ONLY for
 *    SQL this file composes itself: the table list, row counts, the pragma_*
 *    table-valued functions, and the secret-value load for masking. No string
 *    that came from a browser ever reaches it.
 * 2. `runQuery()` — a short-lived CHILD PROCESS that opens its own readonly
 *    handle. Everything the user can influence (console SQL, saved queries,
 *    composed browse SQL) runs there and only there.
 *
 * Neither one is `getDb()`. That is deliberate: `getDb()` is the app's WRITABLE
 * handle, and the single most valuable property of this page is that the code
 * serving it has never held a writable handle at all. If you find yourself
 * importing getDb here, stop — you are removing control A.
 */

import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { isSecretKey, maskSecretValue, SECRET_KEY_RE } from '@/lib/secret-keys';
import { guardSql } from '@/lib/sql-guard';

/**
 * Derived here rather than imported from db.ts ON PURPOSE. db.ts exports a
 * writable handle, not a path, and importing it would pull the writable
 * connection into this module's graph for the sake of one string. The two
 * expressions are identical (db.ts:4 computes the same join) — if the app's
 * database ever moves, both must move, and a grep for 'fnb-controller.db'
 * finds both.
 */
export const READONLY_DB_PATH = path.join(process.cwd(), 'fnb-controller.db');

/* ==========================================================================
 * Bounds
 * ======================================================================== */

/**
 * WHY THESE CAPS EXIST — read this before raising any of them.
 *
 * better-sqlite3 is SYNCHRONOUS. Every row it materialises is built on the main
 * thread of whatever process runs it, and this app's Node process is not just
 * serving pages: it fires KOTs to the kitchen printer, holds the KDS SSE
 * stream open, and settles bills. An unbounded query on that thread is not a
 * slow page — it is the restaurant offline in the middle of service, with the
 * pass unable to print and the cashier unable to close a table.
 *
 * Two measurements decided the shape of the runner, both taken against this
 * database (34 MB) on this machine:
 *
 *   · A worker_thread does NOT solve it. Running
 *       SELECT a.id FROM requisition_items a, requisition_items b, requisition_items c
 *     in a worker and calling worker.terminate() at t=2s did nothing: V8's
 *     termination flag is only checked when control returns to JS, and a thread
 *     parked inside native sqlite3_step() never returns. The worker was still
 *     burning CPU when the 120-second harness gave up and killed it by pid.
 *   · A child process and SIGKILL DOES solve it. The same cartesian join as a
 *     blocking aggregate (SELECT count(*) ... — no rows to stream, so iteration
 *     cannot cap it) was killed at exactly the 3000 ms deadline, and the
 *     parent's 100 ms heartbeat ticked 29 times throughout, proving the event
 *     loop stayed free the whole time.
 *
 * So: separate process, hard row cap, hard SIGKILL. The row cap alone is not
 * enough (an aggregate produces one row after reading trillions) and the kill
 * alone is not enough (a query can stream 4 billion rows quite happily inside
 * the deadline). Both, always.
 */
export const MAX_ROWS = 1000;

/** CSV export reads more, on the same clock and the same kill. */
export const MAX_EXPORT_ROWS = 10_000;

/** Wall clock before SIGKILL. */
export const QUERY_TIMEOUT_MS = 5_000;

/**
 * A held-down Run button must not fork a hundred SQLite readers, each with its
 * own page cache, against a database the POS is also using. Two at a time; the
 * third caller is told to wait rather than queued, because a queue just delays
 * the same pile-up.
 */
export const MAX_CONCURRENT = 2;

/** Child stdout ceiling. Past this the result is not a thing a human reads. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** Default browse page size when the caller does not name one. */
const DEFAULT_PAGE_SIZE = 100;

/* ==========================================================================
 * The metadata handle (server-composed SQL only)
 * ======================================================================== */

let META_DB: Database.Database | null = null;

/**
 * Memoised readonly handle for THIS FILE'S OWN queries.
 *
 * `fileMustExist: true` matters: without it better-sqlite3 would happily CREATE
 * an empty database at this path if the real one were missing or misnamed, and
 * the page would then show a plausible-looking empty schema instead of failing.
 * A wrong answer is worse than an error here.
 */
function metaDb(): Database.Database {
  if (META_DB && META_DB.open) return META_DB;
  META_DB = new Database(READONLY_DB_PATH, {
    readonly: true,
    fileMustExist: true,
    timeout: 3000,
  });
  return META_DB;
}

/** Double-quote an identifier that has ALREADY been whitelisted against the
 *  live schema. This is the last step, never the only one — see quoting note
 *  in composeBrowseSql. */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/* ==========================================================================
 * Table grouping
 * ======================================================================== */

export type TableGroup = 'Purchasing' | 'Stock' | 'Sales' | 'CRM' | 'Platform' | 'Other';

export const TABLE_GROUPS: readonly TableGroup[] = [
  'Purchasing',
  'Stock',
  'Sales',
  'CRM',
  'Platform',
  'Other',
] as const;

/**
 * 131 tables in one alphabetical list is a wall. The owner thinks in parts of
 * his business, so the list is bucketed by name prefix, FIRST MATCH WINS in the
 * order below — which is why `order_guests` lands in Sales (it is a table on an
 * order) rather than CRM, and why the order of these entries is load-bearing.
 *
 * `Other` is a FEATURE, not a gap. A table added next month appears there
 * immediately instead of being silently mis-filed under a prefix that happens
 * to collide. If Other grows, add a rule — do not add a catch-all.
 */
const GROUP_RULES: ReadonlyArray<{ group: Exclude<TableGroup, 'Other'>; prefixes: string[] }> = [
  {
    group: 'Purchasing',
    prefixes: ['purchase', 'vendor', 'po_', 'goods_receipt', 'grn', 'inward', 'invoice', 'petty_cash'],
  },
  {
    group: 'Stock',
    prefixes: [
      'raw_materials', 'inventory_', 'closing_', 'store_', 'requisition', 'transfer',
      'wastage', 'unit', 'production_', 'kitchen_', 'department', 'butchering_',
      'batch_transactions', 'bar_empties', 'variance_approval',
    ],
  },
  {
    group: 'Sales',
    prefixes: [
      'sales', 'orders', 'order_', 'bill', 'menu_', 'recipe', 'sub_recipe',
      'direct_item_links', 'dine_in', 'restaurant_tables', 'kot', 'part', 'cashier',
      'discount_requests', 'service_requests', 'category_placeholders', 'staff_meal',
    ],
  },
  {
    group: 'CRM',
    prefixes: ['ct_', 'crm_', 'customer', 'guest', 'whatsapp_', 'loyalty'],
  },
  {
    group: 'Platform',
    prefixes: [
      'users', 'sessions', 'roles', 'settings', 'outlets', 'audit_events', 'error_reports',
      'task', 'recurring_task_rules', 'push_', 'cron', 'notification', 'print_',
      'config_fingerprint_log', 'checklist', 'daily_checklist_records', 'maintenance',
      'hygiene_audits', 'knowledge_test', 'training_sessions',
    ],
  },
];

/** The bucket for a table name. Exported so a test can assert the partition. */
export function groupForTable(name: string): TableGroup {
  const n = name.toLowerCase();
  for (const rule of GROUP_RULES) {
    if (rule.prefixes.some((p) => n.startsWith(p))) return rule.group;
  }
  return 'Other';
}

/* ==========================================================================
 * Unit basis labels (hard rule 4)
 * ======================================================================== */

/**
 * LABELS ONLY. This page shows RAW TABLE VALUES and converts nothing — that is
 * the entire reason it exists, because the rest of the app converts everywhere
 * (see pack-units.ts) and the owner wanted to see what is actually stored.
 *
 * But a bare number in a column called `current_stock` is a trap: everywhere
 * else in this app that number is shown in PURCHASE units, and here it is the
 * raw RECIPE-unit value. So each quantity-ish column carries a caption naming
 * its basis. Do not turn these into conversion factors. Do not apply them.
 *
 * Keyed 'table.column'. The unit canon they describe:
 *   raw_materials.unit          = the RECIPE unit
 *   raw_materials.purchase_unit = the PURCHASE unit
 *   pack_size                   = recipe units inside one purchase unit
 *   current_stock               = RECIPE units
 *   purchases.quantity          = PURCHASE units
 */
export const UNIT_BASIS: Record<string, string> = {
  'raw_materials.unit': 'the RECIPE unit for this material (what recipes are written in)',
  'raw_materials.purchase_unit': 'the PURCHASE unit (what the vendor bills in)',
  'raw_materials.pack_size': 'recipe units per ONE purchase unit — the multiplier between the two',
  'raw_materials.current_stock': 'RECIPE units. The rest of the app shows this in PURCHASE units (÷ pack_size)',
  'raw_materials.average_price': '₹ per RECIPE unit',
  'raw_materials.last_purchase_price':
    '⚠ MIXED BASIS — some rows are ₹/recipe-unit and some ₹/purchase-unit. Never value stock from this column; use src/lib/closing-valuation.ts',
  'purchases.quantity': 'PURCHASE units (what was billed), not recipe units',
  'purchases.unit_price': '₹ per PURCHASE unit',
  'requisition_items.quantity_requested': "the LINE's own unit — read the `unit` column on the same row",
  'requisition_items.quantity_issued': "the LINE's own unit — read the `unit` column on the same row",
};

/** The basis caption for a column, or null when the column is not a quantity. */
export function unitBasisFor(table: string, column: string): string | null {
  return UNIT_BASIS[table + '.' + column] ?? null;
}

/* ==========================================================================
 * listTables()
 * ======================================================================== */

export interface TableSummary {
  name: string;
  group: TableGroup;
  rows: number;
  columns: number;
  pk: string[];
  fk_count: number;
}

export interface TableCatalog {
  table_count: number;
  groups: readonly TableGroup[];
  tables: TableSummary[];
  generated_at: string;
}

let CATALOG_CACHE: { at: number; value: TableCatalog } | null = null;
const CATALOG_TTL_MS = 30_000;

/**
 * Every user table with its row count, column count, primary key and foreign-key
 * count. 131 COUNT(*)s measured at 2 ms total on this database, so the 30 s
 * cache is about not doing it on every keystroke in the search box, not about
 * cost. Short TTL on purpose: a stale row count on a page whose whole job is
 * "show me what is really in there" would undermine the point of the page.
 */
export function listTables(): TableCatalog {
  const now = Date.now();
  if (CATALOG_CACHE && now - CATALOG_CACHE.at < CATALOG_TTL_MS) return CATALOG_CACHE.value;

  const db = metaDb();
  const names = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);

  const infoStmt = db.prepare('SELECT name, pk FROM pragma_table_info(?)');
  const fkStmt = db.prepare('SELECT COUNT(*) AS n FROM pragma_foreign_key_list(?)');

  const tables: TableSummary[] = names.map((name) => {
    const cols = infoStmt.all(name) as Array<{ name: string; pk: number }>;
    const fk = fkStmt.get(name) as { n: number };
    /* The identifier is a name that came straight out of sqlite_master a few
       lines ago, so it exists by construction; it is still quote-escaped
       because "it came from the database" is not a habit worth forming. */
    const c = db.prepare('SELECT COUNT(*) AS n FROM ' + quoteIdent(name)).get() as { n: number };
    return {
      name,
      group: groupForTable(name),
      rows: c.n,
      columns: cols.length,
      pk: cols.filter((x) => x.pk > 0).sort((a, b) => a.pk - b.pk).map((x) => x.name),
      fk_count: fk.n,
    };
  });

  const value: TableCatalog = {
    table_count: tables.length,
    groups: TABLE_GROUPS,
    tables,
    generated_at: new Date().toISOString(),
  };
  CATALOG_CACHE = { at: now, value };
  return value;
}

/**
 * The name the API route imports. Same function, and deliberately the SAME
 * OBJECT rather than a wrapper — an alias that drifts into a second
 * implementation is how two callers end up with two different table lists.
 */
export const getCatalog = listTables;

/** Clear the metadata cache. For a test, or a "refresh" button. */
export function invalidateCatalogCache(): void {
  CATALOG_CACHE = null;
}

/* ==========================================================================
 * tableSchema()
 * ======================================================================== */

export interface SchemaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  unit_basis: string | null;
}

export interface SchemaForeignKey {
  from: string;
  table: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

export interface SchemaIndex {
  name: string;
  unique: number;
  columns: string[];
}

export interface TableSchema {
  name: string;
  group: TableGroup;
  row_count: number;
  columns: SchemaColumn[];
  foreign_keys: SchemaForeignKey[];
  indexes: SchemaIndex[];
}

/**
 * True only for a name that is really a user table right now.
 *
 * This is the whitelist that makes composeBrowseSql safe. It is a lookup
 * against live sqlite_master, not a regex on the string — a regex answers
 * "does this look like an identifier", which is the wrong question. The right
 * question is "is this one of the 131 names that exist", and only the database
 * can answer it.
 */
export function tableExists(name: unknown): name is string {
  if (typeof name !== 'string' || name === '') return false;
  const row = metaDb()
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name = ?"
    )
    .get(name) as { ok: number } | undefined;
  return !!row;
}

/**
 * Columns, declared types, primary key, declared foreign keys and indexes.
 *
 * Built from the pragma_* TABLE-VALUED FUNCTIONS rather than PRAGMA statements.
 * That is not a style choice: the guard blocks the PRAGMA statement form
 * outright (PRAGMA writable_schema = ON succeeds even on a readonly handle —
 * measured), and an allow-list of "safe" pragma names is a list that has to
 * stay correct forever. The TVFs give the same information through a plain
 * SELECT, so schema browsing costs nothing and the ban stays absolute.
 */
export function tableSchema(name: string): TableSchema | null {
  if (!tableExists(name)) return null;
  const db = metaDb();

  const cols = db.prepare('SELECT * FROM pragma_table_info(?)').all(name) as Array<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;

  const fks = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(name) as Array<{
    from: string;
    table: string;
    to: string | null;
    on_update: string;
    on_delete: string;
  }>;

  const idxList = db.prepare('SELECT * FROM pragma_index_list(?)').all(name) as Array<{
    name: string;
    unique: number;
  }>;

  const indexes: SchemaIndex[] = idxList.map((ix) => ({
    name: ix.name,
    unique: ix.unique,
    columns: (
      db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(ix.name) as Array<{
        name: string | null;
      }>
    )
      .map((c) => c.name)
      .filter((c): c is string => !!c),
  }));

  const rc = db.prepare('SELECT COUNT(*) AS n FROM ' + quoteIdent(name)).get() as { n: number };

  return {
    name,
    group: groupForTable(name),
    row_count: rc.n,
    columns: cols.map((c) => ({
      cid: c.cid,
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      dflt_value: c.dflt_value,
      pk: c.pk,
      unit_basis: unitBasisFor(name, c.name),
    })),
    foreign_keys: fks.map((f) => ({
      from: f.from,
      table: f.table,
      to: f.to,
      on_update: f.on_update,
      on_delete: f.on_delete,
    })),
    indexes,
  };
}

/** The name the API route imports. Same function object — see getCatalog. */
export const getTableSchema = tableSchema;

/* ==========================================================================
 * composeBrowseSql()
 * ======================================================================== */

export interface BrowseRequest {
  table: unknown;
  sort_column?: unknown;
  sort_dir?: unknown;
  page?: unknown;
  page_size?: unknown;
  /**
   * The caller's own row ceiling for this request — MAX_ROWS for a grid page,
   * MAX_EXPORT_ROWS for a "download the whole table" CSV. The page size is
   * clamped to it, so the client cannot ask a browse for more rows than the
   * route already decided it is allowed to return.
   */
  max_rows?: unknown;
}

export type BrowseCode = 'NO_SUCH_TABLE' | 'NO_SUCH_COLUMN' | 'BAD_SORT_DIR';

export type BrowseSql =
  | {
      ok: true;
      sql: string;
      /** Bound values for the ? placeholders in `sql` — LIMIT and OFFSET. */
      params: unknown[];
      table: string;
      page: number;
      page_size: number;
      offset: number;
      total_rows: number;
      sort_column: string | null;
      sort_dir: 'asc' | 'desc';
    }
  | { ok: false; code: BrowseCode; error: string };

/**
 * Compose the browse query SERVER-SIDE from a table name, a column name, a
 * direction and two integers. The client never sends SQL on this path — that is
 * the point of having a browse path at all.
 *
 * The safety here is whitelisting, not escaping. Every identifier is checked
 * against the live schema (does this table exist / does this column exist ON
 * THIS TABLE), the direction against two literals, and the numbers are
 * re-derived as clamped integers rather than trusted. Quoting happens only
 * AFTER all of that, as belt to the whitelist's braces. If you ever find
 * yourself quoting an identifier that was not first found in the schema, you
 * have reintroduced injection on the one path that was supposed to be free of
 * it.
 */
export function composeBrowseSql(req: BrowseRequest): BrowseSql {
  const table = req.table;
  if (!tableExists(table)) {
    return {
      ok: false,
      code: 'NO_SUCH_TABLE',
      error:
        'There is no table called ' + JSON.stringify(String(table ?? '')) +
        ' in this database. Pick one from the list on the left.',
    };
  }

  const schema = tableSchema(table);
  if (!schema) {
    return { ok: false, code: 'NO_SUCH_TABLE', error: 'That table disappeared between two reads. Reload the page.' };
  }

  let sortColumn: string | null = null;
  if (req.sort_column !== undefined && req.sort_column !== null && req.sort_column !== '') {
    const wanted = String(req.sort_column);
    const found = schema.columns.find((c) => c.name === wanted);
    if (!found) {
      return {
        ok: false,
        code: 'NO_SUCH_COLUMN',
        error: 'Table ' + table + ' has no column called ' + JSON.stringify(wanted) + '.',
      };
    }
    sortColumn = found.name;
  }

  const dirRaw = req.sort_dir === undefined || req.sort_dir === null ? 'asc' : String(req.sort_dir).toLowerCase();
  if (dirRaw !== 'asc' && dirRaw !== 'desc') {
    return { ok: false, code: 'BAD_SORT_DIR', error: 'Sort direction must be asc or desc.' };
  }
  const sortDir: 'asc' | 'desc' = dirRaw;

  const ceiling = clampInt(req.max_rows, MAX_ROWS, 1, MAX_EXPORT_ROWS);
  const page = clampInt(req.page, 0, 0, 1_000_000);
  const pageSize = clampInt(req.page_size, DEFAULT_PAGE_SIZE, 1, ceiling);
  const offset = page * pageSize;

  /* Plain string concatenation, never a template literal: a stray backtick or a
     JS // comment inside a SQL template literal has taken this app down twice
     this week. The only things concatenated in are IDENTIFIERS that were found
     in the live schema three lines above; the two numbers go through as BOUND
     PARAMETERS, because a number that reaches SQL as text is a number that can
     one day reach it as something else. */
  let sql = 'SELECT * FROM ' + quoteIdent(schema.name);
  if (sortColumn) sql += ' ORDER BY ' + quoteIdent(sortColumn) + (sortDir === 'desc' ? ' DESC' : ' ASC');
  sql += ' LIMIT ? OFFSET ?';

  return {
    ok: true,
    sql,
    params: [pageSize, offset],
    table: schema.name,
    page,
    page_size: pageSize,
    offset,
    total_rows: schema.row_count,
    sort_column: sortColumn,
    sort_dir: sortDir,
  };
}

function clampInt(v: unknown, dflt: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  const i = Math.trunc(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

/* ==========================================================================
 * Saved queries
 * ======================================================================== */

export interface SavedQuery {
  id: string;
  title: string;
  /** One line of plain English: what question does this answer? */
  explains: string;
  sql: string;
}

/**
 * The six that came out of a real audit of this database. Every one was run
 * against the live file while this was written, and the numbers in `explains`
 * are the numbers it actually returned — so if a figure here stops matching,
 * the DATA changed, and that is worth knowing.
 *
 * These are server constants selected by id. The client sends the id, never the
 * SQL: a saved query is not a place where user text becomes SQL. The SQL is
 * echoed back in the response so nothing on the page is a black box and he can
 * edit any of them in the console.
 */
export const SAVED_QUERIES: readonly SavedQuery[] = [
  {
    // Replaced the old "Is deduct-at-issue on?" query. That setting no longer
    // decides anything — the department basis is now unconditional — so asking
    // for its value would return a stale row and read as if a switch still
    // existed. The useful question now is whether the cutover has been run,
    // because every department balance is anchored on that timestamp.
    id: 'dept_cutover_state',
    title: 'Has the department cutover been run?',
    explains:
      'Stock now leaves Central when the store ISSUES it and leaves the Department when a recipe consumes it. Department balances start from the cutover count — until that has been run, they are incomplete. A row here means it has.',
    sql:
      "SELECT key, value AS cutover_at\nFROM settings\nWHERE key = 'dept_ledger_cutover_at'",
  },
  {
    id: 'menu_items_no_recipe',
    title: 'Menu items with no recipe',
    explains:
      'Items that record ZERO food cost when sold, because nothing tells the system what they are made of. 610 of 628 items; 253 have neither a recipe nor a direct material link.',
    sql:
      'SELECT\n' +
      '  COUNT(*) AS total_items,\n' +
      "  SUM(CASE WHEN recipe_id IS NULL OR recipe_id = '' THEN 1 ELSE 0 END) AS no_recipe,\n" +
      "  SUM(CASE WHEN (recipe_id IS NULL OR recipe_id = '')\n" +
      "            AND (material_id IS NULL OR material_id = '') THEN 1 ELSE 0 END) AS no_recipe_and_no_material\n" +
      'FROM menu_items',
  },
  {
    id: 'purchase_total_mismatch',
    title: 'Purchase rows where total does not equal qty x rate',
    explains:
      'Rows whose stored total_price disagrees with quantity x unit_price. 219 rows, overstated by Rs 156,621.22. Widening the tolerance to 50 paise still leaves Rs 156,616.84 across 105 rows — so this is a handful of large wrong rows from the inward import, not rounding dust.',
    sql:
      'SELECT\n' +
      '  id, date, vendor, quantity, unit_price, total_price,\n' +
      '  ROUND(total_price - (quantity * unit_price), 2) AS overstated_by\n' +
      'FROM purchases\n' +
      'WHERE ABS(COALESCE(total_price, 0) - (COALESCE(quantity, 0) * COALESCE(unit_price, 0))) > 0.005\n' +
      'ORDER BY ABS(total_price - (quantity * unit_price)) DESC',
  },
  {
    id: 'consumption_types_present',
    title: 'Consumption types actually present',
    explains:
      'Which inventory_transactions.type values exist at all. Only purchase (2122), sale (228) and nc (36) — there are no party or staff_meal rows, which is why the variance report finds none.',
    sql: 'SELECT type, COUNT(*) AS rows_present\nFROM inventory_transactions\nGROUP BY type\nORDER BY rows_present DESC',
  },
  {
    id: 'requisition_issued_short',
    title: 'Requisition lines issued short',
    explains:
      'Lines where the store issued LESS than was approved (or requested, when the chef did not change it) — the 7 kg asked, 5 kg issued case. 610 lines.',
    sql:
      'SELECT\n' +
      '  ri.id, ri.req_id, ri.material_id, ri.unit,\n' +
      '  ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued,\n' +
      '  (COALESCE(NULLIF(ri.chef_approved_qty, 0), ri.quantity_requested) - ri.quantity_issued) AS short_by\n' +
      'FROM requisition_items ri\n' +
      'WHERE ri.quantity_issued > 0\n' +
      '  AND ri.quantity_issued < COALESCE(NULLIF(ri.chef_approved_qty, 0), ri.quantity_requested)\n' +
      'ORDER BY short_by DESC',
  },
  {
    id: 'tables_without_fk',
    title: 'Tables with no declared foreign key',
    explains:
      'Tables that hold ids pointing at other tables but never declare the relationship, so SQLite cannot enforce it. 82 of 131. Schema-integrity view, not a bug list.',
    sql:
      'SELECT m.name AS table_name\n' +
      'FROM sqlite_master m\n' +
      "WHERE m.type = 'table'\n" +
      "  AND m.name NOT LIKE 'sqlite_%'\n" +
      '  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name))\n' +
      'ORDER BY m.name',
  },
];

export function getSavedQuery(id: unknown): SavedQuery | null {
  if (typeof id !== 'string') return null;
  return SAVED_QUERIES.find((q) => q.id === id) ?? null;
}

/* ==========================================================================
 * Masking
 * ======================================================================== */

export interface ResultColumn {
  name: string;
  type: string | null;
}

export interface MaskRef {
  row: number;
  column: string;
}

export interface MaskedResult {
  rows: Array<Record<string, unknown>>;
  masked: MaskRef[];
}

/** Column names that behave like a settings KEY. */
const KEY_COLUMNS = new Set(['key', 'setting_key', 'config_key', 'name']);
/** Column names that behave like a settings VALUE. */
const VALUE_COLUMNS = new Set(['value', 'setting_value', 'config_value', 'val']);

/**
 * Below this length a stored "secret" is almost certainly a flag ('0', 'true',
 * 'on'), and matching on it would mask half the database. Layer 3 only hunts
 * for values long enough to actually be a credential.
 */
const MIN_SECRET_VALUE_LEN = 8;

/**
 * Live secret VALUES, read fresh on every call.
 *
 * Deliberately not cached: a cache that is 30 seconds stale is a cache that
 * fails to mask a credential rotated 10 seconds ago, and the failure is silent.
 * Two tiny indexed reads are not worth that.
 */
function loadSecretValues(): string[] {
  const db = metaDb();
  const out = new Set<string>();
  for (const table of ['settings', 'ct_settings']) {
    let rows: Array<{ key: string; value: unknown }> = [];
    try {
      rows = db.prepare('SELECT key, value FROM ' + quoteIdent(table)).all() as Array<{
        key: string;
        value: unknown;
      }>;
    } catch {
      /* Table absent on some deployment — masking degrades to layers 1 and 2
         rather than the page 500ing. */
      continue;
    }
    for (const r of rows) {
      if (!isSecretKey(r.key)) continue;
      const v = r.value === null || r.value === undefined ? '' : String(r.value);
      if (v.length >= MIN_SECRET_VALUE_LEN) out.add(v);
    }
  }
  return [...out];
}

/**
 * Mask stored credentials out of a result set — control E.
 *
 * THE ESCALATION THIS CLOSES. `settings` holds live third-party credentials in
 * plaintext: the Meta WhatsApp access token, the Interakt key, the TeleCMI app
 * secret, the Slack webhook URL, the Google service-account JSON. /api/settings
 * redacts them on the way out (SECRET_KEY_RE, now in secret-keys.ts). A raw SQL
 * console is a SECOND door onto the same rows, and without this it turns "an
 * admin can configure integrations" into "one SELECT * FROM settings exfiltrates
 * every credential the restaurant owns" — keys that can spend money and message
 * guests. The threat is not the owner; it is a stolen session and a screenshot.
 *
 * Three layers, because each one alone has an obvious way around it:
 *   1. COLUMN NAME — masks any column whose own name looks like a credential.
 *      Catches SELECT value AS access_token FROM settings.
 *   2. KEY/VALUE SHAPE — when the result has a key-ish and a value-ish column,
 *      mask the value on rows whose key looks like a credential. Catches the
 *      plain SELECT * FROM settings, where neither column name is suspicious.
 *   3. VALUE SET — the actual secret values, loaded server-side, masked wherever
 *      they appear. Catches SELECT value FROM settings WHERE key = 'wa_access_token',
 *      which has no key column at all and defeats layer 2 completely, plus any
 *      copy of a token sitting in some other table.
 *
 * RESIDUAL RISK, stated rather than papered over: an admin who WANTS a secret
 * can still take it apart with substr(value,1,20) or hex(value). There is no
 * complete defence against arbitrary SQL and claiming one would be worse than
 * saying this. What these layers buy is real — they stop the accidental
 * SELECT *, the screenshot, the CSV that gets emailed on — and a deliberate
 * extraction leaves an audit row with the exact SQL in it, which is what
 * control F is for.
 */
export function maskResult(
  columns: ResultColumn[],
  rows: Array<Record<string, unknown>>
): MaskedResult {
  const masked: MaskRef[] = [];
  if (rows.length === 0) return { rows, masked };

  const names = columns.map((c) => c.name);
  const lower = names.map((n) => n.toLowerCase());

  /* Layer 1 targets. */
  const secretNamed = new Set<string>();
  names.forEach((n) => {
    if (SECRET_KEY_RE.test(n)) secretNamed.add(n);
  });

  /* Layer 2 pairing. */
  const keyIdx = lower.findIndex((n) => KEY_COLUMNS.has(n));
  const valIdx = lower.findIndex((n) => VALUE_COLUMNS.has(n));
  const keyCol = keyIdx >= 0 ? names[keyIdx] : null;
  const valCol = valIdx >= 0 ? names[valIdx] : null;

  /* Layer 3 needles. Only loaded when there is somewhere for them to hide. */
  const needles = loadSecretValues();

  const outRows = rows.map((row, r) => {
    let copy: Record<string, unknown> | null = null;
    const write = (col: string, v: string) => {
      if (!copy) copy = { ...row };
      copy[col] = v;
      masked.push({ row: r, column: col });
    };

    for (const col of names) {
      const raw = row[col];
      if (raw === null || raw === undefined || raw === '') continue;

      /* 1 — the column is named like a credential. */
      if (secretNamed.has(col)) {
        write(col, maskSecretValue(raw));
        continue;
      }

      /* 2 — key/value pair and this row's key is a credential. */
      if (keyCol && valCol && col === valCol && isSecretKey(String(row[keyCol] ?? ''))) {
        write(col, maskSecretValue(raw));
        continue;
      }

      /* 3 — the cell contains a value that IS a stored credential. */
      if (needles.length > 0) {
        const s = typeof raw === 'string' ? raw : String(raw);
        if (s.length >= MIN_SECRET_VALUE_LEN && needles.some((n) => s.includes(n))) {
          write(col, maskSecretValue(s));
        }
      }
    }

    return copy ?? row;
  });

  return { rows: outRows, masked };
}

/* ==========================================================================
 * runQuery() — the child-process runner
 * ======================================================================== */

export type RunErrorCode =
  | 'BUSY'
  | 'TIMEOUT'
  | 'RESULT_TOO_LARGE'
  | 'SQLITE_ERROR'
  | 'NOT_A_READ'
  | 'GUARD'
  | 'CHILD_FAILED';

export interface RunQueryOk {
  ok: true;
  columns: ResultColumn[];
  rows: Array<Record<string, unknown>>;
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  sql_executed: string;
}

export interface RunQueryErr {
  ok: false;
  code: RunErrorCode;
  error: string;
  elapsed_ms: number;
}

export type RunQueryResult = RunQueryOk | RunQueryErr;

export interface RunQueryOptions {
  /** Optional when the SQL is passed as the first positional argument. */
  sql?: string;
  /**
   * Bound values for the ? placeholders in `sql`. composeBrowseSql uses these
   * for LIMIT/OFFSET. Parameters are the one channel through which a value can
   * reach SQLite without ever being parsed as SQL, which is exactly why the
   * browse path uses them for its two numbers.
   */
  params?: unknown[];
  maxRows?: number;
  timeoutMs?: number;
  /**
   * Server-composed SQL (browse, saved queries) skips the text guard, because
   * the guard exists to police text a human typed and these strings were built
   * from whitelisted identifiers. It does NOT skip anything else: same child,
   * same readonly handle, same row cap, same SIGKILL. Never set this for
   * anything that came off the wire.
   */
  trusted?: boolean;
}

/**
 * The child. Passed inline to `node -e` rather than living in its own file so
 * there is no separate artefact for the bundler to fail to trace into the
 * standalone build. `require('better-sqlite3')` resolves from cwd, which is the
 * repo root, and better-sqlite3 is already in serverExternalPackages
 * (next.config.ts) so it is a real node_modules require at runtime either way.
 *
 * It knows nothing about the app. It takes a path, a SQL string and a row cap
 * on stdin, and prints one JSON object on stdout. That narrowness is the point:
 * the process that runs user SQL has no access to sessions, settings, printers
 * or the writable handle, because it does not import any of them.
 */
const CHILD_SRC = [
  "'use strict';",
  "const Database = require('better-sqlite3');",
  "let buf = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', function (c) { buf += c; });",
  "process.stdin.on('end', function () { main(buf); });",
  'function out(o) { process.stdout.write(JSON.stringify(o)); }',
  'function cell(v) {',
  '  if (v === null || v === undefined) return null;',
  "  if (typeof v === 'bigint') return v.toString();",
  "  if (Buffer.isBuffer(v)) return '<BLOB ' + v.length + ' bytes>';",
  '  return v;',
  '}',
  'function main(raw) {',
  '  let req;',
  "  try { req = JSON.parse(raw); } catch (e) { return out({ ok: false, error: 'could not read the request' }); }",
  '  let db = null;',
  '  const t0 = Date.now();',
  '  try {',
  '    db = new Database(req.path, { readonly: true, fileMustExist: true, timeout: 3000 });',
  '    const stmt = db.prepare(req.sql);',
  '    if (!stmt.reader) {',
  "      throw new Error('That statement does not return rows, so it is not a read. It was NOT executed.');",
  '    }',
  '    let columns = [];',
  '    try {',
  '      columns = stmt.columns().map(function (c) { return { name: c.name, type: c.type }; });',
  '    } catch (e) { columns = []; }',
  '    stmt.raw(true);',
  '    const rows = [];',
  '    let truncated = false;',
  '    const params = Array.isArray(req.params) ? req.params : [];',
  '    for (const r of stmt.iterate.apply(stmt, params)) {',
  '      if (rows.length >= req.maxRows) { truncated = true; break; }',
  '      rows.push(r.map(cell));',
  '    }',
  '    out({ ok: true, columns: columns, rows: rows, truncated: truncated, db_ms: Date.now() - t0 });',
  '  } catch (e) {',
  "    out({ ok: false, error: String((e && e.message) || e), sqlite_code: (e && e.code) || null });",
  '  } finally {',
  '    try { if (db) db.close(); } catch (e) {}',
  '  }',
  '}',
].join('\n');

/**
 * The one JSON object the child prints. Declared rather than typed `any`
 * because it is the ONLY thing crossing back from the process that ran user
 * SQL, and the boundary is worth naming: everything below re-validates it
 * (Array.isArray, String(), ok !== true) instead of trusting the shape.
 */
interface ChildPayload {
  ok?: boolean;
  columns?: Array<{ name?: unknown; type?: string | null }>;
  rows?: unknown[][];
  truncated?: boolean;
  db_ms?: number;
  error?: string;
  sqlite_code?: string | null;
}

/** In-flight child processes. See MAX_CONCURRENT. */
let inFlight = 0;

/**
 * Run ONE read and come back with at most `maxRows` rows, or an error, always
 * within `timeoutMs`.
 *
 * Nothing here runs in the app's process except JSON parsing. If you are
 * tempted to "simplify" this into a direct better-sqlite3 call on the server:
 * that is the change that takes the restaurant offline mid-service the first
 * time somebody types a join without an ON clause. See the comment on MAX_ROWS
 * for the two measurements that ruled out the in-process and worker_thread
 * versions.
 */
export function runQuery(opts: RunQueryOptions): Promise<RunQueryResult>;
export function runQuery(sql: string, opts?: Omit<RunQueryOptions, 'sql'>): Promise<RunQueryResult>;
export function runQuery(
  a: RunQueryOptions | string,
  b?: Omit<RunQueryOptions, 'sql'>
): Promise<RunQueryResult> {
  /* Two call shapes, one body. runQuery({ sql, ... }) reads best from a lib;
     runQuery(sql, { params }) reads best from a route where the SQL was built
     three branches earlier. Neither is a different code path — they normalise
     here and everything below is identical, so a control cannot be present in
     one form and missing from the other. */
  const opts: RunQueryOptions = typeof a === 'string' ? { ...(b ?? {}), sql: a } : a;

  const started = Date.now();
  const sql = typeof opts.sql === 'string' ? opts.sql : '';
  const params = Array.isArray(opts.params) ? opts.params : [];
  const maxRows = clampInt(opts.maxRows, MAX_ROWS, 1, MAX_EXPORT_ROWS);
  const timeoutMs = clampInt(opts.timeoutMs, QUERY_TIMEOUT_MS, 250, 30_000);

  /* Defence in depth, not the primary gate. The route guards user text before
     it ever gets here; this second call means a future caller that forgets
     cannot turn this function into an unguarded execute-anything. */
  if (!opts.trusted) {
    const g = guardSql(sql);
    if (!g.ok) {
      return Promise.resolve({ ok: false, code: 'GUARD', error: g.message, elapsed_ms: 0 });
    }
  }

  if (inFlight >= MAX_CONCURRENT) {
    return Promise.resolve({
      ok: false,
      code: 'BUSY',
      error:
        'A query is already running. This page allows ' + MAX_CONCURRENT +
        ' at a time so a heavy read cannot slow the tills down. Try again in a moment.',
      elapsed_ms: 0,
    });
  }

  inFlight++;

  return new Promise<RunQueryResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (r: RunQueryResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    const child = spawn(process.execPath, ['-e', CHILD_SRC], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let killReason: RunErrorCode | null = null;

    /* SIGKILL, not SIGTERM. A process parked inside sqlite3_step() will not run
       a JS signal handler, so a polite signal is a signal that gets ignored —
       the same reason worker.terminate() was useless here. The second kill
       250 ms later is for the case where the first one races the spawn. */
    const unref = (t: unknown) => {
      const h = t as { unref?: () => void };
      if (typeof h?.unref === 'function') h.unref();
    };

    const hardKill = (reason: RunErrorCode) => {
      killReason = reason;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      unref(setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 250));
    };

    timer = setTimeout(() => hardKill('TIMEOUT'), timeoutMs);
    unref(timer);

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_STDOUT_BYTES) {
        hardKill('RESULT_TOO_LARGE');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      inFlight--;
      done({
        ok: false,
        code: 'CHILD_FAILED',
        error: 'Could not start the query runner: ' + err.message,
        elapsed_ms: Date.now() - started,
      });
    });

    child.on('close', () => {
      inFlight--;
      const elapsed = Date.now() - started;

      if (killReason === 'TIMEOUT') {
        return done({
          ok: false,
          code: 'TIMEOUT',
          error:
            'Query stopped after ' + Math.round(timeoutMs / 1000) +
            's to keep the POS responsive. Add a LIMIT or a WHERE clause, or narrow the joins.',
          elapsed_ms: elapsed,
        });
      }
      if (killReason === 'RESULT_TOO_LARGE') {
        return done({
          ok: false,
          code: 'RESULT_TOO_LARGE',
          error: 'That result is too large to send back. Add a LIMIT, or select fewer columns.',
          elapsed_ms: elapsed,
        });
      }

      let parsed: ChildPayload | null;
      try {
        parsed = JSON.parse(stdout) as ChildPayload;
      } catch {
        return done({
          ok: false,
          code: 'CHILD_FAILED',
          error:
            'The query runner did not return a readable result.' +
            (stderr ? ' ' + stderr.trim().split('\n')[0] : ''),
          elapsed_ms: elapsed,
        });
      }

      if (!parsed || parsed.ok !== true) {
        const msg = String((parsed && parsed.error) || 'Unknown SQLite error.');
        /* "not a read" is a refusal, not a database fault — worth its own code
           so the UI can explain rather than show a raw driver string. */
        const code: RunErrorCode = msg.includes('does not return rows') ? 'NOT_A_READ' : 'SQLITE_ERROR';
        return done({ ok: false, code, error: msg, elapsed_ms: elapsed });
      }

      const columns: ResultColumn[] = Array.isArray(parsed.columns)
        ? parsed.columns.map((c) => ({ name: String(c?.name ?? ''), type: c?.type ?? null }))
        : [];

      /* The child streams rows as ARRAYS (stmt.raw(true)) so that a result with
         two columns of the same name — SELECT a.id, b.id FROM ... — does not
         silently lose one on the way through an object. Names are uniquified
         here, and the columns we return carry the SAME names, so the grid
         headers and the row keys can never disagree. */
      const seen = new Map<string, number>();
      const finalNames = columns.map((c, i) => {
        const base = c.name || 'col_' + (i + 1);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return n === 0 ? base : base + ':' + n;
      });
      const finalColumns: ResultColumn[] = columns.map((c, i) => ({ name: finalNames[i], type: c.type }));

      const rawRows: unknown[][] = Array.isArray(parsed.rows) ? parsed.rows : [];
      const rows: Array<Record<string, unknown>> = rawRows.map((arr) => {
        const o: Record<string, unknown> = {};
        for (let i = 0; i < finalNames.length; i++) o[finalNames[i]] = arr[i];
        return o;
      });

      done({
        ok: true,
        columns: finalColumns,
        rows,
        row_count: rows.length,
        truncated: parsed.truncated === true,
        elapsed_ms: elapsed,
        sql_executed: sql,
      });
    });

    try {
      child.stdin.write(JSON.stringify({ path: READONLY_DB_PATH, sql, params, maxRows }));
      child.stdin.end();
    } catch {
      hardKill('CHILD_FAILED');
    }
  });
}

/**
 * Run a query and mask it in one step — the shape every caller actually wants.
 * Kept separate from runQuery so the runner stays a pure "execute and bound"
 * function with no knowledge of credentials.
 */
export async function runQueryMasked(
  opts: RunQueryOptions
): Promise<RunQueryResult & { masked?: MaskRef[] }> {
  const r = await runQuery(opts);
  if (!r.ok) return r;
  const m = maskResult(r.columns, r.rows);
  return { ...r, rows: m.rows, masked: m.masked };
}
