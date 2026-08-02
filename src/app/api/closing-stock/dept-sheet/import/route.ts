import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, getCurrentUser } from '@/lib/auth';
import { allowedDeptSetExpanded, canSeeAllDeptStock } from '@/lib/dept-stock';
import { materialStoreId, getStoreById } from '@/lib/store-engine';
import { upsertVarianceApproval } from '@/lib/variance-approval';
import { rateMap, valueCount, valueSemiCount } from '@/lib/closing-valuation';
import { packFactor, toPurchaseQty, type PackMeta } from '@/lib/pack-units';
import { todayIST } from '@/lib/format-date';

/**
 * ALL-DEPARTMENTS CLOSING COUNT — ONE FILE, ONE COLUMN PER DEPARTMENT
 * ═══════════════════════════════════════════════════════════════════════════
 * The owner counts eight kitchens on one walk and wants to upload the result
 * once. The single-department template on /closing-stock cannot express that:
 * it has a single "Physical count" column, so eight departments meant eight
 * files and eight uploads — and eight chances to upload the Tandoor sheet under
 * Conti.
 *
 * The shape below is the owner's own hand-built file, kept byte-for-byte:
 *
 *   Type,material_id,sub_recipe_id,SKU,Name,Category,Unit,
 *   COLD ROOM Physical count,CONTI Physical count,… ,TOTAL Physical count
 *
 * ONE ROW PER ITEM, ONE COLUMN PER DEPARTMENT. The counter walks the catalogue
 * once and fills the column belonging to whichever department holds the item.
 *
 * ── "TOTAL Physical count" ─────────────────────────────────────────────────
 * A spreadsheet convenience for the human. It is IGNORED on import: never
 * resolved as a department, never written, never used to reconcile. Reconciling
 * against it would let a stale SUM() silently overrule the counted cells.
 *
 * ── WHY DEPARTMENT COLUMNS ARE NEVER FUZZY-MATCHED ─────────────────────────
 * A header prefix resolves to a department by exact, case-insensitive, trimmed
 * NAME or nothing at all. Writing 1,025 counts into the wrong department is far
 * worse than refusing the file: the counts look plausible, they value fine, and
 * nobody discovers the swap until a variance meeting weeks later. An
 * unresolvable column is a hard error that names the column and lists the
 * department names that ARE valid.
 *
 * ── THE UNIT RULE (get this wrong and every count is garbage) ──────────────
 * A RAW row's Unit column carries the PURCHASE unit, so the counter types
 * purchase units (2 = 2 BTL). closing_stock.physical_stock is RECIPE units.
 * The conversion lives in ONE helper (rawRecipeQty). The preview sample shows
 * what was entered and what will be stored, BOTH in purchase units (owner
 * rule): a correct conversion round-trips to the entered number, and a missed
 * pack factor shows as 0.002 l against an entered 2 — visible BEFORE any write,
 * without putting two unit bases on one line.
 * A 2-BTL count on a 750 ml material stores 1,500 ml; skip the conversion and
 * the count lands 750x too small.
 * packFactor() from '@/lib/pack-units' is the ONLY pack rule used here — it
 * carries both halves of the guard (pack_size > 1 AND unit !== purchase_unit).
 * A local `pack_size > 1` test mis-converts PICKLED GINGER 1.5KG (kg/kg, pack
 * 1.5), which must NOT convert.
 * A SUB row is counted in the sub-recipe's own yield_unit: no purchase unit, no
 * pack factor, stored exactly as written.
 *
 * ── PREVIEW IS THE SAFETY MECHANISM ────────────────────────────────────────
 * mode:"preview" resolves everything and writes nothing, so the owner sees the
 * column→department mapping and a sample of the unit conversion before a
 * 1,025-row file touches the ledger.
 *
 * ── APPLY IS ALL-OR-NOTHING ────────────────────────────────────────────────
 * One transaction, and it refuses outright when the file has ANY error. A file
 * that half-applies leaves a count nobody can trust and no way to tell which
 * half landed — the counter would have to diff 8,000 cells by hand. Fix the
 * file (preview says exactly what is wrong), upload again.
 *
 * ── DUPLICATED WRITE LOGIC (declared, not hidden) ──────────────────────────
 * ../route.ts (the dept-sheet POST) owns the raw-material upsert inline; it
 * exports no writer, and calling one route handler from another is not
 * acceptable. So the INSERT + variance + approval block below is replicated
 * from it line for line, and every non-trivial part is IMPORTED rather than
 * re-derived: rateMap / valueCount (valuation), upsertVarianceApproval (the
 * queue), materialStoreId / getStoreById (the liquor guard), packFactor (units),
 * allowedDeptSetExpanded / canSeeAllDeptStock (scope). Only the literal SQL and
 * the systemStock/variance arithmetic are duplicated. If ../route.ts changes
 * its INSERT, this file MUST change with it — bulk and single-entry writes
 * drifting apart is a house rule that has already bitten this codebase.
 * The SUB half is replicated the same way from ../../semi/route.ts.
 *
 * ROUTES
 *   GET  ?date=YYYY-MM-DD&template=1  → text/csv blank multi-department sheet
 *        &items=all                    → optional: the whole countable catalogue
 *                                        instead of the departments' item sets
 *   POST { date, csv, mode:'preview'|'apply' }
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/* ── shared with ../route.ts (kept byte-identical on purpose) ─────────────── */

