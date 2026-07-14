import { getDb } from './db';
import { reorderSuggestions } from './crm-analyst-data';

/**
 * WhatsApp Integration — provider-pluggable foundation.
 *
 * Central home for every current/future WhatsApp capability:
 *   - settings-backed config (Meta Cloud API today; Twilio et al later)
 *   - message templates with {{placeholder}} substitution
 *   - sendWhatsAppMessage(): the ONE outbound door. Cleanly refuses with
 *     { ok:false, reason:'not_configured' } until an admin wires credentials,
 *     so callers can be added now and "light up" later.
 *   - buildWaMeLink(): zero-credential wa.me deep-link fallback (same scheme
 *     the existing review-request feature uses — that feature is untouched).
 *
 * NOTE: no credentials exist yet in this deployment. The Meta Cloud call path
 * below is real but only reachable once config is complete.
 */

/** Settings keys owned by this module (whitelist for setWaConfig). */
export const WA_CONFIG_KEYS = [
  'wa_api_provider',          // 'meta_cloud' | 'twilio' (coming soon) | 'wame'
  'wa_phone_number_id',
  'wa_business_account_id',
  'wa_access_token',          // secret — masked on read
  'wa_webhook_verify_token',  // secret — masked on read
  'wa_notifications_enabled', // '1' | '0' master switch
] as const;
export type WaConfigKey = typeof WA_CONFIG_KEYS[number];

const SECRET_KEYS: WaConfigKey[] = ['wa_access_token', 'wa_webhook_verify_token'];

export interface WaConfig {
  wa_api_provider: string;
  wa_phone_number_id: string;
  wa_business_account_id: string;
  /** Masked: '' when unset, '••••' + last 4 chars when set. Never the raw token. */
  wa_access_token: string;
  wa_access_token_set: boolean;
  /** Masked like the access token. */
  wa_webhook_verify_token: string;
  wa_webhook_verify_token_set: boolean;
  wa_notifications_enabled: boolean;
  /** True when the selected provider has everything it needs to actually send. */
  configured: boolean;
}

function readSetting(key: string): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

/** '••••' + last 4 — enough to recognise a token without leaking it. */
export function maskSecret(v: string): string {
  if (!v) return '';
  return '••••' + v.slice(-4);
}

/** Raw config for the send path ONLY. Never return this from an API route. */
export function getWaConfigRaw(): Record<WaConfigKey, string> {
  const out = {} as Record<WaConfigKey, string>;
  for (const k of WA_CONFIG_KEYS) out[k] = readSetting(k);
  if (!out.wa_api_provider) out.wa_api_provider = 'meta_cloud';
  return out;
}

/** Is the send path actually usable with the current provider + credentials? */
export function isWaConfigured(raw?: Record<WaConfigKey, string>): boolean {
  const c = raw ?? getWaConfigRaw();
  if (c.wa_api_provider !== 'meta_cloud') return false; // twilio: coming soon; wame: link-only
  return !!(c.wa_phone_number_id.trim() && c.wa_access_token.trim());
}

/** Masked, UI-safe config. Secrets come back as ••••last4. */
export function getWaConfig(): WaConfig {
  const raw = getWaConfigRaw();
  return {
    wa_api_provider: raw.wa_api_provider,
    wa_phone_number_id: raw.wa_phone_number_id,
    wa_business_account_id: raw.wa_business_account_id,
    wa_access_token: maskSecret(raw.wa_access_token),
    wa_access_token_set: !!raw.wa_access_token,
    wa_webhook_verify_token: maskSecret(raw.wa_webhook_verify_token),
    wa_webhook_verify_token_set: !!raw.wa_webhook_verify_token,
    wa_notifications_enabled: raw.wa_notifications_enabled === '1',
    configured: isWaConfigured(raw),
  };
}

