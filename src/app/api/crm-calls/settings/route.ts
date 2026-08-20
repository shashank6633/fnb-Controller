/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import {
  ctSetting,
  ctSettings,
  setCtSetting,
  webhookToken,
  isTelecmiConfigured,
  telecmiCredentialStatus,
  CT_SETTING_DEFAULTS,
} from '@/lib/ct/settings';
import { describeCallAgents, isAppLoginAgent } from '@/lib/ct/agents';

/**
 * CRM Call-to-Table — Settings (/api/crm-calls/settings). Admin-only.
 *
 * GET → all ct_settings (defaults merged) EXCEPT the raw webhook token and the
 *       TeleCMI credentials, plus computed webhook URLs (RELATIVE paths — the
 *       client prepends window.location.origin for the copy button),
 *       telecmi_configured, and telecmi_credentials (booleans + a masked tail,
 *       never the values), plus the Agent-mapping editor's inputs: agents_seen /
 *       agents_detail (TeleCMI ids only — app login emails are excluded, see the
 *       GET), agent_hidden, and the staff picker.
 * PUT → { key: value, ... } partial update. Allowlist = CT_SETTING_DEFAULTS
 *       keys + 'telecmi_base_url' + 'agent_hidden' + the two TeleCMI credentials.
 *
 * The credentials are WRITE-ONLY: an admin can save or clear them here so the
 * owner can configure their own telephony from the UI, but no read path ever
 * returns them. Everything else in SECRET_KEYS stays blocked both ways.
 *
 * ── WHERE THE AGENT-MAPPING ROWS COME FROM, AND WHY HIDING EXISTS ───────────
 * The ids in that editor arrive from TWO different places, and only one of them
 * is ours to delete:
 *   1. THE SAVED MAP — the 'agent_map' setting: rows an admin typed here. The
 *      PUT stores a canonical REPLACEMENT of the whole object, so removing an
 *      entry from it does persist.
 *   2. CALL HISTORY (derived) — describeCallAgents() reads the distinct
 *      ct_calls.agent_user values. These are not a setting at all; they are a
 *      projection of real calls that really were answered by that id.
 * So "delete" cannot mean the same thing for both. Un-mapping a derived id (say
 * the retired extension "5004_33338614") saves nothing to change — the id is
 * still on those calls, so the next GET derives it again and it comes back as
 * "— Unmapped —". That is not a lost write; there is nothing about a derived id
 * that a settings write could remove. HIDING is the only way to take one off
 * the list: 'agent_hidden' is an admin's explicit "stop listing this id", and
 * the GET below filters hidden ids out of agents_seen / agents_detail while
 * returning the hidden list separately so the editor can offer "show hidden".
 * Nothing is deleted anywhere: ct_calls, log-callback, and resolveAgentLabel()
 * are untouched, so a hidden agent's calls still display exactly as before.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// 'auto_analyze' is not part of CT_SETTING_DEFAULTS (that lib is shared/owned
// elsewhere) — it is an AI-call-scoring toggle ('0'|'1', default '0') surfaced
// only here.
// Likewise the four call-hint keys: they are seeded by the db.ts migration
// (all conservative/off) rather than by CT_SETTING_DEFAULTS, so they are
// allow-listed explicitly here. See src/lib/ct/routing.ts.
const ROUTING_HINT_KEYS: readonly string[] = ['sticky_agent', 'vip_routing', 'vip_min_visits', 'vip_min_spend'];

// Missed-call WhatsApp acknowledgement — also db.ts-seeded and off by default.
// See src/lib/ct/missed-ack.ts.
const MISSED_ACK_KEYS: readonly string[] = ['missed_call_whatsapp', 'missed_call_wa_text'];

/**
 * The Agent-mapping editor's dismiss list — a JSON array of TeleCMI agent ids an
 * admin has taken off that list (see the header). Like the routing hints it is
 * deliberately NOT in CT_SETTING_DEFAULTS (that lib is shared/owned elsewhere),
 * so it is allow-listed here and given its own validate() case below.
 *
 * NOT A SECRET (per the release-gate comment on SECRET_KEYS): it holds nothing
 * but TeleCMI agent ids the same admin is already looking at in this editor, so
 * it stays OFF SECRET_KEYS on purpose and reads back through this GET.
 */
