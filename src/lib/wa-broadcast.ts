/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Broadcast campaign engine — audience → queue → throttled drain → report.
 *
 * SIBLING of src/lib/ct/winback.ts (same claim discipline, same gates) with
 * the pieces a QUEUED broadcast needs on top:
 *
 *   • DURABLE QUEUE. All state lives in wa_campaigns / wa_campaign_recipients
 *     — nothing in memory — so a restart resumes exactly where it stopped.
 *     drainBroadcasts() is driven by the house scheduler tick and by
 *     POST /api/cron/refresh-parties (both best-effort), the same dual-driver
 *     shape as defer-due. It sends NOTHING unless a campaign was explicitly
 *     started by a management POST.
 *
 *   • THROTTLE = PER-TICK BUDGET, not sleeps (no job in this app sleeps).
 *     budget ≈ msgs_per_min × minutes-since-last-drain, elapsed capped at
 *     ELAPSED_CAP_MIN so a dormant queue can never blast a backlog at once.
 *
 *   • CONSENT AT CLAIM TIME. Every recipient is re-checked against
 *     wa_marketing_consent when their row is CLAIMED — a STOP that arrives
 *     after the audience was previewed/queued still excludes them
 *     (state 'skipped_optout'). Preview filtering is advisory only.
 *
 *   • CROSS-CAMPAIGN COOLDOWN at claim time, against the last marketing send
 *     recorded ANYWHERE (this rail AND the win-back rail) — a guest in two
 *     campaigns gets ONE message per cooldown window.
 *
 *   • DAILY CAP across all campaigns (IST calendar day, both rails counted).
 *
 *   • TWO-PHASE CLAIM 'queued' → 'sending' → terminal. A crash mid-send
 *     leaves 'sending' rows that are NEVER auto-retried (reported as
 *     unconfirmed) — an unconfirmed row is a human's decision, not a retry's.
 *
 *   • THE WAMID IS STORED per recipient AND the send is recorded into the
 *     inbox thread (recordOutbound), so the existing webhook ingest updates
 *     delivery/read/failed both on the thread message AND (via
 *     wa-campaign-hooks) on the recipient row — including honest
 *     capped-vs-failed classification.
 *
 * GATES. drainBroadcasts() sends only when ALL hold:
 *   • ct_settings.broadcast_enabled === '1' (absent → OFF)
 *   • campaign.state === 'sending' (re-read before EVERY message, so
 *     pause/cancel takes effect within one message, not one batch)
 *   • the WhatsApp provider is configured (skipped when a test sender is
 *     injected — the mock IS the transport then)
 *   • recipient passes consent + cooldown + daily cap at claim time.
 */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import { ctSetting, setCtSetting } from '@/lib/ct/settings';
import { norm10, buildLoyaltyMap, buildDiningMap, syntheticGuests } from '@/lib/ct/guest-unify';
import { normalizePhone } from '@/lib/ct/phone';
import { winbackSegment, coerceBucket, istDateStr } from '@/lib/ct/winback';
import {
  sendWhatsAppTemplate, isWaConfigured, renderTemplate, normalizeWaNumber, type WaSendResult,
} from '@/lib/whatsapp';
import { recordOutbound, upsertConversation, utcString, guestDirectoryFor } from '@/lib/wa-inbox';
import { isOptedOut, consentMap } from '@/lib/wa-consent';

type DB = Database.Database;

// ─── Constants ─────────────────────────────────────────────────────────────

/** Cap on recipients in one campaign (venue-sized list, mirrors win-back). */
export const BROADCAST_TARGET_MAX = 2000;
/** Absolute cap on messages one drain pass may attempt. */
export const SEND_SLICE_MAX = 200;
/** Elapsed-minutes cap for budget math — a dormant queue never bursts. */
export const ELAPSED_CAP_MIN = 5;
/** ct_settings watermark key: ms-epoch of the last budgeted drain. */
export const DRAIN_WATERMARK_KEY = 'broadcast_drain_last_at';

/** Master flag — absent/anything-but-'1' → OFF (mirrors winback_enabled). */
export const BROADCAST_FLAG = 'broadcast_enabled';

/** Template vars a broadcast may map into {{1}},{{2}},… */
export const BROADCAST_VARS = ['name', 'venue', 'phone'] as const;

const KEY10_SQL = (col: string) =>
  `substr(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col},''),' ',''),'-',''),'+',''),'(',''),')',''),'.',''),'/',''), -10)`;

// ─── Settings ──────────────────────────────────────────────────────────────

export interface BroadcastSettings {
  enabled: boolean;
  msgs_per_min: number;
  cooldown_days: number;
  /** <= 0 → no daily cap. */
  daily_cap: number;
  /** ₹ per message — the configurable Meta marketing-conversation rate. */
  cost_per_msg: number;
  /**
   * Starting a campaign with MORE than this many eligible recipients makes the
   * UI demand a TYPED confirmation (not just a click). 0 → always typed.
   * UI-side friction only — the server gate is always confirm + expect_count.
   */
  confirm_threshold: number;
}

