import { getDb } from './db';

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
