import { getDb, generateId } from '@/lib/db';
import { LQ_PRODUCT_TYPES } from '@/lib/liquor-recon';
import { requireBrandMapAdmin, gateResponse, requireAuditedWrite } from '../_lib/guard';
import {
  parseCsv, normProductType, numCell, boolCell, normCode,
  KNOWN_COLUMNS, BRAND_MAP_CSV_HEADER,
  spellingFold, spellingFoldMessage, type SpellingFold,
} from '../_lib/rows';

/**
 * BRAND MASTER CSV IMPORT — the one-time migration path off the owner's
 * workbook (docs/liquor-reconciliation-plan.md, phase L1: "CSV import of the
 * Brand Master sheet itself").
 *
 * POST ?commit=0  (default — PREVIEW, writes nothing)
 * POST ?commit=1  (COMMIT — inserts/updates exactly the rows the preview called
 *                  valid, in ONE transaction)
 *
 * Body: multipart/form-data `file`, JSON { csv }, or a raw text/csv body —
 * the same three shapes the HR employee import accepts, so the same uploader
 * component works.
 *
 * COLUMNS (header row REQUIRED, matched case/space/underscore-insensitively):
 *   material | material_id | sku   ← at least one, to identify OUR material
 *   tgbcl_brand_code*  size_code   size_ml   bottles_per_case*
 *   rate_per_case_master           product_type*   is_active   note
 *   (* required per row)
 *
 * RE-IMPORT IS AN UPDATE, NOT A DUPLICATE. The master key is
 * (tgbcl_brand_code, size_code) — the same key the UNIQUE index in db.ts
 * enforces — so a row whose key is already mapped UPDATES that row and is
 * reported as `updated`; a row identical to what is stored is reported as
 * `unchanged` and is not written at all. Running the same file twice therefore
 * produces zero new rows and zero edits the second time. Codes are upper-cased
 * at the edge (normCode) because that UNIQUE index is case-SENSITIVE: without
 * it, "9740/pp" and "9740/PP" would be two master rows for one pack.
 *
 * NO FOLD IS SILENT (owner decision 4, 2026-08-31). The two folds that must
 * stay — the code/pack upper-casing above, and product_type onto BEER / IML /
 * Duty Paid — are each reported as a WARNING naming the line, what the file
 * typed and what is stored ("product type 'Beer' stored as 'BEER'"), on every
 * row whatever its action, and every fold rides the batch audit with the
 * file's own spelling (`spelling_folds`). The material NAME is never folded:
 * it is matched case-insensitively and raw_materials is never written.
 *
 * AN UPDATE CHANGES WHAT THE FILE SAYS, AND ONLY THAT. Three columns are
 * optional (size_ml, is_active, note — only the starred three are required per
 * row), so a file that omits them is a legitimate file, and it is exactly the
 * file an operator builds to push new TGBCL rates. This route used to rewrite
 * EVERY column on every matched row, so such a file silently reset size_ml to
 * 0, is_active to 1 and note to '' on each brand it touched. That is not
 * cosmetic: size_ml 0 removes pickBrandMap's rule-3 tie-break, which turns a
 * two-pack material into 'ambiguous_pack' and its landed cost into null; and
 * is_active 1 RESURRECTS a retired pack, which can win rule 3 and silently
 * HALVE a landed cost that L3/L4 then freeze onto lq_retail_flags and
 * lq_withdrawals for good. So:
 *
 *   column absent from the header   → an UPDATE keeps the stored value;
 *                                     a CREATE uses the documented default.
 *   blank size_ml / is_active cell  → same as absent. Neither 0-for-unknown
 *                                     nor "active" is a value an operator MEANS
 *                                     by leaving a cell empty.
 *   blank `note` cell               → '' , i.e. clear it. Empty IS a real value
 *                                     for free text, and clearing a note from a
 *                                     file has to stay possible.
 *
 * A brand code that already maps the SAME material under a different pack code
 * is a warning on a create, because that is how one real pack becomes two
 * master rows (one imported before the sheet had a size_code column, one
 * after) — the material then reads 'ambiguous_pack' and loses its landed cost,
 * while the preview reports a plain "1 add".
 *
 * A KEY THAT CHANGES MATERIAL IS CALLED OUT BY NAME. Because the key is the
 * TGBCL pack and not our material, a row naming a different material MOVES the
 * mapping: the brand code leaves the material it was on, which silently loses
 * its master rate and its landed cost (they go null, "not mapped"). That is a
 * legitimate correction — the first mapping may simply have been wrong — so it
 * is allowed, but it is never silent. It rides the preview as a WARNING and as
 * its own `material_changes` list (from → to), and both materials go into the
 * batch audit, so the change can be read back and reversed. Counting it only as
 * "1 update" hid the half that matters: which material lost its mapping.
 *
 * WHAT IS A HARD ERROR AND WHAT IS A WARNING — the house split (errors exclude
 * the row, warnings import anyway), decided by what the value carries:
 *   ERROR   material not found / matched more than one row  (a wrong material
 *           re-prices the wrong brand)
 *   ERROR   missing or unrecognised product_type (BEER / IML / Duty Paid) — it
 *           drives the §C beer-vs-spirit split and the §D uplift factors, and
 *           defaulting a beer to IML would quietly misstate both
 *   ERROR   bottles_per_case missing / ≤ 0 / not a whole number — every landed
 *           cost divides by it and SQLite returns NULL rather than raising,
 *           which is the value landedCostPerBottle() reserves for "not mapped"
 *   ERROR   the same (brand code, size code) twice in ONE file
 *   WARNING blank rate_per_case_master (stored 0 — the row maps, the rate is
 *           filled in later), unknown columns, size_ml missing on a NEW row
 *           (stored 0 = "unknown", so rule 3 cannot use it), a new pack under a
 *           brand code that already maps this material, and a mapping that
 *           MOVES to a different material
 *
 * VALUATION IS NOT TOUCHED (plan decision 1(a)): this route writes lq_brand_map
 * and audit_events, and nothing else. No average_price, no last_purchase_price,
 * no ledger row.
 *
 * Gate: ADMIN + CSRF, server-side (../_lib/guard.ts).
 */
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 1_000_000; // 1MB — same cap as the HR import
const MAX_ROWS = 2_000;           // keeps the synchronous commit loop bounded
/** Owner decision 4: fold warnings listed one per line up to this many; the
 *  rest are counted in one closing line (never dropped — see the row loop). */
