// Shared helpers for the Kitchen Production / batch-tracking feature.
// Enrichment (remaining qty, expiry traffic-light, age) is computed here so the
// list route and the detail route stay in sync.

export interface ProductionBatch {
  id: string;
  outlet_id: string | null;
  batch_number: string;
  barcode: string;
  item_name: string;
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
