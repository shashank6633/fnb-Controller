/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Win-back engine — lapsed-guest segment → WhatsApp campaign → attribution.
 *
 * THREE parts, in the order the money moves:
 *
 *  1. SEGMENT  `winbackSegment()` — every guest we know, bucketed by how long
 *     it has been since they last set foot in the venue (30 / 60 / 90 / 120
 *     days). The guest universe and the phone join are NOT reinvented here:
 *     it reuses `norm10` + `buildLoyaltyMap` + `buildDiningMap` +
 *     `syntheticGuests` from guest-unify.ts, exactly like /api/crm-calls/guests
 *     does, so a guest is the same person on both screens.
 *
 *  2. CAMPAIGN `createCampaign()` / `sendCampaign()` — a draft is one
 *     ct_campaigns row plus one ct_campaign_targets row per reachable guest.
 *     Sending is a separate, explicit call. UNIQUE(campaign_id, phone_e164)
 *     makes a double-send structurally impossible, and the two-phase claim
 *     ('pending' → 'sending' → 'sent'/'failed') means a crash mid-batch can be
 *     resumed without re-messaging anyone.
 *
 *  3. ATTRIBUTION `attributeCampaign()` — after the send, stamp returned_at /
 *     return_value on the target row when the guest actually comes back, so
 *     the campaign reports what it earned rather than what it hoped for. See
 *     RETURN PROOF below for exactly which table proves a visit — and what
 *     that signal cannot see.
 *
 * SAFETY. Nothing in this module sends anything unless BOTH are true:
 *   • ct_settings.winback_enabled === '1'  (absent → OFF; this is the flag)
 *   • the WhatsApp provider is configured (src/lib/whatsapp.ts)
 * and only from `sendCampaign()`, which is reached only from an explicit POST.
 * No timer, no cron, no send-on-read anywhere in this file.
 *
 * COMPLIANCE. A win-back message is MARKETING. Under Meta's rules it can only
 * go out as a pre-approved MARKETING-category template, to a guest who opted
 * in — this module never fabricates a way around that. `sendCampaign()` only
 * ever calls `sendWhatsAppTemplate()`; it never falls back to free-form text.
 */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import { normalizePhone } from '@/lib/ct/phone';
import { ctSetting } from '@/lib/ct/settings';
import {
  norm10,
  buildLoyaltyMap,
  buildDiningMap,
  syntheticGuests,
  type LoyaltyAgg,
  type DiningAgg,
} from '@/lib/ct/guest-unify';
import { sendWhatsAppTemplate, isWaConfigured, renderTemplate, normalizeWaNumber } from '@/lib/whatsapp';

type DB = Database.Database;

// ─── Constants ─────────────────────────────────────────────────────────────

/** The four win-back windows offered in the UI (days since last visit). */
export const WINBACK_BUCKETS = [30, 60, 90, 120] as const;
export type WinbackBucket = (typeof WINBACK_BUCKETS)[number];

/** ct_settings flag that must be '1' before ANY campaign message can be sent. */
export const WINBACK_FLAG = 'winback_enabled';

/** Default attribution window (days after the send) when a campaign doesn't pin one. */
export const DEFAULT_ATTRIBUTION_DAYS = 30;

/** Hard cap on one explicit send action — the UI asks again for the remainder. */
export const SEND_BATCH_MAX = 200;

/** Cap on targets in one campaign (a venue-sized list, not a bulk blaster). */
export const CAMPAIGN_TARGET_MAX = 2000;

const IST_OFFSET_MIN = 330;
const DAY_MS = 86_400_000;

/** Visit date of a booking: the booked date if set, else the day the row was
 *  last touched (seating/completion bumps updated_at). Mirrors metrics.ts. */
const VISIT_AT = `COALESCE(NULLIF(b.booking_date, ''), substr(REPLACE(COALESCE(b.updated_at, b.created_at), ' ', 'T'), 1, 10))`;

