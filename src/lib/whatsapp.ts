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

/** Meta Graph API version — v19.0 EXPIRED 2026-05-21 (HTTP 400 for all calls). */
const META_GRAPH_VERSION = 'v23.0';

/** Settings keys owned by this module (whitelist for setWaConfig). */
export const WA_CONFIG_KEYS = [
  'wa_api_provider',          // 'meta_cloud' | 'interakt' | 'twilio' (coming soon) | 'wame'
  'wa_phone_number_id',
  'wa_business_account_id',
  'wa_access_token',          // secret — masked on read
  'wa_webhook_verify_token',  // secret — masked on read
  'wa_interakt_api_key',      // secret — masked on read (Interakt Basic auth key)
  'wa_notifications_enabled', // '1' | '0' master switch
] as const;
export type WaConfigKey = typeof WA_CONFIG_KEYS[number];

const SECRET_KEYS: WaConfigKey[] = ['wa_access_token', 'wa_webhook_verify_token', 'wa_interakt_api_key'];

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
  /** Masked like the access token — Interakt Basic-auth API key. */
  wa_interakt_api_key: string;
  wa_interakt_api_key_set: boolean;
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
  if (c.wa_api_provider === 'meta_cloud') return !!(c.wa_phone_number_id.trim() && c.wa_access_token.trim());
  if (c.wa_api_provider === 'interakt') return !!c.wa_interakt_api_key.trim();
  return false; // twilio: coming soon; wame: link-only
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
    wa_interakt_api_key: maskSecret(raw.wa_interakt_api_key),
    wa_interakt_api_key_set: !!raw.wa_interakt_api_key,
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
 * Split a mobile into { countryCode: '+91', phoneNumber: '<local>' } for
 * providers (Interakt) that want the country code separate from the local
 * number. India-first: a bare 10-digit number is assumed Indian.
 */
export function splitWaNumber(mobile: string): { countryCode: string; phoneNumber: string } {
  let digits = String(mobile || '').replace(/\D/g, '');
  // India-first: a bare local number written with a trunk '0' (e.g. '09876543210')
  // drops the single leading '0' before the length check → 10-digit local.
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) return { countryCode: '+91', phoneNumber: digits.slice(2) };
  if (digits.length === 10) return { countryCode: '+91', phoneNumber: digits };
  if (digits.length > 10) return { countryCode: '+' + digits.slice(0, -10), phoneNumber: digits.slice(-10) };
  return { countryCode: '+91', phoneNumber: digits };
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
 * Provider-pluggable. Incomplete config NEVER throws — it returns
 * { ok:false, reason:'not_configured' } so feature code can call this
 * unconditionally.
 *
 * Free-form text only delivers inside the 24h customer-service window (Meta) —
 * for proactive/anytime delivery use sendWhatsAppTemplate with an approved
 * template. Interakt has NO free-form text API at all: it refuses cleanly.
 */
export async function sendWhatsAppMessage(to: string, body: string): Promise<WaSendResult> {
  const raw = getWaConfigRaw();
  if (!isWaConfigured(raw)) return { ok: false, reason: 'not_configured' };

  if (raw.wa_api_provider === 'interakt') {
    return {
      ok: false,
      reason: 'send_failed',
      detail: 'Interakt sends approved templates only — free-form text is not supported by the API. Configure a template mapping for this event.',
    };
  }

  // Meta Cloud API (graph.facebook.com).
  try {
    const toNum = normalizeWaNumber(to);
    if (!toNum || !body) return { ok: false, reason: 'send_failed', detail: 'Missing recipient or message body' };
    const r = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(raw.wa_phone_number_id.trim())}/messages`, {
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

/**
 * Send a Meta-approved TEMPLATE message — delivers ANY time (no 24h window).
 * Body params are POSITIONAL: bodyParams[0] → {{1}}, [1] → {{2}}, … and the
 * array length MUST equal the template's placeholder count. opts.headerParams
 * fill a header component's placeholders (optional). NEVER throws.
 */
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: (string | number)[],
  opts?: { headerParams?: (string | number)[] },
): Promise<WaSendResult> {
  const raw = getWaConfigRaw();
  if (!isWaConfigured(raw)) return { ok: false, reason: 'not_configured' };

  const lang = String(languageCode || '').trim() || 'en';
  const headerParams = opts?.headerParams;

  try {
    if (raw.wa_api_provider === 'meta_cloud') {
      const toNum = normalizeWaNumber(to);
      if (!toNum || !templateName) return { ok: false, reason: 'send_failed', detail: 'Missing recipient or template name' };

      const components: any[] = [];
      if (headerParams && headerParams.length) {
        components.push({ type: 'header', parameters: headerParams.map(v => ({ type: 'text', text: String(v) })) });
      }
      if (bodyParams && bodyParams.length) {
        components.push({ type: 'body', parameters: bodyParams.map(v => ({ type: 'text', text: String(v) })) });
      }

      const template: any = { name: templateName, language: { code: lang } };
      if (components.length) template.components = components;

      const r = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(raw.wa_phone_number_id.trim())}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${raw.wa_access_token.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toNum,
          type: 'template',
          template,
        }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        return { ok: false, reason: 'send_failed', detail: j?.error?.message || `Meta API HTTP ${r.status}` };
      }
      return { ok: true, provider: 'meta_cloud', message_id: j?.messages?.[0]?.id };
    }

    if (raw.wa_api_provider === 'interakt') {
      if (!templateName) return { ok: false, reason: 'send_failed', detail: 'Missing template name' };
      const { countryCode, phoneNumber } = splitWaNumber(to);
      if (!phoneNumber) return { ok: false, reason: 'send_failed', detail: 'Missing recipient' };

      const template: any = { name: templateName, languageCode: lang, bodyValues: bodyParams.map(String) };
      if (headerParams && headerParams.length) template.headerValues = headerParams.map(String);

      const r = await fetch('https://api.interakt.ai/v1/public/message/', {
        method: 'POST',
        headers: {
          // Interakt Basic key is used AS-IS — do NOT base64-encode it again.
          'Authorization': `Basic ${raw.wa_interakt_api_key.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          countryCode,
          phoneNumber,
          type: 'Template',
          template,
        }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || j?.result === false) {
        return { ok: false, reason: 'send_failed', detail: j?.message || `Interakt API HTTP ${r.status}` };
      }
      // result:true is ACCEPTED (queued), not yet delivered.
      return { ok: true, provider: 'interakt', message_id: j?.id };
    }

    return { ok: false, reason: 'not_configured' };
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