/** Upsert one config key (whitelisted). Returns false for unknown keys. */
export function setWaConfig(key: string, value: string): boolean {
  if (!(WA_CONFIG_KEYS as readonly string[]).includes(key)) return false;
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value ?? ''));
  return true;
}

export function isWaSecretKey(key: string): boolean {
  return (SECRET_KEYS as readonly string[]).includes(key as WaConfigKey);
}

/**
 * Render a template body: '{{name}}' → vars.name. Unknown placeholders are
 * left intact so a preview makes gaps obvious. Whitespace inside the braces
 * is tolerated ({{ name }}).
 */
export function renderTemplate(body: string, vars: Record<string, string | number>): string {
  return String(body ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  );
}

/** Normalise an Indian mobile to digits with country code for the API / wa.me. */
export function normalizeWaNumber(mobile: string): string {
  const digits = String(mobile || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;          // bare Indian mobile
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return digits;                                           // already E.164-ish
}

/**
 * wa.me fallback — opens a chat with the text pre-filled; user taps send.
 * Needs no credentials. (Same scheme as the existing review-request links.)
 */
export function buildWaMeLink(mobile: string, text: string): string {
  const num = normalizeWaNumber(mobile);
  const q = text ? `?text=${encodeURIComponent(text)}` : '';
  return num ? `https://wa.me/${num}${q}` : `https://wa.me/${q}`;
}

export type WaSendResult =
  | { ok: true; provider: string; message_id?: string }
  | { ok: false; reason: 'not_configured' | 'send_failed'; detail?: string };

/**
 * Send a plain-text WhatsApp message via the configured provider.
 * Provider-pluggable: today only Meta Cloud API has a live path. Incomplete
 * config NEVER throws — it returns { ok:false, reason:'not_configured' } so
 * feature code can call this unconditionally.
 */
export async function sendWhatsAppMessage(to: string, body: string): Promise<WaSendResult> {
  const raw = getWaConfigRaw();
  if (!isWaConfigured(raw)) return { ok: false, reason: 'not_configured' };

  // Meta Cloud API (graph.facebook.com) — the only live provider today.
  try {
    const toNum = normalizeWaNumber(to);
    if (!toNum || !body) return { ok: false, reason: 'send_failed', detail: 'Missing recipient or message body' };
    const r = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(raw.wa_phone_number_id.trim())}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${raw.wa_access_token.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toNum,
        type: 'text',
        text: { preview_url: false, body },
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, reason: 'send_failed', detail: j?.error?.message || `Meta API HTTP ${r.status}` };
    }
    return { ok: true, provider: 'meta_cloud', message_id: j?.messages?.[0]?.id };
  } catch (e: any) {
    return { ok: false, reason: 'send_failed', detail: e?.message || 'Network error' };
  }
}

/* ═══════════════ Event notifications (fire-and-forget) ═══════════════ */

/**
 * Events that can ping via WhatsApp. Each has a per-event toggle in the
 * Notifications tab (settings key `wa_notify_<event>`) under the
 * `wa_notifications_enabled` master switch.
 */
export const WA_NOTIFY_EVENTS = [
  'requisition_approved', 'discount_decided', 'low_stock_daily', 'digest_daily',
] as const;
export type WaNotifyEvent = typeof WA_NOTIFY_EVENTS[number];

/**
 * Built-in fallback bodies — used when no ACTIVE whatsapp_templates row is
 * named after the event (template lookup is by convention: name === event).
 * Placeholders match exactly what each call site passes to notifyEvent().
 * The same bodies are seeded into whatsapp_templates by db.ts (INSERT OR
 * IGNORE by name) so admins can edit them in the Templates tab.
 */
export const WA_DEFAULT_EVENT_BODIES: Record<WaNotifyEvent, string> = {
  requisition_approved: '✅ Requisition {{req_number}} ({{department}}) has been approved by {{approved_by}}.',
  discount_decided: 'Discount request for order #{{order}} — {{pct}}% {{decision}} by {{decided_by}}.',
  low_stock_daily: '📦 Low-stock summary ({{date}}) — {{count}} material(s) to reorder:\n{{summary}}',
  digest_daily: '📋 AKAN Daily Digest — {{date}}\n\n{{content}}',
};