/** SQLite punctuation-stripping + last-10 key — mirrors guest-unify's KEY10. */
const NORM = (col: string) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col},''),' ',''),'-',''),'+',''),'(',''),')',''),'.',''),'/','')`;
const KEY10 = (col: string) => `substr(${NORM(col)}, -10)`;

// ─── Clock helpers (IST — the venue's operating timezone) ──────────────────

/** IST calendar date (YYYY-MM-DD) of a UTC instant. */
export function istDateStr(msUtc: number): string {
  return new Date(msUtc + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** Whole days between two IST calendar dates (YYYY-MM-DD). Null if unparseable. */
function daysBetween(fromDate: string, toDate: string): number | null {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / DAY_MS);
}

/** Any timestamp/date string → IST calendar date, or '' if unusable. */
function toIstDate(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;            // already a date
  const ms = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return '';
  return istDateStr(ms);
}

// ─── Settings ──────────────────────────────────────────────────────────────

/**
 * THE flag. Absent/anything-but-'1' → OFF, so a database that has never heard
 * of this feature behaves exactly as it does today.
 */
export function winbackEnabled(db: DB): boolean {
  try { return ctSetting(db, WINBACK_FLAG) === '1'; } catch { return false; }
}

/** Configured default bucket (ct_settings.lapsed_days), snapped to a real bucket. */
export function defaultLapsedDays(db: DB): WinbackBucket {
  let n = 60;
  try { n = Number(ctSetting(db, 'lapsed_days')) || 60; } catch { /* default */ }
  return coerceBucket(n);
}

/** Snap any number to the nearest offered bucket (never throws). */
export function coerceBucket(n: unknown): WinbackBucket {
  const v = Number(n);
  if (!Number.isFinite(v)) return 60;
  let best: WinbackBucket = 60;
  let bestGap = Infinity;
  for (const b of WINBACK_BUCKETS) {
    const gap = Math.abs(b - v);
    if (gap < bestGap) { bestGap = gap; best = b; }
  }
  return best;
}

// ─── Segment ───────────────────────────────────────────────────────────────

export type WinbackBand = '30-59' | '60-89' | '90-119' | '120+' | 'never' | 'active';
export type VisitSource = 'booking' | 'dining' | 'loyalty' | '';

export interface WinbackGuest {
  /** ct_guests.id, or 'phone:<10>' for a loyalty/dining-only guest (synthetic). */
  guest_id: string;
  /** True when guest_id is synthetic (no ct_guests row to hang a booking off). */
  synthetic: boolean;
  key10: string;
  phone_e164: string;
  name: string;
  /** IST calendar date of the last PROVEN visit, or null if we have never seen one. */
  last_visit_at: string | null;
  last_visit_source: VisitSource;
  days_since: number | null;
  band: WinbackBand;
  /** Best single visit count we can defend (see visits_* for the components). */
  visits: number;
  visits_bookings: number;
  visits_loyalty: number;
  visits_dining: number;
  /** Best single spend figure we can defend (₹). 0 when no money signal exists. */
  total_spend: number;
  /** Items on their most recent settled order, when the order carried a phone. */
  last_items: string[];
  /** False when the stored number can't produce a 10-digit key — unmessageable. */
  contactable: boolean;
  tags: string[];
}

export interface WinbackSegment {
  bucket_days: WinbackBucket;
  /** Guests with last_visit_at strictly BEFORE this IST date are in the bucket. */
  cutoff_date: string;
  today: string;
  include_never: boolean;
  counts: {
    total_guests: number;
    active: number;
    never: number;
    /** CUMULATIVE — a guest 100 days away counts in 30, 60 and 90. */
    b30: number; b60: number; b90: number; b120: number;
    /** In the SELECTED bucket (what a campaign would target). */
    in_bucket: number;
    /** Of `in_bucket`, how many have no usable WhatsApp number. */
    unreachable: number;
  };
  guests: WinbackGuest[];
}

export type WinbackSort = 'days' | 'spend' | 'visits' | 'name' | 'last_visit';

export interface SegmentOptions {
  outletId?: string | null;
  days?: number;
  includeNever?: boolean;
  sort?: WinbackSort;
  dir?: 'asc' | 'desc';
  limit?: number;
  nowMs?: number;
}

function bandFor(days: number | null): WinbackBand {
  if (days == null) return 'never';
  if (days >= 120) return '120+';
  if (days >= 90) return '90-119';
  if (days >= 60) return '60-89';
  if (days >= 30) return '30-59';
  return 'active';
}

/** Last seated/completed booking + count, per ct_guests.id. */
function bookingVisitMap(db: DB): Map<string, { last: string; count: number }> {
  const map = new Map<string, { last: string; count: number }>();
  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT b.guest_id AS guest_id, MAX(${VISIT_AT}) AS last_visit, COUNT(*) AS n
      FROM ct_bookings b
      WHERE b.status IN ('seated', 'completed')
      GROUP BY b.guest_id
    `).all() as any[];
  } catch { return map; }
  for (const r of rows) {
    const id = String(r.guest_id || '');
    if (!id) continue;
    map.set(id, { last: toIstDate(r.last_visit), count: Number(r.n) || 0 });
  }
  return map;
}

/**
 * Items on the most recent SETTLED order for each phone key, best-effort.
 * Only called for the guests actually being returned, and silently degrades to
 * an empty map on any older/absent schema.
 */
