/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Guest auto-capture — the ONE intentional writer into ct_guests from dining /
 * loyalty activity. (guest-unify.ts stays pure-read; this file mutates.)
 *
 * Why: a person seen only in orders (dining/QR) or the loyalty desk used to
 * appear in the CRM Guests list as a read-only "synthetic" row (phone:<10>)
 * with no ct_guests record — so notes, tags, follow-ups and call-linking had
 * nowhere to attach. Materializing a real ct_guests row the moment we see a
 * phone gives the CRM complete, editable data.
 *
 * Contract:
 *   • Idempotent + dupe-proof — keyed on the last-10-digit phone → +91XXXXXXXXXX
 *     (the same phone_e164 format the whole platform stores). A UNIQUE race is
 *     swallowed, never surfaced.
 *   • Never overwrites curated data — an existing guest is left untouched except
 *     that a BLANK name is backfilled from the dining/loyalty name.
 *   • Never throws to the caller — an order/loyalty write must never fail because
 *     CRM capture hiccuped, so every path is wrapped and errors are logged only.
 *   • Invalid phones (fewer than 10 digits, letters/extensions) create NOTHING
 *     — norm10 returns '' and we no-op.
 *
 * syntheticGuests() already excludes any phone present in ct_guests, so once a
 * row is materialized here it simply becomes a real entry in the unified list
 * with zero duplication.
 */
import { normalizePhone } from '@/lib/ct/phone';
import { norm10 } from '@/lib/ct/guest-unify';

export interface GuestContact {
  phone: unknown;
  name?: unknown;
  /** 'dine-in' (default) or 'loyalty' — tags where the guest was first seen. */
  source?: string;
  outletId?: string | null;
}

/**
 * Upsert one dining/loyalty contact into ct_guests. Safe to call from any order
 * or loyalty write path. Returns the guest id when a row exists/was created,
 * else null (invalid phone). Best-effort: swallows all errors.
 */
export function autoSaveCrmGuest(db: any, contact: GuestContact): string | null {
  try {
    const key = norm10(String(contact?.phone ?? ''));
    if (!key) return null;                       // not a joinable 10-digit number
    const e164 = normalizePhone(key);            // '9876543210' → '+919876543210'
    if (!e164) return null;
    const name = String(contact?.name ?? '').trim();

    const existing = db
      .prepare('SELECT id, name FROM ct_guests WHERE phone_e164 = ?')
      .get(e164) as { id: string; name: string } | undefined;

    if (existing) {
      // Backfill a blank name only — never clobber a name the CRM team curated.
      if (name && !String(existing.name || '').trim()) {
        db.prepare("UPDATE ct_guests SET name = ?, updated_at = datetime('now') WHERE id = ?")
          .run(name, existing.id);
      }
      return existing.id;
    }

    const id = crypto.randomUUID();
    const source = contact?.source === 'loyalty' ? 'loyalty' : 'dine-in';
    db.prepare(`
      INSERT INTO ct_guests (id, outlet_id, phone_e164, name, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(id, String(contact?.outletId ?? ''), e164, name, source);
    return id;
  } catch (e: any) {
    // A UNIQUE(phone_e164) race means another writer just created it — benign.
    if (!String(e?.message || '').includes('UNIQUE')) {
      console.warn('[autoSaveCrmGuest]', e?.message || e);
    }
    return null;
  }
}

/**
 * One-time backfill: materialize every existing dining + loyalty guest into
 * ct_guests. Dining first (newest name wins on insert), then loyalty (creates
 * loyalty-only guests, backfills blank names on shared ones). Idempotent — the
 * per-row existence check makes re-runs harmless. Returns how many were created.
 * Called from the settings-guarded migration in db.ts.
 */
export function backfillCrmGuestsFromDiningAndLoyalty(db: any): number {
  const before = (db.prepare('SELECT COUNT(*) AS n FROM ct_guests').get() as any)?.n ?? 0;

  // Dining: one representative row per phone, newest non-blank name preferred.
  const dining = db.prepare(`
    SELECT guest_mobile AS phone,
           guest_name   AS name,
           outlet_id    AS outletId
    FROM orders
    WHERE COALESCE(guest_mobile, '') <> '' AND status <> 'void'
    ORDER BY (CASE WHEN COALESCE(guest_name,'') <> '' THEN 0 ELSE 1 END), created_at DESC
  `).all() as any[];
  for (const r of dining) {
    autoSaveCrmGuest(db, { phone: r.phone, name: r.name, source: 'dine-in', outletId: r.outletId });
  }

  // Loyalty: creates loyalty-only guests; shared phones only get a blank-name fill.
  const loyalty = db.prepare(`
    SELECT mobile AS phone, name FROM crm_guests WHERE COALESCE(mobile, '') <> ''
  `).all() as any[];
  for (const r of loyalty) {
    autoSaveCrmGuest(db, { phone: r.phone, name: r.name, source: 'loyalty' });
  }

  const after = (db.prepare('SELECT COUNT(*) AS n FROM ct_guests').get() as any)?.n ?? 0;
  return after - before;
}
