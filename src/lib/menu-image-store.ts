/**
 * THE DISH-PHOTO BLOB STORE — what is in use, what is reclaimable, and the one
 * function allowed to delete anything.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `menu_item_images` rows are immutable and are never rewritten: replacing an
 * item's photo INSERTs a new row and repoints `menu_items.image_url` at the new
 * id. So superseded rows accumulate, and something has to be able to reclaim
 * them. The first attempt did that on the upload path with one SQL statement
 * that compared the canonical URL string exactly:
 *
 *     DELETE FROM menu_item_images
 *      WHERE created_at < datetime('now','-1 day')
 *        AND ('/api/customer/menu-image/' || id) NOT IN (SELECT image_url ...)
 *
 * Executed against a copy of the live database, that destroyed three of four
 * blobs whose menu items were pointing at them through spellings that load
 * perfectly in a browser (absolute URL, stray spaces, a `?v=2` suffix). The
 * photos vanished from the guest menu days later, with no warning and no undo.
 *
 * Two things were wrong, and both are fixed here.
 *
 * ── 1. THE REFERENCE TEST IS NOW ABOUT THE BLOB ID, NOT THE URL TEXT ────────
 * Every stored spelling is resolved through src/lib/menu-image-url.ts — the
 * same module the serving route resolves a REQUEST with — so "is this blob
 * still in use" and "does this URL still work" are answered by one parser and
 * cannot drift apart.
 *
 * And the search is EXHAUSTIVE rather than a list of columns someone has to
 * remember to update. `collectReferencedIds` walks EVERY text column of EVERY
 * table (1,856 columns across 191 tables on the live database — 53 ms) looking
 * for the marker. A blob is only ever deleted if its id appears NOWHERE in the
 * database. That covers `menu_items.image_url`, the sibling `recipes.image_url`
 * and the task module's `image_url` columns, a knowledge-test question that
 * carries its image inside a JSON payload, a note somebody pasted a link into,
 * and any column a future feature adds without knowing this file exists.
 *
 * ── 2. DELETION IS NO LONGER A SIDE EFFECT OF AN UNRELATED WRITE ────────────
 * Nothing in the upload path deletes any more. Reclaiming space is an explicit
 * admin action (Menu Items → "Photo storage"), and it is preceded by a dry-run
 * report of exactly which rows would go. A destructive sweep bolted onto every
 * upload meant one bad match cost real data with nobody watching; the same bad
 * match now shows up in a preview an admin has to read and confirm.
 *
 * Two independent guards remain on top of that:
 *   · the GRACE WINDOW — a row younger than ORPHAN_GRACE_DAYS is never touched,
 *     because a photo that has been uploaded but not yet saved onto its item is
 *     unreferenced BY DEFINITION until the admin presses Save;
 *   · the SWEEP RE-CHECKS EVERYTHING INSIDE ITS OWN TRANSACTION, so a photo
 *     attached to an item between the preview and the confirm is safe.
 */
import { getDb, logAuditEvent } from '@/lib/db';
import { menuImageIdFromUrl, menuImageIdsInText } from '@/lib/menu-image-url';

type Db = ReturnType<typeof getDb>;

/**
 * How old an unreferenced row must be before it may be swept.
 *
 * Seven days, not one. The window's whole job is to cover the gap between "the
 * bytes are stored" and "an item points at them" — an admin who uploads a
 * photo, gets pulled onto the floor, and comes back to the open form tomorrow.
 * A week costs a handful of 80 KB rows and removes the only scenario in which
 * a correct sweep could still delete a photo someone wanted.
 */
export const ORPHAN_GRACE_DAYS = 7;

/** Columns whose declared type means they cannot hold a URL. */
const NON_TEXT_TYPE = /BLOB|INT|REAL|NUM|DOUB|FLOA|BOOL|DATE/i;

