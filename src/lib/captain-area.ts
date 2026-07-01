import type Database from 'better-sqlite3';
import type { SessionUser } from './auth';

/**
 * Captain area restriction. When the `captain_area_lock` setting is ON and `me`
 * is a plain captain (staff tier) who HAS an area assignment, returns a SQL
 * WHERE fragment (over alias `t` = restaurant_tables) + params limiting them to
 * their assigned zones/tables. Returns null when there is NO restriction, i.e.:
 *   - the lock is off,
 *   - the user is admin/manager (they run the whole floor), or
 *   - the captain has no assignment (unassigned = all, so nobody is locked out).
 * Note: an empty table zone ('') displays as 'Floor' in the captain UI, so an
 * assignment of 'Floor' also matches unzoned tables.
 */
export function captainAreaFilter(
  db: Database.Database,
  me: SessionUser | null,
): { sql: string; params: any[] } | null {
  if (!me || me.role !== 'staff') return null;
  const lock = db.prepare("SELECT value FROM settings WHERE key = 'captain_area_lock'").get() as any;
  if (lock?.value !== '1') return null;

  let zones: string[] = [];
  let tableIds: string[] = [];
  try { const z = JSON.parse(me.preferred_zones || '[]'); if (Array.isArray(z)) zones = z; } catch { /* ignore */ }
  try { const t = JSON.parse(me.preferred_table_ids || '[]'); if (Array.isArray(t)) tableIds = t; } catch { /* ignore */ }
  if (zones.length === 0 && tableIds.length === 0) return null;

  const zoneVals = zones.flatMap((z) => (z === 'Floor' ? ['Floor', ''] : [z]));
  const clauses: string[] = [];
  const params: any[] = [];
  if (zoneVals.length) { clauses.push(`t.zone IN (${zoneVals.map(() => '?').join(',')})`); params.push(...zoneVals); }
  if (tableIds.length) { clauses.push(`t.id IN (${tableIds.map(() => '?').join(',')})`); params.push(...tableIds); }
  return { sql: `(${clauses.join(' OR ')})`, params };
}

/** True if `me` is allowed to open/work the given table id (honors the lock). */
export function canWorkTable(db: Database.Database, me: SessionUser | null, tableId: string): boolean {
  const f = captainAreaFilter(db, me);
  if (!f) return true; // no restriction in effect
  const row = db.prepare(`SELECT 1 AS ok FROM restaurant_tables t WHERE t.id = ? AND ${f.sql}`).get(tableId, ...f.params) as any;
  return !!row?.ok;
}
