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
  // How the Entertainment panel pulls acts from party functions (F&P Records):
  //   manual_only — only the manager's Add-event calendar; parties never appear
  //   dj_only     — also show a party ONLY when it has a booked DJ/artist (default)
  //   all_notes   — also show any party that has entertainment/decor/notes text
  whatson_entertainment_mode: 'dj_only',
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

/* ── Recording base URL (plain config, NOT a credential) ───────────────────
 *
 * TeleCMI's CDR field is called "filename" because on some accounts it IS a
 * filename ("REC-2026-08-09-1234.mp3") or a relative path — not a URL.
 * src/lib/ct/recording-fetch.ts feeds that value straight into new URL(), which
 * throws on a bare filename, so the recording proxy answers "Recording URL is
 * invalid" and a recording that exists looks broken. telecmi-mapper.ts joins
 * such a value onto THIS base (see normalizeRecordingValue there).
 *
 * WHY CONFIGURABLE RATHER THAN HARDCODED: no real CDR from this account has
 * ever been seen — ct_webhook_log has zero cdr rows and every recording_url in
 * ct_calls is seed data — so the vendor's real play-URL shape is unverified and
 * we refuse to bake a guess into code. The default below is simply the base the
 * seeded URLs already imply (https://rest.telecmi.com/v2/play/seed-...), which
 * makes the shipped default self-consistent and keeps it inside the DEFAULT
 * host allowlist (telecmi.com) instead of quietly needing a new allowlist entry.
 *
 * NO ROW  → the default below.
 * BLANK   → "do not guess": a relative value stays EMPTY rather than becoming
 *           an unfetchable URL. That is a deliberate, reportable state.
 * A VALUE → used as the join base. It does NOT bypass anything: whatever is
 *           built still has to pass fetchAllowedRecording() (https + host
 *           allowlist + per-redirect re-validation). Point the base at a host
 *           that is not allowlisted and the proxy refuses it and says so —
 *           add the host to 'recording_host_allowlist' deliberately.
 *
 * NOT A SECRET: it holds nothing an admin's browser may not see, so it is
 * deliberately absent from SECRET_KEYS in /api/crm-calls/settings (see the
 * release-gate comment in that route). It is also deliberately NOT in
 * CT_SETTING_DEFAULTS: that map feeds the same route's ALLOWED_KEYS, and a key
 * there with no matching validate() case makes any PUT carrying it fail with
 * "Unknown setting". Like its sibling 'recording_host_allowlist', this key is
 * DB-configured today; giving it a Settings field means adding both a
 * validate() case and a UI input in files this change does not own.
 */
export const RECORDING_BASE_URL_DEFAULT = 'https://rest.telecmi.com/v2/play/';

export function ctRecordingBaseUrl(db: Database.Database): string {
  // Deliberately NOT ctSetting(): that collapses "no row" and "row set to
  // empty" into the same '' , and those two must differ here — no row means
  // use the default, an empty row means the admin turned joining off on purpose.
  try {
    const row = db
      .prepare(`SELECT value FROM ct_settings WHERE key = 'recording_base_url'`)
      .get() as { value?: string } | undefined;
    if (!row) return RECORDING_BASE_URL_DEFAULT;
    return String(row.value ?? '').trim();
  } catch {
    // Table missing (pre-migration DB) — behave like "no row".
    return RECORDING_BASE_URL_DEFAULT;
  }
}

/* ── Call-recording retention (plain config, NOT a credential) ─────────────
 *
 * How long a call recording stays reachable through this app, in days. An
 * admin picks one of 7 / 15 / 30 on the Telephony console; 30 is the default
 * AND the ceiling, because ctRecordingRetentionDays() below only ever returns
 * a value from that list — a hand-edited row saying 3650 resolves to 30, so no
 * direct DB edit can quietly switch retention off.
 *
 * WHAT IT GOVERNS TODAY: this deployment stores no recording AUDIO. There are
 * TWO routes to the bytes, and the setting is worth nothing unless BOTH are
 * gated:
 *   1. the streaming proxy, src/app/api/telecmi/recording/[callId]/route.ts
 *   2. the AI analyzer, src/lib/ct/analyze.ts, behind the Enhance button
 * Both fetch from TeleCMI per use and write no audio to disk. Gating only the
 * proxy left the policy porous in the worst way: past the window a manager
 * could not press play but COULD press Enhance, which pulled the same bytes and
 * wrote a PERMANENT transcript — a derived copy outliving the recording the
 * admin asked us to stop keeping. So what this setting enforces is
 * REACHABILITY: past the window neither path will fetch.
 * The policy, that refusal and the expiry sweeper live in one place —
 * src/lib/ct/retention.ts — which is also the single place that will delete
 * local files if this app ever stores them.
 *
 * NOT IN CT_SETTING_DEFAULTS — deliberate, for the same reason as
 * RECORDING_BASE_URL_DEFAULT above: that map feeds ALLOWED_KEYS in
 * /api/crm-calls/settings, and a key there with no matching validate() case
 * makes any PUT carrying it fail with "Unknown setting". A key OUTSIDE the map
 * is skipped by that route instead ("ignore unknown, non-secret keys"), which
 * would make a save look successful and change nothing — so the write path is
 * the dedicated admin route /api/telecmi/recording-retention, which validates
 * against RECORDING_RETENTION_CHOICES and audits the change.
 *
 * NOT A SECRET: a number of days. Per the release-gate comment in
 * /api/crm-calls/settings it is therefore deliberately absent from SECRET_KEYS
 * there, and this key (plus the sweeper's watermark row, see retention.ts)
 * reads back to admins through that route's GET. Neither holds anything an
 * admin's browser may not see.
 */
