import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { lockedUnitFields } from '@/lib/unit-audit-lock';
import { packFactor } from '@/lib/pack-units';

/** raw_materials unit-of-measure fields that Unit Audit owns. */
const LOCKED_UNIT_FIELDS = new Set(['unit', 'purchase_unit', 'pack_size', 'case_size']);

/**
 * Round-trip inventory import. Designed to receive a CSV exported from
 * /api/inventory/export (possibly with edits in Excel).
 *
 * For each row:
 *   - `id` non-empty → UPDATE that raw_material (per-field merge; only
 *     fields present in the payload get written)
 *   - `id` blank     → INSERT a new raw_material (SKU auto-generated if blank)
 *
 * Body shape:
 *   {
 *     rows: Array<{ id?, sku?, name, category?, unit?, purchase_unit?,
 *                   pack_size?, case_size?, reorder_level?, costing_method?,
 *                   average_price?, super_category?, brand?, yield_percent?,
 *                   tax_percent?, cess_percent?, standard_purchase_rate?,
 *                   closing_cadence?, is_recipe_item?, is_direct_sell?,
 *                   is_semifinished?, storage_location?, shelf_life_days? }>,
 *     deactivateMissing?: boolean,   // "Remove old inventory details" option
 *   }
 *
 * When deactivateMissing=true: any active material whose id is NOT in the
 * payload gets `is_active = 0` (soft delete). We do NOT hard-delete because
 * purchases / recipes / requisitions reference these rows by FK and would
 * cascade-break.
 *
 * ── is_active (Active on/off — owner #6, ruling 78; WHO = ADMIN ONLY, owner
 *    2026-10-28) ────────────────────────────────────────────────────────────
 * The export now carries an `is_active` column (1 on / 0 off).
 *   · FILE HAS THE COLUMN → each row's cell is honoured: 1/0 (also true/false,
 *     yes/no, y/n, on/off) switches the item; a BLANK cell leaves it as it is;
 *     anything else is left as it is and reported (is_active_unreadable). The
 *     old "every kept row is forced back ON" stops for such a file — otherwise
 *     no item could ever stay switched off across a round trip.
 *   · FILE HAS NO is_active COLUMN (a sheet exported before 2026-10-28, or a
 *     hand-built one) → today's behaviour: every matched row is set ON.
 *   · ONLY AN ADMIN'S UPLOAD CHANGES is_active. For anyone else (store manager)
 *     a row that would switch an item ON or OFF — by its cell, or by the
 *     no-column "set ON" — is left exactly as it was and counted in
 *     is_active_not_applied; every other field of that row is still written.
 *     So a store manager re-uploading an old sheet cannot quietly switch back
 *     on what the admin switched off.
 *   · deactivateMissing ("Remove old inventory details", Replace mode) switches
 *     items OFF too, so it is ADMIN ONLY as well: anyone else gets a 403
 *     (code admin_only_is_active) before anything is written. Merge mode
 *     (deactivateMissing false) stays open to store managers.
 * Every switch — by a cell, by the no-column "set ON", or by Replace mode — is
 * counted in the response + summary and written to the audit log
 * (raw_material.import_active_set) with each item's before-value.
 *
 * dryRun: true → the WHOLE import runs inside its transaction and is then
 * rolled back: the same response (plus dry_run: true), nothing written, no
 * audit row. The page uses it to learn exactly which items an upload would
 * switch OFF (switched_off_ids + deactivated_ids, uncapped) and shows their
 * stock and open requisition / PO lines BEFORE the real upload (ruling 78:
 * warn before switching off).
 *
 * Admin / store manager only.
 */
export const dynamic = 'force-dynamic';

