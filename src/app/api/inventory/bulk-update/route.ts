import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Bulk field editor for raw materials — ONE field, MANY explicitly-named rows.
 *
 * Why this route exists: master GST is set on only 27 of 952 materials and the
 * only rate in use is 18%, so the real job is "select these 40 items, set 18%".
 * Until now the only way to do that was Export CSV → edit in Excel → Re-upload
 * Edits, which rewrites all 952 rows from a sheet that goes stale the moment
 * anyone tags anything. This route does the same four columns on-screen,
 * transactionally, with a before-image in the audit log.
 *
 * POST /api/inventory/bulk-update
 *   { field, value, material_ids: string[], dryRun?: boolean }
 *     dryRun → { targeted, changed, skipped, skipped_ids, would_change }  (NOTHING written)
 *     apply  → { updated, changed, skipped, skipped_ids, field, value }
 *
 * ── THE FOUR WRITABLE COLUMNS, AND WHY IT CANNOT TOUCH A FIFTH ──────────────
 * `WRITES` below is a frozen map from an allowlisted field name to a COMPLETE,
 * HARDCODED UPDATE statement. The column name is never interpolated from the
 * request, there is no generic `SET ${col} = ?` anywhere in this file, and an
 * unrecognised field name is a 400 before a statement is ever prepared. So the
 * set of columns this route can write is fixed at author time:
 *     tax_percent, cess_percent, is_butchering_source, is_butchering_output
 * (+ updated_at, as every write path in this app does). average_price,
 * current_stock, last_purchase_price, unit, pack_size and every other column are
 * unreachable from here — no shared upsert helper, no SELECT-then-rewrite
 * round-trip, no spread of a request body into SQL.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 * Gated `admin || is_store_manager`, copied from
 * /api/inventory/bulk-storage-location — the most careful bulk route in this
 * family and the one closest in shape (flip a column across a set of material
 * ids). That tier is deliberately the SAME as export + round-trip-import
 * (export/route.ts, round-trip-import/route.ts), because those two already let
 * exactly this tier rewrite these same four columns on all 952 rows and
 * deactivate the whole catalog. This route therefore adds NO new privilege — it
 * adds a capped, previewable, audited path to a capability that tier already
 * holds. Note this route does NOT copy the neighbouring /api/inventory POST/PUT,
 * which have no handler-level auth at all; matching them would be a regression.
 *
 * CSRF is enforced without a proxy.ts change: '/api/inventory' is a
 * CSRF_REQUIRED_PREFIXES entry (src/proxy.ts) and the match is
 * `pathname.startsWith(p)`, so this path inherits cookie+header enforcement.
 * The handler still gates itself because both proxy session/CSRF blocks sit
 * behind `try { … } catch { /* fail open *\/ }`.
 */
export const dynamic = 'force-dynamic';

/**
 * Cap on rows per call. The entire real catalog is 952 raw materials (1,021 list
 * rows including the 69 sub-recipe pseudo-rows, which match nothing here), so
 * 2,000 is just over 2x the whole catalog: "select all" always works and still
 * will after years of growth, while a scripted or runaway call cannot walk past
 * roughly twice the catalog inside one transaction. Deliberately stricter than
 * bulk-storage-location's MAX_IDS = 5000, which also accepts a whole-CATEGORY
 * mode where the row set is bounded by data rather than by the caller.
 */
const MAX_IDS = 2000;

/** Ids echoed back in the response / audit row, so a 2,000-id call can't bloat either. */
const ID_ECHO_CAP = 200;

type FieldKey = 'tax_percent' | 'cess_percent' | 'is_butchering_source' | 'is_butchering_output';

/**
 * The complete, hardcoded write for each allowlisted field. Nothing here is
 * assembled from the request — see the header note.
 */
