import type Database from 'better-sqlite3';
import { BAR_STATIONS } from './kot-section';

/**
 * THE STATION MASTER — naming, usage, add and rename.
 *
 * `station_departments` IS the station master. It was built as the station →
 * department map, but `station` is its PRIMARY KEY and every station any menu
 * item uses already has a row, so it is also the list of stations that exist.
 * There is deliberately NO second table: two masters is how a station ends up
 * pickable in one place and unroutable in the other.
 *
 * ── STATION IS NOT CATEGORY ────────────────────────────────────────────────
 * `menu_items.category` is what kind of dish it is on the menu (curries-veg,
 * classic-cocktails). `menu_items.station` is WHICH KITCHEN SECTION COOKS IT
 * (indian, tandoor, bar, pizza) and it DRIVES KOT ROUTING: kot-fire.ts groups a
 * fired order by station, one KOT per station; print.ts picks the printer by
 * matching that string against print_stations.station; kot-section.ts decides
 * from that string whether the ticket appears on the Bar board or the Kitchen
 * board; and dept-ledger.ts turns it into the DEPARTMENT whose stock the recipe
 * leaves. A wrong category is a mis-filed dish. A wrong station is a ticket that
 * never reaches the section that had to cook it.
 *
 * ── THE NAME IS A KEY, NOT A LABEL ─────────────────────────────────────────
 * Nothing carries a station id. The STRING is the join, denormalised into
 * menu_items.station, order_items.station, kots.station, print_stations.station,
 * kot_alerts.station, consumption_skips.station and
 * department_material_transactions.station. Every reader normalises with
 * lower(trim()) — resolveStationDepartment() included — so 'Tandoor' and
 * 'tandoor' are ONE station to this system while being two different PRIMARY KEY
 * values in the table. That is why names are canonicalised on the way IN
 * (canonStationName) and matched on lower(trim()) on the way OUT: a second row
 * differing only in case would give resolveStationDepartment's LIMIT 1 two
 * candidates and let a dish deduct from either kitchen depending on row order.
 *
 * ── TWO WRITERS THIS MODULE CANNOT REACH (OPEN, MEASURED) ──────────────────
 * A rename moves menu_items.station, so the NEXT order is written on the new
 * name — order_items.station and kots.station are filled server-side from the
 * menu_items row on the online paths. TWO writers do not read menu_items:
 *
 *  1. src/app/api/dine-in/orders/replay/route.ts:107,121 takes `station`
 *     STRAIGHT FROM THE CLIENT PAYLOAD (produced by public/offline-pos.html:708
 *     out of the bridge's cached menu copy) and writes it verbatim into
 *     order_items and kots. An offline order fired from a cache taken BEFORE a
 *     rename therefore replays onto the OLD name, which now resolves 'unmapped',
 *     so the department is never debited — and because the replayed KOT is
 *     inserted 'served', nothing re-runs it. The fix is in that route: resolve
 *     the station from menu_items by menu_item_id (it already re-reads the item
 *     for tax_value), not from the payload.
 *  2. src/app/api/menu-items/import/route.ts writes menu_items.station from
 *     the CSV with no master REFUSAL (refusing there loses data; it reports
 *     off-master strings instead) — so re-importing a sheet exported before a
 *     rename puts the dead name back on every row it covers, and "Pan Asian"
 *     in a hand-edited column becomes a station nothing routes. It does now
 *     write through stationSpellingForWrite(), so a spelling that RESOLVES on
 *     the master ("Tandoor", a BOM-prefixed cell) lands as the master's own
 *     bytes; only genuinely unknown strings still go in verbatim.
 *
 * Writer 1 is PRE-EXISTING and belongs to other work; it is recorded here
 * because it is a path that can undo what this module guarantees.
 */

/* ── local, defensive schema probes ─────────────────────────────────────────
 * Same reasoning as the route's: several of these columns arrived with the
 * department-inventory cutover, and a Settings screen that 500s because one
 * migration has not run is worse than one that reports a count of 0. */
function tableExists(db: Database.Database, name: string): boolean {
  try {
    return !!db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
    ).get(name);
  } catch { return false; }
}

function columnExists(db: Database.Database, table: string, col: string): boolean {
  try {
    if (!tableExists(db, table)) return false;
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
      .some((c) => String(c.name) === col);
  } catch { return false; }
}

function count(db: Database.Database, sql: string, params: unknown[] = []): number {
  try {
    const r = db.prepare(sql).get(...(params as never[])) as { n?: number } | undefined;
    return Number(r?.n || 0);
  } catch (e) {
    console.error('[station-master] count query failed (reporting 0):', e);
    return 0;
  }
}

/* ── NAMING ──────────────────────────────────────────────────────────────── */

/** Long enough for the longest name in use ('terracegrill', 12) with room. */
export const MAX_STATION_LEN = 32;

