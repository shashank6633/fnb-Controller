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

/** Meta Graph API version — v19.0 EXPIRED 2026-05-21 (HTTP 400 for all calls).
 *  Exported so other Graph callers (wa-inbox media fetch) share ONE copy. */
export const META_GRAPH_VERSION = 'v23.0';

/** Settings keys owned by this module (whitelist for setWaConfig). */
export const WA_CONFIG_KEYS = [
  'wa_api_provider',          // 'meta_cloud' | 'interakt' | 'twilio' (coming soon) | 'wame'
  'wa_phone_number_id',
  'wa_business_account_id',
  'wa_access_token',          // secret — masked on read
  'wa_webhook_verify_token',  // secret — masked on read
  'wa_interakt_api_key',      // secret — masked on read (Interakt Basic auth key)
  'wa_notifications_enabled', // '1' | '0' master switch
  'wa_otp_template',          // approved OTP/authentication template name (for QR OTP)
  'wa_otp_template_lang',     // OTP template language code (default 'en')
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
  // error_code / http_status are POPULATED ONLY on the media-header path (see
  // sendWhatsAppTemplate). The orchestrator needs Meta's numeric code to tell
  // "this media id expired, re-upload and retry" from "this send is doomed" —
  // and a retry must never fire on a network error, where Meta may have
  // accepted the message we never saw the response for. Every pre-existing
  // caller keeps the exact two-key { ok:false, reason, detail } object it gets
  // today, so no whatsapp_events_log payload changes shape.
  | { ok: false; reason: 'not_configured' | 'send_failed'; detail?: string; error_code?: number; http_status?: number };

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
 * ONE media object on a template's HEADER component. `media_id` is a Meta media
 * id from uploadWaMedia() — Route A. There is deliberately no `link` variant:
 * Meta's link fetcher is UNAUTHENTICATED, so a link header would mean serving
 * an internal report from a public URL. See uploadWaMedia() for the full
 * reasoning.
 */
export interface WaHeaderMedia {
  kind: 'document' | 'image';
  media_id: string;
  /** Document only — the filename the recipient sees in the chat. Ignored for images. */
  filename?: string;
}

/** The Graph JSON fields this module actually reads. Everything is optional —
 *  an error response carries no `messages`, and a parse failure carries none of
 *  it — so every read below is already written to survive absence. */
interface GraphJson {
  id?: string;
  data?: unknown[];
  error?: { message?: string; code?: number };
  messages?: Array<{ id?: string }>;
}

/** One template as Meta's message_templates endpoint returns it. */
interface MetaTemplateDef {
  name?: string;
  language?: string;
  status?: string;
  components?: Array<{ type?: string; format?: string }>;
}

/** POST one built template payload to Meta. Extracted so the text path and the
 *  media path build the byte-identical request and differ only in `template`. */
async function postMetaTemplate(
  raw: Record<WaConfigKey, string>,
  toNum: string,
  template: unknown,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; message_id?: string } | { ok: false; detail: string; error_code?: number; http_status: number }> {
  const f = fetchImpl ?? fetch;
  const r = await f(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(raw.wa_phone_number_id.trim())}/messages`, {
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
  const j = await r.json().catch(() => ({})) as GraphJson;
  if (!r.ok) {
    const code = Number(j?.error?.code);
    return {
      ok: false,
      detail: j?.error?.message || `Meta API HTTP ${r.status}`,
      ...(Number.isFinite(code) && code > 0 ? { error_code: code } : {}),
      http_status: r.status,
    };
  }
  return { ok: true, message_id: j?.messages?.[0]?.id };
}

/**
 * Send a Meta-approved TEMPLATE message — delivers ANY time (no 24h window).
 * Body params are POSITIONAL: bodyParams[0] → {{1}}, [1] → {{2}}, … and the
 * array length MUST equal the template's placeholder count. opts.headerParams
 * fill a TEXT header component's placeholders (optional); opts.headerMedia
 * instead attaches ONE document/image to a media header. NEVER throws.
 *
 * headerParams and headerMedia are MUTUALLY EXCLUSIVE — a header component
 * carrying both a text-parameter list and a media object is a Meta 400, and a
 * template approved with a DOCUMENT header has no text placeholders to fill
 * anyway. Passing both is refused here rather than at Meta.
 *
 * This is the raw transport: it does NOT check that `templateName` was actually
 * approved with a media header, because that costs a Graph round trip and every
 * text send would pay it. To attach a report, call sendReportAttachment() in
 * src/lib/wa-report-send.ts — it verifies the header format, uploads, sends and
 * records, in that order.
 */
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: (string | number)[],
  opts?: {
    headerParams?: (string | number)[];
    otpButtonCode?: string;
    headerMedia?: WaHeaderMedia;
    /** Injected transport for tests; defaults to global fetch. */
    fetchImpl?: typeof fetch;
  },
): Promise<WaSendResult> {
  const raw = getWaConfigRaw();
  if (!isWaConfigured(raw)) return { ok: false, reason: 'not_configured' };

  const lang = String(languageCode || '').trim() || 'en';
  const headerParams = opts?.headerParams;
  const headerMedia = opts?.headerMedia;

  if (headerMedia && headerParams && headerParams.length) {
    return {
      ok: false, reason: 'send_failed',
      detail: 'A template header carries EITHER text placeholders OR one media attachment, never both. Drop headerParams when sending an attachment.',
    };
  }
  if (headerMedia && !String(headerMedia.media_id || '').trim()) {
    return { ok: false, reason: 'send_failed', detail: 'Attachment has no media id — upload the file first (uploadWaMedia).' };
  }

  try {
    if (raw.wa_api_provider === 'meta_cloud') {
      const toNum = normalizeWaNumber(to);
      if (!toNum || !templateName) return { ok: false, reason: 'send_failed', detail: 'Missing recipient or template name' };

      const components: any[] = [];
      if (headerMedia) {
        // A media header has EXACTLY ONE parameter, whose type names the media
        // kind and whose value is an object — a different shape from the
        // { type:'text', text } list a TEXT header takes.
        const kind = headerMedia.kind;
        const media: { id: string; filename?: string } = { id: String(headerMedia.media_id).trim() };
        // filename is what the recipient sees on the document bubble. Meta
        // ignores it for images, so it is only ever sent for documents.
        if (kind === 'document' && String(headerMedia.filename || '').trim()) {
          media.filename = String(headerMedia.filename).trim();
        }
        components.push({ type: 'header', parameters: [{ type: kind, [kind]: media }] });
      } else if (headerParams && headerParams.length) {
        components.push({ type: 'header', parameters: headerParams.map(v => ({ type: 'text', text: String(v) })) });
      }
      if (bodyParams && bodyParams.length) {
        components.push({ type: 'body', parameters: bodyParams.map(v => ({ type: 'text', text: String(v) })) });
      }
      if (opts?.otpButtonCode) {
        // Meta AUTHENTICATION (OTP) template — the copy-code button carries the code.
        components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(opts.otpButtonCode) }] });
      }

      const template: any = { name: templateName, language: { code: lang } };
      if (components.length) template.components = components;

      const res = await postMetaTemplate(raw, toNum, template, opts?.fetchImpl);
      if (!res.ok) {
        // The diagnostic fields ride out ONLY on the media path — see the
        // WaSendResult comment. Every existing caller's failure object stays
        // exactly { ok:false, reason:'send_failed', detail }.
        return headerMedia
          ? { ok: false, reason: 'send_failed', detail: res.detail, ...(res.error_code ? { error_code: res.error_code } : {}), http_status: res.http_status }
          : { ok: false, reason: 'send_failed', detail: res.detail };
      }
      return { ok: true, provider: 'meta_cloud', message_id: res.message_id };
    }

    if (raw.wa_api_provider === 'interakt') {
      if (!templateName) return { ok: false, reason: 'send_failed', detail: 'Missing template name' };
      if (headerMedia) {
        // Interakt's media-header field name and shape are UNPROVEN — there is
        // no Interakt media traffic anywhere in this codebase to copy, and a
        // guess would fail at the provider AFTER the file was uploaded and the
        // send recorded. Refuse here, with the fix named.
        return {
          ok: false, reason: 'send_failed',
          detail: 'Attachments are only supported on the Meta Cloud provider. Switch the provider in Settings → Integrations → WhatsApp to send a report as a document.',
        };
      }
      const { countryCode, phoneNumber } = splitWaNumber(to);
      if (!phoneNumber) return { ok: false, reason: 'send_failed', detail: 'Missing recipient' };

      const template: any = { name: templateName, languageCode: lang, bodyValues: bodyParams.map(String) };
      if (headerParams && headerParams.length) template.headerValues = headerParams.map(String);
      // Authentication (OTP) template — the copy-code button's URL suffix must
      // carry the code (mirrors the Meta branch's button component). Without it
      // Interakt rejects the send and the OTP never reaches the guest.
      if (opts?.otpButtonCode) template.buttonValues = { '0': [String(opts.otpButtonCode)] };

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

/* ═══════════════ Outbound media — upload (Route A) ═══════════════ */

/**
 * OUR ceiling on an outbound attachment, enforced BEFORE any network call.
 *
 * Meta's own document cap is far higher, so theirs would never bite first — and
 * a rejection at Meta arrives as an opaque provider error after the bytes have
 * already crossed the wire. This cap is the one that matters here for two more
 * reasons: the bytes are stored as a SQLite BLOB that rides inside every DB
 * backup (wa_report_files), and a report PDF that clears 10 MB is a bug in the
 * report, not a big report. Symmetric in spirit with WA_MEDIA_MAX_BYTES (5 MB)
 * on the inbound rail.
 */
export const WA_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * What we are willing to hand to Meta. An allowlist, not a blocklist: this is
 * an upload of OUR data to a third party, so an unexpected type is a bug to
 * surface, never a payload to forward.
 */
export const WA_UPLOAD_MIME_ALLOW: Record<string, 'document' | 'image'> = {
  'application/pdf': 'document',
  'image/png': 'image',
  'image/jpeg': 'image',
};

export type WaUploadResult =
  | { ok: true; media_id: string }
  | { ok: false; reason: 'not_configured' | 'too_large' | 'unsupported_type' | 'empty' | 'upload_failed'; detail: string };

/** Human-readable byte size for the refusal messages. */
function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/**
 * Upload one file to Meta and get back a media id — ROUTE A.
 *
 * WHY UPLOAD RATHER THAN LINK. Meta will also fetch a media header from a
 * public https link, which needs no upload and no expiry handling. It is the
 * wrong answer here: Meta's fetcher is UNAUTHENTICATED, so the link has to be
 * world-readable while it lives. That would mean adding an internal-report PDF
 * to isPublic() in src/proxy.ts — today a list holding only the guest menu, the
 * quiz link, the two webhooks and the crash reporter — and inventing a
 * public-origin setting this app does not have (the only origin helper derives
 * from an inbound Host header, which a scheduler tick does not have). A stock
 * variance or price-hike PDF is internal commercial data; anyone who has,
 * guesses, forwards or logs that URL reads our numbers. Uploading keeps the
 * bytes reachable only with the WABA token — the same trust boundary the
 * inbound media rail already lives inside — and costs one upload per report.
 *
 * The returned id is a CACHE, not an identity: Meta expires media ids (the
 * exact window is not something this codebase can prove), so callers must be
 * able to re-upload. NEVER throws.
 */
export async function uploadWaMedia(
  args: { data: Uint8Array | Buffer; filename: string; mime: string },
  opts?: { fetchImpl?: typeof fetch },
): Promise<WaUploadResult> {
  const bytes = args?.data;
  const mime = String(args?.mime || '').trim().toLowerCase();
  const filename = String(args?.filename || '').trim() || 'attachment';

  // 1. OUR limits first — no credentials read, no network touched, so an
  //    oversize or wrong-type file is refused identically whether or not
  //    WhatsApp is configured, and the caller gets OUR message, not Meta's.
  if (!bytes || !bytes.byteLength) {
    return { ok: false, reason: 'empty', detail: 'Nothing to attach — the file is empty.' };
  }
  if (bytes.byteLength > WA_UPLOAD_MAX_BYTES) {
    return {
      ok: false, reason: 'too_large',
      detail: `${filename} is ${humanBytes(bytes.byteLength)} — over the ${humanBytes(WA_UPLOAD_MAX_BYTES)} WhatsApp attachment limit. Narrow the report's date range or send it as a link instead.`,
    };
  }
  if (!WA_UPLOAD_MIME_ALLOW[mime]) {
    return {
      ok: false, reason: 'unsupported_type',
      detail: `${mime || 'unknown type'} cannot be sent as a WhatsApp attachment. Allowed: ${Object.keys(WA_UPLOAD_MIME_ALLOW).join(', ')}.`,
    };
  }

  const raw = getWaConfigRaw();
  if (raw.wa_api_provider !== 'meta_cloud') {
    return { ok: false, reason: 'not_configured', detail: 'Attachments are only supported on the Meta Cloud provider.' };
  }
  if (!isWaConfigured(raw)) {
    return { ok: false, reason: 'not_configured', detail: 'WhatsApp is not configured — set the phone number ID and access token in Settings → Integrations → WhatsApp.' };
  }

  try {
    // 2. POST multipart/form-data to {phone-number-id}/media. The boundary is
    //    set by fetch from the FormData body — never hand-rolled.
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    // new Uint8Array(bytes) copies in one go — Uint8Array.from() walks element
    // by element, which is a visible cost at multi-megabyte report sizes.
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);

    const f = opts?.fetchImpl ?? fetch;
    const r = await f(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(raw.wa_phone_number_id.trim())}/media`, {
      method: 'POST',
      // NO Content-Type header: setting it by hand strips the multipart
      // boundary fetch generates and Meta rejects the body.
      headers: { 'Authorization': `Bearer ${raw.wa_access_token.trim()}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const j = await r.json().catch(() => ({})) as GraphJson;
    if (!r.ok || !j?.id) {
      return { ok: false, reason: 'upload_failed', detail: j?.error?.message || `Media upload HTTP ${r.status}` };
    }
    return { ok: true, media_id: String(j.id) };
  } catch (e) {
    return { ok: false, reason: 'upload_failed', detail: (e as Error)?.message || 'Network error during media upload' };
  }
}

