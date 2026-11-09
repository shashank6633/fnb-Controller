import type Database from 'better-sqlite3';
import { canManageKitchenProduction, type SessionUser } from './auth';

/**
 * Brewery beer — blind quantities, beer in hand on a date, and beer counts.
 * Owner rulings 118, 120 and 121 (2026-11-07).
 *
 * ── WHO SEES BREWERY QUANTITIES (ruling 121, "Hide for staff everywhere") ──
 * Admin, manager and HOD — the same set that may record and change batches
 * (canManageKitchenProduction). Everyone else no longer receives how much of a
 * BREWERY batch has been used or is left: not on Brewery Production, not in the
 * batch details, not on Scan, not on the FSSAI FIFO board. They still see what
 * was brewed (quantity_produced — the brewer made it, and the label prints it).
 * The figures are removed on the SERVER, so the screens cannot leak them; a
 * Kitchen batch is never touched. Without this, hiding "expected litres" on the
 * Brewery Closing page alone would be blind in name only: every batch card
 * showed Remaining to anyone signed in.
 *
 * ── BEER IN HAND ON A DATE (ruling 120) ─────────────────────────────────────
 * Only three things ever lower a batch, and each writes a dated row to
 * batch_transactions with the exact amount: 'consumed' (take at scan, FIFO
 * consume), 'wasted' and 'disposed' (the batch Waste / Dispose buttons). So at
 * the end of day D a batch holds
 *     produced (if brewed on or before D) − Σ those rows dated on or before D
 * with the row's created_at read as an IST calendar day. For today this equals
 * produced − quantity_consumed. Status is deliberately NOT used: a PARTIAL waste
 * flips a batch to 'wasted' while beer is still left in it.
 *
 * ── A BEER COUNT IS A RECORD (ruling 120) ──────────────────────────────────
 * Saving a count stores the litres found, the date and who counted. It never
 * changes a batch. One row per (date, batch); a second save that day replaces it.
 */

/** Batch transaction types that lower what a batch holds. */
export const BEER_OUT_TYPES = ['consumed', 'wasted', 'disposed'] as const;

/** The Brewery Closing page — the page grant that lets a user see and save beer counts. */
export const BREWERY_CLOSING_PAGE = '/brewery-closing';

/** May this user see how much of a Brewery batch is used / left (and expected litres)? */
export function canSeeBeerQuantities(me: SessionUser | null | undefined): boolean {
  return !!me && canManageKitchenProduction(me);
}

/**
 * SQL test that a production_batches row is on the Kitchen or the Brewery side
 * — the same split as the batch list's `kind` filter (api/kitchen-production/
 * route.ts): Brewery = its item is ticked "Brewery item"; Kitchen = everything
 * else, including a batch with no item. `col` is the batch's production_item_id
 * column, qualified when the query joins. Owner ruling 122 (2026-11-09).
 */
export function batchKindSql(kind: 'kitchen' | 'brewery', col = 'production_item_id'): string {
  const ids = `SELECT id FROM production_items WHERE is_brewery = 1 AND id IS NOT NULL`;
  return kind === 'brewery' ? `${col} IN (${ids})` : `(${col} IS NULL OR ${col} NOT IN (${ids}))`;
}

/** Ids of every production item ticked "Brewery item". */
export function breweryItemIds(db: Database.Database): Set<string> {
  const rows = db.prepare(
    `SELECT id FROM production_items WHERE is_brewery = 1 AND id IS NOT NULL`,
  ).all() as { id: string }[];
  return new Set(rows.map((r) => String(r.id)));
}

type Quantified = {
  production_item_id?: string | null;
  quantity_consumed?: unknown;
  remaining_quantity?: unknown;
  fifo_use_first?: unknown;
};

/** The same batch with its used / left figures removed (and in its FIFO hints). */
export function hideBatchQuantities<T extends Quantified>(b: T): T {
  const out: Record<string, unknown> = {
    ...b,
    quantity_consumed: null,
    remaining_quantity: null,
    quantities_hidden: true,
  };
  if (Array.isArray(b.fifo_use_first)) {
    out.fifo_use_first = b.fifo_use_first.map((e) =>
      e && typeof e === 'object' ? { ...(e as object), remaining_quantity: null } : e,
    );
  }
  return out as T;
}

/**
 * A history row with its amounts removed. 'created' keeps its quantity (that is
 * the brewed amount, already shown); every other row's quantity adds up to what
 * was used, and its balance IS what is left.
 */
export function hideTxQuantities<T extends { type?: unknown }>(tx: T): T {
  const out: Record<string, unknown> = { ...tx, balance_quantity: null };
  if (tx.type !== 'created') out.quantity = null;
  return out as T;
}

/**
 * One decision per request. A Kitchen batch passes through every function
 * unchanged, for everyone. A BREWERY batch is marked `is_brewery_batch: true`
 * for every viewer — so a screen that keeps answers on the device (Scan's
 * history on a shared tablet) can hide a figure it stored for an earlier,
 * higher viewer — and loses its used / left figures for a viewer below
 * manager / HOD. `hidden(b)` answers "is this batch blind for me?".
 */
