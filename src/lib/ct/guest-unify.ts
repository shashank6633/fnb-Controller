/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unified Guest layer — one guest is ONE person across the whole platform.
 *
 * Three phone-keyed guest sources exist, each in its own format:
 *   • ct_guests   — call-to-table CRM (phone_e164, e.g. +919876543210)
 *   • crm_guests  — loyalty desk      (mobile, normalized 10-digit)
 *   • orders      — real dining/QR    (guest_mobile, captured any format)
 *
 * They are joined on the LAST 10 DIGITS of the phone (norm10) — the one key
 * that collapses +91987…, 0987…, and bare 987… to the same guest. This module
 * is pure DB/logic (no HTTP): it enriches the callers list with loyalty +
 * dining, and manufactures "synthetic" guest rows for people who are in
 * loyalty/dining but have never called (so the single Guests list is complete).
 *
 * NOTHING here mutates data — it only reads and merges. See
 * /api/crm-calls/guests (list) and /api/crm-calls/guests/[id] (360 detail).
 */
import { normalizePhone } from '@/lib/ct/phone';
import { tierForPoints, type GuestTier } from '@/lib/crm-guests';

/**
 * Reduce any phone string to a bare 10-digit join key.
 *   '+91 98765 43210' → '9876543210'
 *   '09876543210'     → '9876543210'
 *   '9876543210'      → '9876543210'
 * Returns '' when fewer than 10 digits survive (not a joinable number).
 */
export function norm10(raw: string | null | undefined): string {
  if (raw == null) return '';
  // Mirror the SQL KEY10 = substr(NORM(col), -10) EXACTLY: strip the SAME seven
  // punctuation chars the SQLite NORM macro removes (space - + ( ) . /), then
  // take the last 10 chars. Then validate digits-only so a number carrying a
  // letter/extension yields '' in BOTH the JS and SQL paths — never a split key
  // or a bogus synthetic guest. (This naturally drops the +91 / leading-0 too:
  // '+91 98765 43210' → '919876543210' → last10 '9876543210'.)
  const stripped = String(raw).replace(/[ \-+().\/]/g, '');
  const k = stripped.slice(-10);
  return /^\d{10}$/.test(k) ? k : '';
}

/** SQLite punctuation-stripping macro (no regexp) — mirrors /api/customers. */
const NORM = (col: string) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col},''),' ',''),'-',''),'+',''),'(',''),')',''),'.',''),'/','')`;
/** Last-10-digit key computed IN SQL — collapses +91 / 0 / bare variants. */
const KEY10 = (col: string) => `substr(${NORM(col)}, -10)`;

export interface LoyaltyAgg {
  crm_guest_id: string;
  name: string;
  points: number;
  tier: GuestTier;
  visit_count: number;
  total_spend: number;
  first_visit_at: string;
  last_visit_at: string | null;
}

export interface DiningAgg {
  name: string;
  orders: number;
  visits: number;
  total_spent: number;
  qr_orders: number;
  first_seen: string | null;
  last_seen: string | null;
}

/** All active loyalty guests, keyed by norm10(mobile). */
export function buildLoyaltyMap(db: any): Map<string, LoyaltyAgg> {
  const map = new Map<string, LoyaltyAgg>();
  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT id, name, mobile, points, visit_count, total_spend, first_visit_at, last_visit_at
      FROM crm_guests WHERE is_active = 1
    `).all() as any[];
  } catch { return map; }
  for (const r of rows) {
    const k = norm10(r.mobile);
    if (!k) continue;
    const points = Number(r.points) || 0;
    map.set(k, {
      crm_guest_id: String(r.id),
      name: String(r.name || '').trim(),
      points,
      tier: tierForPoints(points),
      visit_count: Number(r.visit_count) || 0,
      total_spend: Number(r.total_spend) || 0,
      first_visit_at: r.first_visit_at || '',
      last_visit_at: r.last_visit_at || null,
    });
  }
  return map;
}

