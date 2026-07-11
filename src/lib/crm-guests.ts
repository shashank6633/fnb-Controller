/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Guest Database + Loyalty — pure lib (no HTTP).
 *
 * Guests are keyed by NORMALIZED 10-digit Indian mobile (crm_guests.mobile is
 * UNIQUE). Every visit appends a crm_guest_visits row and rolls up onto the
 * guest (visit_count / last_visit_at / total_spend / points).
 *
 * Points: bill_amount / 100 × settings.crm_loyalty_points_per_100 (default 1).
 * Tier is COMPUTED from points (never stored): Bronze <500, Silver <1500,
 * Gold ≥1500 — see tierForPoints().
 *
 * The POS settle hook (later pass) calls upsertGuestVisit() — the same call
 * POST /api/crm/guests/visit makes today for manual entry.
 */
import { getDb, generateId } from '@/lib/db';

export interface CrmGuest {
  id: string;
  name: string;
  mobile: string;
  birthday: string;
  notes: string;
  first_visit_at: string;
  last_visit_at: string | null;
  visit_count: number;
  total_spend: number;
  points: number;
  is_active: number;
  created_at: string;
}

export interface CrmGuestVisit {
  id: string;
  guest_id: string;
  order_id: string;
  bill_amount: number;
  points_earned: number;
  visited_at: string;
  source: string;
}

export type GuestTier = 'Bronze' | 'Silver' | 'Gold';

/** Bronze <500 pts, Silver 500–1499, Gold ≥1500. Computed, never stored. */
export function tierForPoints(points: number): GuestTier {
  const p = Number(points) || 0;
  if (p >= 1500) return 'Gold';
  if (p >= 500) return 'Silver';
  return 'Bronze';
}

/**
 * Normalize an Indian mobile to bare 10 digits.
 *   '+91 98765 00001' → '9876500001'
 *   '09876500001'     → '9876500001'
 *   '9876500001'      → '9876500001'
 * Returns null when the input can't resolve to exactly 10 digits.
 */
export function normalizeMobile(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let d = String(raw).replace(/\D/g, '');       // strip +, spaces, dashes, etc.
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

/** Loyalty accrual rate: points per ₹100 billed (settings-driven, default 1). */
export function loyaltyPointsPer100(): number {
  try {
    const row = getDb().prepare(`SELECT value FROM settings WHERE key = 'crm_loyalty_points_per_100'`).get() as any;
    const n = parseFloat(row?.value);
    return Number.isFinite(n) && n >= 0 ? n : 1;
  } catch { return 1; }
}

/** Fetch a guest by mobile (any format — normalized here). Null if absent. */
export function getGuest(mobile: string): CrmGuest | null {
  const m = normalizeMobile(mobile);
  if (!m) return null;
  return (getDb().prepare(`SELECT * FROM crm_guests WHERE mobile = ?`).get(m) as CrmGuest | undefined) ?? null;
}

/**
 * Search guests by name or mobile fragment. Empty query → most recent guests.
 * Sorted by last_visit_at DESC (never-visited last, newest-created first).
 */
export function searchGuests(q: string, limit = 100): CrmGuest[] {
  const db = getDb();
  const lim = Math.max(1, Math.min(500, Math.floor(limit) || 100));
  const order = `ORDER BY (last_visit_at IS NULL), last_visit_at DESC, created_at DESC`;
  const query = String(q || '').trim();
  if (!query) {
    return db.prepare(`SELECT * FROM crm_guests ${order} LIMIT ?`).all(lim) as CrmGuest[];
  }
  const like = `%${query}%`;
  // A digits-only query also matches the normalized mobile column directly.
  const digits = query.replace(/\D/g, '');
  return db.prepare(`
    SELECT * FROM crm_guests
    WHERE name LIKE ? COLLATE NOCASE OR mobile LIKE ?
    ${order} LIMIT ?
  `).all(like, `%${digits || query}%`, lim) as CrmGuest[];
}

export interface UpsertVisitInput {
  mobile: string;
  name?: string;
  bill_amount: number;
  order_id?: string;
  source?: string;       // 'pos' (default) | 'manual' | …
}

/**
 * Record a visit: find-or-create the guest by mobile, bump the rollups
 * (visit_count / last_visit_at / total_spend / points), append the visit row.
 * Runs in a single transaction. Returns the updated guest.
 *
 * Throws Error('invalid mobile') when the mobile can't normalize to 10 digits.
 * This is THE entry point the POS settle hook will call in a later pass.
 */
export function upsertGuestVisit(input: UpsertVisitInput): CrmGuest {
  const m = normalizeMobile(input.mobile);
  if (!m) throw new Error('invalid mobile');
  const bill = Number(input.bill_amount);
  if (!Number.isFinite(bill) || bill < 0) throw new Error('invalid bill_amount');

  const db = getDb();
  const rate = loyaltyPointsPer100();
  const pointsEarned = (bill / 100) * rate;
  const name = String(input.name || '').trim();
  const orderId = String(input.order_id || '');
  const source = String(input.source || 'pos');

  const tx = db.transaction((): CrmGuest => {
    let guest = db.prepare(`SELECT * FROM crm_guests WHERE mobile = ?`).get(m) as CrmGuest | undefined;
    if (!guest) {
      const id = generateId();
      db.prepare(`
        INSERT INTO crm_guests (id, name, mobile) VALUES (?, ?, ?)
      `).run(id, name, m);
      guest = db.prepare(`SELECT * FROM crm_guests WHERE id = ?`).get(id) as CrmGuest;
    } else if (name && !String(guest.name || '').trim()) {
      // Backfill a name we learn later (never overwrite an existing one here).
      db.prepare(`UPDATE crm_guests SET name = ? WHERE id = ?`).run(name, guest.id);
    }

    db.prepare(`
      UPDATE crm_guests SET
        visit_count   = visit_count + 1,
        last_visit_at = datetime('now'),
        total_spend   = total_spend + ?,
        points        = points + ?
      WHERE id = ?
    `).run(bill, pointsEarned, guest.id);

    db.prepare(`
      INSERT INTO crm_guest_visits (id, guest_id, order_id, bill_amount, points_earned, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(generateId(), guest.id, orderId, bill, pointsEarned, source);

    return db.prepare(`SELECT * FROM crm_guests WHERE id = ?`).get(guest.id) as CrmGuest;
  });

  return tx();
}