export const BROADCAST_SETTING_KEYS = {
  enabled: BROADCAST_FLAG,
  msgs_per_min: 'broadcast_msgs_per_min',
  cooldown_days: 'broadcast_cooldown_days',
  daily_cap: 'broadcast_daily_cap',
  cost_per_msg: 'broadcast_cost_per_msg',
  confirm_threshold: 'broadcast_confirm_threshold',
} as const;

/** Effective knobs. Read fresh every call (house norm — no caching). */
export function broadcastSettings(db: DB): BroadcastSettings {
  const num = (key: string, dflt: number, min: number, max: number) => {
    // ctSetting returns '' for an ABSENT key (it never throws for one), and
    // Number('') === 0 — so an unset knob must fall to its documented default,
    // not to a silent 0 (which for cooldown/daily-cap would mean "no limit").
    let raw = '';
    try { raw = ctSetting(db, key); } catch { raw = ''; }
    if (String(raw).trim() === '') return dflt;
    const v = Number(raw);
    if (!Number.isFinite(v)) return dflt;
    return Math.min(Math.max(v, min), max);
  };
  let enabled = false;
  try { enabled = ctSetting(db, BROADCAST_FLAG) === '1'; } catch { enabled = false; }
  return {
    enabled,
    msgs_per_min: Math.round(num(BROADCAST_SETTING_KEYS.msgs_per_min, 20, 1, 240)),
    cooldown_days: Math.round(num(BROADCAST_SETTING_KEYS.cooldown_days, 7, 0, 365)),
    daily_cap: Math.round(num(BROADCAST_SETTING_KEYS.daily_cap, 500, -1, 100000)),
    cost_per_msg: num(BROADCAST_SETTING_KEYS.cost_per_msg, 0.8, 0, 100),
    confirm_threshold: Math.round(num(BROADCAST_SETTING_KEYS.confirm_threshold, 50, 0, 100000)),
  };
}

export function setBroadcastSetting(db: DB, key: string, value: string): void {
  setCtSetting(db, key, value);
}

// ─── Audience ──────────────────────────────────────────────────────────────

/** Loyalty tiers (mirrors tierForPoints in src/lib/crm-guests.ts). */
export const BROADCAST_TIERS = ['Bronze', 'Silver', 'Gold'] as const;
export type BroadcastTier = (typeof BROADCAST_TIERS)[number];

export type AudienceDef =
  | { kind: 'all_guests' }
  | { kind: 'winback'; days: number; include_never?: boolean }
  | { kind: 'min_visits'; visits: number }
  | { kind: 'birthday_month'; month: number }   // 1–12 (calendar month of dob/birthday)
  | { kind: 'tier'; tier: BroadcastTier }       // loyalty tier (crm_guests points)
  | { kind: 'phones'; phones: string[] };

export function parseAudience(raw: unknown): AudienceDef | null {
  let v: any = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  switch (v.kind) {
    case 'all_guests': return { kind: 'all_guests' };
    case 'winback': return { kind: 'winback', days: coerceBucket(v.days), include_never: v.include_never === true };
    case 'min_visits': {
      const n = Math.floor(Number(v.visits));
      if (!Number.isFinite(n) || n < 1) return null;
      return { kind: 'min_visits', visits: Math.min(n, 1000) };
    }
    case 'birthday_month': {
      const m = Math.floor(Number(v.month));
      if (!Number.isFinite(m) || m < 1 || m > 12) return null;
      return { kind: 'birthday_month', month: m };
    }
    case 'tier': {
      const t = String(v.tier || '').trim();
      const match = BROADCAST_TIERS.find(x => x.toLowerCase() === t.toLowerCase());
      if (!match) return null;
      return { kind: 'tier', tier: match };
    }
    case 'phones': {
      if (!Array.isArray(v.phones)) return null;
      const phones = v.phones.map((p: unknown) => String(p).trim()).filter(Boolean).slice(0, BROADCAST_TARGET_MAX * 2);
      if (!phones.length) return null;
      return { kind: 'phones', phones };
    }
    default: return null;
  }
}

export interface AudienceGuest {
  guest_id: string | null;   // ct_guests.id, or null (synthetic / raw phone)
  phone_e164: string;        // the number to dial
  phone_key: string;         // norm10
  name: string;
}

export interface AudienceResolution {
  guests: AudienceGuest[];
  total_candidates: number;
  no_phone: number;
  deduped: number;
}

/** Winback's send-to-the-number-we-stored rule (never re-country-code a full E.164). */
function dialableFor(stored: string, key: string): string {
  const s = String(stored || '').trim();
  return /^\+?\d{11,15}$/.test(s.replace(/[\s-]/g, '')) ? '+' + normalizeWaNumber(s).replace(/^\+/, '') : normalizePhone(key);
}

