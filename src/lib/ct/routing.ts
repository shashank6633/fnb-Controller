/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Call-to-Table — "who should take this call" resolvers.
 *
 * HONEST SCOPE: this app does NOT control the PBX. Nothing here can re-route a
 * ringing call, pin a queue, or tell TeleCMI which extension to ring — there is
 * no such API wired into this product and none is invented here. What these
 * resolvers do is make the right answer OBVIOUS TO THE HUMAN who is about to
 * pick up: the Live Calls board says "last handled by Priya" and
 * "VIP · 12 visits · Rs 48,000". The routing decision stays with the GRE team.
 *
 * Two independent, independently-flagged hints:
 *
 *   stickyAgent(db, phone)  → the GRE who last ANSWERED this guest, so a
 *                             regular keeps talking to the person who knows
 *                             them. Flag: ct_settings.sticky_agent = '1'.
 *   vipStatus(db, phone)    → high-value guest, WITH the numbers that make it
 *                             high value (visits / spend), so the badge is
 *                             auditable rather than a mysterious star.
 *                             Flag: ct_settings.vip_routing = '1'.
 *
 * BOTH DEFAULT OFF. With a flag off the resolver returns a neutral result
 * (null / NEUTRAL_VIP) and does no work at all — callers therefore render
 * nothing and the surfaces behave EXACTLY as they did before this module
 * existed. Flag reads fail closed: any DB error → treated as off.
 *
 * Phones are ALWAYS matched on norm10() — the last-10-digit key shared with
 * guest-unify.ts — never on raw strings. '+919848010274', '09848010274' and
 * '9848010274' are one guest, and the loyalty/dining maps are keyed the same
 * way, so the sticky lookup and the VIP lookup can never disagree about who
 * the caller is.
 */
import type Database from 'better-sqlite3';
import { ctSetting } from './settings';
import { getAgentMap, getUserNamesByEmail, resolveAgentLabel } from './agents';
import {
  norm10,
  buildLoyaltyMap,
  buildDiningMap,
  type LoyaltyAgg,
  type DiningAgg,
} from './guest-unify';

type DB = Database.Database;

// ─── Tunables (documented constants, not silent magic) ─────────────────────

/**
 * How far back an answered call still counts as "your guest".
 *
 * 180 days ≈ two quarters. The reasoning is anchored to numbers this codebase
 * already committed to: metrics.ts treats a guest as LAPSED after 45 days and
 * the win-back default (ct_settings.lapsed_days) is 60. A sticky agent must
 * outlive a lapse — otherwise continuity evaporates exactly when a returning
 * guest calls back, which is the case it exists for — so the window is 3× the
 * win-back bucket. Beyond that the claim stops being true: the GRE will not
 * remember the conversation, and in a venue with normal GRE turnover the agent
 * may not even be on the roster any more. A hint that is wrong is worse than
 * no hint, so the window is deliberately finite.
 */
export const STICKY_WINDOW_DAYS = 180;

/**
 * Ignore "answered" rows shorter than this — a connect-and-drop is not a
 * relationship. 10s is conservative: the shortest genuinely-answered inbound
 * call in this database is 54s, so nothing real is excluded today, while a
 * 2-second mis-pick can never become a guest's sticky agent.
 */
export const STICKY_MIN_DURATION_SEC = 10;

const DAY_MS = 86_400_000;

/** Mirrors metrics.ts CALL_AT: sqlite `datetime('now')` rows are
 *  "YYYY-MM-DD HH:MM:SS" while app writes are ISO — swapping the space for 'T'
 *  makes both forms compare correctly against an ISO cutoff (both are UTC). */
const CALL_AT = `REPLACE(COALESCE(NULLIF(c.started_at, ''), c.created_at), ' ', 'T')`;