/* ═══════════════ Template shape — refuse BEFORE sending ═══════════════ */

export type WaHeaderFormat = 'NONE' | 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'VIDEO' | 'LOCATION' | 'UNKNOWN';

/** Header formats Meta documents. Anything else reads back as 'UNKNOWN' — and
 *  'UNKNOWN' never matches the format an attachment needs, so a shape we do not
 *  recognise fails closed. */
const KNOWN_HEADER_FORMATS = new Set(['TEXT', 'IMAGE', 'DOCUMENT', 'VIDEO', 'LOCATION']);

export type WaTemplateShape =
  | { ok: true; name: string; language: string; status: string; headerFormat: WaHeaderFormat }
  | { ok: false; reason: 'not_configured' | 'lookup_failed' | 'not_found'; detail: string };

/**
 * Cached template shapes. A daily report goes to several recipients from one
 * job; without this each send would re-ask Meta for the same definition. Short
 * TTL because a template CAN be edited at Meta and we would rather re-ask than
 * hold a wrong answer.
 */
const TEMPLATE_SHAPE_TTL_MS = 5 * 60 * 1000;
const templateShapeCache = new Map<string, { at: number; val: WaTemplateShape }>();

/** Drop every cached template shape (tests, and after an admin edits templates). */
export function clearWaTemplateShapeCache(): void { templateShapeCache.clear(); }