/** Dining rollup from settled/open orders, keyed by norm10(guest_mobile).
 *  Two full-table passes (aggregate + latest-name-per-key via a window function)
 *  — deliberately NOT a per-group correlated subquery, which would rescan orders
 *  once per distinct phone and dominate the list endpoint's latency at scale. */
export function buildDiningMap(db: any, outletId: string | null | undefined): Map<string, DiningAgg> {
  const outlet = outletId ?? '';
  const map = new Map<string, DiningAgg>();
  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT
        ${KEY10('o.guest_mobile')} AS k,
        COUNT(*) AS orders,
        COUNT(DISTINCT date(o.created_at, '+330 minutes')) AS visits,
        MIN(o.created_at) AS first_seen,
        MAX(o.created_at) AS last_seen,
        SUM(CASE WHEN o.status = 'settled' THEN COALESCE(o.total, 0) ELSE 0 END) AS total_spent,
        SUM(CASE WHEN o.origin = 'customer' THEN 1 ELSE 0 END) AS qr_orders
      FROM orders o
      WHERE COALESCE(o.guest_mobile, '') <> '' AND o.status <> 'void'
        AND (o.outlet_id = @outlet OR o.outlet_id IS NULL)
      GROUP BY ${KEY10('o.guest_mobile')}
    `).all({ outlet }) as any[];
  } catch { return map; }

  // Latest non-empty guest_name per phone key — one windowed pass.
  const names = new Map<string, string>();
  try {
    const nameRows = db.prepare(`
      SELECT k, guest_name FROM (
        SELECT ${KEY10('o.guest_mobile')} AS k, o.guest_name AS guest_name,
               ROW_NUMBER() OVER (PARTITION BY ${KEY10('o.guest_mobile')} ORDER BY o.created_at DESC) AS rn
        FROM orders o
        WHERE COALESCE(o.guest_mobile, '') <> '' AND COALESCE(o.guest_name, '') <> ''
          AND o.status <> 'void' AND (o.outlet_id = @outlet OR o.outlet_id IS NULL)
      ) WHERE rn = 1
    `).all({ outlet }) as any[];
    for (const r of nameRows) {
      const k = String(r.k || '');
      if (/^\d{10}$/.test(k)) names.set(k, String(r.guest_name || '').trim());
    }
  } catch { /* names are best-effort; aggregates already loaded */ }

  for (const r of rows) {
    const k = String(r.k || '');
    if (!/^\d{10}$/.test(k)) continue;   // digits-only 10-digit keys (mirror norm10)
    map.set(k, {
      name: names.get(k) || '',
      orders: Number(r.orders) || 0,
      visits: Number(r.visits) || 0,
      total_spent: Math.round(Number(r.total_spent) || 0),
      qr_orders: Number(r.qr_orders) || 0,
      first_seen: r.first_seen || null,
      last_seen: r.last_seen || null,
    });
  }
  return map;
}

/** Shape a synthetic (never-called) guest row for the unified list. */
export interface SyntheticGuest {
  id: string;                 // 'phone:<norm10>' — resolvable by the detail route
  outlet_id: string;
  phone_e164: string;
  name: string;
  alt_phone: string;
  email: string;
  tags: string[];
  source: string;             // 'loyalty' | 'dine-in'
  notes: string;
  dob: string;
  anniversary: string;
  created_at: string;
  updated_at: string;
  synthetic: true;
}

/**
 * Build synthetic guest rows for phones present in loyalty/dining but NOT
 * already a ct_guest (identified by `ctKeys`). These make the single Guests
 * list exhaustive — a walk-in diner or loyalty member who never phoned still
 * appears. `id` is `phone:<norm10>` so the detail route can resolve them.
 */
export function syntheticGuests(
  ctKeys: Set<string>,
  loyalty: Map<string, LoyaltyAgg>,
  dining: Map<string, DiningAgg>,
): SyntheticGuest[] {
  const keys = new Set<string>([...loyalty.keys(), ...dining.keys()]);
  const out: SyntheticGuest[] = [];
  for (const k of keys) {
    if (!k || ctKeys.has(k)) continue;
    const l = loyalty.get(k);
    const d = dining.get(k);
    const name = (l?.name || d?.name || '').trim();
    const created = d?.first_seen || l?.first_visit_at || '';
    const updated = d?.last_seen || l?.last_visit_at || created || '';
    out.push({
      id: `phone:${k}`,
      outlet_id: '',
      phone_e164: normalizePhone(k),   // 10-digit → +91XXXXXXXXXX
      name,
      alt_phone: '',
      email: '',
      tags: [],
      source: l && !d ? 'loyalty' : 'dine-in',
      notes: '',
      dob: '',
      anniversary: '',
      created_at: created,
      updated_at: updated,
      synthetic: true,
    });
  }
  return out;
}

/** Loyalty detail (profile + visit ledger) for the 360 view. Null if none. */
export function loyaltyDetail(db: any, phone: string): { loyalty: LoyaltyAgg; visits: any[] } | null {
  const m = norm10(phone);
  if (!m) return null;
  let g: any;
  try {
    g = db.prepare(`SELECT * FROM crm_guests WHERE mobile = ?`).get(m) as any;
  } catch { return null; }
  if (!g) return null;
  const points = Number(g.points) || 0;
  let visits: any[] = [];
  try {
    visits = db.prepare(`
      SELECT id, order_id, bill_amount, points_earned, visited_at, source
      FROM crm_guest_visits WHERE guest_id = ? ORDER BY visited_at DESC LIMIT 100
    `).all(g.id) as any[];
  } catch { visits = []; }
  return {
    loyalty: {
      crm_guest_id: String(g.id),
      name: String(g.name || '').trim(),
      points,
      tier: tierForPoints(points),
      visit_count: Number(g.visit_count) || 0,
      total_spend: Number(g.total_spend) || 0,
      first_visit_at: g.first_visit_at || '',
      last_visit_at: g.last_visit_at || null,
    },
    visits,
  };
}

/** Dining detail (order history + summary) for the 360 view, keyed by phone. */
export function diningDetail(
  db: any,
  outletId: string | null | undefined,
  phone: string,
): { summary: DiningAgg; orders: any[] } {
  const outlet = outletId ?? '';
  const empty: DiningAgg = {
    name: '', orders: 0, visits: 0, total_spent: 0, qr_orders: 0, first_seen: null, last_seen: null,
  };
  const m = norm10(phone);
  if (!m) return { summary: empty, orders: [] };
  let orders: any[] = [];
  try {
    orders = db.prepare(`
      SELECT o.id, o.order_number, o.status, o.origin, o.total, o.created_at, o.settled_at,
             o.guest_name, rt.table_number,
             (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
      FROM orders o
      LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
      WHERE ${KEY10('o.guest_mobile')} = @m
        AND o.status <> 'void'
        AND (o.outlet_id = @outlet OR o.outlet_id IS NULL)
      ORDER BY o.created_at DESC
      LIMIT 200
    `).all({ m, outlet }) as any[];
  } catch { orders = []; }

  const dates = new Set<string>();
  let total_spent = 0, qr_orders = 0;
  let first_seen: string | null = null, last_seen: string | null = null, name = '';
  for (const o of orders) {
    if (o.created_at) {
      dates.add(String(o.created_at).slice(0, 10));   // coarse day bucket (UTC ok for count)
      if (!last_seen || o.created_at > last_seen) last_seen = o.created_at;
      if (!first_seen || o.created_at < first_seen) first_seen = o.created_at;
    }
    if (o.status === 'settled') total_spent += Number(o.total) || 0;
    if (o.origin === 'customer') qr_orders += 1;
    if (!name && String(o.guest_name || '').trim()) name = String(o.guest_name).trim();
  }
  return {
    summary: {
      name,
      orders: orders.length,
      visits: dates.size,
      total_spent: Math.round(total_spent),
      qr_orders,
      first_seen,
      last_seen,
    },
    orders,
  };
}