const AGENT_HIDDEN_KEY = 'agent_hidden';
/** Cap per id (matches the agent_map key cap) and on the whole list. */
const AGENT_ID_MAX = 100;
const AGENT_HIDDEN_MAX = 500;

/**
 * TeleCMI app credentials. WRITE-ONLY through this route: an admin may save or
 * clear them (otherwise configuring telephony needs an SSH session and a
 * restart), but they are stripped from every read — the GET reports
 * telecmiCredentialStatus() instead, which is a boolean plus a masked tail.
 */
const CREDENTIAL_KEYS: readonly string[] = ['telecmi_appid', 'telecmi_secret'];

const ALLOWED_KEYS: readonly string[] = [...Object.keys(CT_SETTING_DEFAULTS), 'telecmi_base_url', 'auto_analyze', 'analysis_retention', AGENT_HIDDEN_KEY, ...ROUTING_HINT_KEYS, ...MISSED_ACK_KEYS, ...CREDENTIAL_KEYS];

/**
 * ⚠ RELEASE GATE — read this before adding ANY key to ct_settings.
 *
 * publicSettings() below is a DENYLIST: it hands the browser every ct_settings
 * row and then deletes the ones named here. So a key that is not on this list
 * is PUBLIC by default, whether or not this route knows it exists — it does not
 * have to be in ALLOWED_KEYS, seeded by db.ts, or referenced anywhere in this
 * file. Any code anywhere that calls setCtSetting() with a new key has, by that
 * act alone, published it to every admin's browser through this GET (and
 * through the PUT echo).
 *
 * That is exactly how `telecmi_user_tokens` leaked: the caller-ID route
 * (src/app/api/telecmi/callerid/route.ts) stashes each agent's 30-day TeleCMI
 * USER TOKEN there, and neither file was wrong on its own. A user token can
 * place calls and re-point caller ID for that agent until it expires, so it is
 * a live credential, not config.
 *
 * If you store a token, password, secret, signing key or session in
 * ct_settings, add the key HERE in the same commit. If it holds nothing an
 * admin's browser may not see, leave it off and say so in a comment where you
 * write it.
 */
const SECRET_KEYS: readonly string[] = [
  ...CREDENTIAL_KEYS, 'appid', 'secret',
  'webhook_token', 'telecmi_webhook_secret',
  // Per-agent TeleCMI user tokens ({ agentId: { token, expires_at } }), written
  // ONLY by /api/telecmi/callerid. Never readable and never writable here.
  'telecmi_user_tokens',
];

/** Keys refused in BOTH directions (everything secret that isn't a credential
 *  the admin is allowed to rotate from the UI). The webhook token in particular
 *  is a URL path component the client already receives pre-baked — letting it
 *  be set here would just be a way to smuggle a chosen token in. */
const WRITE_BLOCKED_KEYS: readonly string[] = SECRET_KEYS.filter(k => !CREDENTIAL_KEYS.includes(k));

const HM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * Canonical form of one TeleCMI agent id for hiding and for matching: trimmed,
 * lowercased, capped. Deliberately the SAME normalization agent_map keys get
 * (see the 'agent_map' case), so hiding "GRE.Ravi" also hides the row derived
 * from a call that reported "gre.ravi" — one id, one row, either way.
 */
function canonAgentId(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().slice(0, AGENT_ID_MAX);
}

/**
 * The stored dismiss list as canonical ids. Returns [] for a missing row, an
 * empty row, or anything unparseable — a hand-edited ct_settings value must
 * never 500 the settings GET, and "can't read it" has to mean "hide nothing"
 * (failing the other way would make agents vanish from the editor with no way
 * to get them back).
 */
function hiddenAgentIds(db: Database.Database): string[] {
  try {
    const parsed = JSON.parse(ctSetting(db, AGENT_HIDDEN_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const it of parsed) {
      const id = canonAgentId(it);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= AGENT_HIDDEN_MAX) break;
    }
    return out;
  } catch { return []; }
}

