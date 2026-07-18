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

/** Distinct raw agent ids seen on calls — so the Settings editor can list every
 *  TeleCMI agent that has actually appeared and flag which are still unmapped. */
export function distinctCallAgents(db: Database.Database): string[] {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT agent_user FROM ct_calls WHERE COALESCE(agent_user, '') <> '' ORDER BY agent_user`,
    ).all() as Array<{ agent_user: string }>;
    return rows.map(r => String(r.agent_user || '').trim()).filter(Boolean);
  } catch { return []; }
}