const FIELD_TYPES: Record<string, 'string' | 'number' | 'bool'> = {
  name: 'string', sku: 'string', category: 'string', unit: 'string',
  purchase_unit: 'string', pack_size: 'number', case_size: 'number',
  reorder_level: 'number', priority: 'number',
  costing_method: 'string', average_price: 'number',
  super_category: 'string', brand: 'string',
  yield_percent: 'number', tax_percent: 'number', cess_percent: 'number',
  standard_purchase_rate: 'number',
  closing_cadence: 'string', storage_location: 'string',
  shelf_life_days: 'number',
  is_recipe_item: 'bool', is_direct_sell: 'bool', is_semifinished: 'bool',
  // Butchering role flags — tagged by hand on the master / bulk editor.
  // A CSV exported BEFORE these columns existed has no such header, so `f in r`
  // is false and the field is skipped: an old sheet re-uploaded later leaves both
  // flags exactly as they were. The export blanks them when 0 (BLANK_WHEN_ZERO)
  // so a stale sheet cannot mass-untag either; typing a literal 0 still untags.
  is_butchering_source: 'bool', is_butchering_output: 'bool',
};
const WRITABLE_FIELDS = Object.keys(FIELD_TYPES);

/** Thrown to roll back the whole import when "remove missing" is on but the file
 *  matched no existing material (wrong-file guard — see the deactivation block). */
class ZeroMatchAbort extends Error {}
/** Thrown at the very end of a dryRun so the transaction rolls back EVERYTHING
 *  it did — the dry run walks the exact code path of the real import. */
class DryRunRollback extends Error {}

/**
 * The export ships display-only PURCHASE-unit twins (avg_price_per_purchase_unit,
 * reorder_level_purchase_unit) beside the writable RECIPE-basis columns. They are
 * not in WRITABLE_FIELDS on purpose — writing them back would multiply every rate
 * and buffer by pack_size on each round trip. But a manager who edits the column
 * that matches the screen gets silence, so count those rows and say so.
 *
 * Read-only: runs on the payload BEFORE the transaction and never writes.
 */
function displayOnlyColumnEdits(rows: any[]): number {
  let n = 0;
  for (const r of rows) {
    const pf = packFactor({ unit: r?.unit, purchase_unit: r?.purchase_unit, pack_size: Number(r?.pack_size) });
    if (pf <= 1) continue;   // twins equal the recipe columns — nothing to disagree about
    const pairs: [any, any, number, number][] = [
      // [twin, recipe column, twin→recipe factor, rounding slack in recipe terms]
      // The export rounds the qty twin to 3 dp and the ₹ twin to 2 dp, so an
      // UNTOUCHED sheet is already off by up to half a place — 2 ml of a 750 ml
      // bottle exports as 0.003 BTL and reads back as 2.25 ml. Without the
      // absolute slack every tiny buffer would be flagged as an edit.
      [r.reorder_level_purchase_unit, r.reorder_level, pf, 0.0006 * pf],
      [r.avg_price_per_purchase_unit, r.average_price, 1 / pf, 0.006 / pf],
    ];
    for (const [twinRaw, recipeRaw, factor, slack] of pairs) {
      if (twinRaw == null || twinRaw === '' || recipeRaw == null || recipeRaw === '') continue;
      const twin = Number(twinRaw), recipe = Number(recipeRaw);
      if (!Number.isFinite(twin) || !Number.isFinite(recipe) || recipe === 0) continue;
      const implied = twin * factor;
      if (Math.abs(implied - recipe) > Math.max(Math.abs(recipe) * 0.02, slack)) { n++; break; }
    }
  }
  return n;
}

/**
 * An is_active cell: 1 / 0, or undefined for a BLANK cell (leave it), or
 * 'unreadable' for anything else (also left as it is, but reported — a typo
 * such as "2" or "active" must not pass in silence). Deliberately NOT routed
 * through FIELD_TYPES / coerce(): the generic loop below writes every
 * WRITABLE_FIELDS column for any caller, and is_active is admin-only.
 */