/** Master switch AND the per-event toggle must both be on. */
export function isWaNotifyEnabled(event: WaNotifyEvent): boolean {
  return readSetting('wa_notifications_enabled') === '1'
    && readSetting(`wa_notify_${event}`) === '1';
}

/**
 * Per-event recipient lists — settings key `wa_notify_recipients`, JSON
 * { <event>: ['98xxxxxxxx', ...] }. Edited in the Notifications tab. Used
 * whenever a call site has no direct target mobile for the event.
 */
export function getWaNotifyRecipients(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const ev of WA_NOTIFY_EVENTS) out[ev] = [];
  try {
    const raw = JSON.parse(readSetting('wa_notify_recipients') || '{}');
    for (const ev of WA_NOTIFY_EVENTS) {
      const v = raw?.[ev];
      if (Array.isArray(v)) out[ev] = v.map((m: unknown) => String(m).trim()).filter(Boolean);
    }
  } catch { /* malformed JSON → empty lists */ }
  return out;
}

/**
 * Upsert recipient lists. Only events present in `map` are overwritten, so a
 * partial save never wipes the others. Values may be arrays or comma-separated
 * strings (the UI sends strings). Capped at 10 recipients per event.
 */
export function setWaNotifyRecipients(map: Record<string, unknown>): void {
  const merged = getWaNotifyRecipients();
  for (const ev of WA_NOTIFY_EVENTS) {
    if (!(ev in map)) continue;
    const v = map[ev];
    const list = Array.isArray(v) ? v : String(v ?? '').split(',');
    merged[ev] = list.map(m => String(m).trim()).filter(Boolean).slice(0, 10);
  }
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES ('wa_notify_recipients', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(merged));
}

/** Every notifyEvent attempt (and its outcome) lands here — never throws. */
function logWaSendAttempt(payload: Record<string, unknown>): void {
  try {
    getDb().prepare(`INSERT INTO whatsapp_events_log (kind, payload) VALUES ('send_attempt', ?)`)
      .run(JSON.stringify(payload));
  } catch { /* logging must never break a caller */ }
}

/**
 * Fire a WhatsApp notification for a business event. FIRE-AND-FORGET:
 *   - NEVER throws, never blocks/fails the parent flow (call as
 *     `void notifyEvent(...)` after the main transaction commits)
 *   - master + per-event toggle OFF → clean no-op (no log row)
 *   - toggle on but provider unconfigured → one 'send_attempt' log row with
 *     reason 'not_configured', nothing else
 *   - template by convention: active whatsapp_templates row named after the
 *     event; falls back to WA_DEFAULT_EVENT_BODIES
 *   - recipient: explicit `toMobile` if given, else the event's list from
 *     wa_notify_recipients
 */
export async function notifyEvent(
  event: WaNotifyEvent,
  vars: Record<string, string | number>,
  toMobile?: string,
): Promise<void> {
  try {
    if (!isWaNotifyEnabled(event)) return; // toggled off → silent no-op

    let body = WA_DEFAULT_EVENT_BODIES[event] || '';
    let template_source = 'built_in';
    try {
      const t = getDb().prepare(
        'SELECT body FROM whatsapp_templates WHERE name = ? AND is_active = 1',
      ).get(event) as { body?: string } | undefined;
      if (t?.body) { body = t.body; template_source = 'template'; }
    } catch { /* fall back to built-in body */ }
    const text = renderTemplate(body, vars);
    const recipients = toMobile ? [String(toMobile).trim()].filter(Boolean) : getWaNotifyRecipients()[event] || [];

    if (!isWaConfigured()) {
      logWaSendAttempt({ event, ok: false, reason: 'not_configured', to: recipients, template_source });
      return;
    }
    if (recipients.length === 0) {
      logWaSendAttempt({ event, ok: false, reason: 'no_recipient', template_source });
      return;
    }
    for (const to of recipients) {
      try {
        const res = await sendWhatsAppMessage(to, text);
        logWaSendAttempt({ event, to, template_source, ...res });
      } catch (e: any) {
        // sendWhatsAppMessage shouldn't throw, but belt-and-braces:
        logWaSendAttempt({ event, to, ok: false, reason: 'send_failed', detail: e?.message || 'unexpected error' });
      }
    }
  } catch (e: any) {
    try { console.error(`[whatsapp notifyEvent ${event}]`, e?.message || e); } catch { /* never */ }
  }
}