function lastItemsMap(db: DB, outletId: string | null | undefined, keys: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!keys.length) return out;
  const outlet = outletId ?? '';
  const chunk = 400;
  for (let i = 0; i < keys.length; i += chunk) {
    const slice = keys.slice(i, i + chunk);
    const ph = slice.map(() => '?').join(',');
    let rows: any[] = [];
    try {
      rows = db.prepare(`
        SELECT k, item_name FROM (
          SELECT ${KEY10('o.guest_mobile')} AS k,
                 oi.name                    AS item_name,
                 DENSE_RANK() OVER (PARTITION BY ${KEY10('o.guest_mobile')} ORDER BY o.created_at DESC) AS order_rank,
                 ROW_NUMBER() OVER (PARTITION BY ${KEY10('o.guest_mobile')} ORDER BY o.created_at DESC, oi.id) AS rn
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.status = 'settled'
            AND ${KEY10('o.guest_mobile')} IN (${ph})
            AND (o.outlet_id = ? OR o.outlet_id IS NULL)
        ) WHERE order_rank = 1 AND rn <= 6
      `).all(...slice, outlet) as any[];
    } catch { return out; }   // no order_items/window support → feature degrades, page still works
    for (const r of rows) {
      const k = String(r.k || '');
      const name = String(r.item_name || '').trim();
      if (!k || !name) continue;
      const list = out.get(k) || [];
      if (!list.includes(name)) list.push(name);
      out.set(k, list);
    }
  }
  return out;
}

function parseTags(text: unknown): string[] {
  if (typeof text !== 'string' || !text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.map(t => String(t)) : [];
  } catch { return []; }
}

/**
 * The lapsed-guest segment.
 *
 * Universe = every ct_guests row PLUS the synthetic guests guest-unify builds
 * for people who exist only in loyalty or only in dining. Last visit is the
 * LATEST of the three proofs we hold, and we record which one it came from so
 * the page can be honest about it.
 */
export function winbackSegment(db: DB, opts: SegmentOptions = {}): WinbackSegment {
  const nowMs = opts.nowMs ?? Date.now();
  const today = istDateStr(nowMs);
  const bucket = coerceBucket(opts.days ?? defaultLapsedDays(db));
  const includeNever = !!opts.includeNever;
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), CAMPAIGN_TARGET_MAX);

  const loyalty = buildLoyaltyMap(db);
  const dining = buildDiningMap(db, opts.outletId ?? '');
  const bookings = bookingVisitMap(db);

  let ctRows: any[] = [];
  try {
    ctRows = db.prepare(`SELECT id, phone_e164, name, tags FROM ct_guests`).all() as any[];
  } catch { ctRows = []; }

  const ctKeys = new Set<string>();
  for (const r of ctRows) {
    const k = norm10(r.phone_e164);
    if (k) ctKeys.add(k);
  }

  type Raw = { id: string; synthetic: boolean; phone: string; name: string; key10: string; tags: string[] };
  const universe: Raw[] = ctRows.map(r => ({
    id: String(r.id),
    synthetic: false,
    phone: String(r.phone_e164 || ''),
    name: String(r.name || '').trim(),
    key10: norm10(r.phone_e164),
    tags: parseTags(r.tags),
  }));
  for (const s of syntheticGuests(ctKeys, loyalty, dining)) {
    universe.push({
      id: s.id, synthetic: true, phone: s.phone_e164, name: s.name,
      key10: norm10(s.phone_e164), tags: [],
    });
  }

  const all: WinbackGuest[] = universe.map(u => {
    const l: LoyaltyAgg | undefined = u.key10 ? loyalty.get(u.key10) : undefined;
    const d: DiningAgg | undefined = u.key10 ? dining.get(u.key10) : undefined;
    const bk = u.synthetic ? undefined : bookings.get(u.id);

    // Last visit = the most recent of the three proofs, remembering which won.
    const candidates: Array<[VisitSource, string]> = [];
    if (bk?.last) candidates.push(['booking', bk.last]);
    if (d?.last_seen) candidates.push(['dining', toIstDate(d.last_seen)]);
    if (l?.last_visit_at) candidates.push(['loyalty', toIstDate(l.last_visit_at)]);
    let last_visit_at: string | null = null;
    let last_visit_source: VisitSource = '';
    for (const [src, date] of candidates) {
      if (!date) continue;
      if (!last_visit_at || date > last_visit_at) { last_visit_at = date; last_visit_source = src; }
    }

    const days_since = last_visit_at ? daysBetween(last_visit_at, today) : null;

    const visits_bookings = bk?.count || 0;
    const visits_loyalty = l?.visit_count || 0;
    const visits_dining = d?.visits || 0;
    // MAX, not sum: the same evening can appear as a booking, a loyalty visit
    // AND an order. Summing would inflate every regular's visit count.
    const visits = Math.max(visits_bookings, visits_loyalty, visits_dining);
    const total_spend = Math.round(Math.max(l?.total_spend || 0, d?.total_spent || 0));

    return {
      guest_id: u.id,
      synthetic: u.synthetic,
      key10: u.key10,
      phone_e164: u.phone,
      name: u.name,
      last_visit_at,
      last_visit_source,
      days_since,
      band: bandFor(days_since),
      visits,
      visits_bookings,
      visits_loyalty,
      visits_dining,
      total_spend,
      last_items: [],
      contactable: !!u.key10,
      tags: u.tags,
    };
  });

  // Cumulative bucket counts over the WHOLE universe (bucket-selector badges).
  const counts = {
    total_guests: all.length,
    active: all.filter(g => g.band === 'active').length,
    never: all.filter(g => g.days_since == null).length,
    b30: all.filter(g => g.days_since != null && g.days_since >= 30).length,
    b60: all.filter(g => g.days_since != null && g.days_since >= 60).length,
    b90: all.filter(g => g.days_since != null && g.days_since >= 90).length,
    b120: all.filter(g => g.days_since != null && g.days_since >= 120).length,
    in_bucket: 0,
    unreachable: 0,
  };

  const inBucket = all.filter(g =>
    g.days_since == null ? includeNever : g.days_since >= bucket,
  );
  counts.in_bucket = inBucket.length;
  counts.unreachable = inBucket.filter(g => !g.contactable).length;

  // Sort: default "gone longest first"; never-visited sink to the bottom.
  const sort: WinbackSort = opts.sort || 'days';
  const dir = opts.dir === 'asc' ? 1 : -1;
  inBucket.sort((a, b) => {
    const aNever = a.days_since == null, bNever = b.days_since == null;
    if (aNever !== bNever) return aNever ? 1 : -1;
    let cmp = 0;
    switch (sort) {
      case 'spend': cmp = a.total_spend - b.total_spend; break;
      case 'visits': cmp = a.visits - b.visits; break;
      case 'name': cmp = (a.name || '~').localeCompare(b.name || '~'); break;
      case 'last_visit': cmp = String(a.last_visit_at || '').localeCompare(String(b.last_visit_at || '')); break;
      default: cmp = (a.days_since ?? 0) - (b.days_since ?? 0);
    }
    if (cmp === 0) cmp = a.phone_e164.localeCompare(b.phone_e164);
    return cmp * dir;
  });

  const page = inBucket.slice(0, limit);

  // "Last ordered" only for the rows we're actually returning.
  const items = lastItemsMap(db, opts.outletId, page.filter(g => g.key10).map(g => g.key10));
  for (const g of page) g.last_items = items.get(g.key10) || [];

  const cutoffMs = nowMs - bucket * DAY_MS;
  return {
    bucket_days: bucket,
    cutoff_date: istDateStr(cutoffMs),
    today,
    include_never: includeNever,
    counts,
    guests: page,
  };
}

