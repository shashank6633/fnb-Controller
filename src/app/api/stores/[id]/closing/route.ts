import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { getStoreById, materialStoreId, userStoreAccess, isStoreMappedMaterial, storeCategories } from '@/lib/store-engine';
import {
  recordCountVariance, recordCountDigest, readPhysicalCount, zeroPatternGuard,
} from '@/lib/variance-approval';
import { checkClosingDate, CLOSING_DATE_RE } from '@/lib/closing-date';
import type { PackMeta } from '@/lib/pack-units';

/**
 * /api/stores/[id]/closing — INDEPENDENT store closing stock (Phase C, spec F6).
 *
 * Counts live in `store_closing_counts` — a pure REGISTER. Saving a count
 * never moves stock (no ledger row), so closing can't distort the store's
 * ledger-derived quantities. Completely separate from the central
 * /closing-stock module (different table, different APIs, zero overlap).
 *
 * GET  ?date=YYYY-MM-DD   (can_view)  → that day's saved counts + summary +
 *                                       system as-of qty for every material
 *                                       with ledger history (for the count UI).
 *      (no date)          (can_view)  → history: list of count dates w/ totals.
 *
 * POST                    (can_close_stock)
 *      { date, items: [{ material_id, physical_qty (RECIPE units), note? }],
 *        note?, adjust_to_physical? }
 *      Each item's optional `note` (per-row) persists to the count row; when
 *      absent/blank it falls back to the batch-level `note` (default '').
 *      For each item: system qty = ledger SUM as-of end of `date`;
 *      variance = physical − system; variance ₹ at the store's weighted-avg
 *      cost (fallback rm.average_price). Upserts on (store, material, date).
 *      `adjust_to_physical` is ADMIN-ONLY (silently ignored otherwise): posts
 *      an 'adjustment' ledger row for each non-zero variance so stock matches
 *      the physical count — the saved count row still records the pre-adjust
 *      system qty & variance as evidence.
 */
export const dynamic = 'force-dynamic';