export function beerBlindFor(db: Database.Database, me: SessionUser | null | undefined) {
  const sees = canSeeBeerQuantities(me);
  const ids = breweryItemIds(db);
  const isBeer = (b: { production_item_id?: string | null } | null | undefined): boolean =>
    !!b && !!b.production_item_id && ids.has(String(b.production_item_id));
  const hidden = (b: { production_item_id?: string | null } | null | undefined): boolean => !sees && isBeer(b);
  return {
    sees,
    hidden,
    batch<T extends Quantified>(b: T): T {
      if (!isBeer(b)) return b;
      const marked = { ...b, is_brewery_batch: true };
      return sees ? marked : hideBatchQuantities(marked);
    },
    transactions<T extends { type?: unknown }>(b: { production_item_id?: string | null }, txs: T[]): T[] {
      return hidden(b) ? txs.map(hideTxQuantities) : txs;
    },
  };
}

export interface BeerBatchRow {
  batch_id: string;
  batch_number: string;
  barcode: string;
  production_item_id: string;
  item_name: string;
  production_date: string;
  production_time: string;
  unit: string;
  status: string;
  storage_location: string;
  produced: number;
  /** Σ consumed + wasted + disposed dated on or before the date. */
  out_by_date: number;
  /** produced − out_by_date, never below 0. */
  in_hand: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Every Brewery batch brewed on or before `date`, with what it held at the end
 * of that day. `date` must already be a validated YYYY-MM-DD (checkClosingDate).
 * Outlet-scoped like the batch list (NULL-outlet rows are shared). A batch saved
 * with no brew date counts from the IST day it was recorded — never from the
 * beginning of time.
 */
export function beerBatchesAsOf(
  db: Database.Database,
  date: string,
  outletId: string | null | undefined,
): BeerBatchRow[] {
  const outletSql = outletId ? 'AND (b.outlet_id = ? OR b.outlet_id IS NULL)' : '';
  const types = BEER_OUT_TYPES.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT b.id, b.batch_number, b.barcode, b.production_item_id,
            COALESCE(NULLIF(TRIM(pi.name), ''), b.item_name) AS item_name,
            b.production_date, b.production_time, b.unit, b.status, b.storage_location,
            b.quantity_produced,
            COALESCE((SELECT SUM(t.quantity) FROM batch_transactions t
                       WHERE t.batch_id = b.id AND t.type IN (${types})
                         AND date(t.created_at, '+5 hours', '+30 minutes') <= ?), 0) AS out_by_date
       FROM production_batches b
       JOIN production_items pi ON pi.id = b.production_item_id AND pi.is_brewery = 1
      WHERE COALESCE(NULLIF(TRIM(b.production_date), ''), date(b.created_at, '+5 hours', '+30 minutes')) <= ? ${outletSql}
      ORDER BY item_name COLLATE NOCASE, b.production_date, b.production_time, b.created_at`,
  ).all(...BEER_OUT_TYPES, date, date, ...(outletId ? [outletId] : [])) as any[];
  return rows.map((r) => {
    const produced = Number(r.quantity_produced) || 0;
    const out = Number(r.out_by_date) || 0;
    return {
      batch_id: String(r.id),
      batch_number: String(r.batch_number || ''),
      barcode: String(r.barcode || ''),
      production_item_id: String(r.production_item_id || ''),
      item_name: String(r.item_name || ''),
      production_date: String(r.production_date || ''),
      production_time: String(r.production_time || ''),
      unit: String(r.unit || ''),
      status: String(r.status || ''),
      storage_location: String(r.storage_location || ''),
      produced: round6(produced),
      out_by_date: round6(out),
      in_hand: round6(Math.max(0, produced - out)),
    };
  });
}

export interface BeerCountRow {
  batch_id: string;
  counted_qty: number;
  unit: string;
  counted_by: string;
  updated_at: string;
}

/** Saved beer counts for one date, keyed by batch id. */
export function beerCountsOn(db: Database.Database, date: string): Map<string, BeerCountRow> {
  const rows = db.prepare(
    `SELECT batch_id, counted_qty, unit, counted_by, updated_at
       FROM brewery_beer_counts WHERE count_date = ?`,
  ).all(date) as BeerCountRow[];
  return new Map(rows.map((r) => [String(r.batch_id), r]));
}

/** Totals per beer AND unit — litres and kegs are never added together. */
export function beerTotalsByItem(rows: { item_name: string; unit: string; in_hand: number; produced: number; out_by_date: number }[]) {
  const map = new Map<string, { item_name: string; unit: string; batches: number; produced: number; out_by_date: number; in_hand: number }>();
  for (const r of rows) {
    const key = `${r.item_name.toLowerCase()}\u0000${r.unit.toLowerCase()}`;
    const cur = map.get(key) || { item_name: r.item_name, unit: r.unit, batches: 0, produced: 0, out_by_date: 0, in_hand: 0 };
    cur.batches += 1;
    cur.produced = round6(cur.produced + r.produced);
    cur.out_by_date = round6(cur.out_by_date + r.out_by_date);
    cur.in_hand = round6(cur.in_hand + r.in_hand);
    map.set(key, cur);
  }
  return [...map.values()];
}