function coerceActive(raw: any): 0 | 1 | undefined | 'unreadable' {
  if (raw == null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (s === '') return undefined;
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return 1;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return 0;
  return 'unreadable';
}

/** Rows echoed back per is_active list, so a 2,000-row file can't bloat the reply. */
const ACTIVE_ECHO_CAP = 200;

function coerce(field: string, raw: any): any {
  if (raw == null || raw === '') return undefined;
  const t = FIELD_TYPES[field];
  if (t === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (t === 'bool') {
    const s = String(raw).trim().toLowerCase();
    if (['1','true','yes','y'].includes(s)) return 1;
    if (['0','false','no','n'].includes(s)) return 0;
    return undefined;
  }
  return String(raw).trim();
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && !me.is_store_manager) {
      return Response.json({ error: 'Admin / store manager only' }, { status: 403 });
    }
    const db = getDb();
    const body = await request.json();
    const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
    const deactivateMissing: boolean = !!body?.deactivateMissing;
    const dryRun: boolean = body?.dryRun === true;
    if (rows.length === 0) {
      return Response.json({ error: 'rows array required' }, { status: 400 });
    }
    // Replace mode switches items OFF, and WHO may switch a raw material on or
    // off is ADMIN ONLY (owner, 2026-10-28). Refused before anything is written,
    // dry run included, so a store manager's Replace upload changes nothing.
    if (deactivateMissing && me.role !== 'admin') {
      return Response.json({
        error: '"Remove old inventory details" switches items OFF — only an admin can switch raw '
          + 'materials on or off. Nothing was changed. Upload again without it (Merge mode) to apply '
          + 'your edits, or ask an admin.',
        code: 'admin_only_is_active',
      }, { status: 403 });
    }

    // Read-only pre-scan (no DB, no writes): did anyone edit the display-only
    // purchase-unit twins instead of the writable recipe-basis columns?
    const displayOnlyEdits = displayOnlyColumnEdits(rows);

    const created: any[] = [];
    const updated: any[] = [];
    const skipped: any[] = [];
    const seenIds = new Set<string>();
    let deactivated = 0;
    /** Replace mode's switch-offs ("not in file"), for the audit row + reply. */
    const deactivatedItems: { id: string; name: string }[] = [];

    // is_active — see the header. The column is judged per FILE: Papa.parse
    // (header: true) gives every row every header key, so one row carrying the
    // key means the sheet has the column.
    const isAdmin = me.role === 'admin';
    const fileHasActive = rows.some((r) => r != null && typeof r === 'object'
      && Object.prototype.hasOwnProperty.call(r, 'is_active'));
    type ActiveRow = { row: number; id: string; name: string; from: 0 | 1 | null; to: 0 | 1 };
    const switchedOn: ActiveRow[] = [];
    const switchedOff: ActiveRow[] = [];          // includes items CREATED switched off (from: null)
    const activeNotApplied: (ActiveRow & { reason: string })[] = [];
    const activeUnreadable: { row: number; name: string; value: string }[] = [];

    // Pre-flight: detect duplicate SKUs within the uploaded file BEFORE writing
    // anything. Better to fail the whole import than to half-apply with conflicts.
    const skuSeen = new Map<string, number>(); // sku → first row index
    const fileDupes: { row: number; sku: string; conflicts_with_row: number }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const s = String(rows[i].sku || '').trim().toLowerCase();
      if (!s) continue;
      if (skuSeen.has(s)) {
        fileDupes.push({ row: i + 1, sku: s, conflicts_with_row: (skuSeen.get(s) || 0) + 1 });
      } else {
        skuSeen.set(s, i);
      }
    }
    if (fileDupes.length > 0) {
      return Response.json({
        error: `Aborted — ${fileDupes.length} duplicate SKU${fileDupes.length === 1 ? '' : 's'} within the file. Fix and re-upload.`,
        duplicate_skus_in_file: fileDupes,
      }, { status: 400 });
    }

    const txn = db.transaction(() => {
      for (let idx = 0; idx < rows.length; idx++) {
        const r = rows[idx];
        const name = String(r.name || '').trim();
        if (!name) { skipped.push({ row: idx + 1, reason: 'name is empty' }); continue; }

        // Priority stars are strictly 1-3 (3★ critical / 2★ standard / 1★ low).
        // A wrong value (e.g. 5) rejects the ROW so Excel typos never silently
        // land as bogus star levels. Blank = leave existing / default 2.
        if (r.priority != null && String(r.priority).trim() !== '') {
          const p = Number(r.priority);
          if (!Number.isInteger(p) || p < 1 || p > 3) {
            skipped.push({ row: idx + 1, name, reason: `priority must be 1, 2 or 3 (got "${r.priority}")` });
            continue;
          }
        }

        const id = String(r.id || '').trim();
        const newSku = String(r.sku || '').trim();

        // Resolve the target material: match by id FIRST, then fall back to SKU.
        // This lets a spreadsheet keyed by SKU (blank/stale id column) still
        // update the correct existing row instead of skipping it. No id and no
        // SKU match → create a new material (names are NOT used to match, since
        // they aren't unique). Owner-confirmed 2026-07-24.
        let existing: any = null;
        if (id) existing = db.prepare(`SELECT id, sku, name, COALESCE(is_active, 1) AS is_active FROM raw_materials WHERE id = ?`).get(id) as any;
        if (!existing && newSku) existing = db.prepare(`SELECT id, sku, name, COALESCE(is_active, 1) AS is_active FROM raw_materials WHERE LOWER(sku) = LOWER(?)`).get(newSku) as any;

        // This row's is_active cell (only when the file has the column).
        let cellActive: 0 | 1 | undefined = undefined;
        if (fileHasActive) {
          const c = coerceActive(r.is_active);
          if (c === 'unreadable') activeUnreadable.push({ row: idx + 1, name, value: String(r.is_active) });
          else cellActive = c;
        }

        if (existing) {
          seenIds.add(existing.id);
          // SKU-rename conflict guard: changing this row's SKU to one already
          // held by a DIFFERENT material is rejected (SKUs must stay unique).
          if (newSku && newSku.toLowerCase() !== String(existing.sku || '').toLowerCase()) {
            const dup = db.prepare(`SELECT id FROM raw_materials WHERE LOWER(sku) = LOWER(?) AND id != ?`).get(newSku, existing.id) as any;
            if (dup) {
              skipped.push({ row: idx + 1, name, reason: `SKU "${newSku}" already used by another material (id=${dup.id})` });
              continue;
            }
          }
          // Unit Audit owns the unit-of-measure fields: if this material is
          // locked, a round-tripped CSV can NEVER overwrite its units (that was
          // a top reverter). Skip those fields for locked rows.
          const lock = lockedUnitFields(db, { sku: existing.sku, name: existing.name });
          let unitsSkipped = false;
          // Build dynamic UPDATE from present fields
          const sets: string[] = [];
          const params: any[] = [];
          for (const f of WRITABLE_FIELDS) {
            if (!(f in r)) continue;
            if (lock && LOCKED_UNIT_FIELDS.has(f)) { unitsSkipped = true; continue; }
            const v = coerce(f, r[f]);
            if (v === undefined) continue;
            sets.push(`${f} = ?`); params.push(v);
          }
          // is_active. File WITHOUT the column → today's rule: a kept row is set
          // ON. File WITH it → the cell decides (blank = leave). Either way only
          // an admin's upload may actually change it (see the header).
          const storedActive: 0 | 1 = Number(existing.is_active) === 0 ? 0 : 1;
          const wantActive: 0 | 1 | undefined = fileHasActive ? cellActive : 1;
          if (wantActive !== undefined && wantActive !== storedActive) {
            const entry: ActiveRow = { row: idx + 1, id: String(existing.id), name, from: storedActive, to: wantActive };
            if (isAdmin) {
              sets.push(`is_active = ?`); params.push(wantActive);
              (wantActive === 1 ? switchedOn : switchedOff).push(entry);
            } else {
              activeNotApplied.push({
                ...entry,
                reason: fileHasActive
                  ? `is_active ${wantActive} not applied — only an admin can switch raw materials on or off`
                  : 'left switched off — only an admin can switch raw materials back on (this file has no is_active column)',
              });
            }
          }
          sets.push(`updated_at = datetime('now')`);
          db.prepare(`UPDATE raw_materials SET ${sets.join(', ')} WHERE id = ?`).run(...params, existing.id);
          updated.push({ id: existing.id, name });
        } else {
          // Insert path
          const newId = generateId();
          // Auto-generate SKU if blank
          let sku = String(r.sku || '').trim();
          if (!sku) {
            const last = db.prepare(`SELECT sku FROM raw_materials WHERE sku LIKE 'MAT-%' AND sku GLOB 'MAT-[0-9]*' ORDER BY sku DESC LIMIT 1`).get() as any;
            const n = last?.sku ? parseInt(last.sku.split('-')[1], 10) : 0;
            sku = `MAT-${String(n + 1).padStart(5, '0')}`;
          }
          // Recover units from the unit-audit lock (source of truth) if this
          // name/SKU was audited before — a re-import restores curated units.
          const insLock = lockedUnitFields(db, { sku, name });
          // A new item starts ON (the column default, and today's behaviour).
          // Only an admin's file may create one already switched off.
          let newActive: 0 | 1 = 1;
          if (cellActive === 0) {
            if (isAdmin) newActive = 0;
            else activeNotApplied.push({
              row: idx + 1, id: '', name, from: null, to: 0,
              reason: 'created switched ON — only an admin can create an item switched off',
            });
          }
          db.prepare(`
            INSERT INTO raw_materials (id, sku, name, category, unit, purchase_unit, pack_size, case_size,
              reorder_level, priority, costing_method, average_price, super_category, brand,
              yield_percent, tax_percent, cess_percent, standard_purchase_rate,
              closing_cadence, is_recipe_item, is_direct_sell, is_semifinished,
              is_butchering_source, is_butchering_output,
              storage_location, shelf_life_days, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, datetime('now'), datetime('now'))
          `).run(
            newId, sku, name,
            coerce('category', r.category) ?? 'other',
            insLock?.unit ?? coerce('unit', r.unit) ?? 'kg',
            insLock?.purchase_unit ?? coerce('purchase_unit', r.purchase_unit) ?? 'kg',
            insLock?.pack_size ?? coerce('pack_size', r.pack_size) ?? 1,
            insLock?.case_size ?? coerce('case_size', r.case_size) ?? 1,
            coerce('reorder_level', r.reorder_level) ?? 0,
            coerce('priority', r.priority) ?? 2,
            coerce('costing_method', r.costing_method) ?? 'average',
            coerce('average_price', r.average_price) ?? 0,
            coerce('super_category', r.super_category) ?? '',
            coerce('brand', r.brand) ?? '',
            coerce('yield_percent', r.yield_percent) ?? 100,
            coerce('tax_percent', r.tax_percent) ?? 0,
            coerce('cess_percent', r.cess_percent) ?? 0,
            coerce('standard_purchase_rate', r.standard_purchase_rate) ?? 0,
            coerce('closing_cadence', r.closing_cadence) ?? 'none',
            coerce('is_recipe_item', r.is_recipe_item) ?? 0,
            coerce('is_direct_sell', r.is_direct_sell) ?? 0,
            coerce('is_semifinished', r.is_semifinished) ?? 0,
            // Positional INSERT — these two must stay in step with the column list
            // above. A COUNT mismatch throws loudly; a WRONG ORDER at the right
            // count corrupts silently, so keep them adjacent to their names.
            coerce('is_butchering_source', r.is_butchering_source) ?? 0,
            coerce('is_butchering_output', r.is_butchering_output) ?? 0,
            coerce('storage_location', r.storage_location) ?? '',
            coerce('shelf_life_days', r.shelf_life_days) ?? 0,
            // is_active — last positional value, right after shelf_life_days,
            // matching the column list above.
            newActive,
          );
          seenIds.add(newId);
          created.push({ id: newId, sku, name });
          if (newActive === 0) switchedOff.push({ row: idx + 1, id: newId, name, from: null, to: 0 });
        }
      }

      // "Remove old inventory details": treat the file as the AUTHORITATIVE
      // catalog and deactivate anything not in it. SAFETY: only do this when the
      // file actually MATCHED existing materials (updated > 0). A file that
      // matched ZERO existing rows is almost certainly the wrong file (bad
      // headers / stale ids / mismatched SKUs) — and because the SKU-fallback
      // path would "else create", such a file would otherwise inject new rows
      // AND wipe the real catalog. So we ABORT the whole import: throw → the
      // surrounding transaction rolls back every insert/update too, changing
      // nothing. This is the guard for the "Deactivated 1067 not in file"
      // incident. Owner-confirmed 2026-07-24 ("abort only if 0 applied" — where
      // "applied" means matched an existing material, NOT a brand-new create).
      if (deactivateMissing && updated.length === 0) {
        throw new ZeroMatchAbort();
      }
      if (deactivateMissing) {
        // Admin only — a non-admin's Replace upload was refused at the top.
        const active = db.prepare(`SELECT id, name FROM raw_materials WHERE is_active = 1`).all() as any[];
        const upd = db.prepare(`UPDATE raw_materials SET is_active = 0, updated_at = datetime('now') WHERE id = ?`);
        for (const a of active) {
          if (!seenIds.has(a.id)) {
            upd.run(a.id); deactivated++;
            deactivatedItems.push({ id: String(a.id), name: String(a.name || '') });
          }
        }
      }

      // A dry run stops HERE: everything above is rolled back, and no audit row
      // is written for switches that never happened.
      if (dryRun) throw new DryRunRollback();

      // History of every on/off this file made (admin only — nobody else's
      // file switches anything). Inside the transaction, so it exists exactly
      // when the switches do. Full before-image: reversible from the log alone.
      // Replace mode's "not in file" switch-offs are switches too (from: 1).
      if (switchedOn.length + switchedOff.length + deactivatedItems.length > 0) {
        logAuditEvent(db, {
          event_type: 'raw_material.import_active_set',
          entity_type: 'raw_material',
          entity_id: 'bulk',
          actor_email: me.email,
          before: {
            previous: [
              ...[...switchedOn, ...switchedOff].map((x) => ({ id: x.id, from: x.from })),
              ...deactivatedItems.map((x) => ({ id: x.id, from: 1 })),
            ],
          },
          after: {
            switched_on: switchedOn.map((x) => x.id),
            switched_off: switchedOff.map((x) => x.id),
            ...(deactivateMissing ? { deactivated_not_in_file: deactivatedItems.map((x) => x.id) } : {}),
          },
          note: `Round-trip import: switched ON ${switchedOn.length}, switched OFF ${switchedOff.length}`
            + (fileHasActive ? ' (is_active column)' : ' (file without is_active column: matched rows set ON)')
            + (deactivateMissing ? `; Remove old inventory details switched OFF ${deactivatedItems.length} not in file` : ''),
        });
      }
    });

    let abortedZeroMatch = false;
    let dryRunDone = false;
    try {
      txn();
    } catch (e: any) {
      if (e instanceof ZeroMatchAbort) abortedZeroMatch = true;
      else if (e instanceof DryRunRollback) dryRunDone = true;
      else throw e;
    }

    const first_skips = () => skipped.slice(0, 8).map((s: any) =>
      `row ${s.row}${s.name ? ` (${s.name})` : ''}: ${s.reason}`);

    // "Remove old inventory details" was on but the file matched NO existing
    // material → the whole import rolled back (nothing created/updated/deactivated).
    if (abortedZeroMatch) {
      return Response.json({
        created: [], updated: [], skipped, deactivated: 0,
        ...(dryRun ? { dry_run: true } : {}),
        aborted: true, deactivation_skipped: true, first_skips: first_skips(),
        summary: `⚠ Aborted — "Remove old inventory details" was on, but the file matched 0 of your `
          + `existing materials, so NOTHING was changed (no items created, edited, or deactivated). `
          + `This usually means the wrong file or a mismatched "sku"/"id" column. Fix the file, or `
          + `untick "Remove old inventory details" to add/update without removing anything.`,
      });
    }

    // Nothing matched and nothing created — a harmless no-op, but surface WHY.
    if (created.length + updated.length === 0) {
      return Response.json({
        created, updated, skipped, deactivated: 0, first_skips: first_skips(),
        ...(dryRun ? { dry_run: true } : {}),
        summary: `⚠ Nothing changed — 0 rows matched or created. `
          + `Check that your file's "sku" (or "id") column matches and "name" is filled.`,
      });
    }

    // Proceed, but warn when a non-deactivate upload matched no existing rows and
    // only created — a common sign of a mismatched SKU column making duplicates.
    const createOnlyWarning = (!deactivateMissing && updated.length === 0 && created.length > 0)
      ? ` · ⚠ 0 existing matched — ${created.length} NEW item(s) created; if you meant to EDIT existing `
        + `items, fix your "sku" column and remove the duplicates.`
      : ``;

    const displayOnlyWarning = displayOnlyEdits > 0
      ? ` · ⚠ ${displayOnlyEdits} row(s) had edits in the display-only purchase-unit columns `
        + `(avg_price_per_purchase_unit / reorder_level_purchase_unit) — those columns are IGNORED on `
        + `import. Edit "average_price" (₹ per recipe unit) and "reorder_level" (recipe units) instead.`
      : ``;

    // is_active, said out loud: what the file switched, what it was not allowed
    // to switch, and what it could not read. Each piece only when non-zero, so
    // an upload that touches no on/off reads exactly as before.
    const createdOff = switchedOff.filter((x) => x.from === null).length;
    const activeSummary =
      (switchedOn.length > 0 ? ` · Switched ON ${switchedOn.length}` : '')
      + (switchedOff.length > 0
        ? ` · Switched OFF ${switchedOff.length}${createdOff > 0 ? ` (${createdOff} of them new items created switched off)` : ''}`
        : '')
      + (activeNotApplied.length > 0
        ? ` · ⚠ ${activeNotApplied.length} row(s) would have switched an item on or off — left as they were: `
          + `only an admin can switch raw materials on or off (every other column of those rows was applied)`
        : '')
      + (activeUnreadable.length > 0
        ? ` · ⚠ ${activeUnreadable.length} row(s) had an is_active value that is not 1 or 0 — left as they were`
        : '');

    return Response.json({
      created, updated, skipped, deactivated,
      display_only_edits: displayOnlyEdits,
      // ── is_active (additive) ──
      is_active_column: fileHasActive,
      switched_on: switchedOn.length,
      switched_off: switchedOff.length,
      switched_on_items: switchedOn.slice(0, ACTIVE_ECHO_CAP),
      switched_off_items: switchedOff.slice(0, ACTIVE_ECHO_CAP),
      is_active_not_applied: activeNotApplied.length,
      is_active_not_applied_rows: activeNotApplied.slice(0, ACTIVE_ECHO_CAP),
      is_active_unreadable: activeUnreadable.length,
      is_active_unreadable_rows: activeUnreadable.slice(0, ACTIVE_ECHO_CAP),
      // Replace mode's "not in file" switch-offs (additive). Names capped; ids
      // NOT capped, so the page can warn about every one of them (ruling 78).
      deactivated_items: deactivatedItems.slice(0, ACTIVE_ECHO_CAP),
      deactivated_ids: deactivatedItems.map((x) => x.id),
      // EXISTING items this upload switches OFF by their is_active cell (an item
      // created switched off has no stock or documents to warn about). Uncapped.
      switched_off_ids: switchedOff.filter((x) => x.from !== null).map((x) => x.id),
      ...(dryRunDone ? { dry_run: true } : {}),
      summary: (dryRunDone ? 'Dry run — nothing was written. Would be: ' : '')
               + `Updated ${updated.length} · Created ${created.length} · Skipped ${skipped.length}` +
               (deactivateMissing ? ` · Deactivated ${deactivated} not in file` : '') + activeSummary
               + createOnlyWarning + displayOnlyWarning,
    });
  } catch (e: any) {
    console.error('[/api/inventory/round-trip-import]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