/** Wording is load-bearing: pages match /limited|authoriz/ to render a lock
 *  notice instead of a red error. Same string as ../route.ts. */
const NO_SCOPE =
  'The department closing sheet is limited to admins, managers, HODs and store managers — or to staff with a department assigned.';

// Store-mapped materials (liquor) belong to their own store's closing
// (/api/stores/[id]/closing). Byte-identical to the guard in ../route.ts so the
// two can never disagree about which side of the house owns a material.
const NOT_STORE_MAPPED = `NOT EXISTS (
  SELECT 1 FROM store_category_map scm
  JOIN store_locations sl ON sl.id = scm.store_id
  WHERE sl.is_active = 1 AND REPLACE(REPLACE(REPLACE(LOWER(TRIM(scm.category)),' ',''),'-',''),'_','') = REPLACE(REPLACE(REPLACE(LOWER(TRIM(rm.category)),' ',''),'-',''),'_','')
)`;

/** Row-type tokens. 'SEMI' is what /closing-stock's template emits and what
 *  this template emits; 'SUB' is accepted too because the owner's spreadsheet
 *  habit is to type it. Both mean the same table. */
const TYPE_RAW = 'RAW';
const TYPE_SEMI = 'SEMI';
const SEMI_TOKENS = new Set(['SEMI', 'SUB', 'SUB-RECIPE', 'SUB RECIPE']);
const RAW_TOKENS = new Set(['RAW', 'MATERIAL', 'RAW MATERIAL']);

/** The suffix that marks a department count column. */
const COUNT_SUFFIX = 'physical count';
/** The one prefix that is a spreadsheet total, never a department. */
const TOTAL_PREFIXES = new Set(['total', 'totals', 'grand total', 'sum']);

const SAMPLE_LIMIT = 25;

/* ── tiny CSV plumbing (local on purpose) ─────────────────────────────────── */
// Deliberately not imported from api/direct-items/_lib/csv.ts: that parser
// canonicalises headers to snake_case keys, which destroys the department name
// this route has to read back out of the header ("COLD ROOM Physical count" →
// "cold_room_physical_count" can no longer be shown in an error message).

/** Quote a cell only when it needs it. Never locale-formats — a CSV is data. */
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

interface CsvRecord { /** 1-based line in the FILE the user sees in Excel. */ line: number; cells: string[] }

/**
 * Quoted fields, escaped quotes, CRLF and a BOM. Raw headers are preserved.
 * The line number travels with every record so an error points at the line the
 * counter can actually find, not at an index they have to count out.
 */
function parseCsv(text: string): CsvRecord[] {
  const src = text.replace(/^\uFEFF/, '');
  const out: CsvRecord[] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  let line = 1;
  let recStart = 1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuote) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === ',') { cur.push(field); field = ''; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      line++;
      // `field` MUST be cleared with `cur`. Without it the last cell of a row
      // stayed in the buffer and the next row's first cell was appended to it —
      // "…,TOTAL Physical count\nRAW,…" parsed as a first cell of
      // "TOTAL Physical countRAW", so every data row failed Type validation and
      // a phantom trailing record appeared.
      //
      // It hid because a BLANK template still parses: a row with no counts is
      // skipped before Type is ever checked, so the all-blank sheet the store
      // downloads looked perfect. The bug only appears once real counts are
      // filled in — i.e. on every upload that actually matters.
      if (field !== '' || cur.length > 0) { cur.push(field); out.push({ line: recStart, cells: cur }); cur = []; }
      field = '';
      recStart = line;
      continue;
    }
    field += c;
  }
  if (field !== '' || cur.length > 0) { cur.push(field); out.push({ line: recStart, cells: cur }); }
  return out;
}

/** Header/name comparison key: collapse whitespace, trim, lower-case. */
const key = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Column-header aliases the OWNER confirmed, keyed and valued in key() form.
 *
 * The kitchen's own sheet is headed with what people say — CONTI, TANDOOR — not
 * with the department's registered name. All eight of its columns failed to
 * resolve, so without this the store manager's existing file is unusable.
 *
 * Deliberately a fixed table and not a similarity score: a fuzzy matcher gets
 * seven of these right and quietly files the eighth against the wrong kitchen,
 * and a count in the wrong department is only discovered at the next variance
 * review, if ever. Every pair here was checked against the live department list.
 *
 * COLD ROOM is the owner's explicit call: it is not a department in its own
 * right, and its counts belong to Akan Main Kitchen.
 *
 * A resolved alias still goes through every check a typed name does — scope,
 * active state, duplicates. Newly generated templates carry the real names, so
 * this only ever serves hand-built sheets.
 */
const OWNER_COLUMN_ALIASES: Record<string, string> = {
  'cold room':  'akan main kitchen',
  'conti':      'akan continental',
  'indian':     'akan indian',
  'tandoor':    'akan tandoori',
  'asian':      'akan pan asian',
  'pizza':      'akan pizza',
  'bakery':     'akan - bakery',
  'staff food': 'akan - staff room',
};

/**
 * A count cell → a non-negative number, or null when it is not one.
 *
 * parseFloat is NOT good enough here. Excel hands back grouped numbers
 * ("1,200") and stray unit suffixes ("3 kg"); parseFloat reads those as 1 and 3
 * and writes a silent 1000x / unit error into the ledger. Grouping separators
 * are accepted only in the exact 1,200,000.5 shape; anything else is refused so
 * the counter is told rather than quietly mis-read.
 */