/**
 * Calendar month (1–12) out of a stored birthday string, or 0 when unreadable.
 * ct_guests.dob is ISO 'YYYY-MM-DD'; crm_guests.birthday is free text — accept
 * ISO, vCard '--MM-DD', and 'DD-MM' / 'DD/MM' (day first, the Indian habit).
 */
export function birthdayMonthOf(raw: unknown): number {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(s);          // YYYY-MM[-DD]
  if (m) { const n = Number(m[2]); return n >= 1 && n <= 12 ? n : 0; }
  m = /^--(\d{1,2})-(\d{1,2})$/.exec(s);                        // --MM-DD (vCard)
  if (m) { const n = Number(m[1]); return n >= 1 && n <= 12 ? n : 0; }
  m = /^(\d{1,2})[/-](\d{1,2})(?:[/-]\d{2,4})?$/.exec(s);       // DD-MM[-YYYY]
  if (m) { const n = Number(m[2]); return n >= 1 && n <= 12 ? n : 0; }
  return 0;
}

/** phone_key → birthday month (1–12), from ct_guests.dob + crm_guests.birthday. */
function birthdayMonthMap(db: DB): Map<string, number> {
  const map = new Map<string, number>();
  const fold = (rows: any[]) => {
    for (const r of rows) {
      const k = norm10(r.p);
      const mo = birthdayMonthOf(r.d);
      if (k && mo && !map.has(k)) map.set(k, mo);
    }
  };
  try { fold(db.prepare(`SELECT phone_e164 AS p, dob AS d FROM ct_guests WHERE COALESCE(dob,'') <> ''`).all() as any[]); } catch { /* table missing */ }
  try { fold(db.prepare(`SELECT mobile AS p, birthday AS d FROM crm_guests WHERE is_active = 1 AND COALESCE(birthday,'') <> ''`).all() as any[]); } catch { /* table missing */ }
  return map;
}

/**
 * Resolve an audience definition to a deduped, dialable guest list.
 * NO consent/cooldown filtering here — that is the SEND-TIME gate's job; this
 * is "who was asked for", so the report can say who was excluded and why.
 */
export function resolveAudience(db: DB, def: AudienceDef): AudienceResolution {
  const out: AudienceGuest[] = [];
  const seen = new Set<string>();
  let total = 0, noPhone = 0, deduped = 0;

  const push = (guestId: string | null, phone: string, key: string, name: string) => {
    if (!key) { noPhone++; return; }
    if (seen.has(key)) { deduped++; return; }
    seen.add(key);
    out.push({ guest_id: guestId, phone_e164: phone, phone_key: key, name: String(name || '').trim().slice(0, 120) });
  };

  if (def.kind === 'winback') {
    const seg = winbackSegment(db, { days: def.days, includeNever: !!def.include_never, limit: BROADCAST_TARGET_MAX });
    total = seg.guests.length;
    for (const g of seg.guests) {
      const key = g.key10 || norm10(g.phone_e164);
      push(g.synthetic ? null : g.guest_id, dialableFor(g.phone_e164, key), key, g.name);
    }
  } else if (def.kind === 'phones') {
    total = def.phones.length;
    const keys = def.phones.map(p => norm10(p));
    const dir = guestDirectoryFor(db, keys.filter(Boolean));
    def.phones.forEach((p, i) => {
      const key = keys[i];
      if (!key) { noPhone++; return; }
      const ref = dir.get(key);
      const guestId = ref && !ref.guest_handle.startsWith('phone:') ? ref.guest_handle : null;
      push(guestId, dialableFor(p, key), key, ref?.guest_name || '');
    });
  } else {
    // all_guests / min_visits / birthday_month / tier — the guest-unify
    // universe (ct_guests + synthetic loyalty/dining guests), the same walk
    // winbackSegment does without a band filter. min_visits uses max(loyalty,
    // dining) visit counts (bookings are a winback-internal aggregate; close
    // enough for an audience selector, and the preview shows the resulting
    // names to a human before any send). birthday_month reads ct_guests.dob +
    // crm_guests.birthday; tier reads the loyalty points ladder.
    const loyalty = buildLoyaltyMap(db);
    const dining = buildDiningMap(db, null);
    const birthdays = def.kind === 'birthday_month' ? birthdayMonthMap(db) : null;
    let ctRows: any[] = [];
    try { ctRows = db.prepare(`SELECT id, phone_e164, name FROM ct_guests`).all() as any[]; } catch { ctRows = []; }
    const ctKeys = new Set<string>();
    for (const r of ctRows) { const k = norm10(r.phone_e164); if (k) ctKeys.add(k); }
    const universe: Array<{ id: string | null; phone: string; key: string; name: string }> = ctRows.map(r => ({
      id: String(r.id), phone: String(r.phone_e164 || ''), key: norm10(r.phone_e164), name: String(r.name || ''),
    }));
    for (const s of syntheticGuests(ctKeys, loyalty, dining)) {
      universe.push({ id: null, phone: s.phone_e164, key: norm10(s.phone_e164), name: s.name });
    }
    total = universe.length;
    for (const u of universe) {
      if (def.kind === 'min_visits') {
        const visits = Math.max(loyalty.get(u.key)?.visit_count || 0, dining.get(u.key)?.visits || 0);
        if (visits < def.visits) { total--; continue; }
      } else if (def.kind === 'birthday_month') {
        if ((birthdays!.get(u.key) || 0) !== def.month) { total--; continue; }
      } else if (def.kind === 'tier') {
        if ((loyalty.get(u.key)?.tier || '') !== def.tier) { total--; continue; }
      }
      push(u.id, dialableFor(u.phone, u.key), u.key, u.name);
    }
  }

  if (out.length > BROADCAST_TARGET_MAX) out.length = BROADCAST_TARGET_MAX;
  return { guests: out, total_candidates: total, no_phone: noPhone, deduped };
}