/** SQLite punctuation-stripping macro — byte-identical to guest-unify's NORM. */
const NORM = (col: string) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col},''),' ',''),'-',''),'+',''),'(',''),')',''),'.',''),'/','')`;
/** Last-10-digit phone key computed IN SQL — the norm10() equivalent. */
const KEY10 = (col: string) => `substr(${NORM(col)}, -10)`;

// ─── Feature flags (fail closed) ───────────────────────────────────────────

function flagOn(db: DB, key: string): boolean {
  try {
    return ctSetting(db, key) === '1';
  } catch {
    return false; // no ct_settings / DB trouble → behave as if the feature is off
  }
}

/** ct_settings.sticky_agent === '1'. Default '0'. */
export function isStickyAgentOn(db: DB): boolean {
  return flagOn(db, 'sticky_agent');
}

/** ct_settings.vip_routing === '1'. Default '0'. */
export function isVipRoutingOn(db: DB): boolean {
  return flagOn(db, 'vip_routing');
}

// ─── Sticky agent ──────────────────────────────────────────────────────────

export interface StickyAgentHint {
  /** Raw agent id as stored on ct_calls.agent_user (e.g. 'priya.gre'). */
  agent_user: string;
  /** Human label via the admin's agent_map → staff name; falls back to the raw id. */
  agent_label: string;
  /** UTC ISO of that answered call. */
  last_answered_at: string;
  /** How many of this guest's in-window answered inbound calls that agent took. */
  answered_calls: number;
  /** Total in-window answered inbound calls for this guest (the denominator). */
  total_answered_calls: number;
  /** The recency window actually applied, for display/audit. */
  window_days: number;
}

interface StickyOpts {
  /** Pre-loaded maps so a batch caller does not re-read ct_settings/users per phone. */
  agentMap?: Record<string, string>;
  userNames?: Record<string, string>;
  /** Injectable clock (tests / deterministic proofs). */
  nowMs?: number;
}

/**
 * The GRE who last ANSWERED this guest — null when unknown.
 *
 * Only ANSWERED INBOUND calls count:
 *   • missed / abandoned / voicemail rows are not a conversation, so they can
 *     never make an agent sticky;
 *   • outbound rows are OUR callbacks. Those are handed out by the recovery
 *     queue's round-robin (ingest.ts nextAssignee), so letting them set
 *     stickiness would just echo the rotation back at us and dress a random
 *     assignment up as a relationship. A guest whose only history is outbound
 *     therefore returns null — honestly "unknown" — rather than a fake regular.
 *   • rows with a blank agent_user, or shorter than STICKY_MIN_DURATION_SEC
 *     with no answered_at stamp, are skipped.
 *
 * Returns null when the flag is off, the phone has no 10-digit key, or nothing
 * qualifies inside STICKY_WINDOW_DAYS.
 */
export function stickyAgent(db: DB, phone: string, opts: StickyOpts = {}): StickyAgentHint | null {
  if (!isStickyAgentOn(db)) return null;          // flag off → no work, no hint
  const k = norm10(phone);
  if (!k) return null;

  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - STICKY_WINDOW_DAYS * DAY_MS).toISOString();

  let rows: Array<{ agent_user: string; at: string }> = [];
  try {
    rows = db.prepare(`
      SELECT COALESCE(c.agent_user, '') AS agent_user, ${CALL_AT} AS at
      FROM ct_calls c
      WHERE ${KEY10('c.phone_e164')} = @k
        AND c.direction = 'inbound'
        AND c.status = 'answered'
        AND TRIM(COALESCE(c.agent_user, '')) <> ''
        AND (COALESCE(c.duration_sec, 0) >= @minDur OR COALESCE(c.answered_at, '') <> '')
        AND ${CALL_AT} >= @cutoff
      ORDER BY at DESC
      LIMIT 200
    `).all({ k, minDur: STICKY_MIN_DURATION_SEC, cutoff }) as any[];
  } catch {
    return null;  // ct_calls unreadable → no hint, never an exception into the UI
  }
  if (rows.length === 0) return null;

  const top = String(rows[0].agent_user || '').trim();
  if (!top) return null;
  const topLc = top.toLowerCase();
  const mine = rows.filter(r => String(r.agent_user || '').trim().toLowerCase() === topLc).length;

  const agentMap = opts.agentMap ?? getAgentMap(db);
  const userNames = opts.userNames ?? getUserNamesByEmail(db);

  return {
    agent_user: top,
    agent_label: resolveAgentLabel(top, agentMap, userNames) || top,
    last_answered_at: String(rows[0].at || ''),
    answered_calls: mine,
    total_answered_calls: rows.length,
    window_days: STICKY_WINDOW_DAYS,
  };
}

// ─── VIP status ────────────────────────────────────────────────────────────

export interface VipThresholds {
  /** ct_settings.vip_min_visits (default 5). 0 = criterion disabled. */
  minVisits: number;
  /** ct_settings.vip_min_spend in rupees (default 25000). 0 = criterion disabled. */
  minSpend: number;
}

export interface VipSourceStat { visits: number; spend: number }

export interface VipStatusResult {
  /** False when ct_settings.vip_routing is off — everything else is neutral. */
  enabled: boolean;
  isVip: boolean;
  /** max(loyalty, dining) — see note below on why max and not sum. */
  visits: number;
  /** max(loyalty, dining), whole rupees. */
  spend: number;
  /** Human, auditable justification — empty when not a VIP. */
  reasons: string[];
  thresholds: VipThresholds;
  /** Per-source breakdown so a manager can see where the number came from. */
  sources: { loyalty: VipSourceStat | null; dining: VipSourceStat | null };
}

export const NEUTRAL_VIP: VipStatusResult = Object.freeze({
  enabled: false,
  isVip: false,
  visits: 0,
  spend: 0,
  reasons: [] as string[],
  thresholds: Object.freeze({ minVisits: 0, minSpend: 0 }) as VipThresholds,
  sources: Object.freeze({ loyalty: null, dining: null }) as VipStatusResult['sources'],
}) as VipStatusResult;

function intSetting(db: DB, key: string, fallback: number): number {
  let raw = '';
  try { raw = String(ctSetting(db, key) ?? '').trim(); } catch { raw = ''; }
  // An ABSENT/blank setting must fall back to the documented default, not to
  // Number('') === 0 — a silent 0 reads as "criterion disabled" and would quietly
  // switch VIP detection off on any DB where the migration row is missing.
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;   // garbage/negative → default
  return Math.floor(n);
}

/** Thresholds from ct_settings, with the migrated defaults as the fallback. */
export function vipThresholds(db: DB): VipThresholds {
  return {
    minVisits: intSetting(db, 'vip_min_visits', 5),
    minSpend: intSetting(db, 'vip_min_spend', 25000),
  };
}

/** '48000' → '48,000' (Indian grouping), with a plain fallback if ICU is thin. */
function inr(n: number): string {
  const v = Math.round(n);
  try { return v.toLocaleString('en-IN'); } catch { return String(v); }
}

interface VipOpts {
  /** Pre-built maps (buildLoyaltyMap / buildDiningMap) for batch callers. */
  loyalty?: Map<string, LoyaltyAgg>;
  dining?: Map<string, DiningAgg>;
  /** Outlet scope for the dining rollup — matches the guest 360's scoping. */
  outletId?: string | null;
  thresholds?: VipThresholds;
}

/**
 * Is this caller a high-value guest, and WHY?
 *
 * Sources are exactly the two already joined into the guest 360:
 *   • buildLoyaltyMap — crm_guests.visit_count / total_spend (loyalty desk)
 *   • buildDiningMap  — settled orders keyed by guest_mobile (real dining)
 *
 * The two are combined with max(), not sum(): a single evening can be recorded
 * in BOTH (the loyalty desk stamps the visit, the POS settles the bill), so
 * adding them would inflate a guest into VIP status they have not earned.
 * max() is the defensible floor — "this guest has AT LEAST this many visits".
 * The per-source numbers are returned too, so nothing is hidden.
 *
 * A threshold of 0 disables that criterion (otherwise "0 visits ≥ 0" would make
 * literally every caller a VIP). If both are 0, nobody is a VIP.
 */
export function vipStatus(db: DB, phone: string, opts: VipOpts = {}): VipStatusResult {
  if (!isVipRoutingOn(db)) return NEUTRAL_VIP;    // flag off → neutral, no queries
  const k = norm10(phone);
  const thresholds = opts.thresholds ?? vipThresholds(db);
  const empty: VipStatusResult = {
    enabled: true, isVip: false, visits: 0, spend: 0, reasons: [],
    thresholds, sources: { loyalty: null, dining: null },
  };
  if (!k) return empty;

  const loyaltyMap = opts.loyalty ?? buildLoyaltyMap(db);
  const diningMap = opts.dining ?? buildDiningMap(db, opts.outletId ?? null);

  const l = loyaltyMap.get(k) || null;
  const d = diningMap.get(k) || null;

  const loyalty: VipSourceStat | null = l
    ? { visits: Number(l.visit_count) || 0, spend: Math.round(Number(l.total_spend) || 0) }
    : null;
  const dining: VipSourceStat | null = d
    ? { visits: Number(d.visits) || 0, spend: Math.round(Number(d.total_spent) || 0) }
    : null;

  const visits = Math.max(loyalty?.visits ?? 0, dining?.visits ?? 0);
  const spend = Math.max(loyalty?.spend ?? 0, dining?.spend ?? 0);

  const reasons: string[] = [];
  if (thresholds.minVisits > 0 && visits >= thresholds.minVisits) {
    reasons.push(`${visits} visits (VIP at ${thresholds.minVisits})`);
  }
  if (thresholds.minSpend > 0 && spend >= thresholds.minSpend) {
    reasons.push(`Rs ${inr(spend)} spend (VIP at Rs ${inr(thresholds.minSpend)})`);
  }

  return {
    enabled: true,
    isVip: reasons.length > 0,
    visits,
    spend,
    reasons,
    thresholds,
    sources: { loyalty, dining },
  };
}

// ─── Batch resolver (one pass for a whole ringing board) ───────────────────

export interface RoutingHint {
  phone: string;
  /** norm10 key actually used for the lookups ('' when the number is unusable). */
  key10: string;
  sticky: StickyAgentHint | null;
  vip: VipStatusResult;
}

export interface RoutingHints {
  sticky_agent: boolean;
  vip_routing: boolean;
  window_days: number;
  thresholds: VipThresholds;
  hints: Record<string, RoutingHint>;
}

/**
 * Resolve hints for a whole board in one pass — the loyalty/dining maps and the
 * agent map are built ONCE, not once per ringing card.
 *
 * With both flags off this returns `{ sticky_agent: false, vip_routing: false,
 * hints: {} }` without touching ct_calls, crm_guests or orders at all.
 */
/**
 * Strip the loyalty figures from a VIP result for a non-management viewer.
 *
 * Keeps `isVip` and the thresholds — a GRE must still know to prioritise the
 * call — but removes the lifetime spend, visit counts and the per-source
 * breakdown that reveal them. `reasons` is replaced with a bare statement
 * rather than "12 visits, ₹48,000", because the justification IS the data.
 *
 * Dining spend is intentionally open elsewhere in this app (see /api/customers),
 * but the two figures here are max(loyalty, dining) and therefore may carry the
 * loyalty number, so both are withheld together.
 */
function redactLoyalty(v: VipStatusResult, allow: boolean): VipStatusResult {
  if (allow) return v;
  return {
    ...v,
    visits: 0,
    spend: 0,
    reasons: v.isVip ? ['Priority guest'] : [],
    sources: { loyalty: null, dining: null },
  };
}

export function routingHints(
  db: DB,
  phones: string[],
  opts: {
    outletId?: string | null;
    nowMs?: number;
    /**
     * Include the loyalty figures behind a VIP badge. MANAGEMENT ONLY —
     * points/tier/lifetime spend are gated on every sibling endpoint, so the
     * caller must pass isManagement(user). Defaults to false: a route that
     * forgets to ask leaks nothing.
     *
     * A non-management GRE still sees THAT a caller is a VIP (they need to
     * prioritise the call); they just don't see what the guest is worth.
     */
    includeLoyalty?: boolean;
  } = {},
): RoutingHints {
  const sticky = isStickyAgentOn(db);
  const vip = isVipRoutingOn(db);
  const thresholds = vip ? vipThresholds(db) : { minVisits: 0, minSpend: 0 };
  const out: RoutingHints = {
    sticky_agent: sticky,
    vip_routing: vip,
    window_days: STICKY_WINDOW_DAYS,
    thresholds,
    hints: {},
  };
  if (!sticky && !vip) return out;   // both off → zero queries, empty payload

  const agentMap = sticky ? getAgentMap(db) : {};
  const userNames = sticky ? getUserNamesByEmail(db) : {};
  const loyalty = vip ? buildLoyaltyMap(db) : new Map<string, LoyaltyAgg>();
  const dining = vip ? buildDiningMap(db, opts.outletId ?? null) : new Map<string, DiningAgg>();

  const seen = new Set<string>();
  for (const raw of phones) {
    const phone = String(raw || '').trim();
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    out.hints[phone] = {
      phone,
      key10: norm10(phone),
      sticky: sticky ? stickyAgent(db, phone, { agentMap, userNames, nowMs: opts.nowMs }) : null,
      vip: vip
        ? redactLoyalty(vipStatus(db, phone, { loyalty, dining, thresholds }), opts.includeLoyalty === true)
        : NEUTRAL_VIP,
    };
  }
  return out;
}