const WRITES: Readonly<Record<FieldKey, { sql: string; label: string; coerce: (raw: unknown) => number }>> = Object.freeze({
  tax_percent: {
    sql: `UPDATE raw_materials SET tax_percent = ?, updated_at = datetime('now') WHERE id = ?`,
    label: 'Master GST %',
    coerce: pct,
  },
  cess_percent: {
    sql: `UPDATE raw_materials SET cess_percent = ?, updated_at = datetime('now') WHERE id = ?`,
    label: 'Cess %',
    coerce: pct,
  },
  is_butchering_source: {
    sql: `UPDATE raw_materials SET is_butchering_source = ?, updated_at = datetime('now') WHERE id = ?`,
    label: 'Butchering source (carcass)',
    coerce: flag,
  },
  is_butchering_output: {
    sql: `UPDATE raw_materials SET is_butchering_output = ?, updated_at = datetime('now') WHERE id = ?`,
    label: 'Butchering output (cut)',
    coerce: flag,
  },
});

/** Reading the current value of one allowlisted field — also hardcoded per field. */
const READS: Readonly<Record<FieldKey, string>> = Object.freeze({
  tax_percent: `SELECT id, name, COALESCE(tax_percent, 0) AS v FROM raw_materials WHERE id = ?`,
  cess_percent: `SELECT id, name, COALESCE(cess_percent, 0) AS v FROM raw_materials WHERE id = ?`,
  is_butchering_source: `SELECT id, name, COALESCE(is_butchering_source, 0) AS v FROM raw_materials WHERE id = ?`,
  is_butchering_output: `SELECT id, name, COALESCE(is_butchering_output, 0) AS v FROM raw_materials WHERE id = ?`,
});

/** A percent: REFUSED outside 0..100, never clamped — a clamp turns a fat-finger
 *  180 into a silently-wrong 100 on every ticked row. Throws; caller returns 400. */
function pct(raw: unknown): number {
  // Only a number or a numeric string is a percent. Everything else is refused
  // BY TYPE rather than by Number(): Number([]) is 0 and Number([5]) is 5, so a
  // bare `typeof`-less coercion would quietly accept `value: []` as "0%" and
  // silently clear the rate on every ticked row.
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new Error('value must be a number between 0 and 100');
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new Error('value must be a number between 0 and 100');
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('value must be a number between 0 and 100');
  if (n < 0 || n > 100) throw new Error(`value must be between 0 and 100 (got ${n})`);
  // Two decimals is the most any real GST/cess rate needs (2.5%, 0.25% cess).
  // Rounding a value already inside the range cannot change the owner's intent.
  return Math.round(n * 100) / 100;
}