// ─── Cooldown ──────────────────────────────────────────────────────────────

/**
 * The most recent marketing send to this phone on EITHER rail (broadcasts +
 * win-back) at/after `cutoff` (UTC 'YYYY-MM-DD HH:MM:SS'). Returns a display
 * string ('' when none) — truthiness is the cooldown verdict.
 */
export function lastMarketingSendSince(db: DB, phoneKey: string, cutoff: string): string {
  if (!phoneKey) return '';
  try {
    const r = db.prepare(`
      SELECT sent_at, campaign_id FROM wa_campaign_recipients
      WHERE phone_key = ? AND sent_at IS NOT NULL AND sent_at >= ?
      ORDER BY sent_at DESC LIMIT 1
    `).get(phoneKey, cutoff) as any;
    if (r) return `${r.sent_at} (broadcast ${r.campaign_id})`;
  } catch { /* table missing */ }
  try {
    const r = db.prepare(`
      SELECT sent_at, campaign_id FROM ct_campaign_targets
      WHERE ${KEY10_SQL('phone_e164')} = ? AND send_status = 'sent' AND sent_at IS NOT NULL
        AND REPLACE(sent_at, 'T', ' ') >= ?
      ORDER BY sent_at DESC LIMIT 1
    `).get(phoneKey, cutoff) as any;
    if (r) return `${String(r.sent_at).replace('T', ' ').slice(0, 19)} (win-back ${r.campaign_id})`;
  } catch { /* table missing */ }
  return '';
}

// ─── Campaign CRUD ─────────────────────────────────────────────────────────

export type CampaignState = 'draft' | 'scheduled' | 'sending' | 'paused' | 'done' | 'cancelled';

