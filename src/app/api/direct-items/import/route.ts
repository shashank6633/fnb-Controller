import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { parseBoolCell, parseCsv, readCsvBody } from '../_lib/csv';
import { loadMaterialIndex, loadMenuIndex, nameKey, resolveMenuItems, type MaterialRef } from '../_lib/mapping-rows';
import { writeDirectItemLink } from '../_lib/link-writer';

/**
 * POST /api/direct-items/import — bulk-apply the CSV from /api/direct-items/export.
 *
 * This is the tool the owner uses to REPAIR bad mappings, so every rule below is
 * about making a wrong write impossible rather than about convenience. On this
 * database 31 of 395 saved links share no word at all with the material they
 * point at ("JW BLONDE 30ML" → "JW RED LABEL (750ML)", "Gulab Jamun" → rose
 * water), which is precisely the damage a forgiving importer creates.
 *
 * NON-NEGOTIABLE RULES
 * ────────────────────
 *  1. SKU FIRST, THEN EXACT NAME. Never fuzzy. A near-match is how a wrong
 *     mapping gets written silently, and silent is the whole problem. If the SKU
 *     and the name in one row resolve to DIFFERENT materials, that row is an
 *     error — the file contradicts itself and guessing which half is right is
 *     exactly the guess that must not be made.
 *  2. VALIDATE EVERYTHING BEFORE WRITING ANYTHING. Two modes: `preview` (the
 *     default — reads only, returns the counts and the per-row reasons) and
 *     `apply`, which the UI sends only after the user confirms the preview.
 *  3. AN UNRESOLVABLE MATERIAL IS AN ERROR, reported with its line number, and
 *     the row is SKIPPED. It is never written as NULL: NULL would silently
 *     delete a mapping that was good, turning a typo into data loss. For the
 *     same reason a BLANK material on a row that currently HAS one is an error,
 *     not an unlink — unlinking stays a deliberate click on the page. "Currently
 *     has one" means the link the EXPORT showed, which for a good number of rows
 *     lives on menu_items.material_id and not in direct_item_links at all.
 *  4. ONE TRANSACTION. An apply either lands completely or not at all.
 *  5. ONE WRITER. Rows go through writeDirectItemLink() — the same function
 *     POST /api/direct-items uses — so bulk and single-item edits cannot drift.
 *
 * Body: multipart (`file`, `mode`) | JSON `{ csv, mode }` | raw text/csv (+ ?mode=).
 *
 * ACCESS: management only (admin / manager / HOD). A single-row edit on the page
 * is available to anyone with the page; rewriting several hundred mappings in one
 * shot is a different blast radius, so it is gated. CSRF is enforced by the proxy
 * for the whole /api/direct-items prefix.
 */
export const dynamic = 'force-dynamic';

/** 5 MB — a mapping CSV for this DB is ~120 KB. */
const MAX_BYTES = 5 * 1024 * 1024;

type Verdict = 'update' | 'unchanged' | 'error';

interface Change { field: string; from: string; to: string }

interface RowResult {
  /** 1-based line number in the uploaded file, as Excel shows it. */
  line: number;
  item_name: string;
  verdict: Verdict;
  /** No direct_item_links row exists yet — this would create one. */
  is_new: boolean;
  reason?: string;
  changes?: Change[];
  write?: { item_name: string; material_id: string | null; qty_per_unit: number; dismissed: boolean };
}