/** Said on screen so nobody types "Pan Asian" and wonders why it changed. */
export const STATION_CONVENTION =
  'lowercase letters, digits and single hyphens — like tandoor, pan-asian, terracegrill';

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The house normalisation, and it MUST stay identical to
 * resolveStationDepartment()'s first line. This is the key every reader joins
 * on; a divergence here is a station that resolves in Settings and skips in
 * production.
 */
export const normStationKey = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/**
 * Characters that LOOK like nothing but are bytes all the same: the zero-widths
 * (U+200B/200C/200D, U+2060 word joiner) and U+FEFF (the BOM, which a CSV
 * saved from Excel puts in front of the first cell). JS `trim()` strips the
 * BOM and NBSP but NOT the zero-widths; SQLite's `trim()` strips NONE of them
 * (ASCII space only). A station that differs from a real one only by such a
 * character passes a lower(trim()) master check on the JS side, stores
 * verbatim, and then no SQLite-side lower(trim()) predicate — applyStationRename's
 * UPDATEs, settings' GROUP BY — can ever reach it again: the row is STRANDED on
 * a spelling nothing can type. So the save path removes them before it looks
 * anything up.
 */
const INVISIBLE_CHARS_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

/**
 * The incoming value of a station WRITE, cleaned for LOOKUP: invisibles
 * removed, Unicode whitespace (NBSP included) trimmed from the ends. Case is
 * left alone — folding is the lookup's job (normStationKey), and what gets
 * STORED is never this string anyway but the master row's own spelling (see
 * checkStationOnSave).
 */
export function normStationInput(raw: unknown): string {
  return String(raw ?? '').replace(INVISIBLE_CHARS_RE, '').trim();
}

/**
 * The typed name, written the house way.
 *
 * Only spaces, underscores and slashes are bridged to hyphens — the separators
 * someone reaches for when they mean one. Anything else is left in place so
 * validateStationName() can REFUSE it by name rather than silently deleting a
 * character the typist meant to keep. Auto-correcting "Pan Asian" to
 * "pan-asian" is what stops a second row for a station that already exists.
 */
export function canonStationName(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_/\\]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type StationNameCheck = {
  ok: boolean;
  /** What will be stored. */
  canon: string;
  /** What was typed, trimmed. */
  typed: string;
  /** True when the two differ — the caller must SAY SO, never store silently. */
  changed: boolean;
  error?: string;
};

export function validateStationName(raw: unknown): StationNameCheck {
  const typed = String(raw ?? '').trim();
  const canon = canonStationName(raw);
  const changed = canon !== typed;
  const base = { canon, typed, changed };

  if (!typed) {
    return { ...base, ok: false, error: 'Type the station name — it cannot be blank.' };
  }
  if (!canon) {
    return {
      ...base, ok: false,
      error: `"${typed}" leaves nothing once it is written the house way. Stations are ${STATION_CONVENTION}.`,
    };
  }
  if (canon.length > MAX_STATION_LEN) {
    return {
      ...base, ok: false,
      error: `"${canon}" is ${canon.length} characters. Keep a station to ${MAX_STATION_LEN} or fewer — it has to fit the KOT header and the KDS column.`,
    };
  }
  if (!NAME_RE.test(canon)) {
    return {
      ...base, ok: false,
      error: `"${typed}" is not a station name this system can route. Stations are ${STATION_CONVENTION}. Spaces and underscores become hyphens; anything else has to go.`,
    };
  }
  return { ...base, ok: true };
}

/**
 * Which KDS board a station's tickets land on.
 *
 * NOT owner-configurable and NOT stored: kot-section.ts carries a hard-coded
 * BAR_STATIONS list, and a user's `section` filters the Kitchen Display against
 * it. So the NAME decides the board. Renaming 'cocktail' to 'craft-cocktail'
 * takes it out of that list and the ticket stops appearing for bar staff and
 * starts appearing for kitchen staff — silently, because nothing errors. This
 * function exists so the rename can say that out loud before it happens.
 */
export function stationKdsSection(name: unknown): 'bar' | 'kitchen' {
  return BAR_STATIONS.includes(normStationKey(name)) ? 'bar' : 'kitchen';
}

/* ── THE MASTER ROW ──────────────────────────────────────────────────────── */

export type StationMasterRow = {
  /** The EXACT stored string — write back to this, never to the normalised key. */
  station: string;
  department_id: string | null;
  is_active: number;
  note: string;
};

/**
 * The master row for a station, matched the way every READER matches it
 * (lower(trim())), returning the EXACT stored string so an UPDATE targets the
 * real PRIMARY KEY. The PK collates BINARY; the readers do not.
 */
export function findStationRow(db: Database.Database, name: unknown): StationMasterRow | null {
  const key = normStationKey(name);
  if (!key || !tableExists(db, 'station_departments')) return null;
  try {
    const r = db.prepare(
      `SELECT station, department_id, is_active, COALESCE(note,'') AS note
         FROM station_departments WHERE lower(trim(station)) = ? LIMIT 1`,
    ).get(key) as StationMasterRow | undefined;
    return r ? { ...r, is_active: Number(r.is_active ?? 1) } : null;
  } catch { return null; }
}