export interface BroadcastCampaign {
  id: string;
  name: string;
  template_name: string;
  language: string;
  param_order: string;    // JSON
  preview_body: string;
  audience: string;       // JSON
  state: CampaignState;
  throttle_per_min: number;
  cost_rate: number;
  cost_estimate: number;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function getCampaign(db: DB, id: string): BroadcastCampaign | undefined {
  return db.prepare(`SELECT * FROM wa_campaigns WHERE id = ?`).get(id) as BroadcastCampaign | undefined;
}

export function paramOrderOf(c: Pick<BroadcastCampaign, 'param_order'>): string[] {
  try {
    const v = JSON.parse(String(c.param_order || '[]'));
    return Array.isArray(v) ? v.map(x => String(x)).filter(k => (BROADCAST_VARS as readonly string[]).includes(k)) : [];
  } catch { return []; }
}

export interface CreateBroadcastInput {
  name: string;
  templateName: string;
  language?: string;
  paramOrder?: string[];
  previewBody?: string;
  audience: AudienceDef;
  throttlePerMin?: number;
  createdBy: string;
}

export interface CreateBroadcastResult {
  campaign: BroadcastCampaign;
  queued: number;
  no_phone: number;
  deduped: number;
}

/**
 * Create a DRAFT + queue its recipients. Writes only — never sends, and does
 * NOT filter by consent/cooldown: excluded guests must appear in the report
 * as skipped-with-reason, which requires their row to exist.
 */
export function createBroadcast(db: DB, input: CreateBroadcastInput): CreateBroadcastResult {
  const id = generateId();
  const res = resolveAudience(db, input.audience);
  const audienceMeta = {
    ...input.audience,
    resolved: { total_candidates: res.total_candidates, no_phone: res.no_phone, deduped: res.deduped, queued: res.guests.length },
  };

  const insertCampaign = db.prepare(`
    INSERT INTO wa_campaigns (id, name, template_name, language, param_order, preview_body, audience, state, throttle_per_min, created_by)
    VALUES (@id, @name, @template, @lang, @order, @preview, @audience, 'draft', @throttle, @by)
  `);
  const insertRecipient = db.prepare(`
    INSERT OR IGNORE INTO wa_campaign_recipients (id, campaign_id, guest_id, phone_e164, phone_key, name, state)
    VALUES (?, ?, ?, ?, ?, ?, 'queued')
  `);

  const tx = db.transaction(() => {
    insertCampaign.run({
      id,
      name: String(input.name || '').trim().slice(0, 200) || 'Broadcast',
      template: String(input.templateName || '').trim(),
      lang: String(input.language || 'en').trim() || 'en',
      order: JSON.stringify((input.paramOrder || []).map(String)),
      preview: String(input.previewBody || '').slice(0, 2000),
      audience: JSON.stringify(audienceMeta),
      throttle: Math.max(0, Math.min(Math.floor(Number(input.throttlePerMin) || 0), 240)),
      by: String(input.createdBy || '').slice(0, 200),
    });
    let queued = 0;
    for (const g of res.guests) {
      const r = insertRecipient.run(generateId(), id, g.guest_id, g.phone_e164, g.phone_key, g.name);
      if (r.changes > 0) queued++;
    }
    return queued;
  });
  const queued = tx();

  return {
    campaign: getCampaign(db, id)!,
    queued,
    no_phone: res.no_phone,
    deduped: res.deduped + (res.guests.length - queued),
  };
}

// ─── Preview / cost ────────────────────────────────────────────────────────

export interface AudiencePreview {
  total_candidates: number;
  queued: number;             // rows a create would queue (deduped, dialable)
  eligible_now: number;       // of queued, would pass consent+cooldown TODAY
  excluded: { no_phone: number; deduped: number; opted_out: number; cooldown: number };
  sample: Array<{ name: string; phone_e164: string }>;
  cost: { rate: number; estimate: number };
  note: string;
}

/** Advisory numbers — consent + cooldown are RE-CHECKED at send time. */
export function previewAudience(db: DB, def: AudienceDef, nowMs?: number): AudiencePreview {
  const now = nowMs ?? Date.now();
  const s = broadcastSettings(db);
  const res = resolveAudience(db, def);
  const consent = consentMap(db, res.guests.map(g => g.phone_key));
  const cutoff = utcString(now - s.cooldown_days * 86_400_000);

  let optedOut = 0, cooldown = 0;
  const eligible: AudienceGuest[] = [];
  for (const g of res.guests) {
    if (consent.get(g.phone_key)?.status === 'opted_out') { optedOut++; continue; }
    if (s.cooldown_days > 0 && lastMarketingSendSince(db, g.phone_key, cutoff)) { cooldown++; continue; }
    eligible.push(g);
  }

  return {
    total_candidates: res.total_candidates,
    queued: res.guests.length,
    eligible_now: eligible.length,
    excluded: { no_phone: res.no_phone, deduped: res.deduped, opted_out: optedOut, cooldown },
    sample: eligible.slice(0, 10).map(g => ({ name: g.name, phone_e164: g.phone_e164 })),
    cost: { rate: s.cost_per_msg, estimate: Math.round(eligible.length * s.cost_per_msg * 100) / 100 },
    note: 'Advisory preview — consent, cooldown and the daily cap are re-checked server-side when each message is actually sent.',
  };
}

// ─── State transitions ─────────────────────────────────────────────────────

export type TransitionError =
  | 'not_found' | 'bad_state' | 'no_template' | 'nothing_queued';

export interface TransitionResult {
  ok: boolean;
  error?: TransitionError;
  campaign?: BroadcastCampaign;
}

/** draft → sending. Captures the cost rate + estimate AT THIS MOMENT. */
export function startBroadcast(db: DB, id: string, opts: { nowMs?: number } = {}): TransitionResult {
  const c = getCampaign(db, id);
  if (!c) return { ok: false, error: 'not_found' };
  if (c.state !== 'draft' && c.state !== 'scheduled') return { ok: false, error: 'bad_state', campaign: c };
  if (!String(c.template_name || '').trim()) return { ok: false, error: 'no_template', campaign: c };
  const queued = Number((db.prepare(
    `SELECT COUNT(*) AS n FROM wa_campaign_recipients WHERE campaign_id = ? AND state = 'queued'`,
  ).get(id) as any)?.n) || 0;
  if (queued === 0) return { ok: false, error: 'nothing_queued', campaign: c };

  const rate = broadcastSettings(db).cost_per_msg;
  db.prepare(`
    UPDATE wa_campaigns
    SET state = 'sending', started_at = ?, cost_rate = ?, cost_estimate = ?, updated_at = datetime('now')
    WHERE id = ? AND state IN ('draft', 'scheduled')
  `).run(utcString(opts.nowMs ?? Date.now()), rate, Math.round(queued * rate * 100) / 100, id);
  return { ok: true, campaign: getCampaign(db, id) };
}

/** sending → paused. The drain re-reads state before EVERY message. */
export function pauseBroadcast(db: DB, id: string): TransitionResult {
  const c = getCampaign(db, id);
  if (!c) return { ok: false, error: 'not_found' };
  if (c.state !== 'sending') return { ok: false, error: 'bad_state', campaign: c };
  db.prepare(`UPDATE wa_campaigns SET state = 'paused', updated_at = datetime('now') WHERE id = ? AND state = 'sending'`).run(id);
  return { ok: true, campaign: getCampaign(db, id) };
}

/** paused → sending. */
export function resumeBroadcast(db: DB, id: string): TransitionResult {
  const c = getCampaign(db, id);
  if (!c) return { ok: false, error: 'not_found' };
  if (c.state !== 'paused') return { ok: false, error: 'bad_state', campaign: c };
  db.prepare(`UPDATE wa_campaigns SET state = 'sending', updated_at = datetime('now') WHERE id = ? AND state = 'paused'`).run(id);
  return { ok: true, campaign: getCampaign(db, id) };
}

/** draft|scheduled|sending|paused → cancelled; remaining queued rows too. */
export function cancelBroadcast(db: DB, id: string): TransitionResult {
  const c = getCampaign(db, id);
  if (!c) return { ok: false, error: 'not_found' };
  if (!['draft', 'scheduled', 'sending', 'paused'].includes(c.state)) return { ok: false, error: 'bad_state', campaign: c };
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE wa_campaigns SET state = 'cancelled', finished_at = COALESCE(finished_at, datetime('now')), updated_at = datetime('now')
      WHERE id = ? AND state IN ('draft', 'scheduled', 'sending', 'paused')
    `).run(id);
    db.prepare(`UPDATE wa_campaign_recipients SET state = 'cancelled' WHERE campaign_id = ? AND state = 'queued'`).run(id);
  });
  tx();
  return { ok: true, campaign: getCampaign(db, id) };
}

// ─── Counts / progress ─────────────────────────────────────────────────────

export interface RecipientCounts {
  queued: number; sending: number; sent: number; delivered: number; read: number;
  replied: number; failed: number; capped: number;
  skipped_optout: number; skipped_cooldown: number; cancelled: number;
  total: number;
  /** sent + delivered + read + replied — messages that actually left. */
  sent_total: number;
}

export function recipientCounts(db: DB, campaignId: string): RecipientCounts {
  const out: RecipientCounts = {
    queued: 0, sending: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, capped: 0,
    skipped_optout: 0, skipped_cooldown: 0, cancelled: 0, total: 0, sent_total: 0,
  };
  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT state AS s, COUNT(*) AS n FROM wa_campaign_recipients WHERE campaign_id = ? GROUP BY state
    `).all(campaignId) as any[];
  } catch { return out; }
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (r.s in out) (out as any)[r.s] = n;
    out.total += n;
  }
  out.sent_total = out.sent + out.delivered + out.read + out.replied;
  return out;
}

