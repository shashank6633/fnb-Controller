import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { ctSetting, setCtSetting, isTelecmiConfigured } from '@/lib/ct/settings';
import { agentLogin, listCallerIds, setCallerId, type TelecmiResult } from '@/lib/ct/telecmi-api';

/**
 * POST /api/telecmi/callerid — admin-only caller-ID administration.
 *
 * ── `telecmi_user_tokens` IS A BAG OF LIVE CREDENTIALS ─────────────────────
 * The ct_settings row this file writes does NOT hold config. Every value in it
 * is a working TeleCMI user token: anyone holding one can act as that agent
 * against TeleCMI's API — read and change their caller ID, originate calls —
 * without knowing their password. It is exactly as sensitive as the password
 * itself, and it is bearer-only, so a copy is full access.
 *
 * IT MUST NEVER BE RETURNED BY ANY ENDPOINT. Not by this route, not by the
 * settings route, not in a debug field, not "just for the admin". The key is
 * therefore listed in SECRET_KEYS in src/app/api/crm-calls/settings/route.ts,
 * which strips it from every settings read — that entry is load-bearing, not
 * tidy-up, and removing it re-opens a credential leak to every admin browser
 * (and to anything that logs a response body). If you ever find the key absent
 * from that list, that is the bug.
 *
 * Anything this route sends to the browser is deliberately derived: the agent
 * id, the expiry, the caller-ID list. Never the token.
 *
 * ── WHY THIS ONE ENDPOINT ASKS FOR A PASSWORD ──────────────────────────────
 * Everything else in this module (balance, analysis, agent add/update) runs on
 * the account-wide APP credentials the owner configures once. get_callerid and
 * set_callerid do not: they authenticate with a per-agent USER TOKEN issued by
 * /v2/user/login, which takes that agent's own id AND PASSWORD. TeleCMI will
 * not accept the app secret on these two paths — it 404s, and the error says
 * nothing about auth, so the failure looks like a wrong base URL rather than a
 * wrong credential. That is the whole reason this route exists separately and
 * makes an admin type a password: it CANNOT be "simplified" to the app secret.
 * (See the two-auth-worlds note at the top of src/lib/ct/telecmi-api.ts.)
 *
 * We stash the token after a successful login and let list/set reuse it. When
 * it is absent, past its deadline, or rejected by TeleCMI we say so plainly and
 * drop it, instead of quietly retrying with a credential that cannot work.
 *
 * Body shapes:
 *   { action:'login', id, password }  -> { ok, agent_id, expires_at }
 *   { action:'list',  id }            -> { ok, callerid:[{pstn,price,capacity,profile}] }
 *   { action:'set',   id, callerid }  -> { ok, callerid }
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** One ct_settings row holds every agent's token, keyed by TeleCMI agent id.
 *  See the credential warning above before touching anything that reads it. */
const TOKENS_KEY = 'telecmi_user_tokens';

/** TeleCMI documents the user token's life as 30 days, so we record our own
 *  deadline and refuse early with a useful message. It is only ever an upper
 *  bound: the real expiry is whatever TeleCMI enforces, which is why a rejected
 *  token is also purged on the spot (see isAuthFailure). */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredToken { token: string; expires_at: string }

