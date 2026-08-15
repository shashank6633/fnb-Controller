'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ LIVE IN-HAND STOCK — the client half of GET /api/stock-on-hand.          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * CONTRACT §4. One batched call per picker, cached for the life of the modal.
 * NEVER loop /api/department-stock?department_id=X — its dominant query is a
 * 16k-row requisition_items join that exists only to fill an informational
 * field a picker has no use for (110 ms across 19 departments).
 *
 * WHAT THIS MODULE IS FOR — the store person raising a PO or a GRN must see,
 * per material, TWO separate figures:
 *     Store  = grocery backstock + every store location
 *     Dept   = stock already issued out to departments
 * Separate, never merged: "4 kg exists somewhere in the building" does not tell
 * a buyer that 3 kg of it is already sitting in the kitchen.
 *
 * ── THE RULES THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
 *
 * 1. UNITS. Every number on the wire is in RECIPE units (g / ml) — the stored
 *    basis. Nothing here converts. Conversion happens once, at render, through
 *    toPurchaseQty() in StockOnHandNote, whose packFactor carries the
 *    both-halves guard. Never store or post back a converted figure.
 *
 * 2. NO `?? 0`, ANYWHERE ON THIS PATH. A figure we do not have is UNKNOWN, and
 *    unknown must never render as a numeral. `dept_counted_qty` comes back as
 *    JS `null` when no department has an anchored count, and it stays null all
 *    the way to the screen, where it reads "not counted". A rendered `0` may
 *    only ever mean a recorded zero. That is why the parser below is strict
 *    rather than forgiving: a half-parsed entry is DROPPED (→ "unavailable")
 *    instead of being repaired with zeros, because a confidently wrong stock
 *    figure beside a purchase order is the exact defect this feature exists to
 *    avoid.
 *
 * 3. A MATERIAL MISSING FROM THE RESPONSE MEANS UNKNOWN, NOT ZERO. Lookups
 *    return `undefined`, and the renderer says so.
 *
 * 4. FAIL LOUD, NOT LOW. A failed fetch sets `failed` and leaves the map empty,
 *    so every row reads "unavailable". It never falls back to the catalogue's
 *    `current_stock`: that is the CENTRAL figure only, and showing it under a
 *    "Store" label would understate a liquor material and invent a department
 *    figure that was never measured.
 *
 * The endpoint may not exist yet in every deployment (it ships alongside this
 * hook). A 404 is therefore treated exactly like any other failure — the
 * pickers keep working and simply say the figure is unavailable.
 */

import { useEffect, useRef, useState } from 'react';

/** One store location or one department, with the name AS IT IS RIGHT NOW. */
export interface StockLeg {
  /** store_location_id / department_id. `null` = the grocery (central) leg. */
  id: string | null;
  name: string;
  /** RECIPE units. */
  qty: number;
  /** Inactive department still holding a counted balance — shown, flagged. */
  inactive?: boolean;
}

/**
 * The per-material figure. Structurally identical to the `StockOnHand` the
 * server-side snapshot helper defines, so either type may cross the boundary.
 * Every *_qty is RECIPE units.
 */
export interface StockOnHand {
  material_id: string;
  /** Pack meta AS THE SERVER SEES IT — the renderer converts through this, not
   *  through a catalogue row that may have been edited since. */
  unit: string;
  purchase_unit: string;
  pack_size: number;
  case_size: number;
  /** raw_materials.current_stock — grocery backstock. */
  central_qty: number;
  stores: StockLeg[];
  /** central_qty + SUM(store legs). */
  store_total_qty: number;
  store_mapped: boolean;
  /** ONLY departments with a real anchored figure. A counted zero belongs here. */
  depts: StockLeg[];
  /** NULL — never 0 — when no department has an anchored figure. */
  dept_counted_qty: number | null;
  dept_counted_count: number;
  dept_uncounted_count: number;
}

/** How much of the department rail this viewer is allowed to see (CONTRACT §4.2). */
export type DeptScope = 'all' | 'partial' | 'none';

export interface StockOnHandState {
  /** material_id → figure. A MISSING KEY MEANS UNKNOWN, NOT ZERO. */
  map: Map<string, StockOnHand>;
  scope: DeptScope;
  /** Departments this viewer can see / that exist. 0 = the server did not say. */
  visible: number;
  total: number;
  /** ISO stamp the server computed at, for a tooltip. '' until loaded. */
  asOf: string;
  /** Department-ledger cutover stamp. `null` = never run, so EVERY department
   *  figure is legitimately "not counted" and the page should say so once. */
  cutoverAt: string | null;
  /** False until a successful load — do not show the cutover banner on a guess. */
  cutoverKnown: boolean;
  loading: boolean;
  /** True = we have no figures at all. Renderers must say "unavailable". */
  failed: boolean;
  error: string;
}