const FOLD_WARNINGS_MAX = 200;

interface RowIssue { line: number; message: string }
interface Warning { line?: number; message: string }

interface ValidRow {
  line: number;
  material_id: string;
  material_name: string;
  tgbcl_brand_code: string;
  size_code: string;
  /** RESOLVED: what the file said, or — when the file said nothing and the row
   *  already exists — what is stored. See the header. */
  size_ml: number;
  bottles_per_case: number;
  rate_per_case_master: number;
  product_type: string;
  is_active: number;
  note: string;
  /** '' when this row will INSERT; the lq_brand_map.id it will UPDATE. */
  existing_id: string;
  action: 'create' | 'update' | 'unchanged';
  /** Set on an update whose rate moves — surfaced in the preview and the audit. */
  rate_from: number | null;
  /** Set on an update that MOVES the mapping to a different material: the
   *  material it is being taken away from. Surfaced in the preview, warned
   *  about, and carried into the audit — see the header. */
  material_from: string | null;
  material_from_name: string | null;
  /** Every place the stored value differs from what the file typed (owner
   *  decision 4) — warned in the preview and kept, with the file's spelling,
   *  in the batch audit. */
  spelling_folds: SpellingFold[];
}

async function readCsvBody(req: Request): Promise<string> {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const fd = await req.formData();
    const file = fd.get('file');
    if (!file || !(file instanceof Blob)) return '';
    return await file.text();
  }
  if (ct.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return String(body?.csv || '');
  }
  return await req.text();
}

