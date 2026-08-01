import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { ctSetting, isTelecmiConfigured, setCtSetting, telecmiAppId } from '@/lib/ct/settings';
import { addAgent, fetchAgent, updateAgent, type AgentWrite, type TelecmiAgent } from '@/lib/ct/telecmi-api';

/**
 * /api/telecmi/agents — admin-only TeleCMI agent roster (GET) and
 * add / update / refresh (POST).
 *
 * ── WHY THE ROSTER COMES FROM OUR SIDE ─────────────────────────────────────
 * TeleCMI has NO list-users endpoint — /user/add, /user/update and /user/get
 * are the whole of it, and /user/get needs an id you already know. So the list
 * of "agents this restaurant uses" is the `agent_map` ct setting
 * ({ telecmiAgentId: fnbUserEmail }), which the admin already maintains for
 * click-to-call and CDR attribution, and each id is then ENRICHED by a
 * /user/get. One dead id must not blank the page, so a failed lookup still
 * yields a row carrying what we know plus an `error`.
 *
 * ── SECRETS ────────────────────────────────────────────────────────────────
 * /user/get returns the agent's PASSWORD. Rows are therefore built by an
 * explicit whitelist (toRow) rather than by spreading the upstream object —
 * spreading would ship that password to the browser the day TeleCMI adds a
 * field, and nobody would notice. Nothing here logs a request body either.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Concurrent /user/get lookups. TeleCMI is a shared account-wide endpoint and
 *  a roster is tens of rows, so a small pool keeps the page fast without
 *  hammering the provider. */
const ENRICH_CONCURRENCY = 5;

/** Whole-GET budget for enrichment. Each lookup can burn the client's 8s
 *  timeout; with a large map that multiplies into minutes of a held-open page.
 *  Past the deadline the remaining ids return unenriched rather than hanging. */
const ENRICH_BUDGET_MS = 20_000;

interface AgentRow {
  agent_id: string;
  name: string | null;
  extension: number | null;
  phone: string | null;
  notify: boolean | null;
  start_time: number | null;
  end_time: number | null;
  mapped_email: string | null;
  /** Present only when this one row failed to enrich. */
  error?: string;
}

interface AgentMapRead {
  map: Record<string, string>;
  /**
   * Set when the stored setting could not be read as a map. The roster is then
   * UNKNOWN, not empty — the two must never render the same, so this is carried
   * out to the caller instead of being swallowed.
   */
  error?: string;
}

/**
 * agent_map, read RAW — deliberately not getAgentMap() from lib/ct/agents.
 * That helper drops entries whose value is empty and injects a lowercased
 * duplicate key, both correct for attribution lookups and both wrong for a
 * roster: an agent added here is mapped to "" until an admin assigns a user,
 * and a duplicated key would list the same agent twice.
 *
 * A malformed value is still never a 500 — but it is never silent either. A
 * JSON typo saved into one setting breaks click-to-call attribution app-wide,
 * so it has to be visible on the one screen that shows the mapping.
 */
function readAgentMap(db: ReturnType<typeof getDb>): AgentMapRead {
  const map: Record<string, string> = Object.create(null);

  const raw = String(ctSetting(db, 'agent_map') || '').trim();
  if (!raw) return { map }; // never saved → genuinely nothing mapped, not a fault

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    return {
      map,
      error: `The agent_map CRM setting is not valid JSON (${e?.message || e}), so the agent roster could not be read. Fix it in CRM Settings.`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      map,
      error: 'The agent_map CRM setting is not a JSON object of { "telecmiAgentId": "user@email" }, so the agent roster could not be read. Fix it in CRM Settings.',
    };
  }

  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const key = String(k).trim();
    if (key) map[key] = String(v ?? '').trim();
  }
  return { map };
}

/** Canonical agent_map key form — matches what the CRM Settings PUT stores, so
 *  an id added here cannot reappear as a second row after the next save. */
function mapKey(id: string): string {
  return String(id).trim().toLowerCase().slice(0, 100);
}

/** /user/get answers { agent: {...} } but a plain object has been seen too;
 *  a non-JSON body arrives as a string, which must not be treated as an agent. */