function publicSettings(db: Database.Database): Record<string, string> {
  const s = ctSettings(db);
  for (const k of SECRET_KEYS) delete s[k];
  // auto_analyze lives outside CT_SETTING_DEFAULTS — always surface it in the
  // GET, normalized to '0'|'1' (default off).
  s.auto_analyze = s.auto_analyze === '1' ? '1' : '0';
  // analysis_retention: default 'permanent' (keep scorecards) unless explicitly
  // set to 'ephemeral' (view-on-click, nothing stored).
  s.analysis_retention = s.analysis_retention === 'ephemeral' ? 'ephemeral' : 'permanent';
  // Call-hint flags/thresholds: normalize so the editor always gets a usable
  // value even on a DB where the migration row is somehow absent. Both flags
  // default OFF — only an explicit '1' turns a hint on.
  s.sticky_agent = s.sticky_agent === '1' ? '1' : '0';
  s.vip_routing = s.vip_routing === '1' ? '1' : '0';
  const nonNeg = (v: unknown, dflt: number) => {
    const n = Number(v);
    return String(Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt);
  };
  s.vip_min_visits = nonNeg(s.vip_min_visits, 5);
  s.vip_min_spend = nonNeg(s.vip_min_spend, 25000);
  // Missed-call auto-acknowledgement: OFF unless the stored value is exactly
  // '1', so a missing/garbled row can never read as "messaging is on".
  s.missed_call_whatsapp = s.missed_call_whatsapp === '1' ? '1' : '0';
  s.missed_call_wa_text = typeof s.missed_call_wa_text === 'string' ? s.missed_call_wa_text : '';
  return s;
}

export async function GET() {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const db = getDb();
  const token = webhookToken(db);
  // For the Agent Mapping editor: the TeleCMI agent ids seen on calls (so the
  // admin can map the ones that actually appear) + the staff list to map them to.
  //
  // ct_calls.agent_user legitimately holds TWO kinds of value (see
  // src/lib/ct/agents.ts): a TeleCMI id, and — for callbacks a GRE made from
  // their own phone — that GRE's app login email. Only the first kind belongs in
  // this editor: an email can never be mapped to a TeleCMI id, so pre-listing one
  // just parks a permanent phantom "unmapped" row (that is what put
  // bidigapushpa06@gmail.com / shashank@akanhyd.com in the list and badged them).
  // Those rows are NOT broken — resolveAgentLabel() already shows the person's
  // name everywhere they appear — so they are dropped from the pre-list only, and
  // the SAVED agent_map is left exactly as stored: if an admin mapped an email
  // once, that entry stays theirs to keep or remove.
  //
  // Then the admin's own dismiss list is applied. A derived id cannot be deleted
  // (it is still on real calls — see the header), so hiding is what actually
  // takes a row off this editor: hidden ids are filtered OUT of both agents_seen
  // and agents_detail, and returned separately as agent_hidden so the page can
  // offer "show hidden (N)" and un-hide. This is presentation only — the calls,
  // their agent_user values and resolveAgentLabel() are untouched, so a hidden
  // agent still shows normally everywhere else in the CRM.
  const hidden = hiddenAgentIds(db);
  const hiddenSet = new Set(hidden);
  const seenAgents = describeCallAgents(db)
    .filter(a => a.kind !== 'app_login' && !isAppLoginAgent(a.id))
    .filter(a => !hiddenSet.has(canonAgentId(a.id)));
  let staff: Array<{ email: string; name: string }> = [];
  try {
    staff = (db.prepare(
      `SELECT email, name FROM users WHERE is_active = 1 AND email IS NOT NULL ORDER BY name`,
    ).all() as Array<{ email: string; name: string }>).map(u => ({ email: u.email, name: u.name || u.email }));
  } catch { /* users table issue → empty picker, editor still usable via free text */ }
  return Response.json({
    settings: publicSettings(db),
    // Relative on purpose — client prepends its own origin (works across
    // localhost / testing / production without storing a hostname).
    webhook_live_url: `/api/telecmi/webhook/live/${token}`,
    webhook_cdr_url: `/api/telecmi/webhook/cdr/${token}`,
    telecmi_configured: isTelecmiConfigured(db),
    // Safe to send: { configured, appid:{set,source,masked}, secret:{…} }. The
    // source tells the admin whether an env var is overriding what they just
    // typed — without it, "saved but nothing changed" is indistinguishable from
    // a failed save.
    telecmi_credentials: telecmiCredentialStatus(db),
    // Unchanged key, unchanged shape (a flat list of raw ids, in the same
    // order) — an older client keeps working; it now simply carries TeleCMI ids
    // only. Kept alongside agents_detail so nothing has to read the richer form.
    agents_seen: seenAgents.map(a => a.id),
    // Additive: the same ids with usage, so the editor can mark a stale one
    // (e.g. the removed extension "5004_33338614" — real history, no longer a
    // live agent) instead of showing it identically to a working extension.
    // last_seen is the stored ct_calls timestamp text, '' when the row has none.
    agents_detail: seenAgents.map(a => ({ id: a.id, calls: a.calls, last_seen: a.last_seen })),
    // The ids the two lists above were filtered BY — canonical (trimmed +
    // lowercased), de-duplicated, [] when nothing is hidden. The editor needs it
    // to say "show hidden (N)" and to PUT the list back one id shorter to un-hide.
    agent_hidden: hidden,
    staff,
  });
}

