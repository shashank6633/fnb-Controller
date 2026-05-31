/**
 * Refresh the upcoming-parties cache from the AKAN Party Manager sheet,
 * detect status changes since the last refresh, and dispatch notifications
 * for newly-approved events within 24h of their date.
 *
 * Designed to be called by:
 *   - the in-process scheduler (every 15 min on the production server)
 *   - the manual admin trigger at /api/cron/refresh-parties
 *   - the /api/upcoming-parties POST endpoint (force-refresh from the UI)
 *
 * Side-effects (all in one DB transaction):
 *   1. Writes `upcoming_parties_cache` in settings (existing behavior)
 *   2. Writes `party_status_audit` rows for any status changes detected
 *   3. Enqueues `notifications` rows for Draft→Approved transitions where
 *      event_date - now <= 24h, dispatches Slack webhook if configured
 *   4. Vacuums party_status_audit rows older than 90 days
 *
 * Returns counts so callers can show feedback in the UI.
 */
import { readSheet } from './sheets-client';
import { mapRowToUpcomingParty, UpcomingParty } from './fp-records-mapper';
import { getDb, generateId } from './db';

const SHEET_ID = '1VYpxSOjcHHRPkBb7f7s1bfBFcl-M25PnxkjpEdXFbJI';
const TAB_NAME = 'F&P Records';
const RANGE    = `${TAB_NAME}!A2:BO`;
const AUDIT_RETENTION_DAYS = 90;

export interface RefreshResult {
  fetched_parties: number;
  status_changes: number;
  notifications_created: number;
  slack_sent: number;
  errors: string[];
}

