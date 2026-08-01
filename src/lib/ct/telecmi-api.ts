/**
 * THE ONE CLIENT for TeleCMI's REST API.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Before it, click-to-call held its own copy of the base URL, its own fetch and
 * its own idea of the request shape — and every part of that was wrong: it
 * posted { appid, secret, to, agent } to /v2/click_to_call, a path that does
 * not exist, using a field name (appid) the endpoint does not take. Nobody
 * noticed for months because with no credentials the route runs in mock mode
 * and cheerfully reports success. A second hand-rolled caller would have gone
 * the same way, so every endpoint now lives here, spelled once.
 *
 * ── THE TWO AUTH WORLDS, which is the thing to get right ───────────────────
 * TeleCMI has two credential types and they are NOT interchangeable:
 *
 *   APP credentials — { appid, secret }. The account-wide pair from the
 *     dashboard's DEVELOPER → APP SECRET tab. Used by balance, analysis and all
 *     user administration. This is what the owner configures once.
 *
 *   USER token     — { token }. A per-agent, 30-day token from /v2/user/login,
 *     which needs that agent's own id AND PASSWORD. Used by caller-ID list/set
 *     and the user-flavoured click2call. THE APP SECRET CANNOT SUBSTITUTE FOR
 *     IT. Any feature below marked `userToken` therefore cannot be driven from
 *     the owner's credentials alone — it needs the agent to log in. Do not
 *     "fix" such a call by passing the app secret; it will 404 and the reason
 *     will not be obvious.
 *
 * ── BASE URL ───────────────────────────────────────────────────────────────
 * Everything hangs off https://rest.telecmi.com/v2 . The ct setting
 * `telecmi_base_url` may override it for a regional account, and tolerates
 * being pasted as either the base or one of the full endpoint URLs, because
 * that is what people actually do. apiBase() reduces it either way.
 *
 * Doc: https://doc.telecmi.com/chub/docs/get-started/
 */
import type Database from 'better-sqlite3';
import { ctSetting, telecmiAppId, telecmiSecret } from './settings';

export const TELECMI_DEFAULT_BASE = 'https://rest.telecmi.com/v2';

/** Every full endpoint path a pasted base might carry, longest first so a
 *  prefix never shadows a longer match. */
const FULL_ENDPOINT_SUFFIXES = [
  '/webrtc/click2call', '/click_to_call', '/click2call',
  '/user/login', '/user/update', '/user/add', '/user/get',
  '/set_callerid', '/get_callerid', '/analysis', '/balance', '/token',
];

/** Reduce a configured value to the API base, whatever the admin pasted. */
export function apiBase(setting: string): string {
  let b = String(setting || '').trim().replace(/\/+$/, '');
  if (!b) return TELECMI_DEFAULT_BASE;
  for (const suffix of FULL_ENDPOINT_SUFFIXES) {
    const re = new RegExp(suffix.replace(/[/]/g, '\\/') + '$', 'i');
    if (re.test(b)) { b = b.replace(re, ''); break; }
  }
  b = b.replace(/\/+$/, '');
  return b || TELECMI_DEFAULT_BASE;
}

export interface TelecmiResult<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Human-readable, safe to show a manager. Never contains the secret. */
  error?: string;
}

/** Requests are capped so a hung provider cannot hold a page open. Chosen to
 *  match the 5s the click-to-call path has always used. */
const TIMEOUT_MS = 8000;

async function post<T = any>(url: string, body: Record<string, unknown>): Promise<TelecmiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 500); }

    // TeleCMI answers 200 with a non-200 `code` on some errors, so HTTP status
    // alone is not the verdict — check both or a failure reads as a success.
    const codeOk = data == null || typeof data !== 'object' || data.code == null || Number(data.code) === 200;
    if (!res.ok || !codeOk) {
      const msg = (data && typeof data === 'object' && (data.msg || data.message || data.error))
        || `TeleCMI responded ${res.status}`;
      return { ok: false, status: res.status, data, error: String(msg) };
    }
    return { ok: true, status: res.status, data };
  } catch (e: any) {
    const error = e?.name === 'AbortError'
      ? `TeleCMI did not respond within ${TIMEOUT_MS / 1000}s`
      : `TeleCMI request failed: ${e?.message || e}`;
    return { ok: false, status: 0, data: null, error };
  } finally {
    clearTimeout(timer);
  }
}