/** Has this event already logged a send_attempt today (UTC, matches created_at)? */
function waAttemptedToday(event: WaNotifyEvent): boolean {
  try {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS n FROM whatsapp_events_log
      WHERE kind = 'send_attempt' AND date(created_at) = date('now') AND payload LIKE ?
    `).get(`%"event":"${event}"%`) as { n: number } | undefined;
    return (row?.n || 0) > 0;
  } catch { return false; }
}

/**
 * Daily WhatsApp jobs — dispatched from the /api/cron/refresh-parties pipeline
 * (external cron / admin manual run). Each job is:
 *   - guarded by its Notifications-tab toggle (+ master switch)
 *   - once per day (first attempt of the day wins; later runs skip)
 *   - fully best-effort: never throws
 * Returns a per-job status string for the cron response.
 */
export async function runWaDailyNotifications(): Promise<Record<string, string>> {
  const out: Record<string, string> = { low_stock_daily: 'skipped', digest_daily: 'skipped' };
  const date = new Date().toISOString().slice(0, 10);

  // 1. Low-stock daily summary — top 10 reorder suggestions (same math as CRM
  //    Smart Reorder), CRITICAL (3★ priority) materials ONLY so the daily ping
  //    stays actionable across 1000+ materials.
  try {
    if (!isWaNotifyEnabled('low_stock_daily')) out.low_stock_daily = 'disabled';
    else if (waAttemptedToday('low_stock_daily')) out.low_stock_daily = 'already_sent_today';
    else {
      const rows = (reorderSuggestions(getDb())?.rows || [])
        .filter((r: any) => Number(r.priority) === 3)
        .slice(0, 10);
      if (rows.length === 0) out.low_stock_daily = 'nothing_low';
      else {
        const summary = rows.map((r: any, i: number) =>
          `${i + 1}. ${r.name} — order ${r.suggested_order_qty} ${r.order_unit} (₹${r.est_cost})`).join('\n');
        await notifyEvent('low_stock_daily', { date, count: rows.length, summary });
        out.low_stock_daily = 'fired';
      }
    }
  } catch (e: any) {
    out.low_stock_daily = 'error';
    try { console.error('[whatsapp low_stock_daily]', e?.message || e); } catch { /* never */ }
  }

  // 2. Daily digest — today's stored crm_digests briefing, if one was generated
  try {
    if (!isWaNotifyEnabled('digest_daily')) out.digest_daily = 'disabled';
    else if (waAttemptedToday('digest_daily')) out.digest_daily = 'already_sent_today';
    else {
      const row = getDb().prepare('SELECT content FROM crm_digests WHERE digest_date = ?')
        .get(date) as { content?: string } | undefined;
      if (!row?.content) out.digest_daily = 'no_digest'; // never auto-generates (LLM cost stays explicit)
      else {
        await notifyEvent('digest_daily', { date, content: row.content });
        out.digest_daily = 'fired';
      }
    }
  } catch (e: any) {
    out.digest_daily = 'error';
    try { console.error('[whatsapp digest_daily]', e?.message || e); } catch { /* never */ }
  }

  return out;
}