/* ── WHAT MAY BE WRITTEN ONTO A MENU ITEM ────────────────────────────────── */

export type StationSaveCheck =
  /** `store` is THE string the caller must write — never the incoming value. */
  | { ok: true; store: string }
  | { ok: false; error: string };

/**
 * MAY THIS STRING BE STORED IN `menu_items.station`?
 *
 * The item form now locks its Station control to the master, but a locked
 * dropdown is a courtesy, not a boundary: POST/PUT /api/menu-items take
 * `station` from the request body and write it verbatim, and everything under
 * /api/menu-items is reachable by ANY signed-in session (proxy.ts proves the
 * cookie and the CSRF double-submit; it does not check page access for APIs).
 * A station matching no master row and no print_stations row falls through
 * resolveKotPrinter()'s station match to the food/bar `kind` fallback, so the
 * ticket PRINTS ON A DIFFERENT PHYSICAL BOX — with no error anywhere. That is
 * the same silent unbinding applyStationRename()'s all-or-nothing exists to
 * prevent, arriving through the front door instead. So the master is enforced
 * where the write happens.
 *
 * THREE THINGS ARE ALLOWED, and what is STORED is decided here too — the
 * caller writes `store`, never the incoming string:
 *
 *  1. BLANK. "No station" is a real, chosen state — the item form offers it,
 *     628 of 628 live items are non-blank so nothing depends on it today, and
 *     a blank simply resolves 'unmapped' and skips, which is the house rule for
 *     a station nobody has mapped. Refusing it would be a new restriction this
 *     guard has no business inventing. Stored as '' — the one spelling of
 *     blank every reader agrees on — not as whatever whitespace arrived.
 *
 *  2. A STATION ON THE MASTER — stored as THE MASTER ROW'S OWN SPELLING.
 *     This is the line that killed two proven production defects. The check
 *     matches lower(trim()) (the way every reader matches), so "Tandoor",
 *     " tandoor " and NBSP-"tandoor" all PASSED it — and the routes then
 *     stored the client's bytes VERBATIM. kot-fire.ts groups a fired order by
 *     the RAW string, so one order with items on "Tandoor" and "tandoor"
 *     fired TWO KOTs, two numbers, for one physical section. Worse, a value
 *     JS trim() strips but SQLite trim() does not (NBSP, BOM, tab, newline)
 *     passed here, stored verbatim, and was then UNREACHABLE by every
 *     SQLite-side lower(trim()) predicate: applyStationRename() moved
 *     everything else and STRANDED those rows on the dead name while
 *     reporting success, and settings' GROUP BY lower(trim(station)) split
 *     them into phantom stations. Writing the master's exact string makes
 *     every spelling of a station byte-identical AT THE SOURCE, which is the
 *     only place the fix holds: every downstream comparison — JS or SQL,
 *     case-sensitive or not — then agrees.
 *
 *  3. THE HELD VALUE — the EXACT string the row already stores, when it is
 *     NOT resolvable on the master (rule 2 already covers it when it is, and
 *     cleans its drift in passing). Without this, one legacy item whose
 *     station is off-master (a CSV import's "Pan Asian", a value written
 *     before this guard existed) becomes permanently UNEDITABLE: the form
 *     posts the whole item, so fixing its PRICE would be refused for a
 *     station field nobody touched. Borrowed straight from the menu-category
 *     work, which offers an item's own off-master category back to it for
 *     exactly this reason. Stored verbatim — rewriting a legacy value this
 *     module cannot resolve would be guessing.
 *
 * The lookup key is normStationInput() — invisibles stripped, Unicode
 * whitespace trimmed — folded by findStationRow() to lower case for the match
 * ONLY. The incoming string is never stored on rules 1 and 2.
 *
 * ── COLLATION, SAID OUT LOUD ───────────────────────────────────────────────
 * The category work was bitten by this: `menu_categories.name` is declared
 * COLLATE NOCASE and a bare `=` INHERITS THE COLUMN'S COLLATION, so a lookup
 * meant to be exact silently matched case-insensitively and renamed the wrong
 * row. Both columns here happen to declare no collation today
 * (`menu_items.station TEXT DEFAULT ''`, `station_departments.station TEXT
 * PRIMARY KEY` — both BINARY, verified against the live schema), but "happens
 * to" is precisely what that bug was made of. So:
 *
 *  · The HELD-VALUE test is `===` IN JAVASCRIPT, on the string read back from
 *    the row. No SQL comparison happens at all, so there is no collation to
 *    inherit and no way for a later `ALTER`/table rebuild that adds COLLATE
 *    NOCASE to menu_items.station to quietly turn this exact test into a
 *    case-insensitive one. Exact means exact bytes, permanently.
 *  · The MASTER test is findStationRow(), whose SQL is
 *    `lower(trim(station)) = ?`. The left operand is a FUNCTION RESULT, not a
 *    column reference, so it carries no implicit collation and the comparison
 *    is BINARY on the normalised key — which is deliberate: it is byte-for-byte
 *    the match every production reader uses (resolveStationDepartment,
 *    resolveKotPrinter, the KDS). Asking a stricter question than the readers
 *    ask would refuse a value that routes perfectly well; asking a looser one
 *    would accept a value they cannot route.
 *
 * ── FAILS CLOSED WHEN THE MASTER IS UNREADABLE ─────────────────────────────
 * If `station_departments` is absent, every station is unverifiable and this
 * refuses — but rules 1 and 3 still stand, so every existing item keeps saving
 * every other field and only a station CHANGE is blocked. Accepting anything
 * because the check could not run is how a guard becomes decorative.
 */