/** appid is numeric on TeleCMI's side; send a Number when it looks like one. */
function appIdValue(raw: string): number | string {
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/** Resolve app credentials, or explain what is missing. */
function appCreds(db: Database.Database): { appid: number | string; secret: string } | { error: string } {
  const appid = telecmiAppId(db);
  const secret = telecmiSecret(db);
  if (!appid || !secret) {
    return { error: 'TeleCMI is not configured. Add the App ID and Secret in CRM Settings (dashboard → DEVELOPER → APP SECRET).' };
  }
  return { appid: appIdValue(appid), secret };
}

function url(db: Database.Database, path: string): string {
  return apiBase(ctSetting(db, 'telecmi_base_url')) + path;
}

/* ── APP-CREDENTIAL ENDPOINTS ─────────────────────────────────────────────── */

export interface TelecmiBalance { code: number; expire: number; sms: number; balance: number }

/** Remaining call balance (INR) and SMS credits. */
export async function fetchBalance(db: Database.Database): Promise<TelecmiResult<TelecmiBalance>> {
  const c = appCreds(db);
  if ('error' in c) return { ok: false, status: 0, data: null, error: c.error };
  return post<TelecmiBalance>(url(db, '/balance'), { appid: c.appid, secret: c.secret });
}

export interface TelecmiAnalysis { code: number; total: number; answered: number; missed: number }

/**
 * Answered / missed totals for a window.
 * start/end are epoch MILLISECONDS — TeleCMI defaults to the last 24h if omitted.
 */
export async function fetchAnalysis(
  db: Database.Database, startMs?: number, endMs?: number,
): Promise<TelecmiResult<TelecmiAnalysis>> {
  const c = appCreds(db);
  if ('error' in c) return { ok: false, status: 0, data: null, error: c.error };
  const body: Record<string, unknown> = { appid: c.appid, secret: c.secret };
  if (Number.isFinite(startMs)) body.start_date = Math.trunc(startMs as number);
  if (Number.isFinite(endMs))   body.end_date   = Math.trunc(endMs as number);
  return post<TelecmiAnalysis>(url(db, '/analysis'), body);
}

export interface TelecmiAgent {
  agent_id?: string;
  name?: string;
  extension?: number;
  phone?: string;
  notify?: boolean;
  start_time?: number;
  end_time?: number;
  /** TeleCMI really does return the password on /user/get. Never surface it. */
  password?: string;
}

/** One agent's record. `id` is the full TeleCMI agent id, e.g. '101_1111112'. */
export async function fetchAgent(db: Database.Database, id: string): Promise<TelecmiResult<{ agent: TelecmiAgent }>> {
  const c = appCreds(db);
  if ('error' in c) return { ok: false, status: 0, data: null, error: c.error };
  return post(url(db, '/user/get'), { appid: c.appid, secret: c.secret, id });
}

export interface AgentWrite {
  name: string;
  phone_number: string;
  password: string;
  start_time?: number;
  end_time?: number;
  sms_alert?: boolean;
}

/** Create an agent. `extension` is the numeric extension, not the agent id —
 *  TeleCMI derives the id as `<extension>_<appid>` and returns it. */
export async function addAgent(
  db: Database.Database, extension: number, a: AgentWrite,
): Promise<TelecmiResult<{ agent: TelecmiAgent }>> {
  const c = appCreds(db);
  if ('error' in c) return { ok: false, status: 0, data: null, error: c.error };
  const body: Record<string, unknown> = {
    appid: c.appid, secret: c.secret, extension,
    name: a.name, phone_number: a.phone_number, password: a.password,
  };
  if (a.start_time != null) body.start_time = a.start_time;
  if (a.end_time != null)   body.end_time   = a.end_time;
  if (a.sms_alert != null)  body.sms_alert  = !!a.sms_alert;
  return post(url(db, '/user/add'), body);
}

/**
 * Update an agent. TeleCMI requires name, phone_number AND password on every
 * update — it is a full replace, not a patch, so a caller that omits the
 * password would blank the agent's login. Callers must read the current record
 * first and resend what they are not changing.
 */
export async function updateAgent(
  db: Database.Database, id: string, a: AgentWrite,
): Promise<TelecmiResult<{ agent: TelecmiAgent }>> {
  const c = appCreds(db);
  if ('error' in c) return { ok: false, status: 0, data: null, error: c.error };
  const body: Record<string, unknown> = {
    appid: c.appid, secret: c.secret, id,
    name: a.name, phone_number: a.phone_number, password: a.password,
  };
  if (a.start_time != null) body.start_time = a.start_time;
  if (a.end_time != null)   body.end_time   = a.end_time;
  if (a.sms_alert != null)  body.sms_alert  = !!a.sms_alert;
  return post(url(db, '/user/update'), body);
}

/** 30-day admin token — the credential live-activity and barge features need. */
export async function fetchAdminToken(db: Database.Database): Promise<TelecmiResult<{ secret: string; expiresIn: string }>> {
  const c = appCreds(db);
  if ('error' in c) return { ok: false, status: 0, data: null, error: c.error };
  return post(url(db, '/token'), { appid: c.appid, secret: c.secret });
}

/* ── USER-TOKEN ENDPOINTS ─────────────────────────────────────────────────── */
/* These need an AGENT's own token (id + password → /user/login, 30-day life).
 * The app secret does not work here. See the header note.                    */

export interface TelecmiLogin {
  code: number; msg: string; token: string;
  agent?: { id: string; name: string; category?: string; inet_no?: number };
}

/** Exchange an agent's id + password for their 30-day user token. */
export async function agentLogin(db: Database.Database, id: string, password: string): Promise<TelecmiResult<TelecmiLogin>> {
  return post<TelecmiLogin>(url(db, '/user/login'), { id, password });
}

export interface CallerIdEntry { pstn: number; price: number; capacity: number; profile: string }

/** Caller IDs available to that agent. Needs their user token. */
export async function listCallerIds(db: Database.Database, token: string): Promise<TelecmiResult<{ callerid: CallerIdEntry[] }>> {
  return post(url(db, '/get_callerid'), { token });
}

/** Set the agent's outbound caller ID. Needs their user token. */
export async function setCallerId(
  db: Database.Database, token: string, callerid: number,
): Promise<TelecmiResult<{ callerid: number; msg: string }>> {
  return post(url(db, '/set_callerid'), { token, callerid });
}
