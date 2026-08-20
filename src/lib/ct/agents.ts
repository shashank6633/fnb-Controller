/**
 * Call-to-Table — TeleCMI agent → staff-user resolution.
 *
 * TeleCMI reports the answering agent on the CDR as whatever identity it knows
 * (an extension like "101", a login like "gre.ravi", or a name). The admin maps
 * those raw ids to real fnb users in CRM Settings; the mapping is stored in the
 * ct_settings 'agent_map' key as JSON { "<rawAgentId>": "<user email>" }.
 *
 *   - DISPLAY: resolveAgentLabel() turns a raw agent id into the staff member's
 *     NAME (via the users table) so Call Log / Guest 360 / the leaderboard show
 *     a person, not "101".
 *   - ASSIGNMENT: the SAME map's values (emails) feed round-robin recovery
 *     auto-assign (see ingest.ts nextAssignee).
 *
 * Unmapped ids fall back to showing the raw id — nothing is ever hidden.
 *
 * ── WHY ct_calls.agent_user HOLDS TWO KINDS OF VALUE (do not "clean" either) ──
 * The column legitimately carries EITHER a TeleCMI agent id OR an app login
 * email, and both are correct data:
 *   - TeleCMI ids ("5002", "5004_33338614", "gre.ravi") come from the webhook /
 *     CDR — the identity the PBX knows for whoever answered.
 *   - App login emails are written by the device-callback path
 *     (src/app/api/crm-calls/calls/log-callback/route.ts — it stores me.email as
 *     agent_user) because a GRE returning a call from their OWN phone never
 *     touches TeleCMI, so the PBX has no id for it. The email IS the agent.
 * Attribution is already correct for both: resolveAgentLabel() resolves a raw
 * value that is itself a known user email straight to that user's name, so Call
 * Log / Guest 360 / leaderboard all show a person either way. Nothing needs
 * migrating, and the writer must not be changed — rewriting log-callback would
 * throw away the only agent identity those rows have.
 * The one place the two kinds must NOT be mixed is the Settings → Agent mapping
 * editor, which maps TeleCMI ids to users: an email can never be mapped there
 * and would sit forever as a phantom "unmapped" row. describeCallAgents() below
 * classifies each distinct value so that editor can list only the mappable ones
 * (and show the login-sourced ones for what they are), without the data or the
 * writer being touched.
 */
import type Database from 'better-sqlite3';
import { ctSetting } from './settings';

/** Parsed agent_map: { rawAgentId → user email }. Keys kept as stored + a
 *  lowercased index for case-insensitive matching. Returns {} on any error. */
export function getAgentMap(db: Database.Database): Record<string, string> {
  // NULL-prototype map: a literal "__proto__"/"constructor"/"toString" agent id
  // (which TeleCMI could send verbatim) can't collide with Object.prototype and
  // 500 the read routes; also lets such a key be stored/looked up safely.
  const out: Record<string, string> = Object.create(null);
  try {
    const raw = ctSetting(db, 'agent_map') || '{}';
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).trim();
      const val = String(v ?? '').trim();
      if (!key || !val) continue;
      out[key] = val;
      const lk = key.toLowerCase(); // the promised case-insensitive index
      if (!(lk in out)) out[lk] = val;
    }
    return out;
  } catch { return out; }
}

/** email(lower) → display name, for turning a mapped email into a person's name. */
export function getUserNamesByEmail(db: Database.Database): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  try {
    const rows = db.prepare(`SELECT email, name FROM users WHERE email IS NOT NULL`).all() as Array<{ email: string; name: string }>;
    for (const r of rows) {
      const e = String(r.email || '').trim().toLowerCase();
      if (e) out[e] = String(r.name || '').trim() || r.email;
    }
    return out;
  } catch { return out; }
}