export function checkStationOnSave(
  db: Database.Database,
  incoming: unknown,
  currentStored: string | null | undefined,
): StationSaveCheck {
  const value = String(incoming ?? '');
  const cleaned = normStationInput(value);

  // 1. Blank — "no station", a chosen state. Stored as '' whatever whitespace
  //    or invisibles actually arrived.
  if (!cleaned) return { ok: true, store: '' };

  // 2. On the master, matched the way every reader matches — and stored as the
  //    MASTER'S own spelling, never the client's bytes (see the header: this
  //    line is what makes every spelling of one station byte-identical).
  const master = findStationRow(db, cleaned);
  if (master) return { ok: true, store: master.station };

  // 3. The held value: byte-for-byte what the row already stores. JS ===, so
  //    no column collation can ever loosen it (see the header). Only reached
  //    when the master cannot resolve it — a resolvable held value took
  //    rule 2 and its drift is cleaned by that very save.
  if (currentStored != null && value === String(currentStored)) return { ok: true, store: value };

  if (!tableExists(db, 'station_departments')) {
    return {
      ok: false,
      error:
        `The station list is not available on this server, so "${value}" cannot be checked and will not be stored. ` +
        'A station that is not on the list routes nowhere — its KOT falls through to the printer fallback and prints on a different machine. ' +
        'Leave the station as it is (an unchanged station always saves) or clear it.',
    };
  }
  return {
    ok: false,
    error:
      `"${value}" is not on the station list, so nothing can route it: its KOT would match no printer bound to a station and fall through to the food/bar fallback — it would print on a different machine, with no error anywhere. ` +
      `Stations are ${STATION_CONVENTION}. Pick one an admin has added under Settings → Station → Department Map, leave the station blank, or leave it exactly as it is.`,
  };
}

/**
 * The spelling a WRITE should use for `raw` when the write is not allowed to
 * refuse: the master row's own string when the value resolves on the master,
 * otherwise the cleaned value verbatim (invisibles stripped, ends trimmed).
 *
 * This is the CSV importer's version of checkStationOnSave's rule 2. The
 * importer deliberately accepts off-master stations (refusing one there is a
 * new way for an import to lose data — it reports them in
 * stations_not_in_master instead), but there was no reason for it to keep the
 * FILE'S casing of a station that IS on the master: "Tandoor" in a hand-edited
 * column was stored verbatim and split the section's KOTs exactly like the
 * form path did. Resolvable spellings now land on the master's bytes; only a
 * genuinely unknown string is written as it came (cleaned), and the report
 * still names it.
 */
export function stationSpellingForWrite(db: Database.Database, raw: unknown): string {
  const cleaned = normStationInput(raw);
  if (!cleaned) return '';
  const master = findStationRow(db, cleaned);
  return master ? master.station : cleaned;
}

/* ── WHAT A STATION IS WORTH, AND WHAT A CHANGE WOULD TOUCH ──────────────── */

export type StationUsage = {
  station: string;
  in_master: boolean;
  /** Menu items on this station — active + inactive. All of them move on rename. */
  menu_items: number;
  live_menu_items: number;
  /** Menu items whose recipe would actually deduct. */
  live_recipe_items: number;
  /** Every sold line ever recorded against this station. */
  order_lines: number;
  /** …of which are still LIVE: not yet deducted, on an order that is still open. */
  order_lines_live: number;
  kots: number;
  /** …of which are still on the KDS board (not 'served'). */
  kots_live: number;
  /** Printers bound by their `station` field — these move with a rename. */
  printers: number;
  /** Printers bound only by matching their NAME to the station — these do NOT. */
  printers_by_name: number;
  /** History that is never rewritten. */
  kot_alerts: number;
  consumption_skips: number;
  dept_ledger_rows: number;
};