export function campaignProgress(db: DB, c: BroadcastCampaign) {
  const counts = recipientCounts(db, c.id);
  return {
    counts,
    unconfirmed: counts.sending,
    cost: {
      rate: Number(c.cost_rate) || 0,
      estimate: Number(c.cost_estimate) || 0,
      /** what the sends made so far actually cost at the captured rate */
      actual: Math.round(counts.sent_total * (Number(c.cost_rate) || 0) * 100) / 100,
    },
  };
}

// ─── The drain (scheduler/cron-driven) ─────────────────────────────────────

/** Injectable transport — the REAL one is sendWhatsAppTemplate. */
export type BroadcastSender = (
  to: string, templateName: string, languageCode: string, bodyParams: string[],
) => Promise<WaSendResult>;

export interface DrainResult {
  ran: boolean;
  reason?: 'disabled' | 'wa_not_configured' | 'no_sending_campaigns' | 'no_budget' | 'daily_cap';
  budget: number;
  attempted: number;
  sent: number;
  failed: number;
  skipped_optout: number;
  skipped_cooldown: number;
  campaigns_touched: string[];
  campaigns_finished: string[];
  cap_hit: boolean;
  errors: Array<{ phone: string; error: string }>;
}

function emptyDrain(reason?: DrainResult['reason']): DrainResult {
  return {
    ran: !reason, reason, budget: 0, attempted: 0, sent: 0, failed: 0,
    skipped_optout: 0, skipped_cooldown: 0, campaigns_touched: [], campaigns_finished: [], cap_hit: false, errors: [],
  };
}