export const RECORDING_RETENTION_KEY = 'recording_retention_days';
export const RECORDING_RETENTION_CHOICES = [7, 15, 30] as const;
export const RECORDING_RETENTION_DEFAULT_DAYS = 30;

/**
 * A stored or posted value → one of the offered choices, or null when it is
 * not one of them. Callers decide what "not one of them" means: the API route
 * rejects it, the accessor below falls back to the default.
 */
export function normalizeRecordingRetentionDays(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const days = Math.trunc(n);
  return RECORDING_RETENTION_CHOICES.find(c => c === days) ?? null;
}

/** Effective retention window in days. Never throws, never returns more than
 *  the largest offered choice. */
export function ctRecordingRetentionDays(db: Database.Database): number {
  try {
    const row = db
      .prepare(`SELECT value FROM ct_settings WHERE key = ?`)
      .get(RECORDING_RETENTION_KEY) as { value?: string } | undefined;
    return normalizeRecordingRetentionDays(row?.value) ?? RECORDING_RETENTION_DEFAULT_DAYS;
  } catch {
    // Table missing (pre-migration DB) — behave like "no row".
    return RECORDING_RETENTION_DEFAULT_DAYS;
  }
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

/* ── TeleCMI app credentials ──────────────────────────────────────────────
 *
 * ENV WINS, DB IS THE FALLBACK — the same precedence webhookToken() above has
 * used since day one.
 *
 * These used to be env-only, which meant the owner could not configure their
 * own telephony without an SSH session and a pm2 restart, and the Settings
 * screen could only ever report "Not configured" at them. On a single-tenant
 * box that is friction with no security win: the DB already holds guest phone
 * numbers, sales and staff records, so a TeleCMI secret beside them is not a
 * new class of exposure. Anyone who DOES want the stricter posture keeps it —
 * set the env var and the DB value is ignored entirely.
 *
 * The DB path is also strictly more usable: a value saved here applies on the
 * very next request, where an env var needs the process restarted first.
 *
 * WRITE-ONLY: the settings API must never return these. It returns
 * telecmiCredentialStatus() instead — a boolean plus a masked tail — so the
 * admin can confirm WHICH secret is stored without it being readable back.
 */
function credential(db: Database.Database | null, envKey: string, dbKey: string): string {
  const env = String(process.env[envKey] || '').trim();
  if (env) return env;
  if (!db) return '';
  const row = db.prepare(`SELECT value FROM ct_settings WHERE key = ?`).get(dbKey) as any;
  return String(row?.value || '').trim();
}

export function telecmiAppId(db: Database.Database | null = null): string {
  return credential(db, 'TELECMI_APPID', 'telecmi_appid');
}

export function telecmiSecret(db: Database.Database | null = null): string {
  return credential(db, 'TELECMI_SECRET', 'telecmi_secret');
}

/**
 * True when real TeleCMI REST credentials are available.
 *
 * The db argument is optional so the many existing call sites that pass nothing
 * keep compiling and keep their env-only behaviour. Pass the handle wherever a
 * DB-configured account should count as live — which is everywhere that has one.
 */
export function isTelecmiConfigured(db: Database.Database | null = null): boolean {
  return !!(telecmiAppId(db) && telecmiSecret(db));
}

/** Where a credential came from — shown on Settings so a surprising value is
 *  traceable (an env var silently overriding a freshly-typed one is otherwise
 *  indistinguishable from the save having failed). */
export type CredentialSource = 'env' | 'db' | 'none';

export interface CredentialStatus {
  configured: boolean;
  appid: { set: boolean; source: CredentialSource; masked: string };
  secret: { set: boolean; source: CredentialSource; masked: string };
}

/** Last 4 characters only, never the value. '' stays ''. */
function mask(v: string): string {
  if (!v) return '';
  return v.length <= 4 ? '••••' : '••••' + v.slice(-4);
}

function sourceOf(db: Database.Database | null, envKey: string, dbKey: string): CredentialSource {
  if (String(process.env[envKey] || '').trim()) return 'env';
  if (db) {
    const row = db.prepare(`SELECT value FROM ct_settings WHERE key = ?`).get(dbKey) as any;
    if (String(row?.value || '').trim()) return 'db';
  }
  return 'none';
}

export function telecmiCredentialStatus(db: Database.Database | null = null): CredentialStatus {
  const appid = telecmiAppId(db);
  const secret = telecmiSecret(db);
  return {
    configured: !!(appid && secret),
    appid:  { set: !!appid,  source: sourceOf(db, 'TELECMI_APPID', 'telecmi_appid'),   masked: mask(appid) },
    secret: { set: !!secret, source: sourceOf(db, 'TELECMI_SECRET', 'telecmi_secret'), masked: mask(secret) },
  };
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