/** Case-insensitive salvage pass — see collectReferencedIds. */
const LOOSE_MARKER = /\/api\/customer\/menu-image\/([^/?#"'<>\\\s,;)\]}]+)/gi;

/**
 * The SQL prefilter. WIDER than MENU_IMAGE_PATH on purpose: a double-slashed
 * spelling ('/api/customer//menu-image/<id>') fails an exact-path LIKE, so the
 * row would never even reach the parsers that now understand it (Next.js 308s
 * that spelling to the canonical path and serves the image — it IS live).
 * 'menu-image' is the marker's one distinctive token; anything a spelling can
 * do to the slashes around it leaves it intact. A wider net only adds rows for
 * the parsers to read — every id they extract only ever KEEPS a blob.
 */
const MARKER_LIKE = '%menu-image%';

const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export interface ReferenceScan {
  /** Every blob id mentioned anywhere in the database. */
  ids: Set<string>;
  /** How many text columns were actually read. */
  columnsScanned: number;
  /** table.column → how many values mentioned a menu image. Diagnostics only. */
  foundIn: Record<string, number>;
  /**
   * Tables/columns that could NOT be read. NON-EMPTY MEANS DO NOT DELETE: a
   * column we failed to scan is a column that might hold the only reference to
   * a photo, and there is no way to tell the difference afterwards.
   */
  errors: string[];
}

/**
 * Every menu-image id referenced anywhere in the database.
 *
 * The SQL only narrows the rows worth parsing (`LIKE '%<marker>%'`, which SQLite
 * applies case-insensitively for ASCII); the actual id extraction is done in
 * TypeScript by the shared parser, so the answer matches what the serving route
 * would do with the same text.
 *
 * `menu_item_images` itself is skipped: its `item_id` is provenance, not a
 * reference, and its `data` BLOB would otherwise be dragged through a LIKE.
 */
export function collectReferencedIds(db: Db): ReferenceScan {
  const ids = new Set<string>();
  const foundIn: Record<string, number> = {};
  const errors: string[] = [];
  let columnsScanned = 0;

  let tables: { name: string }[] = [];
  try {
    tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as { name: string }[];
  } catch (e) {
    errors.push(`sqlite_master: ${(e as Error).message}`);
    return { ids, columnsScanned, foundIn, errors };
  }

  for (const { name: table } of tables) {
    if (table === 'menu_item_images') continue;
    let cols: { name: string; type: string }[] = [];
    try {
      cols = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string; type: string }[];
    } catch (e) {
      errors.push(`${table}: ${(e as Error).message}`);
      continue;
    }
    const textCols = cols.filter(c => !NON_TEXT_TYPE.test(c.type || ''));
    if (!textCols.length) continue;

    const select = textCols.map(c => quote(c.name)).join(', ');
    const where = textCols.map(c => `${quote(c.name)} LIKE ?`).join(' OR ');
    let rows: Record<string, unknown>[] = [];
    try {
      rows = db.prepare(`SELECT ${select} FROM ${quote(table)} WHERE ${where}`)
        .all(...textCols.map(() => MARKER_LIKE)) as Record<string, unknown>[];
      columnsScanned += textCols.length;
    } catch (e) {
      // A virtual/FTS table or a dropped-mid-scan table lands here. Recorded,
      // never swallowed — errors[] is what stops the sweep from running blind.
      errors.push(`${table}: ${(e as Error).message}`);
      continue;
    }

    for (const row of rows) {
      for (const c of textCols) {
        const v = row[c.name];
        if (typeof v !== 'string' || !v) continue;
        const before = ids.size;
        // Three passes, widest wins. Every extra id here only ever KEEPS a row.
        const one = menuImageIdFromUrl(v);        // the value is itself a URL
        if (one) ids.add(one);
        for (const id of menuImageIdsInText(v)) ids.add(id);   // ids embedded in JSON/prose
        LOOSE_MARKER.lastIndex = 0;                            // odd-cased spellings
        for (const m of v.matchAll(LOOSE_MARKER)) {
          const raw = m[1];
          if (!raw) continue;
          ids.add(raw.trim());
          try { ids.add(decodeURIComponent(raw).trim()); } catch { /* raw already added */ }
        }
        if (ids.size !== before || one) {
          const key = `${table}.${c.name}`;
          foundIn[key] = (foundIn[key] || 0) + 1;
        }
      }
    }
  }

  ids.delete('');
  return { ids, columnsScanned, foundIn, errors };
}

export interface OrphanRow {
  id: string;
  size: number;
  created_at: string;
  created_by: string;
  item_id: string | null;
  age_days: number;
}

export interface OrphanReport {
  grace_days: number;
  /** Every row in the table. */
  total: { count: number; bytes: number };
  /** Rows something still points at — never touched. */
  in_use: { count: number; bytes: number };
  /** Unreferenced but still inside the grace window — not yet eligible. */
  recent: { count: number; bytes: number };
  /** Unreferenced AND past the grace window — what a sweep would delete. */
  reclaimable: { count: number; bytes: number; rows: OrphanRow[] };
  /** Diagnostics from the reference scan. */
  scan: { columns_scanned: number; found_in: Record<string, number>; errors: string[] };
  /** false when the scan was incomplete — the sweep refuses in that state. */
  safe_to_sweep: boolean;
}

/** At most this many rows are listed individually; the counts stay exact. */
const MAX_LISTED = 500;

/**
 * DRY RUN. Reads only — this function can never delete anything, which is what
 * makes it safe to call from a plain GET.
 */
export function reportMenuImageOrphans(db: Db = getDb()): OrphanReport {
  const scan = collectReferencedIds(db);

  const rows = db.prepare(`
    SELECT id,
           COALESCE(length(data), size, 0) AS size,
           COALESCE(created_at, '')        AS created_at,
           COALESCE(created_by, '')        AS created_by,
           item_id,
           CAST((julianday('now') - julianday(created_at)) AS REAL) AS age_days
      FROM menu_item_images
     ORDER BY created_at DESC
  `).all() as (OrphanRow & { age_days: number | null })[];

  const total = { count: 0, bytes: 0 };
  const inUse = { count: 0, bytes: 0 };
  const recent = { count: 0, bytes: 0 };
  const reclaimable = { count: 0, bytes: 0, rows: [] as OrphanRow[] };

  for (const r of rows) {
    const size = Number(r.size) || 0;
    total.count++; total.bytes += size;
    if (scan.ids.has(r.id)) { inUse.count++; inUse.bytes += size; continue; }
    // A NULL/unparseable created_at yields a null age. Treat it as YOUNG: an
    // unreadable timestamp is not evidence that a row is disposable.
    const age = typeof r.age_days === 'number' && Number.isFinite(r.age_days) ? r.age_days : 0;
    if (age < ORPHAN_GRACE_DAYS) { recent.count++; recent.bytes += size; continue; }
    reclaimable.count++; reclaimable.bytes += size;
    if (reclaimable.rows.length < MAX_LISTED) {
      reclaimable.rows.push({
        id: r.id, size, created_at: r.created_at, created_by: r.created_by,
        item_id: r.item_id ?? null, age_days: Math.floor(age),
      });
    }
  }

  return {
    grace_days: ORPHAN_GRACE_DAYS,
    total, in_use: inUse, recent, reclaimable,
    scan: { columns_scanned: scan.columnsScanned, found_in: scan.foundIn, errors: scan.errors },
    safe_to_sweep: scan.errors.length === 0,
  };
}

export interface SweepResult {
  deleted: { id: string; size: number }[];
  bytes: number;
  /** Ids the caller asked for that were NOT deleted, and why. */
  skipped: { id: string; reason: 'in_use' | 'too_new' | 'missing' }[];
  grace_days: number;
}

/**
 * THE ONLY DELETE. Explicit, admin-driven, and re-verified from scratch inside
 * one transaction — the report the admin read is a preview, never the authority.
 *
 * `ids` narrows the sweep to exactly the rows the admin was shown; omitting it
 * sweeps everything currently eligible. Either way a row is deleted only if it
 * is STILL unreferenced and STILL past the grace window at commit time, so a
 * photo saved onto an item while the modal was open survives.
 *
 * Throws rather than deleting a subset if the reference scan is incomplete.
 */
export function sweepMenuImageOrphans(
  opts: { ids?: string[]; actorEmail?: string } = {},
  db: Db = getDb(),
): SweepResult {
  const wanted = opts.ids && opts.ids.length ? new Set(opts.ids.map(s => String(s).trim()).filter(Boolean)) : null;

  const run = db.transaction((): SweepResult => {
    const scan = collectReferencedIds(db);
    if (scan.errors.length) {
      throw new Error(
        `Could not read every column, so no photo can be safely deleted: ${scan.errors.slice(0, 3).join('; ')}`,
      );
    }

    const rows = db.prepare(`
      SELECT id,
             COALESCE(length(data), size, 0) AS size,
             CAST((julianday('now') - julianday(created_at)) AS REAL) AS age_days
        FROM menu_item_images
    `).all() as { id: string; size: number; age_days: number | null }[];

    const byId = new Map(rows.map(r => [r.id, r]));
    const deleted: { id: string; size: number }[] = [];
    const skipped: SweepResult['skipped'] = [];

    if (wanted) {
      for (const id of wanted) if (!byId.has(id)) skipped.push({ id, reason: 'missing' });
    }

    const del = db.prepare(`DELETE FROM menu_item_images WHERE id = ?`);
    let bytes = 0;
    for (const r of rows) {
      if (wanted && !wanted.has(r.id)) continue;
      if (scan.ids.has(r.id)) { if (wanted) skipped.push({ id: r.id, reason: 'in_use' }); continue; }
      const age = typeof r.age_days === 'number' && Number.isFinite(r.age_days) ? r.age_days : 0;
      if (age < ORPHAN_GRACE_DAYS) { if (wanted) skipped.push({ id: r.id, reason: 'too_new' }); continue; }
      del.run(r.id);
      deleted.push({ id: r.id, size: Number(r.size) || 0 });
      bytes += Number(r.size) || 0;
    }

    if (deleted.length) {
      // Deleting a BLOB is irreversible short of restoring a backup, so the
      // audit trail records exactly which ids went and who asked.
      logAuditEvent(db, {
        event_type: 'menu_image.sweep',
        entity_type: 'menu_item_images',
        entity_id: '',
        actor_email: opts.actorEmail || '',
        after: { ids: deleted.map(d => d.id), bytes, grace_days: ORPHAN_GRACE_DAYS },
        note: `Reclaimed ${deleted.length} unused dish photo(s), ${bytes} bytes`,
      });
    }

    return { deleted, bytes, skipped, grace_days: ORPHAN_GRACE_DAYS };
  });

  return run();
}