/**
 * Ask Meta what a template actually looks like, so an attachment send can be
 * refused BEFORE the file is uploaded and before a message is recorded.
 *
 * This deliberately does NOT read whatsapp_templates.meta_components, the local
 * cache the template-authoring rail fills: that column is only as fresh as the
 * last sync, and a stale row would either block a template that does carry a
 * document header or wave through one that does not — the exact failure this
 * check exists to prevent. Meta is the authority on its own templates.
 */
export async function getWaTemplateShape(
  templateName: string,
  languageCode?: string,
  opts?: { fetchImpl?: typeof fetch; noCache?: boolean },
): Promise<WaTemplateShape> {
  const name = String(templateName || '').trim();
  const lang = String(languageCode || '').trim();
  if (!name) return { ok: false, reason: 'not_found', detail: 'No template name given.' };

  const cacheKey = `${name}::${lang}`;
  if (!opts?.noCache) {
    const hit = templateShapeCache.get(cacheKey);
    if (hit && Date.now() - hit.at < TEMPLATE_SHAPE_TTL_MS) return hit.val;
  }

  const val = await lookupTemplateShape(name, lang, opts?.fetchImpl);
  // Only a definitive answer is cached. A lookup that failed on network or
  // credentials must be retried, not remembered for five minutes.
  if (val.ok || val.reason === 'not_found') templateShapeCache.set(cacheKey, { at: Date.now(), val });
  return val;
}