export async function refreshUpcomingParties(triggeredBy: string = 'cron'): Promise<RefreshResult> {
  const errors: string[] = [];
  let statusChanges = 0;
  let notifsCreated = 0;
  let slackSent = 0;

  // 1. Fetch live sheet
  const rows = await readSheet(SHEET_ID, RANGE);
  const parties = rows
    .map(mapRowToUpcomingParty)
    .filter((p): p is UpcomingParty => p !== null);

  const db = getDb();

  // 2. Load previous cache so we can diff statuses
  const prevRow = db.prepare(`SELECT value FROM settings WHERE key = 'upcoming_parties_cache'`)
    .get() as { value: string } | undefined;
  const prevByUid = new Map<string, { status?: string; event_name?: string; event_date?: string; fp_id?: string }>();
  if (prevRow) {
    try {
      const parsed = JSON.parse(prevRow.value);
      for (const p of (parsed.parties || [])) {
        if (p.party_unique_id) prevByUid.set(p.party_unique_id, {
          status: p.status,
          event_name: p.contact_person || p.guest_name || p.company || p.fp_id,
          event_date: p.date_of_event,
          fp_id: p.fp_id,
        });
      }
    } catch { /* malformed cache → treat as fresh */ }
  }

  // 3. Annotate with linked_req flag (same logic as the route)
  const reqLookup = db.prepare(`
    SELECT event_name, event_date, COUNT(*) AS n
    FROM requisitions
    WHERE purpose = 'party'
    GROUP BY event_name, event_date
  `).all() as { event_name: string; event_date: string; n: number }[];
  const linkedKey = new Set(reqLookup.map(r => `${(r.event_name || '').trim().toLowerCase()}|${r.event_date || ''}`));
  const linkedCount = new Map<string, number>();
  for (const r of reqLookup) linkedCount.set(`${(r.event_name || '').trim().toLowerCase()}|${r.event_date || ''}`, r.n);

  const annotated = parties.map(p => {
    // Per AKAN sheet convention: contact_person (Column P) is the Customer
    // Name. We try it first when probing for an existing linked requisition
    // (older reqs may have used guest_name or company instead).
    const candidateNames = [p.contact_person, p.guest_name, p.company, p.fp_id].filter(Boolean) as string[];
    let linked = false, linked_req_count = 0;
    for (const name of candidateNames) {
      const k = `${name.trim().toLowerCase()}|${p.date_of_event || ''}`;
      if (linkedKey.has(k)) { linked = true; linked_req_count = linkedCount.get(k) || 0; break; }
    }
    return { ...p, linked, linked_req_count };
  });

  // 4. Diff statuses + write audit + enqueue notifications
  const insertAudit = db.prepare(`
    INSERT INTO party_status_audit (id, party_unique_id, fp_id, event_name, event_date, old_status, new_status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertNotif = db.prepare(`
    INSERT OR IGNORE INTO notifications
      (id, kind, party_unique_id, fp_id, event_name, event_date, channel, title, body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date();
  const slackPings: { title: string; body: string }[] = [];

  const txn = db.transaction(() => {
    for (const p of annotated) {
      const prev = p.party_unique_id ? prevByUid.get(p.party_unique_id) : null;
      const oldStatus = (prev?.status || '').trim();
      const newStatus = (p.status || '').trim();
      if (!p.party_unique_id) continue;
      // Only audit real changes (skip initial-load when prev was null)
      if (prev && oldStatus.toLowerCase() !== newStatus.toLowerCase()) {
        const eventName = p.contact_person || p.guest_name || p.company || p.fp_id;
        insertAudit.run(generateId(), p.party_unique_id, p.fp_id, eventName, p.date_of_event,
                        oldStatus || null, newStatus || null, triggeredBy);
        statusChanges += 1;

        // Notification trigger: any status → Approved AND event within 24h
        const justApproved = newStatus.toLowerCase() === 'approved'
                           && oldStatus.toLowerCase() !== 'approved';
        if (justApproved && p.date_of_event) {
          const eventTs = Date.parse(p.date_of_event);
          if (Number.isFinite(eventTs)) {
            const hoursUntil = (eventTs - now.getTime()) / 3_600_000;
            if (hoursUntil >= 0 && hoursUntil <= 24) {
              const title = `🚨 Party approved <24h: ${eventName} on ${p.date_of_event}`;
              const body = `FP ${p.fp_id} · ${p.min_guarantee || p.pax_expected || '?'} pax · ${eventName}` +
                           ` · Just flipped to Approved with ${hoursUntil.toFixed(1)}h to event.` +
                           ` Raise requisitions immediately.`;
              const r = insertNotif.run(generateId(), 'party_approved_within_24h',
                                         p.party_unique_id, p.fp_id, eventName, p.date_of_event,
                                         'slack', title, body);
              if (r.changes > 0) {
                notifsCreated += 1;
                slackPings.push({ title, body });
              }
              // Also queue an inapp notification so admins see it in the UI
              insertNotif.run(generateId(), 'party_approved_within_24h',
                              p.party_unique_id, p.fp_id, eventName, p.date_of_event,
                              'inapp', title, body);
            }
          }
        }
      }
    }

    // 5. Persist the new cache
    const payload = {
      parties: annotated,
      fetched_at: new Date().toISOString(),
      source: 'live' as const,
    };
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('upcoming_parties_cache', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(payload));

    // 6. Vacuum old audit rows
    db.prepare(`DELETE FROM party_status_audit WHERE detected_at < date('now', '-${AUDIT_RETENTION_DAYS} day')`).run();
  });
  txn();

  // 7. Dispatch Slack webhook (outside the DB transaction — best-effort, never throws into refresh)
  if (slackPings.length > 0) {
    const webhookRow = db.prepare(`SELECT value FROM settings WHERE key = 'slack_webhook_url'`).get() as { value: string } | undefined;
    const webhook = webhookRow?.value?.trim();
    if (webhook) {
      for (const ping of slackPings) {
        try {
          const r = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: `${ping.title}\n${ping.body}`,
            }),
          });
          if (r.ok) {
            slackSent += 1;
            db.prepare(`UPDATE notifications SET sent_at = datetime('now'), delivery_meta = 'ok' WHERE party_unique_id IS NOT NULL AND title = ? AND channel = 'slack' AND sent_at IS NULL`).run(ping.title);
          } else {
            errors.push(`Slack ${r.status}: ${ping.title}`);
          }
        } catch (e: any) {
          errors.push(`Slack ${e?.message}: ${ping.title}`);
        }
      }
    }
  }

  return {
    fetched_parties: annotated.length,
    status_changes: statusChanges,
    notifications_created: notifsCreated,
    slack_sent: slackSent,
    errors,
  };
}