function pickAgent(data: unknown): TelecmiAgent | null {
  if (!data || typeof data !== 'object') return null;
  const inner = (data as any).agent;
  if (inner && typeof inner === 'object') return inner as TelecmiAgent;
  return data as TelecmiAgent;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * The ONLY place an AgentRow is built. `id` is authoritative (the agent_map key
 * for GET, the provider-returned id for add) so a row can always be matched
 * back to its mapping. `password` is never read here — see the header note.
 */
function toRow(id: string, mappedEmail: string, a: TelecmiAgent | null, error?: string): AgentRow {
  return {
    agent_id: id,
    name: strOrNull(a?.name),
    extension: numOrNull(a?.extension),
    phone: strOrNull(a?.phone),
    notify: typeof a?.notify === 'boolean' ? a.notify : null,
    start_time: numOrNull(a?.start_time),
    end_time: numOrNull(a?.end_time),
    mapped_email: mappedEmail ? mappedEmail : null,
    ...(error ? { error } : {}),
  };
}

/** Worker-pool map: at most `limit` in flight, results in input order. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Extension first (that is how a GRE team thinks of its handsets), unenriched
 *  rows last, id as the tiebreak so the order never flickers between loads. */
function sortRows(rows: AgentRow[]): AgentRow[] {
  return rows.sort((a, b) => {
    if (a.extension != null && b.extension != null && a.extension !== b.extension) return a.extension - b.extension;
    if ((a.extension == null) !== (b.extension == null)) return a.extension == null ? 1 : -1;
    return a.agent_id.localeCompare(b.agent_id);
  });
}

export async function GET() {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const db = getDb();

  // ── THE RULE FOR EVERY EXIT BELOW ────────────────────────────────────────
  // agents:[] with no `error` is a PROMISE that this restaurant really has no
  // agents. Any path that returns [] because we could not find out must say so
  // in `error` — an empty success state that is really a failure is the worst
  // possible rendering, because nothing on screen invites anyone to look.

  // Mock mode: say so plainly. An empty roster presented as fact would read as
  // "this restaurant has no agents" when the truth is we never asked TeleCMI.
  if (!isTelecmiConfigured(db)) {
    return Response.json({
      configured: false,
      agents: [] as AgentRow[],
      error: 'TeleCMI is not configured, so the agent roster could not be read. Add the App ID and Secret in CRM Settings.',
    });
  }

  const { map, error: mapError } = readAgentMap(db);
  if (mapError) {
    return Response.json({ configured: true, agents: [] as AgentRow[], error: mapError });
  }

  const ids = Object.keys(map);
  // The one legitimate empty state: the setting parsed fine and holds nothing.
  // A fresh install genuinely has no agents until an admin adds one — no error.
  if (ids.length === 0) return Response.json({ configured: true, agents: [] as AgentRow[] });

  const deadline = Date.now() + ENRICH_BUDGET_MS;
  const rows = await mapWithLimit(ids, ENRICH_CONCURRENCY, async (id): Promise<AgentRow> => {
    if (Date.now() > deadline) {
      return toRow(id, map[id], null, 'Not refreshed — TeleCMI was too slow to reach for the whole roster.');
    }
    try {
      const res = await fetchAgent(db, id);
      if (!res.ok) return toRow(id, map[id], null, res.error || 'TeleCMI could not return this agent.');
      const agent = pickAgent(res.data);
      // A 200 whose body is not an agent object would otherwise become a row of
      // blanks that looks like a real but empty agent. Mark it as failed.
      if (!agent) return toRow(id, map[id], null, 'TeleCMI returned no agent record for this id.');
      return toRow(id, map[id], agent);
    } catch (e: any) {
      // fetchAgent already swallows network errors; this is belt-and-braces so
      // one unexpected throw cannot reject the pool and blank every row.
      return toRow(id, map[id], null, `Lookup failed: ${e?.message || e}`);
    }
  });

  // A row's own `error` covers one dead id, and a partial failure must still
  // list the agents that did resolve. But when EVERY lookup failed we are not
  // showing a roster at all — the page would render nothing but blank rows — so
  // the first provider error is surfaced at top level as the reason.
  const failed = rows.filter((r) => r.error);
  const rosterError = failed.length === rows.length
    ? `None of the ${rows.length} mapped agent${rows.length === 1 ? '' : 's'} could be read from TeleCMI. ${failed[0].error}`
    : undefined;

  return Response.json({
    configured: true,
    agents: sortRows(rows),
    ...(rosterError ? { error: rosterError } : {}),
  });
}

/* ── POST ─────────────────────────────────────────────────────────────────── */

interface Validated { name: string; phone_number: string; start_time?: number; end_time?: number; sms_alert?: boolean }

/** Shared field validation for add + update. Returns an error string or the
 *  cleaned common fields; `password` is handled separately per action. */
function validateCommon(body: any): { error: string } | Validated {
  const name = String(body?.name ?? '').trim();
  if (!name) return { error: 'Name is required.' };
  if (name.length > 100) return { error: 'Name must be 100 characters or fewer.' };

  const phone_number = String(body?.phone_number ?? '').trim();
  if (!phone_number) return { error: 'Phone number is required.' };
  if (phone_number.length > 20) return { error: 'Phone number must be 20 characters or fewer.' };

  const out: Validated = { name, phone_number };
  for (const k of ['start_time', 'end_time'] as const) {
    if (body?.[k] == null || body[k] === '') continue;
    const n = Number(body[k]);
    if (!Number.isFinite(n)) return { error: `${k} must be a number.` };
    out[k] = Math.trunc(n);
  }
  if (body?.sms_alert != null) out.sms_alert = !!body.sms_alert;
  return out;
}

function checkPassword(raw: unknown): { error: string } | { password: string } {
  const password = String(raw ?? '');
  if (!password.trim()) return { error: 'Password is required.' };
  if (password.length > 100) return { error: 'Password must be 100 characters or fewer.' };
  return { password };
}

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let body: any = {};
  try { body = await req.json(); } catch { /* validated below */ }
  const action = String(body?.action ?? '').trim();

  const db = getDb();
  if (!isTelecmiConfigured(db)) {
    // Writes spend real money and change real telephony config — there is no
    // sane mock. Refuse clearly instead of pretending an agent was created.
    return Response.json(
      { configured: false, error: 'TeleCMI is not configured. Add the App ID and Secret in CRM Settings first.' },
      { status: 400 },
    );
  }

  if (action === 'add') {
    const extension = Number(body?.extension);
    if (!Number.isInteger(extension) || extension <= 0) {
      return Response.json({ error: 'Extension must be a positive whole number (e.g. 101).' }, { status: 400 });
    }
    const common = validateCommon(body);
    if ('error' in common) return Response.json({ error: common.error }, { status: 400 });
    const pw = checkPassword(body?.password);
    if ('error' in pw) return Response.json({ error: pw.error }, { status: 400 });

    const res = await addAgent(db, extension, { ...common, password: pw.password } as AgentWrite);
    if (!res.ok) return Response.json({ error: res.error || 'TeleCMI refused the new agent.' }, { status: 502 });

    const created = pickAgent(res.data);
    // TeleCMI derives the id as "<extension>_<appid>" and normally echoes it.
    // Rebuild it when it doesn't: without an id the agent exists upstream but is
    // absent from agent_map, so it never appears in the roster and can never be
    // mapped to a user — invisible, and only fixable by hand-editing settings.
    const agentId = String(created?.agent_id || '').trim() || `${extension}_${telecmiAppId(db)}`;

    // Merge, never clobber: agent_map is also edited from CRM Settings, and a
    // blind overwrite here would wipe every existing mapping.
    const { map, error: mapError } = readAgentMap(db);
    const key = mapKey(agentId);
    if (mapError) {
      // The agent DOES now exist on TeleCMI, but agent_map is unreadable and
      // writing our merge result would replace whatever the admin actually has
      // with a single-entry map. Keep their data and tell them the one line to
      // add once they have fixed the JSON.
      return Response.json({
        ok: true,
        agent: toRow(key, '', created),
        error: `The agent was created on TeleCMI but could not be added to the roster mapping. ${mapError} Then add "${key}" to it.`,
      });
    }
    if (!(key in map)) map[key] = ''; // unassigned until an admin picks a user
    setCtSetting(db, 'agent_map', JSON.stringify(map));

    return Response.json({ ok: true, agent: toRow(key, map[key], created) });
  }

  if (action === 'update') {
    const id = String(body?.id ?? '').trim();
    if (!id) return Response.json({ error: 'Agent id is required.' }, { status: 400 });
    const common = validateCommon(body);
    if ('error' in common) return Response.json({ error: common.error }, { status: 400 });

    // THE TRAP IN THIS FILE: /user/update is a FULL REPLACE, not a patch, and it
    // REQUIRES password. Send it blank (or omit it) while only renaming an agent
    // and TeleCMI happily 200s while blanking that agent's login — the GRE can no
    // longer sign in to their softphone, and nothing in the response says so. So
    // when the caller doesn't supply a new password we read the current record
    // and resend the stored one unchanged.
    let password = String(body?.password ?? '');
    if (!password.trim()) {
      const cur = await fetchAgent(db, id);
      if (!cur.ok) {
        return Response.json(
          { error: `${cur.error || 'TeleCMI could not return this agent.'} — cannot update without the current password, as an update would blank the agent's login.` },
          { status: 502 },
        );
      }
      password = String(pickAgent(cur.data)?.password ?? '');
      if (!password.trim()) {
        return Response.json(
          { error: 'TeleCMI did not return this agent\'s current password, and updating without one would blank their login. Enter a password to continue.' },
          { status: 400 },
        );
      }
    } else if (password.length > 100) {
      return Response.json({ error: 'Password must be 100 characters or fewer.' }, { status: 400 });
    }

    const res = await updateAgent(db, id, { ...common, password } as AgentWrite);
    if (!res.ok) return Response.json({ error: res.error || 'TeleCMI refused the update.' }, { status: 502 });

    // A malformed agent_map only costs this row its mapped_email here — it is
    // reported loudly by GET, and failing the write after TeleCMI has already
    // applied it would be a lie.
    const { map } = readAgentMap(db);
    const key = mapKey(id);
    // toRow's whitelist is what keeps the password we just resent out of the
    // response — the updated record echoes it back.
    return Response.json({ ok: true, agent: toRow(id, map[key] ?? map[id] ?? '', pickAgent(res.data)) });
  }

  if (action === 'refresh') {
    const id = String(body?.id ?? '').trim();
    if (!id) return Response.json({ error: 'Agent id is required.' }, { status: 400 });

    const res = await fetchAgent(db, id);
    if (!res.ok) return Response.json({ error: res.error || 'TeleCMI could not return this agent.' }, { status: 502 });

    const { map } = readAgentMap(db);
    const key = mapKey(id);
    return Response.json({ ok: true, agent: toRow(id, map[key] ?? map[id] ?? '', pickAgent(res.data)) });
  }

  return Response.json({ error: "action must be 'add', 'update' or 'refresh'." }, { status: 400 });
}