/** Meta rejects positional params with newlines/tabs/long space runs. */
function cleanParam(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function recipientVars(r: { name: string; phone_e164: string }, venue: string): Record<string, string> {
  return { name: r.name || 'there', venue, phone: r.phone_e164 };
}

/** Rendered body for the inbox thread echo ({{name}} and {{1}} both work). */
export function renderCampaignBody(c: BroadcastCampaign, vars: Record<string, string>): string {
  const body = String(c.preview_body || '');
  if (!body) return `[template] ${c.template_name}`;
  const positional: Record<string, string> = {};
  paramOrderOf(c).forEach((k, i) => { positional[String(i + 1)] = vars[k] ?? ''; });
  return renderTemplate(body, { ...vars, ...positional });
}

/** UTC string of the IST calendar-day start containing `nowMs`. */
export function istDayStartUtc(nowMs: number): string {
  return utcString(Date.parse(`${istDateStr(nowMs)}T00:00:00Z`) - 330 * 60_000);
}

/** Marketing sends today (IST), across BOTH rails. */
export function sentTodayCount(db: DB, nowMs: number): number {
  const dayStart = istDayStartUtc(nowMs);
  let n = 0;
  try {
    n += Number((db.prepare(
      `SELECT COUNT(*) AS n FROM wa_campaign_recipients WHERE sent_at IS NOT NULL AND sent_at >= ?`,
    ).get(dayStart) as any)?.n) || 0;
  } catch { /* table missing */ }
  try {
    n += Number((db.prepare(
      `SELECT COUNT(*) AS n FROM ct_campaign_targets WHERE sent_at IS NOT NULL AND REPLACE(sent_at, 'T', ' ') >= ?`,
    ).get(dayStart) as any)?.n) || 0;
  } catch { /* table missing */ }
  return n;
}

export interface DrainOpts {
  nowMs?: number;
  /** Test seam — when provided, isWaConfigured() is NOT required (the mock IS the transport). */
  sender?: BroadcastSender;
  venue?: string;
}

/**
 * DEV/E2E ONLY — BROADCAST_FAKE_TRANSPORT=1 swaps the provider transport for
 * an in-process fake that "delivers" instantly with a wamid.fake.* id, so the
 * whole pipeline (queue → throttle → thread echo → status webhooks) can be
 * exercised in a browser against a database COPY without a single real
 * WhatsApp message. Dead in production builds by construction: the flag is
 * only honoured when NODE_ENV !== 'production'.
 */
function fakeTransportActive(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.BROADCAST_FAKE_TRANSPORT === '1';
}
let fakeWamidSeq = 0;
const fakeSender: BroadcastSender = async (to) => {
  fakeWamidSeq++;
  const wamid = `wamid.fake.${Date.now()}.${fakeWamidSeq}`;
  console.log(`[wa-broadcast] FAKE transport: pretending to send template to ${to} → ${wamid}`);
  return { ok: true, provider: 'fake', message_id: wamid } as WaSendResult;
};

/**
 * One budgeted drain pass. Safe to call from anywhere, any number of times:
 * it sends nothing unless the master flag is on AND a campaign is in
 * 'sending', and the per-row claim makes concurrent drains race-safe.
 */
export async function drainBroadcasts(db: DB, opts: DrainOpts = {}): Promise<DrainResult> {
  const now = opts.nowMs ?? Date.now();
  const s = broadcastSettings(db);
  if (!s.enabled) return emptyDrain('disabled');
  const fake = !opts.sender && fakeTransportActive();
  if (!opts.sender && !fake && !isWaConfigured()) return emptyDrain('wa_not_configured');

  const campaigns = db.prepare(`
    SELECT * FROM wa_campaigns WHERE state = 'sending' ORDER BY started_at, id
  `).all() as BroadcastCampaign[];
  if (!campaigns.length) return emptyDrain('no_sending_campaigns');

  // Budget = rate × minutes since the last budgeted drain (capped). The
  // watermark only advances when budget ≥ 1, so sub-minute ticks accumulate.
  let lastMs = NaN;
  try { lastMs = Number(ctSetting(db, DRAIN_WATERMARK_KEY)); } catch { lastMs = NaN; }
  const elapsedMin = Number.isFinite(lastMs) && lastMs > 0
    ? Math.min(Math.max((now - lastMs) / 60_000, 0), ELAPSED_CAP_MIN)
    : 1;
  let budget = Math.min(Math.floor(s.msgs_per_min * elapsedMin), SEND_SLICE_MAX);
  if (budget < 1) return emptyDrain('no_budget');

  // Daily cap (IST day, both rails). <=0 → uncapped.
  let capHit = false;
  if (s.daily_cap > 0) {
    const remaining = s.daily_cap - sentTodayCount(db, now);
    if (remaining <= 0) return { ...emptyDrain('daily_cap'), cap_hit: true };
    if (budget > remaining) { budget = remaining; capHit = true; }
  }

  // Budget is consumed whether sends succeed or fail — advance the watermark
  // now so a throwing provider can't grant a double budget next tick.
  setCtSetting(db, DRAIN_WATERMARK_KEY, String(now));

  const sender: BroadcastSender = opts.sender
    ?? (fake ? fakeSender : (to, t, l, p) => sendWhatsAppTemplate(to, t, l, p));
  let venue = String(opts.venue || '').trim();
  if (!venue) {
    try { venue = String((db.prepare(`SELECT name FROM outlets ORDER BY id LIMIT 1`).get() as any)?.name || '').trim(); }
    catch { venue = ''; }
  }

  const result = emptyDrain();
  result.budget = budget;
  result.cap_hit = capHit;
  const cutoff = utcString(now - s.cooldown_days * 86_400_000);

  const claim = db.prepare(`UPDATE wa_campaign_recipients SET state = 'sending' WHERE id = ? AND state = 'queued'`);
  const finishSkip = db.prepare(`UPDATE wa_campaign_recipients SET state = ?, error_detail = ? WHERE id = ?`);
  const finishSent = db.prepare(`UPDATE wa_campaign_recipients SET state = 'sent', sent_at = ?, wamid = ?, error_detail = '' WHERE id = ?`);
  const finishFail = db.prepare(`UPDATE wa_campaign_recipients SET state = 'failed', failed_at = ?, error_detail = ? WHERE id = ?`);

  let budgetLeft = budget;

  for (const camp of campaigns) {
    if (budgetLeft <= 0) break;
    result.campaigns_touched.push(camp.id);
    const paramOrder = paramOrderOf(camp);
    // Per-campaign throttle (when set) caps THIS campaign's share of the tick.
    const campCap = camp.throttle_per_min > 0
      ? Math.max(Math.floor(camp.throttle_per_min * elapsedMin), 1)
      : Infinity;
    let campSends = 0;

    for (;;) {
      if (budgetLeft <= 0 || campSends >= campCap) break;

      // PAUSE/CANCEL GATE — re-read state before EVERY message.
      const live = db.prepare(`SELECT state FROM wa_campaigns WHERE id = ?`).get(camp.id) as any;
      if (String(live?.state) !== 'sending') break;

      const r = db.prepare(`
        SELECT * FROM wa_campaign_recipients
        WHERE campaign_id = ? AND state = 'queued'
        ORDER BY queued_at, id LIMIT 1
      `).get(camp.id) as any;

      if (!r) {
        // Nothing queued: campaign is done when no claims are outstanding.
        // ('sending' claims = crashed rows — NEVER auto-retried; the campaign
        // stays 'sending' and the report shows them as unconfirmed.)
        const c2 = recipientCounts(db, camp.id);
        if (c2.queued === 0 && c2.sending === 0) {
          db.prepare(`
            UPDATE wa_campaigns SET state = 'done', finished_at = COALESCE(finished_at, ?), updated_at = datetime('now')
            WHERE id = ? AND state = 'sending'
          `).run(utcString(now), camp.id);
          result.campaigns_finished.push(camp.id);
        }
        break;
      }

      // 1. CLAIM (conditional — concurrent drains can never double-claim).
      if (claim.run(r.id).changes === 0) continue;

      // 2. CONSENT — the send-time gate. A STOP after preview/queue wins here.
      if (isOptedOut(db, String(r.phone_key))) {
        finishSkip.run('skipped_optout', 'opted out of marketing messages', r.id);
        result.skipped_optout++;
        continue;
      }

      // 3. COOLDOWN — one marketing message per guest per window, both rails.
      if (s.cooldown_days > 0) {
        const prior = lastMarketingSendSince(db, String(r.phone_key), cutoff);
        if (prior) {
          finishSkip.run('skipped_cooldown', `already messaged ${prior}`.slice(0, 300), r.id);
          result.skipped_cooldown++;
          continue;
        }
      }

      // 4. SEND (budget is consumed by the attempt, success or not).
      budgetLeft--;
      campSends++;
      result.attempted++;
      const vars = recipientVars(r, venue);
      const params = paramOrder.map(k => cleanParam(vars[k] ?? ''));
      let res: WaSendResult;
      try {
        res = await sender(String(r.phone_e164), String(camp.template_name), String(camp.language || 'en'), params);
      } catch (e: any) {
        res = { ok: false, reason: 'send_failed', detail: e?.message || 'unexpected error' };
      }

      const sentAt = utcString(opts.nowMs ?? Date.now());
      if (res.ok) {
        const wamid = String(res.message_id || '').trim() || null;
        finishSent.run(sentAt, wamid, r.id);
        result.sent++;
        // Thread echo — the SAME recording the inbox reply path does, so the
        // status webhook updates delivery/read on the visible message too.
        try {
          const conv = upsertConversation(db, String(r.phone_e164));
          if (conv) {
            recordOutbound(db, {
              conversationId: conv.id,
              wamid,
              msgType: 'template',
              body: renderCampaignBody(camp, vars),
              status: 'sent',
              sentBy: `campaign:${camp.id}`,
            });
          }
        } catch (e: any) {
          console.error('[wa-broadcast] thread echo failed (send already recorded):', e?.message);
        }
      } else {
        const detail = String((res as any).detail || (res as any).reason || 'send failed').slice(0, 500);
        finishFail.run(sentAt, detail, r.id);
        result.failed++;
        if (result.errors.length < 10) result.errors.push({ phone: String(r.phone_e164), error: detail });
      }
    }
  }

  return result;
}
