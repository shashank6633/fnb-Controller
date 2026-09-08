/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Broadcast-campaign side-effects of the WhatsApp webhook — called from
 * wa-inbox.ts ingest, NEVER the other way round (wa-broadcast.ts imports
 * wa-inbox.ts, so these hooks live in their own module to keep the import
 * graph acyclic: wa-inbox → wa-campaign-hooks → wa-consent).
 *
 * BOTH hooks are best-effort by contract: they are invoked inside try/catch at
 * the call sites AND swallow their own errors, because a campaign-table fault
 * must never break inbox ingest (the raw archive + thread are the seniors).
 *
 * 1. broadcastOnInbound — fires once per NEW inbound message (after the wamid
 *    dedupe, so a webhook retry / backlog replay cannot double-fire):
 *      • STOP-class detection → wa_marketing_consent opted_out. The webhook is
 *        public/unsigned; a forged POST can only opt someone OUT (fail-safe).
 *      • 'replied' marking — any reply from a phone we campaigned recently
 *        upgrades those recipient rows (sent/delivered/read → replied).
 *
 * 2. broadcastOnStatus — fires when a delivery status lands for a wamid:
 *      • mirrors the wa_messages MONOTONE ladder onto wa_campaign_recipients
 *        (sent → delivered → read; replied never downgrades).
 *      • 'failed' is classified by Meta error code (statusErrorDetail puts the
 *        code first in error_detail):
 *          131049 / 130472 → 'capped' (per-user marketing frequency cap /
 *                            Meta experiment — NOT a real failure)
 *          131050          → 'failed' + consent revoked (user opted out of
 *                            marketing at the WhatsApp level)
 *          anything else   → 'failed'
 *        Code semantics per Meta Cloud API error docs; re-verify against the
 *        current docs before edits — the classifier lives ONLY here.
 */
import type Database from 'better-sqlite3';
import { detectStop, setConsent } from '@/lib/wa-consent';

type DB = Database.Database;

/** How far back a reply still counts as a reply TO a campaign message (days). */
export const REPLY_ATTRIBUTION_DAYS = 7;

/** Meta error codes that mean "capped", not "failed". */
export const CAPPED_ERROR_CODES = [131049, 130472];
/** Meta error code: user opted out of marketing at the WhatsApp level. */
export const META_OPTOUT_ERROR_CODE = 131050;

/** Leading integer of an error_detail ('131049 — …'), or null. */
export function errorCodeOf(errDetail: string): number | null {
  const m = /^\s*(\d{3,7})\b/.exec(String(errDetail || ''));
  return m ? Number(m[1]) : null;
}

export function broadcastOnInbound(db: DB, phoneKey: string, msgType: string, body: string, ts: string): void {
  try {
    const key = String(phoneKey || '').trim();
    if (!key) return;

    // STOP-class message → standing opt-out (idempotent; a repeat STOP just
    // refreshes the row and appends to the audit log).
    const kw = detectStop(db, msgType, body);
    if (kw) {
      setConsent(db, { phoneKey: key, status: 'opted_out', source: 'stop_keyword', detail: kw });
    }

    // Replied marking — only recipients we actually reached, only recently.
    // (A STOP is still a reply: the guest responded, and is now opted out.)
    const cutoff = new Date(Date.now() - REPLY_ATTRIBUTION_DAYS * 86_400_000)
      .toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(`
      UPDATE wa_campaign_recipients
      SET state = 'replied', replied_at = ?
      WHERE phone_key = ? AND state IN ('sent', 'delivered', 'read')
        AND sent_at IS NOT NULL AND sent_at >= ?
    `).run(ts || new Date().toISOString().slice(0, 19).replace('T', ' '), key, cutoff);
  } catch (e: any) {
    console.error('[wa-campaign-hooks] broadcastOnInbound failed:', e?.message);
  }
}

/** Recipient ladder ranks — replied outranks read so a status can't undo it. */
const RECIPIENT_RANK: Record<string, number> = {
  sent: 1, delivered: 2, read: 3, replied: 4,
};

export function broadcastOnStatus(db: DB, wamid: string, status: string, ts: string, errDetail: string): void {
  try {
    const id = String(wamid || '').trim();
    const st = String(status || '').trim().toLowerCase();
    if (!id || !st) return;

    const rows = db.prepare(`
      SELECT id, phone_key, state FROM wa_campaign_recipients WHERE wamid = ?
    `).all(id) as any[];
    if (!rows.length) return;
    const when = ts || new Date().toISOString().slice(0, 19).replace('T', ' ');

    for (const r of rows) {
      const cur = RECIPIENT_RANK[String(r.state)] ?? 0;
      if (st === 'delivered' || st === 'read') {
        const next = RECIPIENT_RANK[st];
        if (next > cur && cur >= 1) {   // only forward, and only from a sent-class state
          db.prepare(`
            UPDATE wa_campaign_recipients
            SET state = ?, ${st === 'read' ? 'read_at' : 'delivered_at'} = ?
            WHERE id = ? AND state IN ('sent', 'delivered')
          `).run(st, when, r.id);
        }
        continue;
      }
      if (st === 'failed') {
        // A message the guest already read/replied to cannot retro-fail.
        if (cur >= 3) continue;
        const code = errorCodeOf(errDetail);
        const finalState = code != null && CAPPED_ERROR_CODES.includes(code) ? 'capped' : 'failed';
        db.prepare(`
          UPDATE wa_campaign_recipients
          SET state = ?, failed_at = ?, error_detail = ?
          WHERE id = ? AND state IN ('sent', 'delivered', 'sending')
        `).run(finalState, when, String(errDetail || '').slice(0, 500), r.id);
        if (code === META_OPTOUT_ERROR_CODE && r.phone_key) {
          // Meta says this user opted out of marketing at the WhatsApp level —
          // honour it locally so we stop attempting them at all.
          setConsent(db, {
            phoneKey: String(r.phone_key), status: 'opted_out',
            source: 'meta_131050', detail: String(errDetail || '').slice(0, 200),
          });
        }
      }
    }
  } catch (e: any) {
    console.error('[wa-campaign-hooks] broadcastOnStatus failed:', e?.message);
  }
}
