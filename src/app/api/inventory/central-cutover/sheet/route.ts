import { getDb } from '@/lib/db';
import { getOpenDraft, listCutoverSheet, istToday } from '@/lib/central-cutover';
import { requireUser, denied, blindSheetRow, cutoverError } from '../_lib/guards';
import { buildCountSheetCsv, countSheetFilename, type CountSheetRow } from '../_lib/count-sheet';

/**
 * THE COUNT SHEET — every central material a counter has to walk past.
 *
 *   GET /api/inventory/central-cutover/sheet
 *     ?format=csv        download the blind walk sheet (default: json)
 *     ?include_inert=1   also list materials with no history of any kind
 *     ?search=, ?category=   narrow the JSON list for the on-screen picker
 *
 * Any signed-in user. The CSV carries NO book quantity for anyone, admin
 * included; the JSON carries it for admins only (see blindSheetRow). Both are
 * deliberate — a counter who can see the expected number stops counting and
 * starts confirming, and on a cutover that would bake the drift in for good.
 *
 * INERT ROWS ARE OFF BY DEFAULT. Measured on this database: 952 materials, 127
 * store-mapped, so ~825 central, of which ~129 have no purchase, no requisition
 * line, no transaction and no stock — ever. Printing them invites a rushed
 * counter to give an obsolete duplicate master a balance for the first time.
 * They are reachable behind an explicit toggle, never by default.
 *
 * STORE-MAPPED (LIQUOR) MATERIALS ARE NOT ON THIS SHEET. The exclusion is by
 * CATEGORY, so a mis-filed bottle still appears — summary.store_excluded_reason
 * says so in words and the CSV banner repeats it. Say it out loud rather than
 * letting a silent omission read as a bug.
 */
export const dynamic = 'force-dynamic';

/** Bound on rows returned in ONE response. The whole central universe is ~825
 *  rows, so this is a ceiling that should never be reached, not a page size. */
const MAX_ROWS = 3000;

export async function GET(request: Request) {
  try {
    const access = await requireUser();
    if (denied(access)) return access.error;
    const db = getDb();
    const url = new URL(request.url);

    const format = (url.searchParams.get('format') || 'json').toLowerCase();
    const includeInert = url.searchParams.get('include_inert') === '1';
    const search = (url.searchParams.get('search') || '').trim().toLowerCase();
    const category = (url.searchParams.get('category') || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(MAX_ROWS, Number(url.searchParams.get('limit')) || MAX_ROWS));

    const draft = getOpenDraft(db);
    const sheet = listCutoverSheet(db, { draftBatchId: draft?.id ?? null, includeInert });

    let rows = sheet.rows;
    if (search) {
      rows = rows.filter((r) =>
        r.name.toLowerCase().includes(search) || String(r.sku || '').toLowerCase().includes(search));
    }
    if (category) rows = rows.filter((r) => String(r.category || '').toLowerCase() === category);
    // Measured against the FILTERED set, not the whole master: "1,000 of 2,400"
    // when a category filter matched 1,200 would send the operator hunting for
    // materials the filter had already excluded.
    const matched = rows.length;
    const truncated = matched > limit;
    if (truncated) rows = rows.slice(0, limit);

    if (format === 'csv') {
      // storage_location is not part of the engine's sheet row, and on this
      // database it is blank on all 952 materials — so it is fetched here and
      // the column is dropped entirely when nothing fills it (see
      // buildCountSheetCsv). One indexed-by-id lookup, bounded by the master.
      const locs = new Map<string, string>(
        (db.prepare(
          "SELECT id, COALESCE(storage_location,'') AS storage_location FROM raw_materials WHERE COALESCE(is_active,1) = 1",
        ).all() as Array<{ id: string; storage_location: string }>)
          .map((r) => [r.id, r.storage_location]),
      );

      const csvRows: CountSheetRow[] = rows.map((r) => ({
        material_id: r.material_id,
        sku: r.sku,
        name: r.name,
        category: r.category,
        // OWNER RULE: the human counts and types in the PURCHASE unit.
        count_unit: r.purchase_unit || r.unit,
        storage_location: locs.get(r.material_id) || '',
      }));

      const date = draft?.cutover_date || istToday(db);
      const csv = buildCountSheetCsv(csvRows, {
        cutoverDate: date,
        storeExcludedReason: sheet.summary.store_excluded_reason,
        // Cannot happen on today's data (~825 central rows against a 3,000
        // ceiling), but a silently short count sheet would mean materials that
        // are simply never counted — indistinguishable afterwards from ones
        // whose book was already right. So it says so in the file, not only in
        // a JSON field nobody downloads.
        warning: truncated
          ? 'INCOMPLETE SHEET — only the first ' + limit + ' of ' + matched
            + ' materials are listed. Narrow by category and download again, or the rest will never be counted.'
          : undefined,
      });
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + countSheetFilename(date) + '"',
          'Cache-Control': 'no-store',
        },
      });
    }

    return Response.json({
      rows: rows.map((r) => blindSheetRow(r, access.isAdmin)),
      returned: rows.length,
      matched,
      truncated,
      include_inert: includeInert,
      summary: access.isAdmin ? sheet.summary : { ...sheet.summary, book_value: null },
      draft_id: draft?.id ?? null,
      cutover_date: draft?.cutover_date ?? istToday(db),
      blind: !access.isAdmin,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover/sheet', e);
  }
}