/**
 * ── THE BILLS THAT ARE FINISHED ───────────────────────────────────────────
 * ONE list, used by the counting query AND by the UPDATE, so the two can never
 * disagree about what a rename is allowed to touch. orders.status is
 * 'open' | 'settled' | 'void' | 'merged' | 'on_hold' | 'pending_approval'
 * (enumerated in src/lib/stale-tables.ts); anything NOT named here — including a
 * status added later — counts as LIVE, because moving a live row is harmless
 * while missing one silently loses a deduction.
 *
 * 'on_hold' IS FINISHED, and that is not obvious. Hold performs every
 * irreversible half of a settle except taking the money: it writes the `sales`
 * rows (with `category: it.station`, the label as it stood), deducts the stock,
 * freezes the totals, and orders/[id]/route.ts then refuses to add another item
 * to it. Settle-from-hold skips its own item loop. So a held line's station is
 * already a record, not an input — and its `sales` row is frozen under the old
 * label, so rewriting the order line would put the two permanently out of step.
 * Only recipe lines get recipe_deducted_at stamped on hold (610 of 628 menu
 * items carry no recipe), so the stamp alone does NOT keep held lines out.
 *
 * 'pending_approval' is the opposite: a QR order waiting for a captain. Nothing
 * has been decided, so it is live and it moves.
 */
export const CLOSED_ORDER_STATUSES = ['settled', 'void', 'merged', 'on_hold'] as const;
const CLOSED_LIST = CLOSED_ORDER_STATUSES.map((s) => `'${s}'`).join(',');

/**
 * ── WHAT COUNTS AS "STILL LIVE" ───────────────────────────────────────────
 * A sold line stops being live once its deduction has been DECIDED — either it
 * deducted (recipe_deducted_at stamped) or the bill finished (see above) so it
 * never will. Until then its station string is still an INPUT to a decision the
 * system has not made yet, not a record of one it already made.
 *
 * The join is INNER on purpose. Every deduction path (settle, hold,
 * kot-completion) loads its lines THROUGH the order, so a line whose order row
 * is gone can never deduct again — it is history, not an unknown. There are 0
 * such rows today (the FK cascades), and the same class demonstrably exists on
 * kots, so the guard is cheap and the failure it prevents is a silent rewrite of
 * a row nothing will ever read again.
 */
function liveOrderLineSql(db: Database.Database): string {
  const hasDeducted = columnExists(db, 'order_items', 'recipe_deducted_at');
  return `
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
   WHERE lower(trim(COALESCE(oi.station,''))) = ?
     AND COALESCE(o.status,'open') NOT IN (${CLOSED_LIST})
     ${hasDeducted ? 'AND oi.recipe_deducted_at IS NULL' : ''}`;
}

/**
 * A ticket is live until it is 'served' — the terminal step of KOT_FLOW — and it
 * does NOT matter what the bill did.
 *
 * THIS IS DELIBERATELY NOT THE order_items TEST BESIDE IT, and the asymmetry is
 * the point. /api/dine-in/kds/route.ts defines a ticket on the board as
 * `status != 'served'` with NO order-status filter, and neither void nor settle
 * touches kots — so a non-served ticket on a settled or voided bill is STILL on
 * the Kitchen Display and still has to find its printer. Leaving it on a dead
 * name would unbind it. The order_items row beside it is about a DEDUCTION,
 * which the closed bill has already decided; this one is about a TICKET, which
 * the board says is still open. Two artefacts, two liveness tests.
 *
 * The one exception is the orphan: the KDS INNER JOINs orders, so a ticket whose
 * order row is gone is invisible on the board, unbumpable and pure history. The
 * live DB holds exactly one (station 'pan-asian', status 'new'). It stays put.
 */
function liveKotSql(): string {
  return `FROM kots k
           WHERE lower(trim(COALESCE(k.station,''))) = ?
             AND COALESCE(k.status,'') <> 'served'
             AND EXISTS (SELECT 1 FROM orders o WHERE o.id = k.order_id)`;
}