/**
 * Turn a raw TeleCMI agent id into a human display label:
 *   mapped → staff user's name (email looked up), else the mapped value,
 *   raw is itself a known user email (device-dialed callbacks store agent_user =
 *     the GRE's email) → that user's name,
 *   unmapped → the raw id unchanged, empty → ''.
 * Pass pre-loaded maps (load once per request to avoid N+1).
 */
export function resolveAgentLabel(
  rawAgent: string | null | undefined,
  agentMap: Record<string, string>,
  userNames: Record<string, string>,
): string {
  const raw = String(rawAgent || '').trim();
  if (!raw) return '';
  const mappedEmail = agentMap[raw] || agentMap[raw.toLowerCase()];
  if (typeof mappedEmail === 'string' && mappedEmail) {
    return userNames[mappedEmail.toLowerCase()] || mappedEmail;
  }
  // Device-callback rows store the GRE's own email as agent_user → show their name.
  const asUser = userNames[raw.toLowerCase()];
  if (typeof asUser === 'string' && asUser) return asUser;
  return raw; // unmapped → show the raw id, never hide it
}

/**
 * WHO A RINGING CALL IS RINGING FOR — a PERSON or a GROUP, and which of the two.
 *
 *   'agent' — the telephony payload NAMED an extension, and `label` is that
 *             agent resolved through resolveAgentLabel (the raw id when it is
 *             unmapped, which is that function's contract — never blank).
 *   'group' — the payload named no person, but it DID name the ring group /
 *             team the call is hunting through (TeleCMI calls this `team`).
 *             A GROUP IS NOT A PERSON: a renderer must word it as a group and
 *             must never print it where it would read as an individual's name.
 */
export type RingingFor = { kind: 'agent' | 'group'; label: string };

/**
 * THE RINGING LADDER, in ONE place so no two surfaces can answer it differently.
 * The screen-pop (from the bus event), the Live wallboard and the /live snapshot
 * all resolve "who is it ringing for" through this function.
 *
 *   1. named extension  → { kind: 'agent' }
 *   2. ring group/team  → { kind: 'group' }
 *   3. neither          → null. THE CALLER MUST SAY NOTHING, or say what it
 *      already says while it does not know ("trying the next agent").
 *
 * THERE IS NO FOURTH RUNG, and in particular "whoever missed the previous leg"
 * is NOT one. That is a different fact about a different extension — the phone
 * that has ALREADY STOPPED ringing — and naming it here would tell a GRE their
 * handset is ringing when it is not. A blank degrades to honest wording; it
 * never degrades to a guess.
 *
 * Pure: pass pre-loaded maps (getAgentMap / getUserNamesByEmail), exactly as
 * resolveAgentLabel above, so a list of rows costs one load and not N.
 */
export function ringingForLabel(
  rawAgent: string | null | undefined,
  queue: string | null | undefined,
  agentMap: Record<string, string>,
  userNames: Record<string, string>,
): RingingFor | null {
  const named = resolveAgentLabel(rawAgent, agentMap, userNames);
  if (named) return { kind: 'agent', label: named };
  const group = String(queue || '').trim();
  if (group) return { kind: 'group', label: group };
  return null;
}

/**
 * WHICH TELEPHONY IDS BELONG TO THIS APP USER — the caller's OWN agent_map keys
 * and nothing else, so a client can be told "this ringing call is for you"
 * without ever being handed anybody else's mapping.
 *
 * Reads the map by VALUE (the mapped email), the reverse of every other use of
 * agent_map here. Deduped case-insensitively because getAgentMap deliberately
 * publishes a lowercased alias for each key — those two entries are one mapping,
 * not two ids — and the original spelling wins because it is inserted first.
 *
 * An EMPTY result means "no TeleCMI id is mapped to you", which is the ordinary
 * state for a manager who never takes calls. It must never be read as "this
 * user has no calls": ownership (ct_calls.owner_email) is the authority on that,
 * and a device-dialed callback stores the user's own email as agent_user with no
 * mapping involved at all.
 */
