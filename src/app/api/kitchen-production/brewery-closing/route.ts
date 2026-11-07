import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAccessPage } from '@/lib/page-catalog';
import { checkClosingDate } from '@/lib/closing-date';
import { todayIST } from '@/lib/format-date';
import {
  BREWERY_CLOSING_PAGE, beerBatchesAsOf, beerCountsOn, canSeeBeerQuantities,
} from '@/lib/brewery-beer';

/**
 * Brewery Closing — the BEER half of the count sheet (owner rulings 118/120).
 * The malts / hops half is the ordinary department closing count
 * (/api/closing-stock with the Brewery department) — see the page.
 *
 * GET  ?date=YYYY-MM-DD (default today, IST)
 *   → { date, can_see_expected, batches: [...], others: [...] }
 *   batches = every Brewery batch that held beer at the end of that day, plus
 *             any batch already counted that day (so a count of 0 stays on).
 *             expected / difference are null unless the viewer is admin,
 *             manager or HOD (ruling 120) — the blind count.
 *   others  = the remaining Brewery batches brewed by that date (no figures),
 *             for "add a batch the list doesn't show".
 *
 * POST { date, counts: [{ batch_id, counted }] }
 *   Saves a RECORD per counted batch (blank = not counted, skipped; 0 is a
 *   count). Never changes a batch. The whole submit is refused, with nothing
 *   saved, if the date is bad or any line names a batch that is not a Brewery
 *   batch brewed by that date, or carries a figure that is not a number ≥ 0.
 *   The answer carries no expected figure, so saving cannot be used to read it.
 *
 * Who: signed in AND allowed to open the Brewery Closing page (Settings →
 * Roles / Page Access decide, like every page). CSRF: the '/api/kitchen-
 * production' prefix in src/proxy.ts covers this route.
 */
export const dynamic = 'force-dynamic';

const EPS = 1e-9;

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canAccessPage(BREWERY_CLOSING_PAGE, me)) {
      return Response.json({ error: 'Your login cannot open Brewery Closing.' }, { status: 403 });
    }
    const url = new URL(request.url);
    const checked = checkClosingDate(url.searchParams.get('date') || todayIST());
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    const date = checked.date;

    const db = getDb();
    const outletId = await getCurrentOutletId();
    const sees = canSeeBeerQuantities(me);
    const all = beerBatchesAsOf(db, date, outletId);
    const counts = beerCountsOn(db, date);

    const batches = all
      .filter((r) => r.in_hand > EPS || counts.has(r.batch_id))
      .map((r) => {
        const c = counts.get(r.batch_id);
        const counted = c ? Number(c.counted_qty) : null;
        return {
          batch_id: r.batch_id,
          batch_number: r.batch_number,
          barcode: r.barcode,
          item_name: r.item_name,
          production_date: r.production_date,
          production_time: r.production_time,
          unit: r.unit,
          status: r.status,
          storage_location: r.storage_location,
          produced: r.produced,
          counted,
          counted_by: c?.counted_by || '',
          counted_at: c?.updated_at || '',
          expected: sees ? r.in_hand : null,
          difference: sees && counted !== null ? Math.round((counted - r.in_hand) * 1e6) / 1e6 : null,
        };
      });
    const listed = new Set(batches.map((b) => b.batch_id));
    const others = all
      .filter((r) => !listed.has(r.batch_id))
      .map((r) => ({
        batch_id: r.batch_id,
        batch_number: r.batch_number,
        barcode: r.barcode,
        item_name: r.item_name,
        production_date: r.production_date,
        unit: r.unit,
        status: r.status,
      }));

    return Response.json({ date, can_see_expected: sees, batches, others });
  } catch (e: any) {
    console.error('GET /api/kitchen-production/brewery-closing failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the beer count sheet' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'You are not signed in. Sign in again, then save your counts.' }, { status: 401 });
    if (!canAccessPage(BREWERY_CLOSING_PAGE, me)) {
      return Response.json({ error: 'Your login cannot save Brewery Closing counts.' }, { status: 403 });
    }
    const body = await request.json().catch(() => null);
    const checked = checkClosingDate(body?.date);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    const date = checked.date;
    if (!Array.isArray(body?.counts) || body.counts.length === 0) {
      return Response.json({ error: 'counts array is required' }, { status: 400 });
    }

    const db = getDb();
    const outletId = await getCurrentOutletId();
    const allowed = new Map(beerBatchesAsOf(db, date, outletId).map((r) => [r.batch_id, r]));

    // Read every line before writing anything, so a bad line saves nothing.
    const lines = new Map<string, { qty: number; unit: string; item: string }>();
    const errors: string[] = [];
    for (const raw of body.counts as unknown[]) {
      const line = (raw && typeof raw === 'object' ? raw : {}) as { batch_id?: unknown; counted?: unknown };
      const batchId = String(line.batch_id ?? '').trim();
      const b = allowed.get(batchId);
      if (!b) {
        errors.push(`"${batchId || '(no batch)'}" is not a Brewery batch brewed on or before ${date}.`);
        continue;
      }
      const text = line.counted == null ? '' : String(line.counted).trim();
      if (text === '') continue;                       // blank = not counted
      const qty = Number(text);
      if (!Number.isFinite(qty) || qty < 0) {
        errors.push(`${b.batch_number || b.barcode}: "${text}" is not a count — type a number, 0 or more.`);
        continue;
      }
      lines.set(batchId, { qty: Math.round(qty * 1e6) / 1e6, unit: b.unit, item: b.production_item_id });
    }
    if (errors.length > 0) {
      return Response.json({ error: `Nothing was saved. ${errors.join(' ')}`, errors }, { status: 400 });
    }
    if (lines.size === 0) {
      return Response.json({ error: 'Type a count for at least one batch.' }, { status: 400 });
    }

    const who = me.name || me.email || '';
    const upsert = db.prepare(
      `INSERT INTO brewery_beer_counts
         (id, outlet_id, count_date, batch_id, production_item_id, counted_qty, unit, counted_by)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(count_date, batch_id) DO UPDATE SET
         counted_qty = excluded.counted_qty, unit = excluded.unit,
         counted_by = excluded.counted_by, updated_at = datetime('now')`,
    );
    db.transaction(() => {
      for (const [batchId, l] of lines) {
        upsert.run(generateId(), outletId, date, batchId, l.item, l.qty, l.unit, who);
      }
    })();
    try {
      logAuditEvent(db, {
        event_type: 'brewery.beer_count',
        entity_type: 'brewery_beer_count',
        entity_id: date,
        actor_email: me.email,
        outlet_id: outletId,
        after: { date, counts: [...lines].map(([batch_id, l]) => ({ batch_id, counted: l.qty, unit: l.unit })) },
      });
    } catch { /* audit must never break the save */ }

    return Response.json({ ok: true, date, saved: lines.size });
  } catch (e: any) {
    console.error('POST /api/kitchen-production/brewery-closing failed:', e);
    return Response.json({ error: e?.message || 'Failed to save beer counts' }, { status: 500 });
  }
}