export function stationUsage(db: Database.Database, name: unknown): StationUsage {
  const key = normStationKey(name);
  const hasOrderStation = columnExists(db, 'order_items', 'station');
  const hasKotStation = columnExists(db, 'kots', 'station');

  return {
    station: key,
    in_master: !!findStationRow(db, key),
    menu_items: count(db,
      `SELECT COUNT(*) n FROM menu_items WHERE lower(trim(COALESCE(station,''))) = ?`, [key]),
    live_menu_items: count(db,
      `SELECT COUNT(*) n FROM menu_items WHERE lower(trim(COALESCE(station,''))) = ? AND is_active = 1`, [key]),
    live_recipe_items: count(db, `
      SELECT COUNT(*) n FROM menu_items mi JOIN recipes r ON r.id = mi.recipe_id
       WHERE lower(trim(COALESCE(mi.station,''))) = ?
         AND mi.is_active = 1 AND COALESCE(r.is_active, 1) = 1`, [key]),
    order_lines: hasOrderStation ? count(db,
      `SELECT COUNT(*) n FROM order_items WHERE lower(trim(COALESCE(station,''))) = ?`, [key]) : 0,
    order_lines_live: hasOrderStation ? count(db,
      `SELECT COUNT(*) n ${liveOrderLineSql(db)}`, [key]) : 0,
    kots: hasKotStation ? count(db,
      `SELECT COUNT(*) n FROM kots WHERE lower(trim(COALESCE(station,''))) = ?`, [key]) : 0,
    kots_live: hasKotStation ? count(db, `SELECT COUNT(*) n ${liveKotSql()}`, [key]) : 0,
    printers: count(db,
      `SELECT COUNT(*) n FROM print_stations WHERE lower(trim(COALESCE(station,''))) = ?`, [key]),
    // print.ts resolveKotPrinter() matches a printer on its `station` OR on its
    // `name`. A printer bound only by NAME is invisible to the rename — its
    // human label is not ours to rewrite — so it is counted separately and
    // warned about instead of being silently unbound.
    printers_by_name: count(db, `
      SELECT COUNT(*) n FROM print_stations
       WHERE lower(trim(COALESCE(name,''))) = ?
         AND lower(trim(COALESCE(station,''))) <> ?`, [key, key]),
    kot_alerts: tableExists(db, 'kot_alerts') ? count(db,
      `SELECT COUNT(*) n FROM kot_alerts WHERE lower(trim(COALESCE(station,''))) = ?`, [key]) : 0,
    consumption_skips: tableExists(db, 'consumption_skips') ? count(db,
      `SELECT COUNT(*) n FROM consumption_skips WHERE lower(trim(COALESCE(station,''))) = ?`, [key]) : 0,
    dept_ledger_rows: columnExists(db, 'department_material_transactions', 'station') ? count(db,
      `SELECT COUNT(*) n FROM department_material_transactions WHERE lower(trim(COALESCE(station,''))) = ?`, [key]) : 0,
  };
}

/**
 * Every place the name `key` is used, SPLIT INTO THE TWO KINDS, because they
 * carry opposite consequences and the same refusal for both is what made a
 * rename one-way.
 *
 *  · `live` — a master row, menu items, a printer binding. The name is CURRENTLY
 *    A SECTION. Renaming onto it folds two kitchen sections into one string:
 *    there is then no record of which tickets came from which section, and one
 *    master row decides the department for both. NEVER allowed, no override.
 *
 *  · `history` — closed sold lines, served tickets, KOT alerts, skips, ledger
 *    rows. The name is not a section any more; it is a LABEL ON THE PAST, and
 *    history is never rewritten, so it stays on those rows whatever happens.
 *
 * A name with history and no live use is the UNDO CASE: rename 'tandoor' to a
 * typo and the only thing still holding 'tandoor' is the history the rename
 * deliberately left behind. Refusing that outright — which is what a single list
 * did — makes every rename of a station that has ever been sold permanent (5 of
 * the 13 stations here were already in that state). It is still not free: the
 * old rows would start reading as the renamed section in KOT-analytics and the
 * item-journey report, and if the name once belonged to a DIFFERENT retired
 * section, the two pasts merge under one label. So it takes an informed second
 * click (409 + force:true), the house shape already used by SENTINEL_STATION and
 * KDS_SECTION_SHIFT — not a silent yes and not a permanent no.
 *
 * `sales.category` is deliberately NOT consulted. recordSale writes the station
 * into it for order-linked rows, but the same column legitimately holds POS menu
 * categories for every imported sale, so checking it would refuse names that
 * were never stations. It is named here so the omission is a decision rather
 * than an oversight.
 */
export type StationConflict = { live: string[]; history: string[] };

export function stationInUseBy(db: Database.Database, name: unknown): StationConflict {
  const u = stationUsage(db, name);
  const live: string[] = [];
  const history: string[] = [];
  if (u.in_master) live.push('the station list');
  if (u.menu_items) live.push(`${u.menu_items} menu item${u.menu_items === 1 ? '' : 's'}`);
  if (u.printers || u.printers_by_name) {
    const n = u.printers + u.printers_by_name;
    live.push(`${n} printer${n === 1 ? '' : 's'}`);
  }
  if (u.order_lines) history.push(`${u.order_lines} sold line${u.order_lines === 1 ? '' : 's'}`);
  if (u.kots) history.push(`${u.kots} KOT${u.kots === 1 ? '' : 's'}`);
  if (u.kot_alerts) history.push(`${u.kot_alerts} KOT alert${u.kot_alerts === 1 ? '' : 's'}`);
  if (u.consumption_skips) history.push(`${u.consumption_skips} recorded skip${u.consumption_skips === 1 ? '' : 's'}`);
  if (u.dept_ledger_rows) history.push(`${u.dept_ledger_rows} department stock-ledger row${u.dept_ledger_rows === 1 ? '' : 's'}`);
  return { live, history };
}