function readTokens(db: Database.Database): Record<string, StoredToken> {
  try {
    const parsed = JSON.parse(ctSetting(db, TOKENS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, StoredToken>;
  } catch {
    // A hand-edited or truncated value must not lock every agent out — treat a
    // malformed store as empty and let the next login rewrite it cleanly.
    return {};
  }
}

/**
 * Read-modify-write one agent's entry in the shared JSON blob.
 *
 * The whole map lives in a single ct_settings row, so an unguarded
 * read-merge-write silently discards a token another admin wrote between our
 * read and our write. better-sqlite3 is synchronous, so a transaction is the
 * entire fix — no locking, no retry loop. IMMEDIATE (not the default DEFERRED)
 * because we know at BEGIN that we are going to write: taking the write lock
 * up front makes the whole read-merge-write one atomic step, where a deferred
 * transaction would start read-only and could fail on the upgrade.
 */
function mutateTokens(db: Database.Database, mutate: (all: Record<string, StoredToken>) => void): void {
  db.transaction(() => {
    const all = readTokens(db);
    mutate(all);
    setCtSetting(db, TOKENS_KEY, JSON.stringify(all));
  }).immediate();
}

function saveToken(db: Database.Database, agentId: string, token: string, expiresAt: string): void {
  mutateTokens(db, all => { all[agentId] = { token, expires_at: expiresAt }; });
}

/** Drop a dead token. A credential we cannot use is still a credential, so it
 *  goes rather than sitting in the row waiting to be leaked. */
function forgetToken(db: Database.Database, agentId: string): void {
  mutateTokens(db, all => { delete all[agentId]; });
}

const SIGN_IN_AGAIN = 'Sign this agent in again (their TeleCMI password) to continue.';

/** The live token for an agent, or the exact reason an admin cannot proceed. */
function liveToken(db: Database.Database, agentId: string): { token: string } | { error: string } {
  const stored = readTokens(db)[agentId];
  if (!stored?.token) {
    return { error: `Agent ${agentId} has not been signed in to TeleCMI yet. Use "Sign in" on this agent (their TeleCMI password) before reading or changing caller ID.` };
  }
  const expiry = Date.parse(stored.expires_at || '');
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    forgetToken(db, agentId);
    return { error: `The TeleCMI sign-in for agent ${agentId} has expired (tokens last about 30 days). ${SIGN_IN_AGAIN}` };
  }
  return { token: stored.token };
}

/**
 * Did TeleCMI reject the TOKEN, as opposed to the request?
 *
 * The documented 30 days is TeleCMI's promise, not a guarantee: a token can be
 * revoked the moment the agent's password is changed from their dashboard, or
 * when the account is re-provisioned. Without this check that token stays
 * cached until our own deadline lapses and every caller-ID action fails with an
 * opaque provider error for up to a month, with nothing on screen suggesting
 * "log in again" — which is precisely the state nobody diagnoses.
 *
 * The token is the ONLY credential in a /get_callerid or /set_callerid body, so
 * an auth-shaped status or a complaint mentioning the token can only be about
 * it. A false positive costs one re-login; a false negative costs a month of
 * mystery failures, so this leans towards forgetting.
 *
 * status 0 is our own timeout/network failure — TeleCMI never saw the token,
 * so it must survive.
 */
function isAuthFailure(res: TelecmiResult): boolean {
  if (res.status === 0) return false;
  // TeleCMI answers 200 with the real verdict in the body `code`, so check both.
  const bodyCode = Number((res.data as any)?.code);
  if ([401, 403, 404].includes(res.status)) return true;
  if ([401, 403, 404].includes(bodyCode)) return true;
  return /token|unauthori|not\s*logged|session/i.test(String(res.error || ''));
}

/** Belt and braces: if a provider message ever quoted the token back at us,
 *  redact it before it reaches a browser or a log line. */
function scrub(message: string, token: string): string {
  if (!token) return message;
  return message.split(token).join('«token»');
}

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let body: any = {};
  try { body = await req.json(); } catch { /* validated below */ }

  const action = String(body?.action || '').trim();
  const id = String(body?.id || '').trim();
  if (!id) return Response.json({ error: 'Agent id is required' }, { status: 400 });

  const db = getDb();

  // Mock mode: no credentials means we cannot reach TeleCMI at all. Say that
  // instead of 500-ing or, worse, reporting an empty caller-ID list as fact.
  if (!isTelecmiConfigured(db)) {
    return Response.json({
      ok: false,
      configured: false,
      error: 'TeleCMI is not configured. Add the App ID and Secret in CRM Settings first.',
    });
  }

  if (action === 'login') {
    const password = String(body?.password || '');
    if (!password) return Response.json({ error: 'The agent’s TeleCMI password is required to sign them in' }, { status: 400 });

    const res = await agentLogin(db, id, password);
    // res.error is TeleCMI's own message; the password never appears in it, and
    // we never echo the submitted password back either.
    if (!res.ok || !res.data?.token) {
      // Always 502, never TeleCMI's own status. A wrong agent password makes
      // TeleCMI answer 401/403, and CRM pages read 401/403 on their own fetches
      // as "this admin has lost access" and swap the screen for a lock notice —
      // so forwarding it would log the admin out of the page over a typo.
      return Response.json(
        { ok: false, error: res.error || 'TeleCMI rejected the agent sign-in. Check the agent id and password.' },
        { status: 502 },
      );
    }

    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    saveToken(db, id, res.data.token, expiresAt);
    // Token withheld on purpose — the browser has no use for it and every copy
    // is another place it can leak from.
    return Response.json({ ok: true, agent_id: id, expires_at: expiresAt });
  }

  if (action === 'list') {
    const t = liveToken(db, id);
    if ('error' in t) return Response.json({ ok: false, error: t.error }, { status: 400 });

    const res = await listCallerIds(db, t.token);
    if (!res.ok) {
      if (isAuthFailure(res)) {
        forgetToken(db, id);
        return Response.json(
          { ok: false, error: `TeleCMI no longer accepts the stored sign-in for agent ${id}. ${SIGN_IN_AGAIN}` },
          { status: 400 },
        );
      }
      return Response.json(
        { ok: false, error: scrub(res.error || 'TeleCMI could not list caller IDs', t.token) },
        { status: 502 },
      );
    }
    // Project onto the documented shape rather than forwarding TeleCMI's rows
    // whole: whatever they add to this payload later reaches the browser
    // unreviewed otherwise, and this is a response built from a credential.
    const rows = Array.isArray(res.data?.callerid) ? res.data.callerid : [];
    const callerid = rows
      .filter((r: any) => r && typeof r === 'object')
      .map((r: any) => ({ pstn: r.pstn, price: r.price, capacity: r.capacity, profile: r.profile }));
    return Response.json({ ok: true, callerid });
  }

  if (action === 'set') {
    // Digits only: TeleCMI wants a bare number. A leading '+' or spaces make it
    // reject the whole request, and silently stripping them would let a typo
    // through as a different, valid-looking DID.
    const raw = String(body?.callerid ?? '').trim();
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      return Response.json({ error: 'callerid must be a positive number, digits only (no + or spaces)' }, { status: 400 });
    }
    const callerid = Number(raw);
    if (!Number.isSafeInteger(callerid)) {
      return Response.json({ error: 'callerid is not a valid phone number' }, { status: 400 });
    }

    const t = liveToken(db, id);
    if ('error' in t) return Response.json({ ok: false, error: t.error }, { status: 400 });

    const res = await setCallerId(db, t.token, callerid);
    if (!res.ok) {
      if (isAuthFailure(res)) {
        forgetToken(db, id);
        return Response.json(
          { ok: false, error: `TeleCMI no longer accepts the stored sign-in for agent ${id}. ${SIGN_IN_AGAIN} The caller ID was NOT changed.` },
          { status: 400 },
        );
      }
      return Response.json(
        { ok: false, error: scrub(res.error || 'TeleCMI could not set the caller ID', t.token) },
        { status: 502 },
      );
    }
    // Echo what TeleCMI confirmed, falling back to what we asked for when the
    // response omits it, so the UI always has a number to show.
    return Response.json({ ok: true, callerid: Number(res.data?.callerid ?? callerid) });
  }

  return Response.json({ error: 'Unknown action. Use login, list or set.' }, { status: 400 });
}