// ─── Campaign creation ─────────────────────────────────────────────────────

export interface CampaignRow {
  id: string;
  name: string;
  segment: string;
  template: string;
  status: 'draft' | 'sending' | 'sent' | 'failed';
  created_by: string;
  created_at: string;
  sent_at: string | null;
}

/** The parts of a campaign that decide what actually goes out. Stored as JSON
 *  in ct_campaigns.segment so a campaign is reproducible after the fact. */
export interface CampaignSegmentMeta {
  bucket_days: number;
  include_never: boolean;
  cutoff_date: string;
  created_from: 'winback';
  /** Provider (Meta/Interakt) APPROVED template name — what actually sends. */
  provider_template: string;
  language: string;
  /** Which vars fill {{1}},{{2}},… in the approved template, in order. */
  param_order: string[];
  /** Local copy of the approved body, for preview only. Never sent as text. */
  preview_body: string;
  attribution_days: number;
  /** Guests dropped at create time because their number can't be dialled. */
  skipped_no_phone: number;
  /** Rows the UNIQUE(campaign_id, phone_e164) index collapsed (same person twice). */
  deduped: number;
  selected_count: number;
}

export interface CreateCampaignInput {
  name: string;
  createdBy: string;
  guests: Array<{ guest_id: string; phone_e164: string; name: string }>;
  meta: Omit<CampaignSegmentMeta, 'skipped_no_phone' | 'deduped' | 'selected_count'>;
}

export interface CreateCampaignResult {
  campaign: CampaignRow;
  targets: number;
  skipped_no_phone: number;
  deduped: number;
}

/**
 * Create a DRAFT campaign + its target rows. Writes only — never sends.
 *
 * Phones are canonicalised to +91XXXXXXXXXX before insert so that the UNIQUE
 * (campaign_id, phone_e164) index sees "9876543210" and "+91 98765 43210" as
 * the same guest and collapses them. A guest whose number can't produce a
 * 10-digit key is dropped (and counted) rather than stored with an empty
 * phone, which the UNIQUE index would allow exactly one of.
 */