export async function POST(request: Request) {
  const gate = await requireBrandMapAdmin(request);
  if (!gate.ok) return gateResponse(gate);

  try {
    const declaredLen = Number(request.headers.get('content-length') || 0);
    if (declaredLen > MAX_BODY_BYTES) {
      return Response.json({ error: 'File too large — keep the Brand Master under 1MB (split the file).' }, { status: 400 });
    }
    const qs = new URL(request.url).searchParams;
    const commit = qs.get('commit') === '1';

    const csv = await readCsvBody(request);
    if (!csv.trim()) return Response.json({ error: 'No CSV content received' }, { status: 400 });
    if (Buffer.byteLength(csv, 'utf8') > MAX_BODY_BYTES) {
      return Response.json({ error: 'File too large — keep the Brand Master under 1MB (split the file).' }, { status: 400 });
    }

    const { headers, rows } = parseCsv(csv);
    const hasIdentity = headers.includes('material') || headers.includes('material_id') || headers.includes('sku');
    if (!hasIdentity || !headers.includes('tgbcl_brand_code')) {
      return Response.json({
        error: 'Missing header row — the first line must name the columns, and it needs a tgbcl_brand_code column plus one of material / material_id / sku.',
        expected_header: BRAND_MAP_CSV_HEADER,
      }, { status: 400 });
    }
    if (rows.length === 0) return Response.json({ error: 'The file has no data rows' }, { status: 400 });
    if (rows.length > MAX_ROWS) {
      return Response.json({ error: `Too many rows (max ${MAX_ROWS.toLocaleString('en-IN')} per import) — split the file` }, { status: 400 });
    }

    const errors: RowIssue[] = [];
    const warnings: Warning[] = [];
    const unknown = [...new Set(headers.filter(h => h && !KNOWN_COLUMNS.has(h)))];
    if (unknown.length > 0) {
      warnings.push({ message: `Unknown column${unknown.length > 1 ? 's' : ''} ignored: ${unknown.join(', ')}` });
    }

    const db = getDb();
    const byId   = db.prepare('SELECT id, name FROM raw_materials WHERE id = ?');
    const bySku  = db.prepare("SELECT id, name FROM raw_materials WHERE TRIM(sku) = ? COLLATE NOCASE AND TRIM(sku) != ''");
    const byName = db.prepare('SELECT id, name FROM raw_materials WHERE TRIM(name) = ? COLLATE NOCASE');
    const byKey  = db.prepare(`
      SELECT id, material_id, size_ml, bottles_per_case, rate_per_case_master,
             product_type, is_active, note
      FROM lq_brand_map WHERE tgbcl_brand_code = ? AND size_code = ?
    `);
    // Other packs ALREADY STORED under the same brand code for the same
    // material — the "one pack, two master rows" warning (see the header).
    // Deliberately reads the TABLE only, not the rows earlier in this file: a
    // sheet that legitimately lists 9740-PP and 9740-NN together is the
    // workbook's own multi-pack case and must not be warned about on the
    // one-time migration import.
    const otherPacks = db.prepare(`
      SELECT size_code FROM lq_brand_map
      WHERE tgbcl_brand_code = ? AND material_id = ? AND size_code != ?
      ORDER BY size_code
    `);

    /** Did the FILE carry this column at all? `cells` only holds headers that
     *  exist, so cell() alone cannot tell "column absent" from "cell blank". */
    const has = (k: string): boolean => headers.includes(k);

    const seenKeys = new Map<string, number>();   // "CODE|SIZE" → first file line
    let foldWarned = 0, foldOverflow = 0;         // owner decision 4 — see the row loop
    const valid: ValidRow[] = [];

    for (const row of rows) {
      const cell = (k: string): string => (row.cells[k] ?? '').trim();
      const rowErrors: string[] = [];

      // ── material: id, then sku, then exact name (all case-insensitive) ──
      let material_id = '';
      let material_name = '';
      const idCell = cell('material_id');
      const skuCell = cell('sku');
      const nameCell = cell('material');
      if (idCell) {
        const hit = byId.get(idCell) as any;
        if (hit) { material_id = hit.id; material_name = hit.name; }
        else rowErrors.push(`material_id "${idCell}" does not exist`);
      } else if (skuCell) {
        const hits = bySku.all(skuCell) as any[];
        if (hits.length === 1) { material_id = hits[0].id; material_name = hits[0].name; }
        else if (hits.length === 0) rowErrors.push(`No material has SKU "${skuCell}"`);
        else rowErrors.push(`SKU "${skuCell}" matches ${hits.length} materials — use material_id to say which`);
      } else if (nameCell) {
        const hits = byName.all(nameCell) as any[];
        if (hits.length === 1) { material_id = hits[0].id; material_name = hits[0].name; }
        else if (hits.length === 0) rowErrors.push(`No material named "${nameCell}" — create it on /inventory first, or use material_id`);
        else rowErrors.push(`"${nameCell}" matches ${hits.length} materials — use material_id or sku to say which`);
      } else {
        rowErrors.push('No material on this row (fill material, material_id or sku)');
      }

      // ── TGBCL key ──
      const tgbcl_brand_code = normCode(cell('tgbcl_brand_code'));
      const size_code = normCode(cell('size_code'));
      if (!tgbcl_brand_code) rowErrors.push('Missing tgbcl_brand_code');
      const key = `${tgbcl_brand_code}|${size_code}`;
      if (tgbcl_brand_code) {
        const firstAt = seenKeys.get(key);
        if (firstAt !== undefined) {
          rowErrors.push(`${tgbcl_brand_code}${size_code ? '-' + size_code : ''} already appears on line ${firstAt} of this file`);
        } else {
          seenKeys.set(key, row.line);
        }
      }

      // ── bottles per case — hard, see the header ──
      // A bad VALUE and a missing value are named differently, the way
      // rate_per_case_master already does it eight lines below: "Missing" sent
      // an operator hunting for an empty cell that was in fact a typo.
      const bpcRaw = cell('bottles_per_case');
      const bpc = numCell(bpcRaw);
      if (bpc === null) {
        rowErrors.push(bpcRaw
          ? `bottles_per_case "${bpcRaw}" is not a number`
          : 'Missing bottles_per_case — every landed cost divides by it');
      } else if (!(bpc > 0) || !Number.isInteger(bpc)) {
        rowErrors.push(`bottles_per_case "${bpcRaw}" must be a whole number greater than 0`);
      }

      // ── product type — hard, see the header ──
      const ptRaw = cell('product_type');
      const product_type = normProductType(ptRaw);
      if (!product_type) {
        rowErrors.push(ptRaw
          ? `product_type "${ptRaw}" is not one of ${LQ_PRODUCT_TYPES.join(' / ')}`
          : `Missing product_type — it must be one of ${LQ_PRODUCT_TYPES.join(' / ')} (it drives the beer-vs-spirit split and the uplift factors)`);
      }

      // ── numbers that degrade to a warning ──
      const rateRaw = cell('rate_per_case_master');
      const rate = numCell(rateRaw);
      if (rateRaw && rate === null) rowErrors.push(`rate_per_case_master "${rateRaw}" is not a number`);
      if (rate !== null && rate < 0) rowErrors.push('rate_per_case_master must be ≥ 0');
      // A blank or absent rate is resolved against the stored row below, like
      // the optional columns: a file that only re-sends codes and packs must
      // not wipe every master it does not mention down to ₹0.

      // ── the three OPTIONAL columns ──────────────────────────────────────
      // null here means "the file said nothing about this" — resolved against
      // the stored row below, NOT against the schema default. See the header.
      const mlRaw = cell('size_ml');
      const size_ml_supplied = numCell(mlRaw);   // null = absent column OR blank cell
      if (mlRaw && size_ml_supplied === null) rowErrors.push(`size_ml "${mlRaw}" is not a number`);
      if (size_ml_supplied !== null && size_ml_supplied < 0) rowErrors.push('size_ml must be ≥ 0');

      // boolCell answers with its DEFAULT for anything it does not recognise,
      // so a cell reading "maybe" used to reactivate a retired pack exactly as a
      // missing column did. An unreadable flag is not an instruction: say so and
      // leave the row's own is_active alone.
      const activeRaw = cell('is_active');
      let is_active_supplied: number | null = null;
      if (has('is_active') && activeRaw !== '') {
        const parsed = boolCell(activeRaw, -1);
        if (parsed === -1) {
          warnings.push({
            line: row.line,
            message: `is_active "${activeRaw}" is not yes/no — left unchanged `
              + '(a row already retired stays retired; a new row is created active).',
          });
        } else {
          is_active_supplied = parsed;
        }
      }

      // note is the ONE optional column where a blank cell in a PRESENT column
      // means "clear it" — empty is a real value for free text.
      const note_supplied = has('note') ? cell('note') : null;

      if (rowErrors.length > 0) {
        for (const message of rowErrors) errors.push({ line: row.line, message });
        continue;
      }

      // ── owner decision 4: name every fold, never fold quietly ──
      // Only on a row that will import (an excluded row stores nothing), and on
      // EVERY such row whatever its action: an 'unchanged' re-import was folded
      // just the same, and that was where a fold used to pass with no word.
      const folds = [
        spellingFold('code', cell('tgbcl_brand_code'), tgbcl_brand_code),
        spellingFold('pack code', cell('size_code'), size_code),
        spellingFold('product type', ptRaw, product_type as string),
      ].filter((f): f is SpellingFold => f !== null);
      // One line per fold up to FOLD_WARNINGS_MAX, then a single count line at
      // the end — a whole TGBCL sheet typed in lower case is still ANNOUNCED,
      // without a 6,000-line preview.
      for (const f of folds) {
        if (foldWarned < FOLD_WARNINGS_MAX) { warnings.push({ line: row.line, message: spellingFoldMessage(f) }); foldWarned++; }
        else foldOverflow++;
      }

      const existing = byKey.get(tgbcl_brand_code, size_code) as any;
      // The master rate: what the file said, else what is stored, else ₹0 on a
      // NEW row — and only that last case is warned about.
      const storedRate = existing ? Math.round((Number(existing.rate_per_case_master) || 0) * 100) / 100 : null;
      const rate2 = rate !== null
        ? Math.round(rate * 100) / 100
        : (storedRate !== null ? storedRate : 0);
      if (rate === null && !(rate2 > 0)) {
        warnings.push({ line: row.line, message: 'No rate_per_case_master — mapped with rate ₹0. Rate Movement cannot compare this pack, and it has no cost before its first indent, until a master rate is filled in' });
      }

      // RESOLVE the optional columns: what the file said, else what is stored,
      // else the documented default. An omitted column can no longer rewrite a
      // value it never mentioned.
      const size_ml = size_ml_supplied !== null
        ? size_ml_supplied : (existing ? Number(existing.size_ml) || 0 : 0);
      const is_active = is_active_supplied !== null
        ? is_active_supplied : (existing ? (Number(existing.is_active) ? 1 : 0) : 1);
      const note = note_supplied !== null
        ? note_supplied : (existing ? String(existing.note || '') : '');

      // The documented "size_ml missing" WARNING, which this route promised in
      // its header and never emitted. Only on a row that will really be stored
      // with 0: an update that kept a known size has nothing to warn about.
      if (!(size_ml > 0)) {
        warnings.push({
          line: row.line,
          message: `No size_ml for ${tgbcl_brand_code}${size_code ? '-' + size_code : ''} — stored as 0 ("unknown"). `
            + 'If this brand is ever mapped in a second pack, nothing will be able to tell the two apart '
            + 'and its landed cost goes blank.',
        });
      }
      // One real pack, two master rows — see the header.
      if (!existing && tgbcl_brand_code && material_id) {
        const siblings = (otherPacks.all(tgbcl_brand_code, material_id, size_code) as any[])
          .map(s => String(s.size_code || ''));
        if (siblings.length > 0) {
          warnings.push({
            line: row.line,
            message: `${tgbcl_brand_code} already maps "${material_name}" as pack `
              + siblings.map(s => s ? `"${s}"` : '(no pack code)').join(', ')
              + `; this ADDS pack ${size_code ? `"${size_code}"` : '(no pack code)'} for the same material. `
              + 'If they are one real pack imported twice, delete the wrong row — two packs that size_ml and '
              + 'bottles_per_case cannot tell apart make this material "which pack?" and blank its landed cost.',
          });
        }
      }

      let action: ValidRow['action'] = 'create';
      let rate_from: number | null = null;
      let material_from: string | null = null;
      let material_from_name: string | null = null;
      if (existing) {
        if (String(existing.material_id) !== material_id) {
          material_from = String(existing.material_id);
          const prev = byId.get(material_from) as any;
          material_from_name = prev ? String(prev.name) : '(deleted material)';
          warnings.push({
            line: row.line,
            message: `${tgbcl_brand_code}${size_code ? '-' + size_code : ''} MOVES from "${material_from_name}" to "${material_name}" — `
              + `"${material_from_name}" loses its TGBCL mapping and its landed cost until another row maps it.`,
          });
        }
        const same =
          String(existing.material_id) === material_id &&
          (Number(existing.size_ml) || 0) === (size_ml as number) &&
          Number(existing.bottles_per_case) === (bpc as number) &&
          Math.round((Number(existing.rate_per_case_master) || 0) * 100) / 100 === rate2 &&
          String(existing.product_type) === product_type &&
          Number(existing.is_active) === is_active &&
          String(existing.note || '') === note;
        action = same ? 'unchanged' : 'update';
        if (!same && Math.round((Number(existing.rate_per_case_master) || 0) * 100) / 100 !== rate2) {
          rate_from = Math.round((Number(existing.rate_per_case_master) || 0) * 100) / 100;
        }
      }

      valid.push({
        line: row.line, material_id, material_name,
        tgbcl_brand_code, size_code, size_ml: size_ml as number,
        bottles_per_case: bpc as number, rate_per_case_master: rate2,
        product_type: product_type as string, is_active, note,
        existing_id: existing ? String(existing.id) : '',
        action, rate_from, material_from, material_from_name,
        spelling_folds: folds,
      });
    }

    if (foldOverflow > 0) {
      warnings.push({
        message: `…and ${foldOverflow} more value${foldOverflow > 1 ? 's' : ''} stored with a different spelling from the file `
          + '(codes upper-cased, product types onto BEER / IML / Duty Paid) — counted in spelling_folds_total and in the '
          + 'import audit, which also lists the first 200 with the file\'s own spelling.',
      });
    }

    const creates = valid.filter(v => v.action === 'create').length;
    const updates = valid.filter(v => v.action === 'update').length;
    const unchangedCount = valid.filter(v => v.action === 'unchanged').length;
    const rateChanges = valid.filter(v => v.rate_from !== null);
    const materialChanges = valid.filter(v => v.material_from !== null);
    const materialChangeRows = materialChanges.map(v => ({
      line: v.line,
      code: v.tgbcl_brand_code, size_code: v.size_code,
      from_material_id: v.material_from, from_material: v.material_from_name,
      to_material_id: v.material_id, to_material: v.material_name,
    }));
    // Owner decision 4: the file's own spelling beside what is stored, per fold.
    const spellingFoldRows = valid.flatMap(v => v.spelling_folds.map(f => ({
      line: v.line, material: v.material_name,
      code: v.tgbcl_brand_code, size_code: v.size_code,
      field: f.field, typed: f.typed, stored: f.stored,
    })));

    if (!commit) {
      return Response.json({
        ok: true,
        total_rows: rows.length,
        valid: valid.length,
        creates, updates, unchanged: unchangedCount,
        errors, warnings,
        rate_changes: rateChanges.slice(0, 50).map(v => ({
          line: v.line, material: v.material_name,
          code: v.tgbcl_brand_code, size_code: v.size_code,
          from: v.rate_from, to: v.rate_per_case_master,
        })),
        rate_changes_total: rateChanges.length,
        material_changes: materialChangeRows.slice(0, 50),
        material_changes_total: materialChanges.length,
        spelling_folds: spellingFoldRows.slice(0, 50),
        spelling_folds_total: spellingFoldRows.length,
        sample: valid.slice(0, 10),
      });
    }

    // ── COMMIT ────────────────────────────────────────────────────────────
    const batchId = generateId();
    const skipped: RowIssue[] = errors.map(e => ({ line: e.line, message: e.message }));
    let created = 0, updated = 0;

    const ins = db.prepare(`
      INSERT INTO lq_brand_map
        (id, material_id, tgbcl_brand_code, size_code, size_ml, bottles_per_case,
         rate_per_case_master, product_type, is_active, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upd = db.prepare(`
      UPDATE lq_brand_map
      SET material_id = ?, size_ml = ?, bottles_per_case = ?, rate_per_case_master = ?,
          product_type = ?, is_active = ?, note = ?, updated_at = datetime('now')
      WHERE id = ?
    `);

    const run = db.transaction(() => {
      for (const v of valid) {
        if (v.action === 'unchanged') continue;
        try {
          if (v.existing_id) {
            upd.run(v.material_id, v.size_ml, v.bottles_per_case, v.rate_per_case_master,
              v.product_type, v.is_active, v.note, v.existing_id);
            updated++;
          } else {
            ins.run(generateId(), v.material_id, v.tgbcl_brand_code, v.size_code, v.size_ml,
              v.bottles_per_case, v.rate_per_case_master, v.product_type, v.is_active,
              v.note, gate.user.email);
            created++;
          }
        } catch (rowErr: any) {
          // One refused row never rolls back the rest of the file — the house
          // "forgiving CSV" rule. It is reported with its line number instead.
          console.error('brand-map import: row refused', v.line, rowErr);
          skipped.push({ line: v.line, message: `Row refused by the database (${String(rowErr?.message || '').slice(0, 120)})` });
        }
      }
      // ONE batch-level audit event — per-row events would swamp audit_events.
      // The rate movements ride inside it, capped, because they are the part an
      // admin may need to reverse.
      requireAuditedWrite(db, {
        event_type: 'liquor.brand_map.import',
        entity_type: 'lq_brand_map_import',
        entity_id: batchId,
        actor_email: gate.user.email,
        after: {
          created, updated, unchanged: unchangedCount,
          total_rows: rows.length, skipped: skipped.length,
          rate_changes_total: rateChanges.length,
          rate_changes: rateChanges.slice(0, 200).map(v => ({
            material: v.material_name, code: v.tgbcl_brand_code, size_code: v.size_code,
            from: v.rate_from, to: v.rate_per_case_master,
          })),
          // Both sides, so the audit can say which material LOST its mapping —
          // the half a bare "updated" count cannot reconstruct.
          material_changes_total: materialChanges.length,
          material_changes: materialChangeRows.slice(0, 200),
          // Owner decision 4: what the FILE typed, beside what was stored — so
          // the audit keeps the file's spelling even where the master cannot.
          spelling_folds_total: spellingFoldRows.length,
          spelling_folds: spellingFoldRows.slice(0, 200),
        },
        note: `Brand Master CSV import — ${created} added, ${updated} updated, ${unchangedCount} unchanged`
          + (spellingFoldRows.length > 0
            ? `; ${spellingFoldRows.length} spelling${spellingFoldRows.length > 1 ? 's' : ''} stored differently from the file (`
              + spellingFoldRows.slice(0, 5).map(f => `line ${f.line} ${f.field} '${f.typed}' → '${f.stored}'`).join('; ')
              + (spellingFoldRows.length > 5 ? '; …' : '') + ')'
            : '')
          + (materialChanges.length > 0
            ? `; ${materialChanges.length} mapping${materialChanges.length > 1 ? 's' : ''} MOVED to a different material (`
              + materialChangeRows.slice(0, 5).map(m => `${m.code}${m.size_code ? '-' + m.size_code : ''}: ${m.from_material} → ${m.to_material}`).join('; ')
              + (materialChanges.length > 5 ? '; …' : '') + ')'
            : ''),
      }, 'this Brand Master import');
    });
    run();

    return Response.json({
      ok: true, batch_id: batchId,
      created, updated, unchanged: unchangedCount,
      skipped,
      rate_changes_total: rateChanges.length,
      material_changes_total: materialChanges.length,
      material_changes: materialChangeRows.slice(0, 50),
      spelling_folds_total: spellingFoldRows.length,
    });
  } catch (e: any) {
    console.error('[POST /api/liquor/brand-map/import]', e);
    return Response.json({ error: String(e?.message || 'Could not import the Brand Master.') }, { status: 500 });
  }
}
