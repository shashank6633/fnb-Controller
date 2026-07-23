/**
 * Call-to-Table CRM settings + SLA clock.
 *
 * Settings live in ct_settings (key/value TEXT). TeleCMI SECRETS live in env
 * only (TELECMI_APPID / TELECMI_SECRET / TELECMI_WEBHOOK_SECRET) and are never
 * stored in the DB nor returned to the client.
 */
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export const CT_SETTING_DEFAULTS: Record<string, string> = {
  sla_minutes: '30',
  attribution_hours: '48',
  business_open: '12:00',   // IST HH:mm — SLA clock + after-hours logic
  business_close: '23:30',  // IST HH:mm
  auto_assign: 'off',       // off | round_robin
  after_hours_whatsapp: '0',
  after_hours_template: 'Sorry we missed your call! We open at {open}. Book a table: {link}',
  agent_map: '{}',          // { telecmiAgentId: fnbUserEmail }
  // Quick-send documents a GRE can WhatsApp a caller from the Live Calls feed
  // (menu / band list / corporate menu …). JSON array of { label, url }.
  quick_send_links: '[{"label":"Menu","url":""},{"label":"Band List","url":""},{"label":"Corporate Menu","url":""}]',
  // GRE "What's On" board — which panels show (managers toggle in CRM Settings).
  whatson_panels: '{"entertainment":true,"parties":true,"reservations":true,"specials":true,"capacity":true,"call_context":true}',
  // Talking points (offers / new menu / happy hours) a GRE reads out on calls.
  whatson_specials: '',
  // Daily seat capacity for the "how full is this date" gauge (0 = not set → gauge hidden).
  whatson_capacity: '0',
};

export function ctSetting(db: Database.Database, key: string): string {
  const row = db.prepare(`SELECT value FROM ct_settings WHERE key = ?`).get(key) as any;
  return row?.value ?? CT_SETTING_DEFAULTS[key] ?? '';
}

export function ctSettings(db: Database.Database): Record<string, string> {
  const out: Record<string, string> = { ...CT_SETTING_DEFAULTS };
  const rows = db.prepare(`SELECT key, value FROM ct_settings`).all() as any[];
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setCtSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO ct_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

/** Webhook path token: env wins; else a random token generated once and
 *  persisted so dev works with zero env setup. */
export function webhookToken(db: Database.Database): string {
  const env = process.env.TELECMI_WEBHOOK_SECRET;
  if (env && env.length >= 12) return env;
  let tok = db.prepare(`SELECT value FROM ct_settings WHERE key = 'webhook_token'`).get() as any;
  if (tok?.value) return tok.value;
  const fresh = crypto.randomBytes(24).toString('hex');
  setCtSetting(db, 'webhook_token', fresh);
  return fresh;
}

/** True when real TeleCMI REST credentials are configured via env. */
export function isTelecmiConfigured(): boolean {
  return !!(process.env.TELECMI_APPID && process.env.TELECMI_SECRET);
}

// ─── Business-hours-aware SLA clock ────────────────────────────────────────
// All ct_ timestamps are UTC ISO strings; business hours are defined in IST.

const IST_OFFSET_MIN = 330; // +05:30, no DST

function istMinutesOfDay(d: Date): number {
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (utcMin + IST_OFFSET_MIN) % (24 * 60);
}

function parseHm(hm: string, fallback: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hm || '').trim()) || /^(\d{1,2}):(\d{2})$/.exec(fallback);
  if (!m) return 0;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

/**
 * SLA due time for a missed call (UTC ISO in → UTC ISO out).
 *   - Missed during business hours → missed_at + SLA minutes.
 *   - Missed outside business hours → next opening (IST) + SLA minutes.
 * Handles same-day opens and overnight gaps. Business hours spanning midnight
 * are not supported (close must be after open within one IST day) — matches
 * Akan's 12:00–23:30 pattern.
 */
export function slaDueAt(missedAtIso: string, db: Database.Database): string {
  const slaMin = Math.max(1, Number(ctSetting(db, 'sla_minutes')) || 30);
  const openMin = parseHm(ctSetting(db, 'business_open'), CT_SETTING_DEFAULTS.business_open);
  const closeMin = parseHm(ctSetting(db, 'business_close'), CT_SETTING_DEFAULTS.business_close);
  const missed = new Date(missedAtIso);
  if (isNaN(missed.getTime())) return new Date(Date.now() + slaMin * 60_000).toISOString();

  const nowIst = istMinutesOfDay(missed);
  if (nowIst >= openMin && nowIst < closeMin) {
    return new Date(missed.getTime() + slaMin * 60_000).toISOString();
  }
  // Outside hours → next opening + SLA
  let minutesUntilOpen: number;
  if (nowIst < openMin) minutesUntilOpen = openMin - nowIst;               // before today's open
  else minutesUntilOpen = (24 * 60 - nowIst) + openMin;                    // after close → tomorrow
  return new Date(missed.getTime() + (minutesUntilOpen + slaMin) * 60_000).toISOString();
}

/** Is the given UTC instant inside IST business hours? */
export function isBusinessHours(atIso: string, db: Database.Database): boolean {
  const openMin = parseHm(ctSetting(db, 'business_open'), CT_SETTING_DEFAULTS.business_open);
  const closeMin = parseHm(ctSetting(db, 'business_close'), CT_SETTING_DEFAULTS.business_close);
  const d = new Date(atIso);
  if (isNaN(d.getTime())) return true;
  const m = istMinutesOfDay(d);
  return m >= openMin && m < closeMin;
}