function parseCount(raw: string): number | null {
  let s = String(raw ?? '').trim();
  if (s === '') return null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/* ── scope ────────────────────────────────────────────────────────────────── */

interface DeptRow { id: string; name: string; is_active: number }

/** Same gate as the dept-sheet POST: admins / managers / HODs / store managers
 *  see every department; anyone else is limited to their own department set
 *  (expanded to sub-departments), and nobody with an empty set gets in. */
async function resolveScope(db: ReturnType<typeof getDb>) {
  const me = await getCurrentUser();
  if (!me) return { error: Response.json({ error: 'Not authorized.' }, { status: 401 }) } as const;
  const seesAll = canSeeAllDeptStock(me);
  const scopedIds = seesAll ? null : new Set(allowedDeptSetExpanded(db, me));
  if (scopedIds && scopedIds.size === 0) {
    return { error: Response.json({ error: NO_SCOPE }, { status: 403 }) } as const;
  }
  return { me, seesAll, scopedIds } as const;
}

/** Departments this user may count, active-first. Inactive departments are
 *  included ONLY when they already hold a count on this date — the same rule
 *  ../route.ts uses, so an existing count never becomes un-editable. */
function countableDepts(db: ReturnType<typeof getDb>, scopedIds: Set<string> | null, date: string): DeptRow[] {
  const all = db.prepare('SELECT id, name, is_active FROM departments ORDER BY name').all() as DeptRow[];
  const counted = new Set(
    (db.prepare("SELECT DISTINCT COALESCE(department_id,'') AS d FROM closing_stock WHERE date = ?")
      .all(date) as { d: string }[]).map(r => r.d).filter(Boolean),
  );
  return all.filter(d =>
    (d.is_active === 1 || counted.has(d.id)) && (!scopedIds || scopedIds.has(d.id)),
  );
}

/* ── the ONE unit helper ──────────────────────────────────────────────────── */

interface MatRow {
  id: string; name: string; sku: string | null; category: string | null;
  super_category: string | null; unit: string | null; purchase_unit: string | null;
  pack_size: number | null; case_size: number | null;
  average_price: number | null; current_stock: number | null; is_active: number;
}

/**
 * THE conversion. A RAW count is typed in the basis the row's own Unit cell
 * declares and stored in RECIPE units.
 *
 * The template writes the PURCHASE unit, so the normal path is
 * `entered x packFactor(material)`. The recipe-unit and blank cases are honoured
 * too, identical to the single-department importer on /closing-stock — the two
 * importers must never read the same file differently. A blank Unit on a packed
 * material is REFUSED rather than guessed: guessing picks a basis that can scale
 * the count by the pack factor.
 */
function rawRecipeQty(m: MatRow, entered: number, unitCell: string):
  { qty: number; unit: string } | { error: string } {
  const pf = packFactor(m as PackMeta);
  const ru = String(m.unit || '').trim();
  const pu = String(m.purchase_unit || m.unit || '').trim();
  const cell = key(unitCell);
  if (cell === '' && pf > 1) {
    return { error: `the Unit column is blank — write ${pu} (count in purchase units) or ${ru} (recipe units) so the basis is unambiguous` };
  }
  // pf === 1 collapses both branches to the same number, so the order is safe.
  if (cell === '' || cell === key(ru)) return { qty: entered, unit: ru || pu };
  if (cell === key(pu)) return { qty: Math.round(entered * pf * 1e6) / 1e6, unit: pu };
  return { error: `unit "${unitCell.trim()}" matches neither ${ru} nor ${pu}` };
}

/* ── GET: the blank multi-department template ─────────────────────────────── */

interface SubRow { id: string; name: string; category: string | null; yield_unit: string }

export async function GET(request: Request) {
  try {
    const db = getDb();
    const scope = await resolveScope(db);
    if ('error' in scope) return scope.error;

    const url = new URL(request.url);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '')
      ? String(url.searchParams.get('date'))
      : todayIST();
    // WHICH ITEMS GO ON THE SHEET — an admin setting, not a hardcoded rule.
    //
    // Two legitimate ways to run a count, and the house does both:
    //   all        the STORE walks the building and counts everything, so the
    //              sheet must carry the whole raw-material catalogue. An item
    //              missing from the sheet is an item nobody counts.
    //   requested  each department counts only what it has ever asked for —
    //              the department-scoped concept the rest of the app uses. A
    //              sheet padded with items that department never holds is a
    //              thousand rows of noise on a physical walk.
    //
    // Owner-selectable in Settings -> Purchasing & Stock. Default 'all',
    // because the bulk sheet exists FOR the store's whole-building count; the
    // on-screen department sheet is unchanged and stays department-scoped.
    //
    // ?items= still wins when present, so a one-off run either way needs no
    // settings trip: ?items=all or ?items=requested.
    const scopeParam = String(url.searchParams.get('items') || '').toLowerCase();
    const scopeSetting = String(
      (db.prepare(`SELECT value FROM settings WHERE key = 'closing_sheet_bulk_scope'`).get() as any)?.value || 'all',
    ).toLowerCase();
    const wholeCatalogue = scopeParam
      ? scopeParam === 'all'
      : scopeSetting !== 'requested';

    const depts = countableDepts(db, scope.scopedIds, date);
    if (depts.length === 0) {
      // A sheet with no department columns is not a sheet — it is a catalogue
      // dump the importer would then refuse. Say so here instead.
      return Response.json({ error: NO_SCOPE }, { status: 403 });
    }
    const deptIdsJson = JSON.stringify(depts.map(d => d.id));

    // ONE row per item — the union of the included departments' item sets (the
    // house definition: ever issued to, UNION ever counted by). Store-mapped
    // (liquor) materials are excluded: they are counted in their own store's
    // closing, and the POST rejects them too.
    const mats = db.prepare(`
      ${wholeCatalogue ? '' : `WITH pairs AS (
        SELECT ri.material_id AS material_id
          FROM requisition_items ri
          JOIN requisitions r ON r.id = ri.req_id
         WHERE COALESCE(ri.department_id, r.department_id) IN (SELECT value FROM json_each(?))
           AND r.status NOT IN ('cancelled','chef_rejected')
           AND COALESCE(r.purpose,'internal') <> 'party'
           AND ri.quantity_issued > 0
           AND COALESCE(ri.is_rejected,0) = 0
           AND COALESCE(ri.store_rejected,0) = 0
        UNION
        SELECT cs.material_id
          FROM closing_stock cs
         WHERE cs.department_id IN (SELECT value FROM json_each(?))
      )`}
      SELECT rm.id                                                 AS id,
             COALESCE(rm.sku, '')                                  AS sku,
             rm.name                                               AS name,
             COALESCE(NULLIF(TRIM(rm.super_category),''), COALESCE(rm.category,'')) AS category,
             COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit)  AS purchase_unit,
             COALESCE(NULLIF(TRIM(rm.category),''), 'zz')          AS sort_cat
        FROM ${wholeCatalogue ? 'raw_materials rm' : 'pairs JOIN raw_materials rm ON rm.id = pairs.material_id'}
       WHERE ${NOT_STORE_MAPPED}
         AND (COALESCE(rm.is_active,1) = 1
              OR EXISTS (SELECT 1 FROM closing_stock cs2
                          WHERE cs2.material_id = rm.id AND cs2.date = ?))
       ORDER BY sort_cat, name
    `).all(...(wholeCatalogue ? [date] : [deptIdsJson, deptIdsJson, date])) as
      (Pick<MatRow, 'id' | 'name' | 'purchase_unit'> & { sku: string; category: string })[];

    // Sub-recipes have no department item set (they are cooked and held
    // wherever the kitchen keeps them), so every active one is listed — the
    // same set the single-department template emits.
    const subs = db.prepare(`
      SELECT id, name, COALESCE(category,'') AS category, yield_unit
        FROM sub_recipes WHERE is_active = 1 ORDER BY category, name
    `).all() as SubRow[];

    const header = [
      'Type', 'material_id', 'sub_recipe_id', 'SKU', 'Name', 'Category', 'Unit',
      ...depts.map(d => `${d.name} Physical count`),
      'TOTAL Physical count',
    ];
    // One blank count cell per department + the trailing TOTAL the owner's
    // spreadsheet fills in for itself. The importer ignores TOTAL entirely.
    const blanks = new Array(depts.length + 1).fill('');

    const lines = [header.map(csvEscape).join(',')];
    for (const m of mats) {
      // RAW: material_id + SKU, Unit = the PURCHASE unit the counter types in.
      lines.push([TYPE_RAW, m.id, '', m.sku || '', m.name || '', m.category || '',
        m.purchase_unit || '', ...blanks].map(csvEscape).join(','));
    }
    for (const s of subs) {
      // SUB: sub_recipe_id + the sub-recipe's OWN yield unit. No purchase unit
      // and no pack conversion exists, so the count goes in as written.
      lines.push([TYPE_SEMI, '', s.id, '', s.name, s.category || 'sub-recipe',
        s.yield_unit || '', ...blanks].map(csvEscape).join(','));
    }

    // BOM: Excel on Windows otherwise mangles non-ASCII material names, and the
    // counter never sees the file again after that.
    return new Response('\uFEFF' + lines.join('\n') + '\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="closing-stock-all-departments-${date}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error)?.message || 'Failed' }, { status: 500 });
  }
}

/* ── POST: preview + apply ────────────────────────────────────────────────── */

interface ImportError { line: number; label: string; reason: string }
interface DeptCol { /** Header prefix exactly as written in the file. */ name: string; id: string | null; matched: boolean; index: number }
interface RawEntry {
  line: number; label: string; department_id: string; department: string;
  material: MatRow; entered: number; unit: string; recipeQty: number; notes: string;
}
interface SemiEntry {
  line: number; label: string; department_id: string; department: string;
  sub: SubRow & { cost_per_unit: number | null }; entered: number; unit: string; qty: number; notes: string;
}

/** Read the CSV whichever way it arrives: the agreed JSON body, or multipart
 *  from a plain <input type=file> form. */
async function readBody(req: Request): Promise<{ date: string; csv: string; mode: string }> {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const fd = await req.formData();
    const file = fd.get('file');
    return {
      date: String(fd.get('date') || ''),
      csv: file instanceof Blob ? await file.text() : String(fd.get('csv') || ''),
      mode: String(fd.get('mode') || 'preview'),
    };
  }
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  return {
    date: String((body as Record<string, unknown>)?.date || ''),
    csv: String((body as Record<string, unknown>)?.csv || ''),
    mode: String((body as Record<string, unknown>)?.mode || 'preview'),
  };
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const scope = await resolveScope(db);
    if ('error' in scope) return scope.error;
    const me = scope.me;

    const { date, csv, mode: rawMode } = await readBody(request);
    const mode = rawMode === 'apply' ? 'apply' : 'preview';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return Response.json({ error: 'A valid date (YYYY-MM-DD) is required.' }, { status: 400 });
    }
    if (!csv.trim()) {
      return Response.json({ error: 'No CSV content received.' }, { status: 400 });
    }

    const records = parseCsv(csv);
    if (records.length === 0) {
      return Response.json({ error: 'The file has no rows.' }, { status: 400 });
    }
    const headers = records[0].cells;
    const dataRows = records.slice(1).filter(r => r.cells.some(c => c.trim() !== ''));

    const errors: ImportError[] = [];

    /* ── 1. FIXED COLUMNS, matched by header NAME (case/space-insensitive) ── */
    const colIndex = (...names: string[]): number => {
      for (const n of names) {
        const want = key(n);
        const i = headers.findIndex(h => key(h) === want);
        if (i >= 0) return i;
      }
      return -1;
    };
    const cType = colIndex('Type', 'Item type', 'item_type');
    const cMatId = colIndex('material_id', 'material id');
    const cSubId = colIndex('sub_recipe_id', 'sub recipe id');
    const cSku = colIndex('SKU');
    const cName = colIndex('Name');
    const cUnit = colIndex('Unit');
    const cNotes = colIndex('Notes');

    /* ── 2. DEPARTMENT COLUMNS — the new part, and the risky one ──────────── */
    const depts = countableDepts(db, scope.scopedIds, date);
    const validNames = depts.map(d => d.name).sort((a, b) => a.localeCompare(b));

    // Every department in the table, so a column naming an out-of-scope or
    // inactive department gets the RIGHT error instead of "no such department".
    const allDepts = db.prepare('SELECT id, name, is_active FROM departments').all() as DeptRow[];
    const byName = new Map<string, DeptRow[]>();
    for (const d of allDepts) {
      const k = key(d.name);
      const list = byName.get(k);
      if (list) list.push(d); else byName.set(k, [d]);
    }
    const allowed = new Map(depts.map(d => [d.id, d.name]));

    const deptCols: DeptCol[] = [];
    const ignoredColumns: string[] = [];
    const seenDeptIds = new Set<string>();

    headers.forEach((h, i) => {
      const hk = key(h);
      if (!hk.endsWith(COUNT_SUFFIX)) return;
      const prefix = String(h).replace(/\s*physical\s+count\s*$/i, '').trim();
      const pk = key(prefix);

      // The spreadsheet's own SUM(). Never a department, never written — a
      // stale formula must not be allowed to overrule the counted cells.
      // The one case that must NOT be silently ignored is a real department
      // actually named "Total": then the column is genuinely ambiguous, and
      // ignoring it would drop that department's entire count without a word.
      if (TOTAL_PREFIXES.has(pk)) {
        if ((byName.get(pk) || []).length > 0) {
          errors.push({
            line: records[0].line, label: String(h).trim(),
            reason: `column "${String(h).trim()}" is the spreadsheet total column, but a department is also named "${prefix}". Rename the department so the two cannot be confused.`,
          });
          return;
        }
        ignoredColumns.push(String(h).trim());
        return;
      }

      if (pk === '') {
        errors.push({
          line: records[0].line, label: String(h).trim(),
          reason: `column "${String(h).trim()}" has no department prefix. This importer needs one column per department (e.g. "${validNames[0] || 'CONTI'} Physical count"). For a one-department file use Closing Stock → upload instead.`,
        });
        return;
      }

      let hits = byName.get(pk) || [];

      // OWNER-CONFIRMED COLUMN ALIASES.
      //
      // The store's own sheet predates this importer, so its headers are the
      // shorthand the kitchen actually says ("CONTI", "TANDOOR") rather than the
      // department's registered name ("Akan Continental", "Akan Tandoori"). Every
      // one of its eight columns failed to resolve on the first run.
      //
      // These are NOT fuzzy matches — fuzzy matching would be right most of the
      // time and eventually file a count against the wrong kitchen, which costs a
      // recount nobody knows to do. Each entry below was confirmed by the owner
      // against the live department list, and COLD ROOM in particular is their
      // explicit instruction: it is not a department of its own and its counts
      // belong to Akan Main Kitchen.
      //
      // An alias only ever RESOLVES a name; scope, active-state and duplicate
      // checks below still apply exactly as they would for a typed-out name. The
      // generated template uses the real names, so a freshly downloaded sheet
      // never needs any of this.
      if (hits.length === 0) {
        const target = OWNER_COLUMN_ALIASES[pk];
        if (target) hits = byName.get(target) || [];
      }
      if (hits.length === 0) {
        errors.push({
          line: records[0].line, label: String(h).trim(),
          reason: `column "${String(h).trim()}": no department is named "${prefix}". Valid departments: ${validNames.join(', ') || '(none available to you)'}.`,
        });
        deptCols.push({ name: prefix, id: null, matched: false, index: i });
        return;
      }
      if (hits.length > 1) {
        // departments.name is UNIQUE but only case-SENSITIVELY, so "Conti" and
        // "CONTI" can both exist. Refuse rather than pick one.
        errors.push({
          line: records[0].line, label: String(h).trim(),
          reason: `column "${String(h).trim()}" matches ${hits.length} departments whose names differ only by case. Rename one of them before uploading.`,
        });
        deptCols.push({ name: prefix, id: null, matched: false, index: i });
        return;
      }

      const d = hits[0];
      if (!allowed.has(d.id)) {
        const why = scope.scopedIds && !scope.scopedIds.has(d.id)
          ? 'you are not allowed to record counts for it'
          : 'it is inactive and holds no count on this date';
        errors.push({
          line: records[0].line, label: String(h).trim(),
          reason: `column "${String(h).trim()}": ${why}. Remove the column, or ask an admin. Valid departments: ${validNames.join(', ') || '(none available to you)'}.`,
        });
        deptCols.push({ name: prefix, id: null, matched: false, index: i });
        return;
      }
      if (seenDeptIds.has(d.id)) {
        errors.push({
          line: records[0].line, label: String(h).trim(),
          reason: `department "${d.name}" has more than one count column. Keep one.`,
        });
        deptCols.push({ name: prefix, id: null, matched: false, index: i });
        return;
      }
      seenDeptIds.add(d.id);
      deptCols.push({ name: d.name, id: d.id, matched: true, index: i });
    });

    const liveCols = deptCols.filter(c => c.matched && c.id);
    if (liveCols.length === 0 && errors.length === 0) {
      return Response.json({
        error: `No department count columns found. Each department needs its own column, e.g. "${validNames[0] || 'CONTI'} Physical count". Download the all-departments template to get the right header.`,
      }, { status: 400 });
    }

    /* ── 3. CATALOGUE, loaded once (a 1,025-row file x 8 columns is 8,200
           lookups — per-cell SELECTs would make preview unusable) ─────────── */
    const matRows = db.prepare(`
      SELECT id, name, sku, category, super_category, unit,
             COALESCE(NULLIF(TRIM(purchase_unit),''), unit) AS purchase_unit,
             pack_size, case_size, average_price, current_stock,
             COALESCE(is_active,1) AS is_active
        FROM raw_materials
    `).all() as MatRow[];
    const matById = new Map<string, MatRow>();
    const matBySku = new Map<string, MatRow>();
    const matByName = new Map<string, MatRow>();
    for (const m of matRows) {
      matById.set(String(m.id), m);
      const sk = key(m.sku);
      if (sk && !matBySku.has(sk)) matBySku.set(sk, m);
      const nk = key(m.name);
      if (nk && !matByName.has(nk)) matByName.set(nk, m);
    }

    const subRows = db.prepare(`
      SELECT id, name, COALESCE(category,'') AS category, yield_unit, cost_per_unit
        FROM sub_recipes
    `).all() as (SubRow & { cost_per_unit: number | null })[];
    const subById = new Map(subRows.map(s => [String(s.id), s]));
    const subByName = new Map<string, (SubRow & { cost_per_unit: number | null })>();
    for (const s of subRows) { const k = key(s.name); if (k && !subByName.has(k)) subByName.set(k, s); }

    // materialStoreId() hits store_category_map per call; cache by category.
    const storeIdCache = new Map<string, string | null>();
    const storeFor = (cat: string | null): string | null => {
      const k = key(cat);
      if (storeIdCache.has(k)) return storeIdCache.get(k) ?? null;
      const id = materialStoreId(db, { category: cat });
      storeIdCache.set(k, id);
      return id;
    };

    /* ── 4. ROWS ───────────────────────────────────────────────────────────── */
    const rawEntries: RawEntry[] = [];
    const semiEntries: SemiEntry[] = [];
    /** Guards a silent last-write-wins when one item appears twice in the file. */
    const seenCells = new Map<string, number>();
    let rowsWithCounts = 0;

    const cell = (r: CsvRecord, i: number) => (i >= 0 ? String(r.cells[i] ?? '').trim() : '');

    for (const rec of dataRows) {
      const nameCell = cell(rec, cName);
      const matIdCell = cell(rec, cMatId);
      const subIdCell = cell(rec, cSubId);
      const skuCell = cell(rec, cSku);
      const unitCell = cell(rec, cUnit);
      // Notes are a per-ROW column (there is no room for one per department on
      // this shape), so a row's note is copied onto each of its counts.
      const notes = cell(rec, cNotes);
      const label = nameCell || matIdCell || subIdCell || skuCell || `line ${rec.line}`;

      // Which department columns did this row actually get a count in? Blank =
      // not counted = skipped silently, exactly like the existing importer.
      const filled: { col: DeptCol; raw: string }[] = [];
      for (const col of liveCols) {
        const v = cell(rec, col.index);
        if (v !== '') filled.push({ col, raw: v });
      }
      if (filled.length === 0) continue;
      rowsWithCounts++;

      // Type: blank means RAW unless a sub_recipe_id is present. Anything else
      // is refused — a sub-recipe counted as a raw material (or the reverse) is
      // valued by an entirely different rule (₹/purchase-unit x pack factor vs
      // ₹/yield-unit).
      const typeCell = cell(rec, cType).toUpperCase();
      let isSemi: boolean;
      if (typeCell === '') isSemi = !!subIdCell;
      else if (SEMI_TOKENS.has(typeCell)) isSemi = true;
      else if (RAW_TOKENS.has(typeCell)) isSemi = false;
      else {
        errors.push({ line: rec.line, label, reason: `unknown Type "${typeCell}" — use ${TYPE_RAW} for a raw material or ${TYPE_SEMI} for a sub-recipe` });
        continue;
      }
      // A blank Type on a name that exists ONLY as a sub-recipe is a hand-built
      // row. Ask for the Type rather than silently counting the wrong thing.
      if (typeCell === '' && !subIdCell && nameCell && !matByName.has(key(nameCell)) && subByName.has(key(nameCell))) {
        errors.push({ line: rec.line, label, reason: `this is a sub-recipe — set Type to ${TYPE_SEMI} (or fill sub_recipe_id) so it is not read as a raw material` });
        continue;
      }

      if (isSemi) {
        const sub = (subIdCell ? subById.get(subIdCell) : undefined)
          ?? (nameCell ? subByName.get(key(nameCell)) : undefined);
        if (!sub) {
          errors.push({ line: rec.line, label, reason: 'sub-recipe not found (check sub_recipe_id / Name)' });
          continue;
        }
        // No purchase unit and no pack factor: the Unit cell may only CONFIRM
        // the yield unit. Anything else means the counter used another basis.
        const yu = String(sub.yield_unit || '').trim();
        if (unitCell !== '' && key(unitCell) !== key(yu)) {
          errors.push({ line: rec.line, label, reason: `unit "${unitCell}" is not this sub-recipe's yield unit (${yu})` });
          continue;
        }
        for (const f of filled) {
          const n = parseCount(f.raw);
          if (n === null) {
            errors.push({ line: rec.line, label, reason: `${f.col.name}: invalid physical count "${f.raw}"` });
            continue;
          }
          const k = `SEMI|${sub.id}|${f.col.id}`;
          const prev = seenCells.get(k);
          if (prev !== undefined) {
            errors.push({ line: rec.line, label, reason: `${f.col.name}: counted twice (also on line ${prev}) — keep one row per item per department` });
            continue;
          }
          seenCells.set(k, rec.line);
          semiEntries.push({
            line: rec.line, label, department_id: f.col.id!, department: f.col.name,
            sub, entered: n, unit: yu, qty: n, notes,
          });
        }
        continue;
      }

      /* RAW */
      const m = (matIdCell ? matById.get(matIdCell) : undefined)
        ?? (skuCell ? matBySku.get(key(skuCell)) : undefined)
        ?? (nameCell ? matByName.get(key(nameCell)) : undefined);
      if (!m) {
        errors.push({ line: rec.line, label, reason: 'material not found (check material_id / SKU / Name)' });
        continue;
      }
      // Liquor lives in its own store's closing, never on a department sheet.
      // Same wording as the dept-sheet POST so the two agree.
      const storeId = storeFor(m.category);
      if (storeId) {
        const storeName = getStoreById(db, storeId)?.name || 'store';
        errors.push({
          line: rec.line, label,
          reason: `${storeName.toUpperCase()} material — use ${storeName} closing (Inventory → ${storeName}), not the department sheet.`,
        });
        continue;
      }
      const conv0 = rawRecipeQty(m, 0, unitCell);
      if ('error' in conv0) { errors.push({ line: rec.line, label, reason: conv0.error }); continue; }

      for (const f of filled) {
        const n = parseCount(f.raw);
        if (n === null) {
          errors.push({ line: rec.line, label, reason: `${f.col.name}: invalid physical count "${f.raw}"` });
          continue;
        }
        const conv = rawRecipeQty(m, n, unitCell);
        if ('error' in conv) { errors.push({ line: rec.line, label, reason: conv.error }); continue; }
        const k = `RAW|${m.id}|${f.col.id}`;
        const prev = seenCells.get(k);
        if (prev !== undefined) {
          errors.push({ line: rec.line, label, reason: `${f.col.name}: counted twice (also on line ${prev}) — keep one row per item per department` });
          continue;
        }
        seenCells.set(k, rec.line);
        rawEntries.push({
          line: rec.line, label, department_id: f.col.id!, department: f.col.name,
          material: m, entered: n, unit: conv.unit, recipeQty: conv.qty, notes,
        });
      }
    }

    const willWrite = rawEntries.length + semiEntries.length;

    /* ── 5. PREVIEW — resolve everything, write nothing ────────────────────── */
    if (mode === 'preview') {
      // Both figures in the sample: `entered` is what the counter typed and
      // `stored_recipe_qty` is what would land in the table. A wrong basis
      // (2 BTL stored as 2 instead of 1,500 ml) is visible here or nowhere.
      const sample = [...rawEntries, ...semiEntries]
        .slice(0, SAMPLE_LIMIT)
        .map(e => ({
          label: e.label,
          department: e.department,
          entered: e.entered,
          unit: e.unit,
          stored_recipe_qty: 'recipeQty' in e ? e.recipeQty : e.qty,
          // The stored figure is MEANINGLESS without its unit: "2 kg -> 2000"
          // reads as a bug, "2 kg -> 2000 g" reads as the conversion working.
          // RAW carries the material's recipe unit; SUB has no conversion, so it
          // reports the unit it was entered in.
          // PURCHASE UNITS ONLY (owner rule). Showing the stored recipe figure
          // here put '2 l => 2000 ml' in front of the store, mixing two bases on
          // one line. The stored value is instead converted BACK to the purchase
          // unit, which still proves the conversion: a correct one round-trips to
          // exactly what was typed, and a missed pack factor shows as 0.002 l
          // against an entered 2. Same safety, one basis.
          stored_purchase_qty: 'material' in e
            ? toPurchaseQty(e.recipeQty, e.material as PackMeta)
            : e.qty,
          stored_unit: 'material' in e
            ? String((e.material as any).purchase_unit || (e.material as any).unit || '')
            : e.unit,
          line: e.line,
        }));
      return Response.json({
        mode: 'preview',
        date,
        // Every resolved column, so the owner sees the mapping BEFORE applying.
        departments: deptCols.map(c => ({ name: c.name, id: c.id, matched: c.matched })),
        ignored_columns: ignoredColumns,
        total_rows: dataRows.length,
        will_write: willWrite,
        // Rows where no department column carried a count at all.
        skipped: Math.max(0, dataRows.length - rowsWithCounts),
        errors,
        sample,
      });
    }

    /* ── 6. APPLY — one transaction, all or nothing ────────────────────────── */
    if (errors.length > 0) {
      // Refuse the whole file. A partial apply of a 1,025-row sheet leaves a
      // count nobody can trust and no way to tell which half landed.
      return Response.json({ mode: 'apply', saved: 0, pending: 0, refused: true, errors });
    }
    if (willWrite === 0) {
      return Response.json({
        mode: 'apply', saved: 0, pending: 0, errors: [
          { line: 0, label: 'file', reason: 'No physical counts found in the file — every department column is blank.' },
        ],
      });
    }

    const outletId = await getCurrentOutletId();
    const rates = rateMap(db);
    let saved = 0, savedSemi = 0, pending = 0;

    const run = db.transaction(() => {
      /* ── RAW half — replicated from ../route.ts (see the header note) ───── */
      const delRaw = db.prepare(
        "DELETE FROM closing_stock WHERE date = ? AND material_id = ? AND COALESCE(department_id,'') = ?",
      );
      const insRaw = db.prepare(`
        INSERT INTO closing_stock
          (id, material_id, department_id, date, system_stock, physical_stock, variance,
           variance_value, notes, recorded_by, outlet_id,
           rate_per_purchase_unit, rate_source, total_value, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      for (const e of rawEntries) {
        const m = e.material;
        delRaw.run(date, m.id, e.department_id);

        // KNOWN LIMITATION, inherited verbatim from ../route.ts: the system
        // figure is the CENTRAL pool (raw_materials.current_stock) even for a
        // row tagged to a department, so a department count is not directly
        // comparable to it. approveVariance() already refuses to move central
        // stock for a departmental central count.
        const systemStock = Number(m.current_stock) || 0;
        const variance = Math.round((e.recipeQty - systemStock) * 1000) / 1000;
        // UNCHANGED rupee formula (variance x average_price, ₹/recipe unit).
        const varianceValue = Math.round(variance * (Number(m.average_price) || 0) * 100) / 100;

        const valued = valueCount(db, {
          id: m.id, unit: m.unit, purchase_unit: m.purchase_unit,
          pack_size: m.pack_size, average_price: m.average_price,
        }, e.recipeQty, rates.get(m.id) ?? null);

        insRaw.run(
          generateId(), m.id, e.department_id, date, systemStock, e.recipeQty, variance,
          varianceValue, e.notes, me.email || '', outletId || null,
          valued.ratePerPurchaseUnit, valued.source, valued.totalValue,
        );

        // A non-zero variance never moves stock — it raises a PENDING approval,
        // through the SAME call the single-entry writer makes, so bulk counts
        // land in the same admin queue.
        upsertVarianceApproval(db, {
          source: 'central',
          material_id: m.id,
          department_id: e.department_id,
          date,
          system_stock: systemStock,
          physical_stock: e.recipeQty,
          unit: String(m.unit || ''),
          counted_by: me.email || '',
          count_note: e.notes,
          outlet_id: outletId,
        });
        if (variance !== 0) pending++;
        saved++;
      }

      /* ── SUB half — replicated from ../../semi/route.ts ───────────────────
         SUB rows are HANDLED, not rejected: closing_stock.material_id is NOT
         NULL with a FK to raw_materials, so a sub-recipe id physically cannot
         go in that table. It goes to closing_stock_semi, costed by
         cost_per_unit with NO pack factor (a sub-recipe has no purchase unit —
         running one through packFactor would be a category error). There is no
         system balance for sub-recipes, hence no variance and no approval row. */
      const delSemi = db.prepare(
        "DELETE FROM closing_stock_semi WHERE date = ? AND sub_recipe_id = ? AND COALESCE(department_id, '') = COALESCE(?, '')",
      );
      const insSemi = db.prepare(`
        INSERT INTO closing_stock_semi
          (id, sub_recipe_id, date, department_id, outlet_id, physical_stock, unit, rate, total_value, notes, recorded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const e of semiEntries) {
        const valued = valueSemiCount(e.sub, e.qty);
        delSemi.run(date, e.sub.id, e.department_id);
        insSemi.run(
          generateId(), e.sub.id, date, e.department_id, outletId || null,
          e.qty, valued.unit, valued.rate, valued.totalValue, e.notes, me.email || '',
        );
        savedSemi++;
      }
    });

    run();

    return Response.json({
      mode: 'apply',
      saved: saved + savedSemi,
      pending,
      saved_raw: saved,
      saved_semi: savedSemi,
      errors: [] as ImportError[],
    });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error)?.message || 'Failed' }, { status: 500 });
  }
}