async function lookupTemplateShape(name: string, lang: string, fetchImpl?: typeof fetch): Promise<WaTemplateShape> {
  const raw = getWaConfigRaw();
  if (raw.wa_api_provider !== 'meta_cloud') {
    return { ok: false, reason: 'not_configured', detail: 'Template definitions can only be read from the Meta Cloud provider.' };
  }
  const waba = raw.wa_business_account_id.trim();
  const token = raw.wa_access_token.trim();
  if (!waba) {
    return {
      ok: false, reason: 'not_configured',
      detail: 'Set the WhatsApp Business Account ID in Settings → Integrations → WhatsApp. Without it the template\'s header format cannot be verified, and an attachment must never be sent against a template that cannot carry one.',
    };
  }
  if (!token) return { ok: false, reason: 'not_configured', detail: 'Set the Meta access token in Settings → Integrations → WhatsApp.' };

  try {
    const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(waba)}/message_templates`
      + `?name=${encodeURIComponent(name)}&fields=name,status,language,components&limit=50`;
    const f = fetchImpl ?? fetch;
    const r = await f(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => ({})) as GraphJson;
    if (!r.ok) return { ok: false, reason: 'lookup_failed', detail: j?.error?.message || `Meta API HTTP ${r.status}` };

    // Meta's ?name= filter is a PREFIX match, so 'daily_report' also returns
    // 'daily_report_v2'. Match the exact name, then prefer the requested
    // language (a template exists once per language, each with its own shape).
    const all = (Array.isArray(j?.data) ? j.data as MetaTemplateDef[] : [])
      .filter(t => String(t?.name || '') === name);
    if (!all.length) {
      return { ok: false, reason: 'not_found', detail: `No template named "${name}" exists on this WhatsApp Business Account.` };
    }
    const t = (lang && all.find(x => String(x?.language || '') === lang)) || all[0];

    let headerFormat: WaHeaderFormat = 'NONE';
    for (const c of (Array.isArray(t?.components) ? t.components : [])) {
      if (String(c?.type || '').toUpperCase() !== 'HEADER') continue;
      const fmt = String(c?.format || 'TEXT').toUpperCase();
      headerFormat = KNOWN_HEADER_FORMATS.has(fmt) ? (fmt as WaHeaderFormat) : 'UNKNOWN';
      break;
    }
    return {
      ok: true, name, language: String(t?.language || lang || ''),
      status: String(t?.status || ''), headerFormat,
    };
  } catch (e) {
    return { ok: false, reason: 'lookup_failed', detail: (e as Error)?.message || 'Network error reading the template definition' };
  }
}

/* ═══════════════ Event notifications (fire-and-forget) ═══════════════ */

/**
 * Events that can ping via WhatsApp. Each has a per-event toggle in the
 * Notifications tab (settings key `wa_notify_<event>`) under the
 * `wa_notifications_enabled` master switch.
 */
/**
 * REGISTERING AN EVENT HERE DOES NOT TURN IT ON. isWaNotifyEnabled() below
 * requires the master switch AND `wa_notify_<event>`; an absent settings key
 * reads '' and is off. Registration buys the event a toggle in Settings →
 * WhatsApp → Notifications and, crucially, A SEAT IN `wa_notify_recipients`.
 *
 * That second half is why `grn_qc_pending` had to be added. getWaNotifyRecipients()
 * rebuilds the whole recipient JSON FROM THIS LIST and setWaNotifyRecipients()
 * writes that rebuilt object back — so while the QC event was deliberately kept
 * out of this array (it has its own reader in src/lib/grn-qc-notify.ts on the
 * same key), ANY save on the Notifications tab silently deleted its mobiles:
 *
 *   before  {"grn_qc_pending":["98…"], "requisition_approved":["90…"]}
 *   save an unrelated event
 *   after   {"requisition_approved":["91…"], …} — the QC slot is simply gone
 *
 * waQcRecipients() then returned [] and waSend logged `no_recipients` and sent
 * nothing, silently, while the admin screen said the list was shared with every
 * other event — which is exactly what made the loss unexpected. Both readers key
 * on the same string, so this changes no behaviour beyond stopping the wipe.
 */
export const WA_NOTIFY_EVENTS = [
  'requisition_approved', 'discount_decided', 'low_stock_daily', 'digest_daily',
  'calls_daily', 'grn_qc_pending',
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
  // Yesterday's reservations line, in one glance. Utility, not marketing —
  // it goes to our own staff about our own operation.
  calls_daily: '📞 AKAN Calls — {{date}}\n\nCalls {{calls}} · Answered {{answered}} ({{answered_pct}}%) · Missed {{missed}}\nBookings from calls: {{bookings}}\nMissed still open: {{pending}}\nBusiest hour: {{peak}}\n\n{{agents}}',
  // The QC rail composes its own text (src/lib/grn-qc-notify.ts) and passes it to
  // sendWhatsAppMessage directly, so this body is the shape an APPROVED TEMPLATE
  // should take rather than a string notifyEvent() will ever render. Kept in step
  // with the five positional params waSend() sends, in the same order.
  grn_qc_pending: '⏸ {{grn_number}} from {{vendor}} is waiting for a {{checker}} quality check — {{categories}}. ₹{{value}} of goods are at the bay and NO stock has been added. Keep the vendor there until it is signed off.',
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
  calls_daily: ['date', 'calls', 'answered', 'answered_pct', 'missed', 'bookings', 'pending', 'peak', 'agents'],
  // MUST match, in order, the five params waSend() passes in grn-qc-notify.ts:
  // grn_number, vendor, checker, categories, value. The overdue ping reuses the
  // same key and sends grn_number, vendor, checker, waited_hours, date — noted
  // in the hand-over as a thing to split if a template is ever approved for both.
  grn_qc_pending: ['grn_number', 'vendor', 'checker', 'categories', 'value'],
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

/** Every notifyEvent attempt (and its outcome) lands here — never throws.
 *  Exported so the attachment rail (wa-report-send.ts) audits through the SAME
 *  door rather than growing a second, differently-shaped send log. */
export function logWaSendAttempt(payload: Record<string, unknown>): void {
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
  const out: Record<string, string> = { low_stock_daily: 'skipped', digest_daily: 'skipped', calls_daily: 'skipped' };
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

  // 3. Calls analytics — yesterday's reservations line in one message to the
  //    owner/admin. Reads dashboardStats(), the SAME source the CRM dashboard
  //    renders, so the WhatsApp figure and the screen can never disagree.
  //
  //    Reports YESTERDAY, not today: the cron runs in the morning, and a
  //    part-finished day would send a "missed 40%" panic at 9am that fixes
  //    itself by lunch.
  try {
    if (!isWaNotifyEnabled('calls_daily')) out.calls_daily = 'disabled';
    else if (waSentToday('calls_daily')) out.calls_daily = 'already_sent_today';
    else {
      const { dashboardStats } = await import('@/lib/ct/metrics');
      // 2 days covers yesterday whichever side of midnight the job fires.
      const st = dashboardStats(getDb(), { days: 2 });
      const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const day = (st.byDay || []).find((d: any) => d.date === y);

      if (!day || day.total === 0) out.calls_daily = 'no_calls';
      else {
        const answeredPct = day.total > 0 ? Math.round((day.answered / day.total) * 100) : 0;
        // Busiest hour across the window — byHour is hour-of-day, so this is
        // "the hour that is usually busy", which is what a rota decision needs.
        let peak = '—';
        let best = 0;
        for (const h of st.byHour || []) {
          if (h.total > best) { best = h.total; peak = `${String(h.hour).padStart(2, '0')}:00 (${h.total} calls)`; }
        }
        // Top 3 agents by calls handled, each with its denominator so a small
        // sample cannot masquerade as a trend.
        const agents = (st.agents || [])
          .slice()
          .sort((a: any, b: any) => b.handled - a.handled)
          .slice(0, 3)
          .map((a: any) => `• ${a.agent}: ${a.handled} handled, ${a.bookings} booking(s)`)
          .join('\n') || '• no agent activity recorded';

        await notifyEvent('calls_daily', {
          date: y,
          calls: day.total,
          answered: day.answered,
          answered_pct: answeredPct,
          missed: day.missed,
          bookings: st.today?.bookings_from_calls ?? 0,
          pending: st.today?.pending_recoveries ?? 0,
          peak,
          agents,
        });
        out.calls_daily = 'fired';
      }
    }
  } catch (e: any) {
    out.calls_daily = 'error';
    try { console.error('[whatsapp calls_daily]', e?.message || e); } catch { /* never */ }
  }

  return out;
}