/**
 * Positional variable order per event — the map from a template's {{1}},{{2}},…
 * to the names in the `vars` object notifyEvent receives. Meta/Interakt approved
 * templates take POSITIONAL body params (not named), so this ordering is the
 * contract. A whatsapp_templates row may override it via its param_order column.
 */
export const WA_EVENT_PARAM_ORDER: Record<WaNotifyEvent, string[]> = {
  requisition_approved: ['req_number', 'department', 'approved_by'],
  discount_decided: ['order', 'pct', 'decision', 'decided_by'],
  low_stock_daily: ['date', 'count', 'summary'],
  digest_daily: ['date', 'content'],
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
    // Newer DBs add provider-template columns; guard for older DBs without them.
    let row: {
      body?: string;
      send_as_template?: number;
      provider_template_name?: string;
      provider_language?: string;
      language?: string;
      param_order?: string;
    } | undefined;
    try {
      row = getDb().prepare(
        `SELECT body,
                COALESCE(send_as_template, 0) AS send_as_template,
                provider_template_name, provider_language, language, param_order
           FROM whatsapp_templates WHERE name = ? AND is_active = 1`,
      ).get(event) as typeof row;
    } catch {
      // Older DB without the new columns — retry with just body.
      try {
        row = getDb().prepare(
          'SELECT body FROM whatsapp_templates WHERE name = ? AND is_active = 1',
        ).get(event) as typeof row;
      } catch { /* fall back to built-in body */ }
    }
    if (row?.body) { body = row.body; template_source = 'template'; }

    const recipients = toMobile ? [String(toMobile).trim()].filter(Boolean) : getWaNotifyRecipients()[event] || [];

    if (!isWaConfigured()) {
      logWaSendAttempt({ event, ok: false, reason: 'not_configured', to: recipients, template_source });
      return;
    }
    if (recipients.length === 0) {
      logWaSendAttempt({ event, ok: false, reason: 'no_recipient', template_source });
      return;
    }

    // Provider-template path: send a Meta/Interakt approved template with
    // POSITIONAL params (delivers anytime, not just inside the 24h window).
    const providerTemplate = String(row?.provider_template_name || '').trim();
    if (row?.send_as_template === 1 && providerTemplate) {
      let order = WA_EVENT_PARAM_ORDER[event];
      if (row.param_order) {
        try {
          const parsed = JSON.parse(row.param_order);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(v => typeof v === 'string')) order = parsed;
        } catch { /* invalid → fall back to WA_EVENT_PARAM_ORDER */ }
      }
      // Meta rejects positional body params containing newlines/tabs/runs of >4
      // spaces, so collapse every whitespace run to a single space and trim.
      // (Only the provider-template path — the free-form text path is untouched.)
      const params = order.map(name => {
        const v = Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : '';
        return v.replace(/\s+/g, ' ').trim();
      });
      const language = String(row.provider_language || row.language || 'en').trim() || 'en';
      for (const to of recipients) {
        try {
          const res = await sendWhatsAppTemplate(to, providerTemplate, language, params);
          logWaSendAttempt({ event, to, template_source: 'provider_template', template: providerTemplate, ...res });
        } catch (e: any) {
          logWaSendAttempt({ event, to, template_source: 'provider_template', template: providerTemplate, ok: false, reason: 'send_failed', detail: e?.message || 'unexpected error' });
        }
      }
      return;
    }

    // Free-form text path (unchanged) — only delivers inside the 24h window.
    const text = renderTemplate(body, vars);
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

/**
 * Has this event been SUCCESSFULLY delivered today (UTC, matches created_at)?
 * Deliberately counts only ok:true rows — a doomed attempt (not_configured /
 * no_recipient / send_failed) must NOT burn the day's slot, so a later run (after
 * the admin fixes credentials/recipients, or a transient outage clears) still
 * fires. A successful send logs a payload containing both "event":"<ev>" and
 * "ok":true, so both fragments are required.
 */
function waSentToday(event: WaNotifyEvent): boolean {
  try {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS n FROM whatsapp_events_log
      WHERE kind = 'send_attempt' AND date(created_at) = date('now')
        AND payload LIKE ? AND payload LIKE '%"ok":true%'
    `).get(`%"event":"${event}"%`) as { n: number } | undefined;
    return (row?.n || 0) > 0;
  } catch { return false; }
}

/**
 * Daily WhatsApp jobs — dispatched from the /api/cron/refresh-parties pipeline
 * (external cron / admin manual run). Each job is:
 *   - guarded by its Notifications-tab toggle (+ master switch)
 *   - once per day (first SUCCESSFUL send wins; failed/no-op runs don't burn the
 *     slot, so a later run still fires once config/recipients are fixed)
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
    else if (waSentToday('low_stock_daily')) out.low_stock_daily = 'already_sent_today';
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
    else if (waSentToday('digest_daily')) out.digest_daily = 'already_sent_today';
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