/** A role flag: strictly 0 or 1. Accepts a real boolean; refuses 2, '', 'yes', null. */
function flag(raw: unknown): number {
  if (raw === true || raw === 1 || raw === '1') return 1;
  if (raw === false || raw === 0 || raw === '0') return 0;
  throw new Error('value must be 0 or 1 for a butchering flag');
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && !me.is_store_manager) {
      return Response.json({ error: 'Admin / store manager only' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));

    /* ── field: allowlist, checked before any statement is prepared ───────── */
    const field = String(body?.field || '') as FieldKey;
    if (!Object.prototype.hasOwnProperty.call(WRITES, field)) {
      return Response.json({
        error: `field must be one of: ${Object.keys(WRITES).join(', ')}`,
      }, { status: 400 });
    }
    const spec = WRITES[field];

    /* ── value: refused, never clamped ───────────────────────────────────── */
    let value: number;
    try {
      value = spec.coerce(body?.value);
    } catch (e: any) {
      return Response.json({ error: e?.message || 'Invalid value' }, { status: 400 });
    }

    /* ── ids: explicit, deduped, capped ──────────────────────────────────── */
    if (!Array.isArray(body?.material_ids)) {
      return Response.json({ error: 'material_ids must be an array of material ids' }, { status: 400 });
    }
    const ids: string[] = [...new Set(
      (body.material_ids as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean),
    )];
    if (ids.length === 0) {
      return Response.json({ error: 'material_ids is empty — tick at least one item' }, { status: 400 });
    }
    // Checked BEFORE the cap so a caller that sent 3,000 ids is told the cap,
    // not silently handed the first 2,000.
    if (ids.length > MAX_IDS) {
      return Response.json({
        error: `Too many items: ${ids.length}. This route applies at most ${MAX_IDS} materials per call — narrow the filter and apply in batches.`,
        cap: MAX_IDS,
        received: ids.length,
      }, { status: 400 });
    }

    const db = getDb();
    const read = db.prepare(READS[field]);

    /* ── before-image, read with the SAME per-id WHERE the UPDATE uses, so a
       dry-run's count always equals the apply's count. Ids that match no row
       (a 'sub:' sub-recipe pseudo-row, an item deleted in another tab) are
       reported as skipped, never silently counted as success. ───────────── */
    type Row = { id: string; name: string; v: number };
    const before: Row[] = [];
    const skippedIds: string[] = [];
    for (const id of ids) {
      const row = read.get(id) as Row | undefined;
      if (row) before.push({ id: row.id, name: row.name, v: Number(row.v) });
      else skippedIds.push(id);
    }
    const changedRows = before.filter((r) => Number(r.v) !== Number(value));

    if (body?.dryRun) {
      return Response.json({
        targeted: before.length,
        changed: changedRows.length,
        skipped: skippedIds.length,
        skipped_ids: skippedIds.slice(0, ID_ECHO_CAP),
        field,
        field_label: spec.label,
        value,
        // Named rows so the confirmation can show exactly WHAT changes, not
        // just how many.
        would_change: changedRows.slice(0, ID_ECHO_CAP).map((r) => ({ id: r.id, name: r.name, from: r.v })),
      });
    }

    if (before.length === 0) {
      return Response.json({
        error: 'None of those ids is a raw material (sub-recipes cannot be tagged here)',
        skipped: skippedIds.length,
      }, { status: 400 });
    }

    /* ── ONE transaction: all rows or none. better-sqlite3 is SYNCHRONOUS —
       nothing inside here may be awaited. ────────────────────────────────── */
    const upd = db.prepare(spec.sql);
    let updated = 0;
    db.transaction(() => {
      for (const r of before) updated += upd.run(value, r.id).changes;
      logAuditEvent(db, {
        event_type: 'raw_material.bulk_field_set',
        entity_type: 'raw_material',
        entity_id: 'bulk',
        actor_email: me.email,
        // FULL before-image — a bulk apply rewrites hundreds of rows in one
        // click and there is no undo button, so the prior value of EVERY row is
        // recorded and the change is reversible from the audit log alone. Not
        // truncated: MAX_IDS caps this at 2,000 tiny {id, from} entries.
        // (logAuditEvent swallows its own failure — best-effort, not a
        // guarantee. The write above is what is transactional.)
        before: { field, previous: before.map((r) => ({ id: r.id, from: r.v })) },
        after: {
          field,
          value,
          material_id_count: ids.length,
          material_ids: ids.slice(0, ID_ECHO_CAP),
          matched: before.length,
          changed: changedRows.length,
          skipped: skippedIds.length,
        },
        note: `Bulk set ${spec.label} = ${value} on ${before.length} material(s)`
          + ` (${changedRows.length} actually changed, ${skippedIds.length} id(s) matched nothing)`,
      });
    })();

    return Response.json({
      updated,
      // Rows whose value actually DIFFERED. `updated` counts every matched row
      // because an UPDATE to the same value still bumps updated_at; reporting
      // both keeps the success message honest.
      changed: changedRows.length,
      skipped: skippedIds.length,
      skipped_ids: skippedIds.slice(0, ID_ECHO_CAP),
      field,
      field_label: spec.label,
      value,
    });
  } catch (e: any) {
    console.error('[/api/inventory/bulk-update]', e);
    return Response.json({ error: e?.message || 'Bulk update failed' }, { status: 500 });
  }
}