/**
 * An existing station that differs from `canon` ONLY by hyphens.
 *
 * The realistic typo on this dataset, because the master already contains the
 * un-hyphenated outlier `terracegrill`: typing "Terrace Grill" canonicalises to
 * `terrace-grill`, which is a DIFFERENT station under the case-insensitive rule
 * and is therefore accepted — leaving two rows, one of them unmapped, and any
 * item later moved onto the wrong one skips its deduction in silence. Two
 * stations that differ only in hyphenation are essentially never intended, so
 * this is worth a second click; it is not worth a refusal, because they COULD
 * be intended and the tool must not decide that for the owner.
 */
export function nearDuplicateStation(db: Database.Database, canon: string): string | null {
  const squash = (s: string) => s.replace(/-/g, '');
  const target = squash(normStationKey(canon));
  if (!target || !tableExists(db, 'station_departments')) return null;
  try {
    for (const r of db.prepare(`SELECT station FROM station_departments`).all() as Array<{ station: string }>) {
      const other = normStationKey(r.station);
      if (other !== normStationKey(canon) && squash(other) === target) return other;
    }
  } catch { /* a probe must never take the add down */ }
  return null;
}

/* ── THE WORDING, IN ONE PLACE ───────────────────────────────────────────── */

/**
 * What switching a station off actually costs, named with the count.
 *
 * Deactivating has always worked; what was missing was the consequence being
 * visible. An inactive row resolves as reason 'inactive' — the deduction is
 * SKIPPED and recorded. The menu items keep their station string, so KOT
 * routing, the KDS board and the printers are all unaffected; only the stock
 * deduction stops. Saying both halves is the point: the fear is that pausing a
 * station stops tickets reaching the kitchen, and it does not.
 */
export function deactivateWarning(u: StationUsage, departmentName?: string | null): string {
  const items = u.live_menu_items;
  const head = items
    ? `${items} live menu item${items === 1 ? '' : 's'} still route${items === 1 ? 's' : ''} to '${u.station}'`
    : `No live menu item uses '${u.station}' right now`;
  const recipes = u.live_recipe_items
    ? ` ${u.live_recipe_items} of them cook${u.live_recipe_items === 1 ? 's' : ''} from a recipe, so ${u.live_recipe_items === 1 ? 'that one' : 'those'} will stop deducting from ${departmentName || 'the department'} and be recorded as skips instead.`
    // Said from the ZERO branch too, so the sentence does not refer to items it
    // has just finished saying do not exist.
    : items
      ? ' None of them cooks from a recipe, so no deduction is happening on this station anyway.'
      : ' Nothing cooks from a recipe on it, so no deduction is happening on this station anyway.';
  return `${head}.${recipes} Their station is NOT changed — KOTs still print and still reach the section. Only the stock deduction stops.`;
}

/* ── ADD ─────────────────────────────────────────────────────────────────── */

/**
 * Insert a station into the master, UNMAPPED.
 *
 * department_id is NULL on purpose. The house rule (see the route header and
 * dept-ledger.ts) is that an unmapped station SKIPS the deduction and records
 * the skip — it never guesses. A new station arriving pre-pointed at some
 * plausible department is exactly the silent-wrong-kitchen outcome that rule
 * exists to prevent, so a new station starts inert and the owner maps it in a
 * second, deliberate step.
 *
 * Caller must have validated the name and checked for a clash INSIDE the same
 * transaction.
 */
export function insertStation(db: Database.Database, canon: string, note: string): void {
  db.prepare(`
    INSERT INTO station_departments (station, department_id, is_active, note, updated_at)
    VALUES (?, NULL, 1, ?, datetime('now'))
  `).run(canon, String(note || '').slice(0, 500));
}

/* ── RENAME ──────────────────────────────────────────────────────────────── */

export type RenameCounts = {
  master: number;
  menu_items: number;
  printers: number;
  order_lines_live: number;
  kots_live: number;
};