/** Validate + normalize one settings value. Returns the string to store, or
 *  an error message. */
function validate(key: string, value: any): { ok: true; value: string } | { ok: false; error: string } {
  switch (key) {
    case 'sla_minutes': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 1440) {
        return { ok: false, error: 'sla_minutes must be a whole number of minutes between 1 and 1440' };
      }
      return { ok: true, value: String(n) };
    }
    case 'attribution_hours': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 720) {
        return { ok: false, error: 'attribution_hours must be a whole number between 1 and 720' };
      }
      return { ok: true, value: String(n) };
    }
    case 'business_open':
    case 'business_close': {
      const v = String(value ?? '').trim();
      if (!HM_RE.test(v)) return { ok: false, error: `${key} must be HH:mm (IST 24h), e.g. 12:00` };
      return { ok: true, value: v };
    }
    case 'auto_assign': {
      const v = String(value ?? '').trim();
      if (v !== 'off' && v !== 'round_robin') {
        return { ok: false, error: "auto_assign must be 'off' or 'round_robin'" };
      }
      return { ok: true, value: v };
    }
    case 'after_hours_whatsapp': {
      const v = value === true || value === 1 || value === '1' ? '1'
        : value === false || value === 0 || value === '0' ? '0' : null;
      if (v === null) return { ok: false, error: "after_hours_whatsapp must be '0' or '1'" };
      return { ok: true, value: v };
    }
    // Missed-call auto-acknowledgement (src/lib/ct/missed-ack.ts). Strictly
    // '0'|'1' so no truthy junk can ever switch guest messaging on.
    case 'missed_call_whatsapp': {
      const v = value === true || value === 1 || value === '1' ? '1'
        : value === false || value === 0 || value === '0' ? '0' : null;
      if (v === null) return { ok: false, error: "missed_call_whatsapp must be '0' or '1'" };
      return { ok: true, value: v };
    }
    case 'missed_call_wa_text': {
      const v = String(value ?? '');
      if (v.length > 1000) return { ok: false, error: 'missed_call_wa_text must be 1000 characters or fewer' };
      return { ok: true, value: v };
    }
    case 'auto_analyze': {
      const v = value === true || value === 1 || value === '1' ? '1'
        : value === false || value === 0 || value === '0' ? '0' : null;
      if (v === null) return { ok: false, error: "auto_analyze must be '0' or '1'" };
      return { ok: true, value: v };
    }
    case 'sticky_agent':
    case 'vip_routing': {
      const v = value === true || value === 1 || value === '1' ? '1'
        : value === false || value === 0 || value === '0' ? '0' : null;
      if (v === null) return { ok: false, error: `${key} must be '0' or '1'` };
      return { ok: true, value: v };
    }
    case 'vip_min_visits': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 10000) {
        return { ok: false, error: 'vip_min_visits must be a whole number between 0 and 10000 (0 = ignore visits)' };
      }
      return { ok: true, value: String(n) };
    }
    case 'vip_min_spend': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 100000000) {
        return { ok: false, error: 'vip_min_spend must be a whole number of rupees between 0 and 10,00,00,000 (0 = ignore spend)' };
      }
      return { ok: true, value: String(n) };
    }
    case 'analysis_retention': {
      const v = String(value ?? '').trim();
      if (v !== 'permanent' && v !== 'ephemeral') {
        return { ok: false, error: "analysis_retention must be 'permanent' or 'ephemeral'" };
      }
      return { ok: true, value: v };
    }
    case 'after_hours_template': {
      const v = String(value ?? '');
      if (v.length > 1000) return { ok: false, error: 'after_hours_template must be 1000 characters or fewer' };
      return { ok: true, value: v };
    }
    case 'agent_map': {
      // Accept an object or a JSON string; store canonical JSON text.
      let obj: any = value;
      if (typeof value === 'string') {
        try { obj = JSON.parse(value || '{}'); } catch { return { ok: false, error: 'agent_map must be valid JSON' }; }
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return { ok: false, error: 'agent_map must be a JSON object { telecmiAgentId: userEmail }' };
      }
      // Canonical storage: keys lowercased + trimmed so a mixed-case TeleCMI
      // agent id ("Gre.Ravi" vs "gre.ravi") can never split into two rows or
      // fail to resolve. Last non-empty value wins on a case-collision.
      //
      // AN UNASSIGNED AGENT IS KEPT. This used to require a value
      // (`if (key && val)`), which made agent_map "ids that have a staff
      // member" — but the map is ALSO the roster: /api/telecmi/agents lists
      // its keys, and both `add` (a new agent created on TeleCMI) and `map`
      // (an agent found by a scan) deliberately write id -> '' meaning "in
      // the roster, not yet assigned". So one press of Save mapping silently
      // deleted every agent nobody had assigned yet — including the ones just
      // discovered — and the roster shrank each time it was saved. An empty
      // value is a real state and is now preserved; an empty value still never
      // OVERWRITES an assignment on a case-collision, which is what keeps the
      // "last non-empty wins" rule above true.
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).trim().toLowerCase().slice(0, 100);
        const val = String(v ?? '').trim().slice(0, 200);
        if (!key) continue;
        if (val || !(key in clean)) clean[key] = val;
      }
      return { ok: true, value: JSON.stringify(clean) };
    }
    case AGENT_HIDDEN_KEY: {
      // Accept an array or a JSON string of one; store canonical JSON text.
      // AN EMPTY ARRAY IS VALID and means "nothing hidden" — it MUST be storable,
      // because [] is exactly what un-hiding the last id sends. (Unlike the
      // credentials, an empty value here is not a "clear the row" case: the row
      // is the list, and an empty list is a real state.)
      let arr: any = value;
      if (typeof value === 'string') {
        try { arr = JSON.parse(value || '[]'); } catch { return { ok: false, error: 'agent_hidden must be a JSON array of TeleCMI agent ids' }; }
      }
      if (!Array.isArray(arr)) {
        return { ok: false, error: 'agent_hidden must be a JSON array of TeleCMI agent ids' };
      }
      // Same canonical key form as agent_map (trim + lowercase + 100 chars), so a
      // hidden id matches its mapped/derived row whatever case TeleCMI reported.
      // De-duplicated, blanks dropped, whole list capped — the editor never sends
      // more than a screenful, so the cap only bounds a hand-crafted request.
      const clean: string[] = [];
      const seen = new Set<string>();
      for (const it of arr) {
        const id = canonAgentId(it);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        clean.push(id);
        if (clean.length >= AGENT_HIDDEN_MAX) break;
      }
      return { ok: true, value: JSON.stringify(clean) };
    }
    // ── TeleCMI credentials (write-only) ────────────────────────────────────
    // An empty string is a deliberate "clear it" — the caller gets the row
    // DELETED, not an empty row, so credential() falls back to env/none instead
    // of resolving to ''. Error messages describe the SHAPE only: echoing back
    // even a rejected value would put a mistyped secret in a log or a toast.
    case 'telecmi_appid': {
      const v = String(value ?? '').trim();
      if (!v) return { ok: true, value: '' };            // clear
      if (!/^\d+$/.test(v)) return { ok: false, error: 'TeleCMI App ID must be digits only' };
      if (v.length > 32) return { ok: false, error: 'TeleCMI App ID is too long' };
      return { ok: true, value: v };
    }
    case 'telecmi_secret': {
      const v = String(value ?? '').trim();
      if (!v) return { ok: true, value: '' };            // clear
      if (v.length > 300) return { ok: false, error: 'TeleCMI Secret is too long' };
      return { ok: true, value: v };
    }
    case 'telecmi_base_url': {
      const v = String(value ?? '').trim();
      if (v && !/^https?:\/\/\S+$/.test(v)) {
        return { ok: false, error: 'telecmi_base_url must be an http(s) URL (or empty to reset)' };
      }
      if (v.length > 300) return { ok: false, error: 'telecmi_base_url too long' };
      return { ok: true, value: v };
    }
    case 'quick_send_links': {
      // JSON array of { label, url?, message? }. Keep rows with a label; a URL,
      // if present, must be http(s). A row is "sendable" in the Live feed when it
      // has a URL OR a message (so a band list can go out as plain text, and a
      // corporate menu as a PDF link). Blank rows (label only) are kept as a
      // "fill me in" placeholder but won't appear in the Send menu. Cap at 20.
      let arr: any = value;
      if (typeof value === 'string') { try { arr = JSON.parse(value); } catch { return { ok: false, error: 'quick_send_links must be a JSON array' }; } }
      if (!Array.isArray(arr)) return { ok: false, error: 'quick_send_links must be a JSON array of { label, url, message }' };
      const clean: { label: string; url: string; message: string }[] = [];
      for (const it of arr.slice(0, 20)) {
        const label = String(it?.label ?? '').trim().slice(0, 80);
        const url = String(it?.url ?? '').trim().slice(0, 500);
        const message = String(it?.message ?? '').trim().slice(0, 1000);
        if (!label) continue;
        if (url && !/^https?:\/\/\S+$/.test(url)) return { ok: false, error: `"${label}" link must start with http:// or https://` };
        clean.push({ label, url, message });
      }
      return { ok: true, value: JSON.stringify(clean) };
    }
    case 'whatson_panels': {
      // Which panels show on the GRE "What's On" board. Accept an object or a
      // JSON string; keep ONLY the 6 known boolean keys, coerce each to a real
      // bool, and store canonical JSON so the board can parse it deterministically.
      let obj: any = value;
      if (typeof value === 'string') {
        try { obj = JSON.parse(value || '{}'); } catch { return { ok: false, error: 'whatson_panels must be valid JSON' }; }
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return { ok: false, error: 'whatson_panels must be a JSON object of { panel: boolean }' };
      }
      const PANEL_KEYS = ['entertainment', 'parties', 'reservations', 'specials', 'capacity', 'call_context'] as const;
      const clean: Record<string, boolean> = {};
      for (const k of PANEL_KEYS) {
        const v = obj[k];
        // Default a missing panel to ON; only an explicit falsey value hides it.
        clean[k] = v === undefined ? true : !(v === false || v === 0 || v === '0' || v === 'false');
      }
      return { ok: true, value: JSON.stringify(clean) };
    }
    case 'whatson_specials': {
      const v = String(value ?? '');
      if (v.length > 4000) return { ok: false, error: 'whatson_specials must be 4000 characters or fewer' };
      return { ok: true, value: v };
    }
    case 'whatson_capacity': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 100000) {
        return { ok: false, error: 'whatson_capacity must be a whole number between 0 and 100000 (0 = gauge hidden)' };
      }
      return { ok: true, value: String(n) };
    }
    case 'whatson_entertainment_mode': {
      const v = String(value ?? '').trim();
      if (v !== 'manual_only' && v !== 'dj_only' && v !== 'all_notes') {
        return { ok: false, error: 'whatson_entertainment_mode must be manual_only, dj_only, or all_notes' };
      }
      return { ok: true, value: v };
    }
    default:
      return { ok: false, error: `Unknown setting '${key}'` };
  }
}