const EMPTY_STATE: StockOnHandState = {
  map: new Map(),
  scope: 'all',
  visible: 0,
  total: 0,
  asOf: '',
  cutoverAt: null,
  cutoverKnown: false,
  loading: true,
  failed: false,
  error: '',
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Legs, or null when ANY leg is malformed. Null means "no breakdown available"
 * — the scalar total still renders. Silently dropping one leg would leave a
 * breakdown that does not add up to its own total, which reads as a stock
 * discrepancy that does not exist.
 */
const parseLegs = (raw: unknown): StockLeg[] | null => {
  if (!Array.isArray(raw)) return null;
  const out: StockLeg[] = [];
  for (const r of raw) {
    const q = num((r as any)?.qty);
    if (q === null) return null;
    const id = (r as any)?.id;
    out.push({
      id: id === null || id === undefined ? null : String(id),
      name: String((r as any)?.name ?? '').trim(),
      qty: q,
      inactive: (r as any)?.inactive === true,
    });
  }
  return out;
};

/**
 * One wire entry → StockOnHand, or null if it cannot be trusted whole.
 * STRICT ON PURPOSE: central_qty and store_total_qty are the two figures a
 * buyer acts on, so if either is absent or unparseable the entry is dropped and
 * the row reads "unavailable". Repairing it with a zero would put a number on
 * screen that nobody measured.
 */
const parseEntry = (materialId: string, raw: any): StockOnHand | null => {
  if (!raw || typeof raw !== 'object') return null;
  const central = num(raw.central_qty);
  const storeTotal = num(raw.store_total_qty);
  if (central === null || storeTotal === null) return null;

  const countedCount = Math.max(0, Math.trunc(num(raw.dept_counted_count) ?? 0));
  const uncountedCount = Math.max(0, Math.trunc(num(raw.dept_uncounted_count) ?? 0));
  // A count of zero anchored departments has NO total — null, not 0. And a
  // server that sends a total without a count is not trusted to mean zero
  // either: the count is what decides whether the figure exists at all.
  const countedQty = countedCount > 0 ? num(raw.dept_counted_qty) : null;

  return {
    material_id: materialId,
    unit: String(raw.unit ?? '').trim(),
    purchase_unit: String(raw.purchase_unit ?? '').trim(),
    pack_size: num(raw.pack_size) ?? 1,
    case_size: num(raw.case_size) ?? 1,
    central_qty: central,
    stores: parseLegs(raw.stores) ?? [],
    store_total_qty: storeTotal,
    store_mapped: raw.store_mapped === true,
    depts: parseLegs(raw.depts) ?? [],
    dept_counted_qty: countedQty,
    dept_counted_count: countedCount,
    dept_uncounted_count: uncountedCount,
  };
};

const parseScope = (v: unknown): DeptScope =>
  v === 'partial' ? 'partial' : v === 'none' ? 'none' : 'all';

/**
 * Fetch the whole catalogue's in-hand figures ONCE, when `enabled` first turns
 * true, and hold them for the life of the component (a picker must not re-fetch
 * per keystroke, per row or per material).
 *
 * Deliberately NOT refreshed on a timer: the figure is a decision aid shown
 * while a single order is being typed, and a number that silently changes under
 * the buyer mid-line is worse than one that is a minute old. Closing and
 * reopening the composer re-reads it.
 */
export function useStockOnHand(enabled = true): StockOnHandState {
  const [state, setState] = useState<StockOnHandState>(EMPTY_STATE);
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    let alive = true;

    (async () => {
      try {
        const res = await fetch('/api/stock-on-hand');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const src = json?.materials;
        if (!src || typeof src !== 'object') throw new Error('malformed payload');

        const map = new Map<string, StockOnHand>();
        for (const [id, raw] of Object.entries(src)) {
          const parsed = parseEntry(String(id), raw);
          if (parsed) map.set(String(id), parsed);   // unparseable → absent → "unavailable"
        }

        const ds = json?.dept_scope || {};
        const cutRaw = json?.cutover_at;
        if (!alive) return;
        setState({
          map,
          scope: parseScope(ds.mode),
          visible: Math.max(0, Math.trunc(num(ds.visible) ?? 0)),
          total: Math.max(0, Math.trunc(num(ds.total) ?? 0)),
          asOf: String(json?.as_of ?? ''),
          cutoverAt: cutRaw ? String(cutRaw) : null,
          cutoverKnown: true,
          loading: false,
          failed: false,
          error: '',
        });
      } catch (e: any) {
        // Empty map + failed → every row reads "unavailable". No fallback to
        // the catalogue's current_stock: that is central-only and would be
        // presented under a "Store" label it does not answer to.
        if (!alive) return;
        setState({
          ...EMPTY_STATE,
          loading: false,
          failed: true,
          error: String(e?.message || e || 'could not load in-hand stock'),
        });
      }
    })();

    return () => { alive = false; };
  }, [enabled]);

  return state;
}