/** Weighted-avg ₹/recipe-unit + system qty as-of end of `date` for one material. */
function asOfStats(db: any, storeId: string, materialId: string, date: string) {
  const r = db.prepare(`
    SELECT SUM(quantity) AS qty,
           SUM(CASE WHEN quantity > 0 AND unit_cost > 0 THEN quantity * unit_cost ELSE 0 END) AS in_value,
           SUM(CASE WHEN quantity > 0 AND unit_cost > 0 THEN quantity ELSE 0 END)             AS in_qty
    FROM store_stock_ledger
    WHERE store_id = ? AND material_id = ? AND date(created_at) <= date(?)
  `).get(storeId, materialId, date) as any;
  const mat = db.prepare('SELECT average_price FROM raw_materials WHERE id = ?').get(materialId) as any;
  const avg = (Number(r?.in_qty) || 0) > 0
    ? (Number(r.in_value) || 0) / Number(r.in_qty)
    : (Number(mat?.average_price) || 0);
  return {
    system_qty: Number(r?.qty) || 0,
    avg_cost: Math.round(avg * 10000) / 10000,
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    const access = userStoreAccess(db, user, storeId);
    if (!access.can_view) {
      return Response.json({ error: `You are not authorized to view ${store.name}` }, { status: 403 });
    }
    // Blind count: only admins may see the system figure + variance. Everything
    // that would reveal the expected number is stripped for everyone else.
    const isAdmin = user.role === 'admin';

    const url = new URL(request.url);
    const date = (url.searchParams.get('date') || '').trim();

    // History: dates with totals, newest first.
    if (!date) {
      const dates = (db.prepare(`
        SELECT date,
               COUNT(*)                                        AS item_count,
               SUM(CASE WHEN variance < 0 THEN 1 ELSE 0 END)   AS shortage_count,
               SUM(CASE WHEN variance > 0 THEN 1 ELSE 0 END)   AS excess_count,
               SUM(variance_value)                             AS total_variance_value,
               SUM(ABS(variance_value))                        AS abs_variance_value
        FROM store_closing_counts
        WHERE store_id = ?
        GROUP BY date
        ORDER BY date DESC
        LIMIT 90
      `).all(storeId) as any[]).map(r => ({
        date: r.date,
        item_count: Number(r.item_count) || 0,
        // Variance fields are admin-only (they reveal the system figure).
        shortage_count: isAdmin ? (Number(r.shortage_count) || 0) : null,
        excess_count: isAdmin ? (Number(r.excess_count) || 0) : null,
        total_variance_value: isAdmin ? Math.round((Number(r.total_variance_value) || 0) * 100) / 100 : null,
        abs_variance_value: isAdmin ? Math.round((Number(r.abs_variance_value) || 0) * 100) / 100 : null,
      }));
      return Response.json({ store: { id: store.id, name: store.name }, dates });
    }

    // SHAPE ONLY ON THE READ PATH, DELIBERATELY. CLOSING_DATE_RE is imported
    // from the shared guard (src/lib/closing-date) purely so this route stops
    // carrying its own copy of the literal — a copied regex does not prevent
    // drift, it IS the drift surface. What it is NOT is checkClosingDate():
    // that belongs to POST alone. This handler only FILTERS by `date`, and its
    // future/no-such-day refusals would stop an admin from even LOOKING at a
    // date. A day with nothing counted must keep answering with an empty
    // result, not a 400. Message and status unchanged.
    if (!CLOSING_DATE_RE.test(date)) {
      return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }

    // Saved counts for the day.
    const counts = db.prepare(`
      SELECT c.id, c.material_id, c.date, c.system_qty, c.physical_qty, c.variance,
             c.variance_value, c.counted_by, c.note, c.created_at,
             rm.name AS material_name, rm.unit, rm.purchase_unit, rm.pack_size, rm.case_size, rm.category
      FROM store_closing_counts c
      JOIN raw_materials rm ON rm.id = c.material_id
      WHERE c.store_id = ? AND c.date = ?
      ORDER BY rm.name COLLATE NOCASE
    `).all(storeId, date) as any[];

    // System qty as-of end of the selected date for every material with ledger
    // history — the count UI's "system" column (works for backdated counts too).
    const system_asof = (db.prepare(`
      SELECT material_id, SUM(quantity) AS qty
      FROM store_stock_ledger
      WHERE store_id = ? AND date(created_at) <= date(?)
      GROUP BY material_id
    `).all(storeId, date) as any[]).map(r => ({
      material_id: r.material_id,
      qty: Number(r.qty) || 0,
    }));

    const summary = {
      items: counts.length,
      shortage_count: isAdmin ? counts.filter(c => c.variance < 0).length : null,
      excess_count: isAdmin ? counts.filter(c => c.variance > 0).length : null,
      match_count: isAdmin ? counts.filter(c => c.variance === 0).length : null,
      total_variance_value: isAdmin ? Math.round(counts.reduce((s, c) => s + (Number(c.variance_value) || 0), 0) * 100) / 100 : null,
    };

    // Blind count: non-admins get NO system figure. Strip the as-of map entirely
    // and the system/variance columns from each saved count (physical count +
    // counted_by stay so they still see WHAT was counted, just not the expected).
    const safeCounts = isAdmin ? counts : counts.map(c => ({ ...c, system_qty: null, variance: null, variance_value: null }));
    const safeAsof = isAdmin ? system_asof : [];

    return Response.json({ store: { id: store.id, name: store.name }, date, counts: safeCounts, system_asof: safeAsof, summary });
  } catch (e: any) {
    console.error('[/api/stores/[id]/closing GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    const access = userStoreAccess(db, user, storeId);
    if (!access.can_close_stock) {
      return Response.json({ error: `You are not authorized to record closing stock for ${store.name}` }, { status: 403 });
    }

    const b = await request.json();
    // The RAW body date. Trimmed HERE, at the call site, because this field has
    // always tolerated a padded paste and the shared guard deliberately does
    // not (see its "no whitespace tolerance" note). Nothing below binds this
    // value — `date`, below, is what was actually checked.
    const rawDate = String(b.date || '').trim();
    const note = String(b.note || '').trim();
    // A non-zero variance NEVER moves stock here. It creates a PENDING variance
    // approval; an admin reviews it and only then does stock reconcile to the
    // count. (Previously an admin-only `adjust_to_physical` flag did this inline;
    // that path is retired in favour of the review queue.)
    const outletId = await getCurrentOutletId();

    /* ══════════════════════════════════════════════════════════════════════
     * THE DATE GUARD — ONCE PER SUBMIT, BEFORE THE TRANSACTION OPENS (2026-08)
     * ══════════════════════════════════════════════════════════════════════
     * Shape, real calendar day, then not-in-the-future — in that order, from
     * the ONE shared validator (src/lib/closing-date.ts) that every writer
     * into closing_stock / store_closing_counts now runs its date through.
     * That module carries the full WHY; in short: one fat-fingered 2027-08-09
     * becomes the newest count for that material and supersedes every real
     * count of it thereafter (e91c64c), until somebody rejects the phantom
     * row — and 2026-02-31 used to pass the old shape-only check and SAVE a
     * count dated to a day that does not exist.
     *
     * IST, NOT UTC — A BUG FIX, NOT A LOOSENING. The line this replaces was
     * `new Date().toISOString().slice(0, 10)`, i.e. UTC. For the whole
     * 00:00–05:30 IST window that returns YESTERDAY, so a count dated TODAY
     * was refused as "in the future" — and a bar's closing count is taken
     * squarely inside that window, which made this a live nightly-close
     * failure. todayIST() (reached through the shared guard) makes today mean
     * today. The only refusal that disappears is one that should never have
     * fired: nothing legitimately blocked before is accepted now.
     *
     * BACKDATING IS UNTOUCHED — no lower bound. Late sheets and paper counts
     * typed up the next morning are ordinary business here. Only future and
     * invalid dates are refused, and the future test fails OPEN if todayIST()
     * ever hands back a non-date, so a broken helper cannot reject every count
     * and take the close down store-wide.
     *
     * Response shape is this route's own, unchanged: { error } at 400. Only
     * the wording comes from the shared module, so every door into a closing
     * count complains in the same words.
     * ────────────────────────────────────────────────────────────────────── */
    const checked = checkClosingDate(rawDate);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    // Bind THIS below, never rawDate/b.date — it is the value that was checked.
    const date = checked.date;

    if (!Array.isArray(b.items) || b.items.length === 0) {
      return Response.json({ error: 'items array is required' }, { status: 400 });
    }
    // A FLOOR bar owns no categories: it may count ANY catalog (liquor) item,
    // not just ones already transferred in.
    const floorStore = storeCategories(db, storeId).length === 0;

    // Validate everything BEFORE writing anything (all-or-nothing save).
    const prepared: {
      material_id: string; name: string; unit: string;
      /** Pack meta, so the qty axis of the bar reads in PURCHASE units. */
      pack: PackMeta;
      system_qty: number; physical_qty: number; variance: number;
      variance_value: number; avg_cost: number; note: string;
    }[] = [];
    const seen = new Set<string>();
    /** Lines whose count cell was BLANK — recorded, never written. */
    let notCounted = 0;
    for (const item of b.items) {
      const materialId = String(item?.material_id || '').trim();
      /* BLANK = NOT COUNTED, read through the ONE shared reader
       * (readPhysicalCount, src/lib/variance-approval.ts).
       *
       * `Number(item?.physical_qty)` turned `''`, `'   '` and `null` into a
       * finite, non-negative 0 that passed the `!Number.isFinite || < 0` guard
       * and was stored as a real counted zero — and storage here is an
       * `ON CONFLICT(store_id, material_id, date) DO UPDATE`, so that phantom
       * zero OVERWROTE a real same-day count in place rather than sitting
       * beside it. A blank now produces no upsert at all. A 0 is a real count
       * and behaves exactly as it always has. */
      const pc = readPhysicalCount(item?.physical_qty);
      if (!materialId) return Response.json({ error: 'Every item needs a material_id' }, { status: 400 });
      if (seen.has(materialId)) {
        return Response.json({ error: 'Duplicate material in items — count each material once' }, { status: 400 });
      }
      seen.add(materialId);
      if (pc.kind === 'not_counted') { notCounted++; continue; }
      if (pc.kind === 'error') {
        // WHOLE-SUBMIT REFUSAL, UNCHANGED. This route has always been
        // all-or-nothing (see the comment above the loop) and the liquor page
        // posts one floor's grid as one save; turning it into a per-line skip
        // here would let a bar's sheet half-land with no record of which half.
        // Only the WORDING changes — it now names what was typed.
        return Response.json({ error: `physical_qty must be a number ≥ 0 (recipe units) — ${pc.reason}` }, { status: 400 });
      }
      const physical = pc.qty;
      const mat = db.prepare('SELECT id, name, category, unit, purchase_unit, pack_size, case_size FROM raw_materials WHERE id = ?').get(materialId) as any;
      if (!mat) return Response.json({ error: `Material not found: ${materialId}` }, { status: 404 });
      // A store may count a material it OWNS (category-mapped) OR one it actually
      // HOLDS via its ledger — receiving FLOORS own no categories, so a
      // transferred-in bottle is only reachable through its ledger history. This
      // mirrors the union storeItemList() uses to build the count list.
      if (materialStoreId(db, mat) !== storeId) {
        const held = db.prepare('SELECT 1 FROM store_stock_ledger WHERE store_id = ? AND material_id = ? LIMIT 1').get(storeId, materialId);
        // A floor bar (owns no categories) may count ANY catalog (liquor) item.
        const catalogOk = floorStore && isStoreMappedMaterial(db, materialId);
        if (!held && !catalogOk) {
          return Response.json({ error: `"${mat.name}" is not a ${store.name} material — its category "${mat.category}" is not mapped to this store and it holds no stock here` }, { status: 400 });
        }
      }
      // Optional per-item note (per-row Notes column). Absent/blank → fall back
      // to the batch-level note (which itself defaults to '').
      const itemNote = String(item?.note ?? '').trim() || note;
      const { system_qty, avg_cost } = asOfStats(db, storeId, materialId, date);
      const variance = Math.round((physical - system_qty) * 1000) / 1000;
      const variance_value = Math.round(variance * avg_cost * 100) / 100;
      prepared.push({
        material_id: materialId, name: mat.name, unit: mat.unit, pack: mat,
        system_qty, physical_qty: physical, variance, variance_value, avg_cost,
        note: itemNote,
      });
    }

    /* THE UPLOAD PATTERN GUARD (owner requirement 7). The liquor grid and its
     * CSV both post through here, so this is the door a mass-zeroed bar sheet
     * would arrive at. Judged on the PATTERN — a 0 is a real count and stays
     * one — refused BEFORE the transaction opens, and re-submittable with
     * confirm_zeros for a genuine all-empty stocktake. Placed after `prepared`
     * so it counts what will actually be written, and before `txn()` so nothing
     * is. */
    const zeroGuard = zeroPatternGuard(prepared.map(p => p.physical_qty));
    if (zeroGuard.suspicious && b.confirm_zeros !== true) {
      return Response.json(
        { error: zeroGuard.message, zero_guard: { ...zeroGuard, confirm_field: 'confirm_zeros' } },
        { status: 409 },
      );
    }

    // One id for this save — the handle the monthly review and bulk reject use.
    const batchId = generateId();
    let pendingCount = 0;
    let appliedCount = 0;
    let autoAppliedCount = 0;
    const upsert = db.prepare(`
      INSERT INTO store_closing_counts
        (id, store_id, material_id, date, system_qty, physical_qty, variance,
         variance_value, counted_by, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(store_id, material_id, date) DO UPDATE SET
        system_qty     = excluded.system_qty,
        physical_qty   = excluded.physical_qty,
        variance       = excluded.variance,
        variance_value = excluded.variance_value,
        counted_by     = excluded.counted_by,
        note           = excluded.note,
        created_at     = datetime('now')
    `);

    const txn = db.transaction(() => {
      for (const p of prepared) {
        upsert.run(
          generateId(), storeId, p.material_id, date,
          p.system_qty, p.physical_qty, p.variance, p.variance_value,
          user.email, p.note,
        );
        // THE ONE DOOR — the same call every other count path makes.
        //
        // ABOVE THE BAR the stock is HELD: the count row above is a pure
        // REGISTER (it posts no ledger movement), so the store's on-hand does
        // not move until an admin approves. UNDER THE BAR the same approval is
        // granted now, through approveVariance(), which posts a signed
        // 'adjustment' to store_stock_ledger — the identical write, and the
        // identical audit row, that approving it next month would produce.
        // A corrected count that now matches clears any stale pending row.
        const decided = recordCountVariance(db, {
          source: 'liquor',
          material_id: p.material_id,
          store_id: storeId,
          date,
          system_stock: p.system_qty,
          physical_stock: p.physical_qty,
          unit: p.unit,
          counted_by: user.email,
          count_note: p.note,
          outlet_id: outletId,
          batch_id: batchId,
          batch_label: `${store.name} closing sheet`,
          pack: p.pack,
        });
        if (decided.outcome === 'applied') {
          appliedCount++;
          if (decided.auto_applied) autoAppliedCount++;
        } else if (decided.outcome === 'held') {
          pendingCount++;
        }
      }
    });
    txn();

    /* ══════════════════════════════════════════════════════════════════════
     * THE COUNT DIGEST — fired here, at the boundary of this upload.
     * ══════════════════════════════════════════════════════════════════════
     * AFTER the transaction, never inside it, and it swallows everything it can
     * throw: a notification may not fail or roll back the count it is
     * announcing. recordCountDigest() is try/catch'd end to end and returns null
     * on any failure; ignoring the return value is correct.
     *
     * ALWAYS FIRES, on every upload that counted at least one line — no
     * threshold decides WHETHER the owner hears about a count, only what is
     * named inside the sentence. An upload that counted nothing writes no
     * digest, because there is no count to digest.
     *
     * THE STORE RAIL IS ITS OWN DIGEST, never merged with the central one: it
     * is a different stock pool (store_stock_ledger, not raw_materials), and
     * store_locations carries no outlet, so its counted figure cannot be
     * outlet-scoped the way a central one can. Four floor bars counted on one
     * date still make ONE item — the key is (date, outlet, rail), so the
     * per-store saves coalesce instead of ringing the bell four times.
     * The store name is deliberately NOT put in the sentence: it is free text a
     * manager can rename, and the digest label is a delimited string the queue
     * page splits back apart.
     * ────────────────────────────────────────────────────────────────────── */
    recordCountDigest(db, {
      date,
      rail: 'liquor',
      // What THIS upload wrote — the fire/don't-fire gate only. The reported
      // "counted" is derived from store_closing_counts for the date.
      saved: prepared.length,
      outlet_id: outletId,
      actor_email: user.email,
    });

    // BLIND COUNTS ON THE WAY BACK OUT — the same rule GET applies (see the
    // summary it builds and its `safeCounts`), which this POST was missing.
    //
    // Every field below is a system-stock oracle, not just a statistic. The
    // sharpest is `pending_count`: a variance creates a pending row, so saving
    // ONE line and watching the number flip between 1 and 0 tells the counter
    // exactly whether their figure matched — and a few bisecting re-saves
    // recover system_qty precisely. That is the number downloadTemplate()
    // strips from their CSV and GET nulls out of every row, so handing it back
    // in the save confirmation defeated the whole control. shortage/excess/
    // match/value leak the same thing in aggregate.
    //
    // Admins get the real figures; everyone else gets nulls and a
    // variance-INDEPENDENT confirmation on screen (see the callers in
    // inventory/liquor-store/page.tsx — they must not render "all match the
    // system" as the null branch, or the oracle comes straight back).
    // `summary` stays FULL and unblinded: it feeds logAuditEvent below, which
    // spreads it into `after` and interpolates total_variance_value into the
    // note. Blinding this object would write nulls and "variance ₹null" into the
    // audit trail for precisely the saves worth auditing — a non-admin counter's.
    // Blinding belongs on the wire, not in the record. See `safeSummary` below.
    const postIsAdmin = user.role === 'admin';
    const summary = {
      items: prepared.length,
      shortage_count: prepared.filter(p => p.variance < 0).length,
      excess_count: prepared.filter(p => p.variance > 0).length,
      match_count: prepared.filter(p => p.variance === 0).length,
      total_variance_value: Math.round(prepared.reduce((s, p) => s + p.variance_value, 0) * 100) / 100,
      pending_count: pendingCount,
      // ── Additive (2026-08). `applied_count` = variances the BAR (or an
      // admin's tick) posted to the ledger at count time; `not_counted` = lines
      // whose cell was BLANK, which are neither counted nor written.
      applied_count: appliedCount,
      auto_applied_count: autoAppliedCount,
      not_counted: notCounted,
      batch_id: batchId,
    };
    const safeSummary = postIsAdmin ? summary : {
      ...summary,
      shortage_count: null, excess_count: null, match_count: null,
      total_variance_value: null, pending_count: null,
      // Blinded for the same reason pending_count is, and more sharply: with a
      // bar configured, `applied_count` answers "was my count within ₹X of the
      // system figure?" per save, which bisects system_qty in a few re-saves.
      // `not_counted` and `batch_id` are NOT blinded — they describe what the
      // counter submitted, not what the system expected.
      applied_count: null, auto_applied_count: null,
    };

    logAuditEvent(db, {
      event_type: 'store.closing',
      entity_type: 'store_closing_counts',
      entity_id: `${storeId}:${date}`,
      actor_email: user.email,
      after: {
        store_id: storeId, store: store.name, date, note,
        ...summary,
        items_detail: prepared.map(p => ({
          material_id: p.material_id, material: p.name,
          system_qty: p.system_qty, physical_qty: p.physical_qty,
          variance: p.variance, variance_value: p.variance_value,
        })),
      },
      note: `${store.name}: closing count ${date} — ${prepared.length} item(s) counted`
        + (notCounted ? `, ${notCounted} left blank (not counted)` : '')
        + `, variance ₹${summary.total_variance_value}`
        + (pendingCount ? ` (${pendingCount} held for approval)` : '')
        + (appliedCount ? ` (${appliedCount} applied at count time${autoAppliedCount ? `, ${autoAppliedCount} under the bar` : ''})` : ''),
    });

    // `results` is the bluntest leak of the three: per item it carried
    // system_qty, variance, variance_value AND `pending` — a literal per-line
    // "did your count match the system?" boolean. Nothing reads it (no consumer
    // in the app at the time of writing), so a non-admin gets back only what
    // they typed. Mirrors GET's `safeCounts`. If you ever add a consumer, gate
    // it on isAdmin rather than un-blinding this.
    const safeResults = prepared.map(p => ({
      material_id: p.material_id,
      physical_qty: p.physical_qty,
      system_qty: postIsAdmin ? p.system_qty : null,
      variance: postIsAdmin ? p.variance : null,
      variance_value: postIsAdmin ? p.variance_value : null,
      pending: postIsAdmin ? p.variance !== 0 : null,
    }));

    return Response.json({
      ok: true, date, summary: safeSummary, results: safeResults,
    }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/stores/[id]/closing POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
