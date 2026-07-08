// Shared helpers for the Kitchen Production / batch-tracking feature.
// Enrichment (remaining qty, expiry traffic-light, age) is computed here so the
// list route and the detail route stay in sync.

export interface ProductionBatch {
  id: string;
  outlet_id: string | null;
  batch_number: string;
  barcode: string;
  item_name: string;
  /** FK to the production_items master; null on legacy free-typed batches. */
  production_item_id?: string | null;
  category: string;
  material_id: string | null;
  recipe_id: string | null;
  production_date: string;
  production_time: string;
  expiry_date: string;
  expiry_time: string;
  shelf_life: string;
  quantity_produced: number;
  quantity_consumed: number;
  unit: string;
  prepared_by: string;
  kitchen_section: string;
  storage_location: string;
  remarks: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/** Combine a date ('YYYY-MM-DD') and an optional time ('HH:mm' / 'HH:mm:ss') into a Date, or null. */
export function parseDateTime(date: string | null | undefined, time: string | null | undefined): Date | null {
  if (!date) return null;
  let t = (time || '').trim();
  if (!t) t = '00:00:00';
  else if (/^\d{2}:\d{2}$/.test(t)) t = `${t}:00`;
  const d = new Date(`${date}T${t}`);
  return isNaN(d.getTime()) ? null : d;
}

/** red if already expired, yellow if within 24h, else green (also green when no expiry set). */
export function expiryStatus(
  expiry_date: string | null | undefined,
  expiry_time: string | null | undefined,
  now: Date,
): 'green' | 'yellow' | 'red' {
  const exp = parseDateTime(expiry_date, expiry_time);
  if (!exp) return 'green';
  const diffMs = exp.getTime() - now.getTime();
  if (diffMs <= 0) return 'red';
  if (diffMs <= 24 * 3600 * 1000) return 'yellow';
  return 'green';
}

/** Hours since production (rounded to 1 decimal); 0 if unknown. */
export function batchAgeHours(
  production_date: string | null | undefined,
  production_time: string | null | undefined,
  now: Date,
): number {
  const prod = parseDateTime(production_date, production_time);
  if (!prod) return 0;
  const hrs = (now.getTime() - prod.getTime()) / (3600 * 1000);
  return Math.round(Math.max(0, hrs) * 10) / 10;
}

/** Human "time until expiry" string from an expiry date/time vs now (e.g. "2d 4h left", "expired"). */
export function shelfLifeRemaining(
  expiry_date: string | null | undefined,
  expiry_time: string | null | undefined,
  now: Date,
): string {
  const exp = parseDateTime(expiry_date, expiry_time);
  if (!exp) return 'no expiry';
  let ms = exp.getTime() - now.getTime();
  if (ms <= 0) return 'expired';
  const days = Math.floor(ms / (24 * 3600 * 1000));
  ms -= days * 24 * 3600 * 1000;
  const hours = Math.floor(ms / (3600 * 1000));
  ms -= hours * 3600 * 1000;
  const mins = Math.floor(ms / (60 * 1000));
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}

/** Attach derived fields (no fifo_priority — that is a list-level ranking). */
export function enrichBatch(b: ProductionBatch, now: Date) {
  const remaining_quantity = Math.max(0, (b.quantity_produced || 0) - (b.quantity_consumed || 0));
  return {
    ...b,
    remaining_quantity,
    expiry_status: expiryStatus(b.expiry_date, b.expiry_time, now),
    batch_age_hours: batchAgeHours(b.production_date, b.production_time, now),
  };
}

/**
 * SQL condition + params matching ALL batches that belong to the SAME production
 * item as `row`. THE single source of truth for FIFO grouping — every surface
 * (scan/take verdict, list ranks, consume draw-down, by-barcode, dashboard
 * compliance) uses this so they can never disagree. Groups by
 * production_item_id when the row carries one (a rename or a case-typo can never
 * split a chain), also folding in any legacy unlinked same-name rows; falls back
 * to NOCASE name only for rows with no master item at all.
 */
export function itemGroupClause(row: { production_item_id?: string | null; item_name: string }): { cond: string; params: any[] } {
  if (row.production_item_id) {
    return {
      cond: '(production_item_id = ? OR (production_item_id IS NULL AND item_name = ? COLLATE NOCASE))',
      params: [row.production_item_id, row.item_name],
    };
  }
  return { cond: 'item_name = ? COLLATE NOCASE', params: [row.item_name] };
}

/**
 * FIFO verdict for one batch, shared by the /scan and /take endpoints so the
 * two can never drift. fifo_priority = the batch's rank among the item's
 * ACTIVE batches (oldest = 1; null when the batch itself isn't active).
 * fifo_use_first = older active batches to use BEFORE this one (oldest first,
 * capped at 5); for a non-active batch it lists ALL actives (the first entry
 * is the item's current FIFO #1).
 */
export function computeFifo(
  db: { prepare: (sql: string) => { all: (...a: any[]) => any[] } },
  row: ProductionBatch,
  outletId: string | null,
  now: Date,
): { fifo_priority: number | null; fifo_use_first: any[] } {
  const { cond: itemCond, params: itemParams } = itemGroupClause(row);
  const active = db.prepare(
    `SELECT * FROM production_batches
      WHERE status = 'active' AND ${itemCond}
        ${outletId ? 'AND (outlet_id = ? OR outlet_id IS NULL)' : ''}
      ORDER BY production_date ASC, production_time ASC, created_at ASC`
  ).all(...(outletId ? [...itemParams, outletId] : itemParams)) as ProductionBatch[];
  const idx = active.findIndex((a) => a.id === row.id);
  const fifo_priority = row.status === 'active' && idx >= 0 ? idx + 1 : null;
  const before = row.status === 'active' ? (idx >= 0 ? active.slice(0, idx) : []) : active;
  const fifo_use_first = before.slice(0, 5).map((b) => {
    const e = enrichBatch(b, now);
    return {
      barcode: b.barcode,
      batch_number: b.batch_number,
      production_date: b.production_date,
      production_time: b.production_time,
      expiry_date: b.expiry_date,
      storage_location: b.storage_location,
      remaining_quantity: e.remaining_quantity,
      unit: b.unit,
      shelf_life_remaining: shelfLifeRemaining(b.expiry_date, b.expiry_time, now),
    };
  });
  return { fifo_priority, fifo_use_first };
}