export function agentIdsForEmail(
  agentMap: Record<string, string>,
  email: string | null | undefined,
): string[] {
  const want = String(email || '').trim().toLowerCase();
  if (!want) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [id, mapped] of Object.entries(agentMap)) {
    if (String(mapped || '').trim().toLowerCase() !== want) continue;
    const lower = id.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(id);
  }
  return out;
}

/** What kind of identity a raw ct_calls.agent_user value is. See the header:
 *  'telecmi'   — an id the PBX reported; mappable in Settings → Agent mapping.
 *  'app_login' — the GRE's own app login email, written by the device-callback
 *                route; already resolves to a name, and is NOT mappable. */
export type CallAgentKind = 'telecmi' | 'app_login';

export interface CallAgentSummary {
  /** The raw agent_user value, trimmed. */
  id: string;
  kind: CallAgentKind;
  /** COUNT(*) of ct_calls rows carrying this agent. */
  calls: number;
  /** MAX(started_at) for this agent (falls back to created_at — started_at is
   *  nullable on ct_calls); '' if neither is set. */
  last_seen: string;
}

/**
 * Is this agent_user value an app login email rather than a TeleCMI id?
 *
 * ONE definition, shared by every caller (settings route, editors, reports) so
 * the shape is never re-tested inline and never drifts. Deliberately pragmatic,
 * NOT RFC-5322: `local@domain.tld` with no spaces and at least one dot in the
 * domain. That is exactly the shape log-callback writes — it stores `me.email`,
 * i.e. a users.email this app already accepted at login — so the test only has
 * to separate those from TeleCMI ids, which are extensions/logins/names and
 * never contain '@' (e.g. "5002", "5004_33338614", "gre.ravi").
 * Consequence of the trade-off: an exotic-but-valid address (quoted local part,
 * a TLD-less intranet address) reads as 'telecmi' and merely shows up as a
 * mappable row — a cosmetic miss, never wrong attribution, since display goes
 * through resolveAgentLabel() either way.
 */
export function isAppLoginAgent(value: string | null | undefined): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value ?? '').trim());
}

/**
 * Every distinct agent seen on calls, classified and with usage stats — so the
 * Settings editor can list the TeleCMI agents that actually need mapping and
 * keep app-login values out of that list instead of badging them "unmapped".
 * Counts/last-seen let an admin tell a live extension from a retired one (e.g.
 * "5004_33338614", removed but legitimately present in history).
 *
 * ONE grouped query — no per-agent follow-up (this runs on a settings GET that
 * already loads several maps). Returns [] on any error, like the maps above.
 */
export function describeCallAgents(db: Database.Database): CallAgentSummary[] {
  try {
    const rows = db.prepare(
      `SELECT TRIM(agent_user) AS id,
              COUNT(*)         AS calls,
              MAX(COALESCE(NULLIF(started_at, ''), created_at)) AS last_seen
         FROM ct_calls
        WHERE TRIM(COALESCE(agent_user, '')) <> ''
        GROUP BY TRIM(agent_user)
        ORDER BY TRIM(agent_user)`,
    ).all() as Array<{ id: string; calls: number; last_seen: string | null }>;
    return rows
      .map(r => {
        const id = String(r.id || '').trim();
        return {
          id,
          kind: (isAppLoginAgent(id) ? 'app_login' : 'telecmi') as CallAgentKind,
          calls: Number(r.calls) || 0,
          last_seen: String(r.last_seen || ''),
        };
      })
      .filter(a => a.id);
  } catch { return []; }
}

/** Distinct raw agent ids seen on calls — so the Settings editor can list every
 *  TeleCMI agent that has actually appeared and flag which are still unmapped.
 *  Unchanged contract (sorted, trimmed, non-empty raw ids, BOTH kinds); kept
 *  because existing callers read it as a plain string list. */
export function distinctCallAgents(db: Database.Database): string[] {
  return describeCallAgents(db).map(a => a.id);
}
