/**
 * VALET retention (spec §11). Valet-only personal details and photos are kept
 * for the outlet's configured months (max 12), then:
 *   - photos: the image bytes are removed (the row stays, marked deleted, so the
 *     audit still shows a photo existed and who took it);
 *   - the car session: plate, guest name, guest mobile and notes are blanked and
 *     the row is stamped redacted_at (state, times and staff names stay — the
 *     operational audit is append-only and contains no contact data);
 *   - verified WhatsApp identities: the phone number is blanked;
 *   - pending/expired guest check-ins: plate/name/mobile blanked.
 * A session with an incident marked "retention hold" is skipped (narrowly: only
 * that session). Shared FNB records — customers, orders, bills, payments — are
 * NEVER touched here. This is a configurable cleanup, not automatic legal
 * compliance (docs/valet/OPERATIONS.md).
 *
 * Once per outlet per day (unique run_date), so pm2 workers cannot double-run.
 */
import type { DB, OutletValet } from './core';
import { newId } from './core';
import { nowIso, businessDate } from './config';

export function runRetention(db: DB, ov: OutletValet, now: Date = new Date()): { ran: boolean; sessions: number; photos: number; held: number } {
  const at = nowIso(now);
  const date = businessDate(now, ov.cfg);
  const cutoffDate = new Date(now);
  cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - ov.cfg.retention_months);
  const cutoff = nowIso(cutoffDate);
  const tx = db.transaction(() => {
    const claim = db.prepare(`INSERT OR IGNORE INTO valet_retention_runs (id, outlet_id, run_date, cutoff, created_at) VALUES (?,?,?,?,?)`)
      .run(newId(), ov.outlet_id, date, cutoff, at);
    if (!claim.changes) return { ran: false, sessions: 0, photos: 0, held: 0 };
    const due = db.prepare(`
      SELECT s.id, EXISTS (SELECT 1 FROM valet_incidents i WHERE i.session_id = s.id AND i.retention_hold = 1) AS held
      FROM valet_vehicle_sessions s
      WHERE s.outlet_id = ? AND s.redacted_at IS NULL AND s.state IN ('HANDED_OVER','VOIDED')
        AND COALESCE(s.handed_over_at, s.voided_at, s.checked_in_at) < ?`).all(ov.outlet_id, cutoff) as { id: string; held: number }[];
    let sessions = 0, photos = 0, held = 0;
    for (const s of due) {
      if (s.held) { held++; continue; }
      photos += db.prepare(`UPDATE valet_media SET data = NULL, deleted_at = ?, deleted_reason = 'retention' WHERE session_id = ? AND deleted_at IS NULL`).run(at, s.id).changes;
      sessions += db.prepare(`UPDATE valet_vehicle_sessions SET plate = '', plate_norm = '', guest_name = '', guest_mobile = '', notes = '', duplicate_plate_note = '',
                                handover_note = CASE WHEN handover_note = '' THEN '' ELSE '[redacted]' END, redacted_at = ? WHERE id = ?`).run(at, s.id).changes;
      db.prepare(`UPDATE valet_msg_identities SET phone = '' WHERE session_id = ?`).run(s.id);
    }
    db.prepare(`UPDATE valet_checkin_requests SET plate = '', plate_norm = '', guest_name = '', guest_mobile = ''
                WHERE outlet_id = ? AND status <> 'pending' AND created_at < ?`).run(ov.outlet_id, cutoff);
    db.prepare(`UPDATE valet_retention_runs SET sessions_redacted = ?, photos_removed = ?, held_skipped = ? WHERE outlet_id = ? AND run_date = ?`)
      .run(sessions, photos, held, ov.outlet_id, date);
    return { ran: true, sessions, photos, held };
  });
  return tx.immediate();
}