const fmtQpu = (n: number) => String(Math.round(n * 1000) / 1000);
const matLabel = (m: MaterialRef | null) => (m ? `${m.material_name}${m.sku ? ` [${m.sku}]` : ''}` : '(none)');

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) {
      return Response.json(
        { error: 'Bulk import is restricted to Admin / Manager / HOD. Single mappings can still be edited on the page.' },
        { status: 403 },
      );
    }

    const { csv, mode: bodyMode } = await readCsvBody(request);
    const urlMode = new URL(request.url).searchParams.get('mode');
    const mode = (bodyMode || urlMode || 'preview').toLowerCase() === 'apply' ? 'apply' : 'preview';

    if (!csv.trim()) return Response.json({ error: 'Empty CSV — nothing to import.' }, { status: 400 });
    if (csv.length > MAX_BYTES) {
      return Response.json({ error: `CSV too large (${Math.round(csv.length / 1024)} KB, max ${MAX_BYTES / 1024} KB).` }, { status: 413 });
    }

    const parsed = parseCsv(csv);
    if (!parsed.headers.includes('item_name')) {
      return Response.json({
        error: 'Missing required column "item_name". Download the CSV from this page first, edit it, then upload that file.',
        headers_found: parsed.headers,
      }, { status: 400 });
    }
    if (parsed.rows.length === 0) {
      return Response.json({ error: 'No data rows found under the header.' }, { status: 400 });
    }

    const db = getDb();
    const mats = loadMaterialIndex(db);

    // Current state, keyed the same way the table is (item_name COLLATE NOCASE).
    const existing = new Map<string, { material_id: string | null; qty_per_unit: number; dismissed: boolean }>();
    for (const l of db.prepare(`
      SELECT item_name, material_id, COALESCE(qty_per_unit, 1) AS qty_per_unit, COALESCE(dismissed, 0) AS dismissed
        FROM direct_item_links
    `).all() as any[]) {
      existing.set(nameKey(l.item_name), {
        material_id: l.material_id || null,
        qty_per_unit: Number(l.qty_per_unit) > 0 ? Number(l.qty_per_unit) : 1,
        dismissed: !!l.dismissed,
      });
    }

    // The OTHER half of the link the export showed. A row's material can live on
    // menu_items.material_id with no direct_item_links row at all (the export
    // marks those link_source = menu_items, has_saved_mapping = no), and
    // buildMappingRows resolves direct_item_links first and falls back to that.
    // Validation has to see the same thing: for a menu-sourced row `existing`
    // holds nothing, so the blank-material guard below could not fire, and
    // writeDirectItemLink's `UPDATE menu_items SET material_id = NULL` would wipe
    // a real mapping on the very round trip the owner was told was safe.
    const menu = loadMenuIndex(db);
    const posIdByName = new Map<string, string>();
    for (const s of db.prepare(`
      SELECT item_name, MAX(pos_item_id) AS pos_item_id
        FROM sales
       WHERE item_name IS NOT NULL AND TRIM(item_name) != '' AND TRIM(item_name) != '-'
       GROUP BY item_name
    `).all() as any[]) posIdByName.set(nameKey(s.item_name), String(s.pos_item_id || ''));
    /** Menu-sourced material for a sold item name — POS id first, then name,
     *  exactly the precedence buildMappingRows uses for the export. */
    const menuMaterialId = (itemName: string): string | null =>
      resolveMenuItems(menu, itemName, posIdByName.get(nameKey(itemName))).find(m => m.material_id)?.material_id || null;

    /* ── PASS 1: validate every row. No writes happen anywhere in here. ───── */
    const results: RowResult[] = [];
    const seen = new Map<string, number>();   // name key → first line it appeared on

    for (const { line, cells } of parsed.rows) {
      const itemName = String(cells.item_name || '').trim();
      const push = (r: Omit<RowResult, 'line' | 'item_name'>) => results.push({ line, item_name: itemName, ...r });

      if (!itemName) { push({ verdict: 'error', is_new: false, reason: 'item_name is blank' }); continue; }

      const key = nameKey(itemName);
      const dup = seen.get(key);
      if (dup !== undefined) {
        push({ verdict: 'error', is_new: false, reason: `duplicate of line ${dup} — the same item name appears twice` });
        continue;
      }
      seen.set(key, line);

      const cur = existing.get(key) || null;
      const isNew = !cur;
      // EFFECTIVE current link, direct_item_links first then menu_items — what the
      // export printed in the material cells, and therefore what a blank cell is
      // asking to erase. `cur` alone is only the direct_item_links half.
      const curMaterialId = cur?.material_id || menuMaterialId(itemName);

      // ── material: SKU first, then exact name. Never fuzzy. ──
      const sku = String(cells.material_sku || '').trim();
      const mName = String(cells.material_name || '').trim();
      let bySku: MaterialRef | null = null;
      let byName: MaterialRef | null = null;
      const problems: string[] = [];

      if (sku) {
        const id = mats.bySku.get(sku);
        bySku = id ? mats.byId.get(id) || null : null;
        if (!bySku) problems.push(`material_sku "${sku}" does not match any raw material`);
      }
      if (mName) {
        const ids = mats.byName.get(nameKey(mName)) || [];
        if (ids.length === 1) byName = mats.byId.get(ids[0]) || null;
        else if (ids.length > 1) problems.push(`material_name "${mName}" matches ${ids.length} raw materials — use material_sku to say which`);
        else problems.push(`material_name "${mName}" does not exactly match any raw material (no fuzzy matching on import)`);
      }
      if (bySku && byName && bySku.material_id !== byName.material_id) {
        push({
          verdict: 'error', is_new: isNew,
          reason: `material_sku and material_name disagree — "${sku}" is ${bySku.material_name}, but material_name says ${byName.material_name}. Fix one of them.`,
        });
        continue;
      }
      const material: MaterialRef | null = bySku || byName;

      if (!material && (sku || mName)) {
        // Something was written in the material cells and it could not be
        // resolved. Reported and skipped — never written as NULL.
        push({ verdict: 'error', is_new: isNew, reason: problems.join('; ') || 'raw material could not be resolved' });
        continue;
      }
      if (!material && curMaterialId) {
        const curMat = mats.byId.get(curMaterialId) || null;
        const via = cur?.material_id ? '' : ' through its menu item';
        push({
          verdict: 'error', is_new: isNew,
          reason: `material cells are blank but this item is currently linked to ${matLabel(curMat)}${via}. `
                + 'A blank cell will not clear a saved mapping — put the SKU back, or use Unlink on the page.',
        });
        continue;
      }

      // ── qty_per_unit ──
      const qpuCell = String(cells.qty_per_unit ?? '').trim();
      let qpu = cur?.qty_per_unit ?? 1;
      if (qpuCell !== '') {
        const n = Number(qpuCell.replace(/,/g, ''));
        if (!Number.isFinite(n) || n <= 0) {
          push({ verdict: 'error', is_new: isNew, reason: `qty_per_unit "${qpuCell}" is not a number greater than zero` });
          continue;
        }
        qpu = n;
      }

      // ── dismissed ──
      const dismissedCell = parseBoolCell(cells.dismissed);
      if (dismissedCell.kind === 'invalid') {
        push({ verdict: 'error', is_new: isNew, reason: `dismissed "${cells.dismissed}" is not yes/no` });
        continue;
      }
      const dismissed = dismissedCell.kind === 'value' ? dismissedCell.value : (cur?.dismissed ?? false);

      const targetMaterialId = material?.material_id ?? null;

      // Nothing to write: no saved row, no material, not being dismissed. This
      // is the normal state of the several hundred unmapped sold items the
      // export carries so they CAN be mapped — leaving them blank is a no-op,
      // not an error.
      if (isNew && !targetMaterialId && !dismissed) {
        push({ verdict: 'unchanged', is_new: true });
        continue;
      }

      const changes: Change[] = [];
      if ((cur?.material_id ?? null) !== targetMaterialId) {
        changes.push({
          field: 'material',
          from: matLabel(cur?.material_id ? mats.byId.get(cur.material_id) || null : null),
          to: matLabel(material),
        });
      }
      if (!cur || Math.abs((cur.qty_per_unit ?? 1) - qpu) > 1e-9) {
        changes.push({ field: 'qty_per_unit', from: cur ? fmtQpu(cur.qty_per_unit) : '(new)', to: fmtQpu(qpu) });
      }
      if ((cur?.dismissed ?? false) !== dismissed) {
        changes.push({ field: 'dismissed', from: String(cur?.dismissed ?? false), to: String(dismissed) });
      }

      if (changes.length === 0) { push({ verdict: 'unchanged', is_new: false }); continue; }

      push({
        verdict: 'update', is_new: isNew, changes,
        write: { item_name: itemName, material_id: targetMaterialId, qty_per_unit: qpu, dismissed },
      });
    }

    const updates = results.filter(r => r.verdict === 'update');
    const unchanged = results.filter(r => r.verdict === 'unchanged');
    const errors = results.filter(r => r.verdict === 'error');

    const summary = {
      total_rows: results.length,
      will_update: updates.length,
      unchanged: unchanged.length,
      errors: errors.length,
      new_mappings: updates.filter(r => r.is_new).length,
    };

    if (mode === 'preview') {
      return Response.json({
        mode: 'preview',
        ...summary,
        updates: updates.map(({ line, item_name, is_new, changes }) => ({ line, item_name, is_new, changes })),
        error_rows: errors.map(({ line, item_name, reason }) => ({ line, item_name, reason })),
        unchanged_sample: unchanged.slice(0, 20).map(r => r.item_name),
      });
    }

    /* ── PASS 2: apply. One transaction; errored rows are skipped. ────────── */
    let menuItemsUpdated = 0;
    const txn = db.transaction(() => {
      for (const r of updates) {
        if (!r.write) continue;
        menuItemsUpdated += writeDirectItemLink(db, r.write);
      }
    });
    txn();

    return Response.json({
      mode: 'apply',
      success: true,
      ...summary,
      applied: updates.length,
      skipped_errors: errors.length,
      menu_items_updated: menuItemsUpdated,
      error_rows: errors.map(({ line, item_name, reason }) => ({ line, item_name, reason })),
    });
  } catch (error: any) {
    console.error('[/api/direct-items/import] error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