const parseHmMin = (hm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

export async function PUT(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Body must be an object of { key: value } settings' }, { status: 400 });
  }

  // Hard-refuse the secrets that are not admin-rotatable (webhook token & co).
  for (const k of Object.keys(body)) {
    if (WRITE_BLOCKED_KEYS.includes(k)) {
      return Response.json({
        error: `'${k}' cannot be set via this API.`,
      }, { status: 400 });
    }
  }

  // Credentials are admin-only even if the gate above ever loosens: these spend
  // real money and re-point the outlet's telephony, so the check is restated
  // here rather than inherited.
  const touchesCredentials = Object.keys(body).some(k => CREDENTIAL_KEYS.includes(k));
  if (touchesCredentials && gate.user.role !== 'admin') {
    return Response.json({ error: 'Admin role required to change TeleCMI credentials' }, { status: 403 });
  }

  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_KEYS.includes(key)) continue; // ignore unknown, non-secret keys
    const res = validate(key, value);
    if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
    updates[key] = res.value;
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({
      error: `No valid settings provided. Editable keys: ${ALLOWED_KEYS.join(', ')}`,
    }, { status: 400 });
  }

  const db = getDb();

  // Cross-field check: business hours must not invert (SLA clock assumes
  // open < close within one IST day).
  const current = ctSettings(db);
  const effOpen = updates.business_open ?? current.business_open ?? CT_SETTING_DEFAULTS.business_open;
  const effClose = updates.business_close ?? current.business_close ?? CT_SETTING_DEFAULTS.business_close;
  if (parseHmMin(effOpen) >= parseHmMin(effClose)) {
    return Response.json({ error: 'business_open must be earlier than business_close (same IST day)' }, { status: 400 });
  }

  for (const [key, value] of Object.entries(updates)) {
    // Clearing a credential must REMOVE the row. Storing '' would leave a row
    // that reads as "set" to anything doing a plain existence check, and would
    // pin the value to empty forever instead of falling back to the env var.
    if (CREDENTIAL_KEYS.includes(key) && value === '') {
      db.prepare(`DELETE FROM ct_settings WHERE key = ?`).run(key);
      continue;
    }
    setCtSetting(db, key, value);
  }

  // Switching to 'ephemeral' means "keep nothing" — so PURGE any scorecards
  // stored while in 'permanent' mode. Otherwise old transcripts/scores would
  // linger in the DB and still render (chips + GET), breaking the contract.
  // No-op if already ephemeral (nothing is stored).
  let purged = 0;
  if (updates.analysis_retention === 'ephemeral') {
    try {
      purged = db.prepare(`
        UPDATE ct_calls SET
          analysis_json = '', analysis_score = NULL, analysis_outcome = '',
          analysis_summary = '', analysis_status = '', analysis_error = '',
          analyzed_at = NULL, analyzed_by = ''
        WHERE COALESCE(analysis_status, '') <> '' OR COALESCE(analysis_json, '') <> ''
      `).run().changes;
    } catch (e) { console.error('[ct settings] scorecard purge failed', e); }
  }

  return Response.json({
    success: true,
    updated: Object.keys(updates),
    ...(updates.analysis_retention === 'ephemeral' ? { scorecards_purged: purged } : {}),
    settings: publicSettings(db),
    // Additive, same name and shape as the GET's: the canonical dismiss list as
    // actually stored. Hiding/un-hiding is a one-key PUT, so echoing it lets the
    // editor settle on the stored truth (de-duplicated, lowercased) without a
    // second round trip.
    agent_hidden: hiddenAgentIds(db),
    // Fresh status after the write. This is how the client learns that an env
    // var still wins (source stays 'env' even though the save succeeded) and
    // which secret is now stored — the masked tail is the only echo it gets.
    telecmi_configured: isTelecmiConfigured(db),
    telecmi_credentials: telecmiCredentialStatus(db),
  });
}

/** Some clients POST settings instead of PUT-ing them; identical semantics.
 *  /api/crm-calls is a CSRF-required prefix in src/proxy.ts, so this is covered
 *  by the same double-submit check. */
export async function POST(req: Request) {
  return PUT(req);
}