/**
 * Move a station name across everything that still has a JOB to do with it, and
 * across nothing that merely RECORDS it.
 *
 * MUST be called inside a db.transaction(): the master row and the menu items
 * have to move together or KOT routing and the department map disagree.
 *
 * ── WHAT MOVES, AND WHY ────────────────────────────────────────────────────
 *  · station_departments.station — the master row. It is the PRIMARY KEY, so
 *    this is a re-key, not a label edit; every reader joins on it.
 *  · menu_items.station — what routes the NEXT KOT and resolves the NEXT
 *    deduction. EVERY row moves, active and inactive: an inactive item left on
 *    the old string re-creates the old station the moment it is switched back
 *    on. Matched on lower(trim()) rather than exactly, because to this system
 *    'Tandoor' and 'tandoor' are one station (see the header) — so a rename also
 *    cleans up any casing drift instead of stranding it.
 *  · print_stations.station — the physical printer binding. A rename that
 *    missed this would silently unbind the printer: the KOT would fall through
 *    resolveKotPrinter()'s station match to the food/bar `kind` fallback and
 *    print somewhere else, with no error anywhere.
 *  · order_items.station — ONLY an un-deducted line on a bill that is still
 *    running (see liveOrderLineSql). It has not become history yet: it still has
 *    to resolve a department when the ticket completes. Left on the old name it
 *    would resolve against a master row that no longer carries it and SKIP — a
 *    deduction lost to an admin's rename, invisible until the next variance
 *    review.
 *  · kots.station — ONLY a ticket that is still on the board (see liveKotSql),
 *    WHICHEVER STATE ITS BILL IS IN. This is NOT the order_items test: the KDS
 *    board's own definition of a live ticket is `status != 'served'` with no
 *    order-status filter, and neither void nor settle touches kots, so a
 *    non-served ticket on a settled or voided bill is still on the board and
 *    still has to find its printer. The full reasoning is on liveKotSql().
 *
 * ── WHAT DOES NOT MOVE, AND WHY ────────────────────────────────────────────
 *  · order_items on a FINISHED bill (settled / void / merged / on_hold) or one
 *    already deducted — the line records the label it was decided under, and for
 *    a settled or held bill the `sales` row recordSale wrote alongside it is
 *    frozen under that same label. The KOT-analytics and item-journey reports
 *    read these columns to say what happened on the night.
 *  · a served ticket, and a ticket whose ORDER ROW IS GONE — the latter is
 *    invisible on the board (the KDS INNER JOINs orders), unbumpable, and pure
 *    history. The live DB holds exactly one.
 *  · department_material_transactions.station — the append-only DEPARTMENT STOCK
 *    LEDGER. It records which station resolved which department for a movement
 *    that already happened. It is the audit trail behind a variance figure
 *    pointed at a chef and it is not rewritable; rewriting order_items to a name
 *    the ledger never saw would put the two permanently out of step.
 *  · consumption_skips.station — the register of skips already taken. "We
 *    skipped 'terracegrill' on 3 Aug" is a fact about 3 Aug.
 *  · kot_alerts.station — a message about a past ticket. It resolves by kot_id,
 *    never by the string, so a stale label costs nothing.
 *  · print_stations.name — a human label for a physical box ("Tandoor Printer").
 *    Not ours to rewrite. Counted and warned about instead, because a printer
 *    bound ONLY by its name does stop matching.
 */
export function applyStationRename(
  db: Database.Database,
  fromStored: string,
  to: string,
): RenameCounts {
  const key = normStationKey(fromStored);
  const hasOrderStation = columnExists(db, 'order_items', 'station');
  const hasKotStation = columnExists(db, 'kots', 'station');

  const master = db.prepare(
    `UPDATE station_departments SET station = ?, updated_at = datetime('now') WHERE station = ?`,
  ).run(to, fromStored).changes;

  const menu = db.prepare(
    `UPDATE menu_items SET station = ?, updated_at = datetime('now')
      WHERE lower(trim(COALESCE(station,''))) = ?`,
  ).run(to, key).changes;

  /* THE PRINTER BINDING IS INSIDE THE ALL-OR-NOTHING, and it must stay there.
   *
   * This used to be wrapped in try/catch so "a missing print_stations table
   * cannot take the rename down". SQLite rolls back only the failed STATEMENT,
   * so the catch let the surrounding transaction COMMIT: the master row and 28
   * menu items moved, the printer stayed on the dead name, the answer reported
   * `printers: 0` — indistinguishable from "there were none" — and every ticket
   * for that section then fell through resolveKotPrinter()'s station match to
   * the food/bar `kind` fallback and printed on a DIFFERENT physical box, with
   * no error and no warning. That is exactly the silent unbinding this UPDATE
   * exists to prevent, and it was the only statement in the cascade exempted
   * from the transaction's guarantee.
   *
   * The absence case is now handled by ASKING (columnExists covers a missing
   * table and a missing column), so a real failure — a trigger, a constraint, a
   * locked page — propagates and takes the whole rename back. A rename that
   * cannot move the printer must not happen. */
  const printers = columnExists(db, 'print_stations', 'station')
    ? db.prepare(
      `UPDATE print_stations SET station = ?, updated_at = datetime('now')
        WHERE lower(trim(COALESCE(station,''))) = ?`,
    ).run(to, key).changes
    : 0;

  /* Both UPDATEs re-use the SAME predicates the counters use (liveOrderLineSql /
   * liveKotSql), so `impact` cannot promise a number the cascade does not move
   * and a status added to the closed list is applied to both at once. */
  let orderLines = 0;
  if (hasOrderStation) {
    orderLines = db.prepare(
      `UPDATE order_items SET station = ? WHERE id IN (SELECT oi.id ${liveOrderLineSql(db)})`,
    ).run(to, key).changes;
  }

  let kots = 0;
  if (hasKotStation) {
    kots = db.prepare(
      `UPDATE kots SET station = ?, updated_at = datetime('now')
        WHERE id IN (SELECT k.id ${liveKotSql()})`,
    ).run(to, key).changes;
  }

  return { master, menu_items: menu, printers, order_lines_live: orderLines, kots_live: kots };
}