export function createCampaign(db: DB, input: CreateCampaignInput): CreateCampaignResult {
  const id = generateId();
  const name = String(input.name || '').trim().slice(0, 200) || 'Win-back campaign';

  const prepared: Array<{ guest_id: string | null; phone: string; name: string }> = [];
  let skipped_no_phone = 0;
  const seen = new Set<string>();
  let deduped = 0;

  for (const g of input.guests.slice(0, CAMPAIGN_TARGET_MAX)) {
    const key = norm10(g.phone_e164);
    if (!key) { skipped_no_phone++; continue; }
    // SEND TO THE NUMBER WE STORED, not to a reconstruction of it.
    //
    // norm10 keeps the last 10 digits — the right key for MATCHING a guest
    // across tables — but it is lossy, and feeding it back through
    // normalizePhone() re-attaches +91 unconditionally. A guest stored as
    // +1 212 555 1234 came out as +91 21255 51234: a real, unrelated Indian
    // number that would have received the campaign. Messaging a stranger is
    // not a rounding error.
    //
    // So: match on norm10, but SEND to the stored E.164 whenever it already
    // carries a country code. Only bare 10-digit input gets the +91 default,
    // which is correct for this venue's own guests.
    const stored = String(g.phone_e164 || '').trim();
    const phone = /^\+?\d{11,15}$/.test(stored.replace(/[\s-]/g, ''))
      ? normalizeWaNumber(stored)
      : normalizePhone(key);
    if (seen.has(phone)) { deduped++; continue; }
    seen.add(phone);
    prepared.push({
      // 'phone:<10>' synthetic ids are NOT ct_guests rows — store null so the
      // column never points at a guest that doesn't exist.
      guest_id: g.guest_id && !g.guest_id.startsWith('phone:') ? g.guest_id : null,
      phone,
      name: String(g.name || '').trim().slice(0, 120),
    });
  }

  const meta: CampaignSegmentMeta = {
    ...input.meta,
    skipped_no_phone,
    deduped,
    selected_count: input.guests.length,
  };

  const insertCampaign = db.prepare(`
    INSERT INTO ct_campaigns (id, name, segment, template, status, created_by)
    VALUES (?, ?, ?, ?, 'draft', ?)
  `);
  const insertTarget = db.prepare(`
    INSERT OR IGNORE INTO ct_campaign_targets (id, campaign_id, guest_id, phone_e164, name, send_status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);

  const tx = db.transaction(() => {
    insertCampaign.run(id, name, JSON.stringify(meta), meta.provider_template, String(input.createdBy || '').slice(0, 200));
    let inserted = 0;
    for (const p of prepared) {
      const res = insertTarget.run(generateId(), id, p.guest_id, p.phone, p.name);
      if (res.changes > 0) inserted++;
    }
    return inserted;
  });
  const inserted = tx();

  const campaign = db.prepare(`SELECT * FROM ct_campaigns WHERE id = ?`).get(id) as CampaignRow;
  return {
    campaign,
    targets: inserted,
    // Anything the index collapsed on the way in is a dedupe too.
    skipped_no_phone,
    deduped: deduped + (prepared.length - inserted),
  };
}

export function parseCampaignMeta(segment: unknown): CampaignSegmentMeta {
  const fallback: CampaignSegmentMeta = {
    bucket_days: 60, include_never: false, cutoff_date: '', created_from: 'winback',
    provider_template: '', language: 'en', param_order: ['name'], preview_body: '',
    attribution_days: DEFAULT_ATTRIBUTION_DAYS, skipped_no_phone: 0, deduped: 0, selected_count: 0,
  };
  if (typeof segment !== 'string' || !segment) return fallback;
  try {
    const v = JSON.parse(segment);
    if (!v || typeof v !== 'object') return fallback;
    return {
      ...fallback,
      ...v,
      param_order: Array.isArray(v.param_order) && v.param_order.length
        ? v.param_order.map((s: unknown) => String(s))
        : fallback.param_order,
      attribution_days: Number(v.attribution_days) > 0 ? Number(v.attribution_days) : DEFAULT_ATTRIBUTION_DAYS,
    };
  } catch { return fallback; }
}

// ─── Sending ───────────────────────────────────────────────────────────────

export interface TargetRow {
  id: string;
  campaign_id: string;
  guest_id: string | null;
  phone_e164: string;
  name: string;
  send_status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  send_error: string;
  sent_at: string | null;
  returned_at: string | null;
  return_value: number | null;
  created_at: string;
}

export type SendRefusal =
  | 'disabled'          // ct_settings.winback_enabled is not '1'
  | 'wa_not_configured' // no WhatsApp provider credentials
  | 'no_template'       // campaign has no approved provider template name
  | 'not_found'
  | 'nothing_pending';

export interface SendResult {
  ok: boolean;
  refused?: SendRefusal;
  attempted: number;
  sent: number;
  failed: number;
  remaining: number;
  /** Rows left in the two-phase 'sending' claim — never auto-retried. */
  unconfirmed: number;
  status: CampaignRow['status'];
  errors: Array<{ phone: string; error: string }>;
}

/** Build the positional body params for one target, in the campaign's order. */
export function buildParams(order: string[], vars: Record<string, string | number>): string[] {
  return order.map(k => {
    const v = Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : '';
    // Meta rejects positional params containing newlines/tabs/long space runs.
    return v.replace(/\s+/g, ' ').trim();
  });
}

/** Vars available to a win-back template, per target. */
export function targetVars(t: Pick<TargetRow, 'name' | 'phone_e164'>, meta: CampaignSegmentMeta, venue: string) {
  return {
    name: t.name || 'there',
    days: String(meta.bucket_days),
    venue,
    phone: t.phone_e164,
  } as Record<string, string>;
}

/**
 * SEND. Called ONLY from an explicit POST — never on a read, never on a timer.
 *
 * Order of operations per target, and why:
 *   1. Claim the row: 'pending' → 'sending' (a conditional UPDATE, so two
 *      concurrent send requests can never both claim the same guest).
 *   2. Call the provider.
 *   3. Record 'sent' or 'failed'.
 * If the process dies between 1 and 3 the row is stuck at 'sending' — and a
 * later resume will NOT pick it up, because resuming only ever selects
 * 'pending'. That is deliberate: an unconfirmed row is reported to the
 * operator rather than silently re-messaged.
 */
export async function sendCampaign(
  db: DB,
  campaignId: string,
  opts: { batch?: number; venue?: string; retryFailed?: boolean } = {},
): Promise<SendResult> {
  const empty = (refused: SendRefusal, status: CampaignRow['status'] = 'draft'): SendResult => ({
    ok: false, refused, attempted: 0, sent: 0, failed: 0,
    remaining: 0, unconfirmed: 0, status, errors: [],
  });

  const campaign = db.prepare(`SELECT * FROM ct_campaigns WHERE id = ?`).get(campaignId) as CampaignRow | undefined;
  if (!campaign) return empty('not_found');

  // ── The two hard gates. Both must pass or nothing leaves the building. ──
  if (!winbackEnabled(db)) return empty('disabled', campaign.status);
  if (!isWaConfigured()) return empty('wa_not_configured', campaign.status);

  const meta = parseCampaignMeta(campaign.segment);
  const template = String(campaign.template || meta.provider_template || '').trim();
  if (!template) return empty('no_template', campaign.status);

  const batch = Math.min(Math.max(Number(opts.batch) || SEND_BATCH_MAX, 1), SEND_BATCH_MAX);
  const statuses = opts.retryFailed ? `('pending','failed')` : `('pending')`;

  const queue = db.prepare(`
    SELECT * FROM ct_campaign_targets
    WHERE campaign_id = ? AND send_status IN ${statuses}
    ORDER BY created_at, id
    LIMIT ?
  `).all(campaignId, batch) as TargetRow[];

  if (queue.length === 0) {
    const rem = countByStatus(db, campaignId);
    return {
      ok: true, refused: 'nothing_pending', attempted: 0, sent: 0, failed: 0,
      remaining: rem.pending, unconfirmed: rem.sending, status: campaign.status, errors: [],
    };
  }

  db.prepare(`UPDATE ct_campaigns SET status = 'sending' WHERE id = ?`).run(campaignId);

  const claim = db.prepare(`
    UPDATE ct_campaign_targets SET send_status = 'sending', send_error = ''
    WHERE id = ? AND send_status IN ${statuses}
  `);
  const finish = db.prepare(`
    UPDATE ct_campaign_targets SET send_status = ?, send_error = ?, sent_at = ?
    WHERE id = ?
  `);

  const venue = String(opts.venue || '').trim();
  let sent = 0, failed = 0, attempted = 0;
  const errors: Array<{ phone: string; error: string }> = [];

  for (const t of queue) {
    // 1. claim — a losing racer sees changes === 0 and skips the guest entirely.
    if (claim.run(t.id).changes === 0) continue;
    attempted++;

    const params = buildParams(meta.param_order, targetVars(t, meta, venue));
    let res;
    try {
      // TEMPLATE ONLY. A win-back is marketing: there is no free-form fallback.
      res = await sendWhatsAppTemplate(t.phone_e164, template, meta.language || 'en', params);
    } catch (e: any) {
      res = { ok: false as const, reason: 'send_failed' as const, detail: e?.message || 'unexpected error' };
    }

    const nowIso = new Date().toISOString();
    if (res.ok) {
      finish.run('sent', '', nowIso, t.id);
      sent++;
    } else {
      const detail = String((res as any).detail || (res as any).reason || 'send failed').slice(0, 500);
      // sent_at stays NULL on failure — attribution must never credit a guest
      // we never actually reached.
      finish.run('failed', detail, null, t.id);
      failed++;
      if (errors.length < 10) errors.push({ phone: t.phone_e164, error: detail });
    }
  }

  const after = countByStatus(db, campaignId);
  let status: CampaignRow['status'] = 'sending';
  if (after.pending === 0 && after.sending === 0) {
    status = after.sent > 0 ? 'sent' : 'failed';
  }
  db.prepare(`
    UPDATE ct_campaigns
    SET status = ?, sent_at = COALESCE(sent_at, CASE WHEN ? > 0 THEN ? ELSE NULL END)
    WHERE id = ?
  `).run(status, sent, new Date().toISOString(), campaignId);

  return {
    ok: true, attempted, sent, failed,
    remaining: after.pending, unconfirmed: after.sending, status, errors,
  };
}

export function countByStatus(db: DB, campaignId: string) {
  const rows = db.prepare(`
    SELECT send_status AS s, COUNT(*) AS n FROM ct_campaign_targets
    WHERE campaign_id = ? GROUP BY send_status
  `).all(campaignId) as any[];
  const out = { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0, total: 0 };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (r.s in out) (out as any)[r.s] = n;
    out.total += n;
  }
  return out;
}

// ─── Attribution ───────────────────────────────────────────────────────────

/**
 * RETURN PROOF — which table proves a guest came back, in priority order:
 *
 *   1. orders (status = 'settled', KEY10(guest_mobile) = the target's phone).
 *      The ONLY source that carries money. return_value = the sum of those
 *      bills inside the window.
 *   2. crm_guest_visits (loyalty desk swipe) — also carries a bill_amount.
 *   3. ct_bookings with status seated|completed. Proves presence, carries NO
 *      bill, so a booking-only return leaves return_value NULL.
 *
 * LIMITS, stated plainly:
 *   • A walk-in who never gives a phone number is invisible here. In THIS
 *     database 0 of 23 orders carry a guest_mobile, so today the money signal
 *     is effectively blind and attribution will lean on ct_bookings alone.
 *   • This is LAST-TOUCH, not causal. A guest who was coming back anyway still
 *     gets counted. There is no hold-out group, so "revenue attributed" is an
 *     upper bound on "revenue caused".
 *   • Only targets we actually reached (send_status='sent', sent_at NOT NULL)
 *     are ever attributed.
 *   • The window is campaign-scoped (segment.attribution_days, default 30). A
 *     guest who returns on day 31 is not counted.
 *   • A phone shared by a family/office attributes the whole table to whoever
 *     we messaged.
 */
export interface AttributionResult {
  checked: number;
  newly_attributed: number;
  total_returned: number;
  total_return_value: number;
  /** Returned guests we can prove came back but cannot value (no linked bill). */
  returned_without_value: number;
}

export function attributeCampaign(
  db: DB,
  campaignId: string,
  opts: { outletId?: string | null; nowMs?: number } = {},
): AttributionResult {
  const nowMs = opts.nowMs ?? Date.now();
  // No outlet context → do NOT filter by outlet. Silently attributing ₹0
  // because the caller had no current outlet would be worse than counting a
  // sister outlet's bill: it looks like the campaign earned nothing.
  const outlet = String(opts.outletId ?? '').trim();
  const outletClause = outlet ? `AND (o.outlet_id = @outlet OR o.outlet_id IS NULL)` : '';
  const campaign = db.prepare(`SELECT * FROM ct_campaigns WHERE id = ?`).get(campaignId) as CampaignRow | undefined;
  const result: AttributionResult = {
    checked: 0, newly_attributed: 0, total_returned: 0, total_return_value: 0, returned_without_value: 0,
  };
  if (!campaign) return result;

  const meta = parseCampaignMeta(campaign.segment);
  const windowDays = meta.attribution_days || DEFAULT_ATTRIBUTION_DAYS;

  const open = db.prepare(`
    SELECT * FROM ct_campaign_targets
    WHERE campaign_id = ? AND send_status = 'sent' AND sent_at IS NOT NULL AND returned_at IS NULL
  `).all(campaignId) as TargetRow[];
  result.checked = open.length;

  const stamp = db.prepare(`UPDATE ct_campaign_targets SET returned_at = ?, return_value = ? WHERE id = ? AND returned_at IS NULL`);

  for (const t of open) {
    const sentMs = Date.parse(t.sent_at || '');
    if (!Number.isFinite(sentMs)) continue;
    const untilMs = Math.min(nowMs, sentMs + windowDays * DAY_MS);
    if (untilMs <= sentMs) continue;
    const sentIso = new Date(sentMs).toISOString();
    const untilIso = new Date(untilMs).toISOString();
    const sentDate = istDateStr(sentMs);
    const untilDate = istDateStr(untilMs);
    const key = norm10(t.phone_e164);

    let earliest: string | null = null;
    let value = 0;
    let haveValue = false;

    // 1. Settled orders — presence AND money.
    if (key) {
      try {
        const row = db.prepare(`
          SELECT MIN(REPLACE(o.created_at, ' ', 'T')) AS first_at,
                 SUM(COALESCE(o.total, 0))            AS spend,
                 COUNT(*)                             AS n
          FROM orders o
          WHERE ${KEY10('o.guest_mobile')} = @key
            AND o.status = 'settled'
            AND REPLACE(o.created_at, ' ', 'T') >= @from
            AND REPLACE(o.created_at, ' ', 'T') <= @to
            ${outletClause}
        `).get(outlet ? { key, from: sentIso, to: untilIso, outlet } : { key, from: sentIso, to: untilIso }) as any;
        if (row && Number(row.n) > 0) {
          earliest = String(row.first_at || '');
          value += Number(row.spend) || 0;
          haveValue = true;
        }
      } catch { /* older schema → skip this proof */ }
    }

    // 2. Loyalty-desk visits — PRESENCE ONLY. Deliberately no money.
    //
    // /api/crm/guests/settle-capture writes a crm_guest_visits row for the very
    // same settled order that step 1 already counted (src/lib/crm-guests.ts:164),
    // so adding this spend too reported roughly double what the campaign
    // actually earned — and a win-back report that overstates itself is worse
    // than no report, because it justifies spending more on a channel that did
    // not perform.
    //
    // Orders are the money of record; the loyalty ledger only widens the
    // evidence that the guest CAME BACK (a walk-in logged at the desk with no
    // linked order still proves a return). Where both exist, step 1 wins.
    if (key) {
      try {
        const row = db.prepare(`
          SELECT MIN(REPLACE(v.visited_at, ' ', 'T')) AS first_at,
                 COUNT(*)                             AS n
          FROM crm_guest_visits v
          JOIN crm_guests g ON g.id = v.guest_id
          WHERE substr(${NORM('g.mobile')}, -10) = ?
            AND REPLACE(v.visited_at, ' ', 'T') >= ?
            AND REPLACE(v.visited_at, ' ', 'T') <= ?
        `).get(key, sentIso, untilIso) as any;
        if (row && Number(row.n) > 0) {
          const first = String(row.first_at || '');
          if (first && (!earliest || first < earliest)) earliest = first;
        }
      } catch { /* no loyalty ledger → skip */ }
    }

    // 3. Bookings actually seated/completed — presence ONLY, no bill.
    if (t.guest_id) {
      try {
        const row = db.prepare(`
          SELECT MIN(${VISIT_AT}) AS first_date, COUNT(*) AS n
          FROM ct_bookings b
          WHERE b.guest_id = ? AND b.status IN ('seated','completed')
            AND ${VISIT_AT} >= ? AND ${VISIT_AT} <= ?
        `).get(t.guest_id, sentDate, untilDate) as any;
        if (row && Number(row.n) > 0) {
          const first = String(row.first_date || '');
          // A booking gives us a DATE only; compare on the date portion so a
          // same-day order still wins the "earliest" slot.
          if (first && (!earliest || first < earliest.slice(0, 10))) earliest = `${first}T00:00:00.000Z`;
        }
      } catch { /* skip */ }
    }

    if (!earliest) continue;
    stamp.run(earliest, haveValue ? Math.round(value) : null, t.id);
    result.newly_attributed++;
  }

  const agg = db.prepare(`
    SELECT COUNT(*)                                            AS returned,
           SUM(COALESCE(return_value, 0))                      AS value,
           SUM(CASE WHEN return_value IS NULL THEN 1 ELSE 0 END) AS novalue
    FROM ct_campaign_targets
    WHERE campaign_id = ? AND returned_at IS NOT NULL
  `).get(campaignId) as any;
  result.total_returned = Number(agg?.returned) || 0;
  result.total_return_value = Math.round(Number(agg?.value) || 0);
  result.returned_without_value = Number(agg?.novalue) || 0;
  return result;
}

// ─── Reporting ─────────────────────────────────────────────────────────────

export interface CampaignReport {
  campaign: CampaignRow;
  meta: CampaignSegmentMeta;
  counts: ReturnType<typeof countByStatus>;
  attribution: {
    returned: number;
    return_value: number;
    returned_without_value: number;
    /** returned ÷ sent, 0–100, 1 decimal. */
    return_rate: number;
  };
}

export function campaignReport(db: DB, campaignId: string): CampaignReport | null {
  const campaign = db.prepare(`SELECT * FROM ct_campaigns WHERE id = ?`).get(campaignId) as CampaignRow | undefined;
  if (!campaign) return null;
  const counts = countByStatus(db, campaignId);
  const agg = db.prepare(`
    SELECT COUNT(*)                                              AS returned,
           SUM(COALESCE(return_value, 0))                        AS value,
           SUM(CASE WHEN return_value IS NULL THEN 1 ELSE 0 END) AS novalue
    FROM ct_campaign_targets WHERE campaign_id = ? AND returned_at IS NOT NULL
  `).get(campaignId) as any;
  const returned = Number(agg?.returned) || 0;
  return {
    campaign,
    meta: parseCampaignMeta(campaign.segment),
    counts,
    attribution: {
      returned,
      return_value: Math.round(Number(agg?.value) || 0),
      returned_without_value: Number(agg?.novalue) || 0,
      return_rate: counts.sent > 0 ? Math.round((returned / counts.sent) * 1000) / 10 : 0,
    },
  };
}

/** Render the local copy of the approved body for PREVIEW ONLY. */
export function previewMessage(meta: CampaignSegmentMeta, vars: Record<string, string>): string {
  const body = String(meta.preview_body || '');
  if (!body) return '';
  // Support both {{name}} (local editing style) and {{1}} (Meta's positional
  // style) so a pasted approved body previews correctly either way.
  const positional: Record<string, string> = {};
  meta.param_order.forEach((k, i) => { positional[String(i + 1)] = vars[k] ?? ''; });
  return renderTemplate(body, { ...vars, ...positional });
}
