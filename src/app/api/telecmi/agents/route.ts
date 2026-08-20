import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { ctSetting, isTelecmiConfigured, setCtSetting, telecmiAppId } from '@/lib/ct/settings';
import { describeCallAgents } from '@/lib/ct/agents';
import { reportServerError } from '@/lib/error-alerts';
import { addAgent, fetchAgent, updateAgent, type AgentWrite, type TelecmiAgent, type TelecmiResult } from '@/lib/ct/telecmi-api';

/**
 * /api/telecmi/agents — admin-only TeleCMI agent roster (GET) and
 * add / update / refresh / scan / verify (POST).
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
 * ── DISCOVERY IS AN EXTENSION PROBE, NOT A LIST (action 'scan') ─────────────
 * The consequence of "no list endpoint" is the owner's actual bug: an agent who
 * exists on TeleCMI but was never typed into agent_map is INVISIBLE here
 * forever. There is exactly one lever the provider leaves us — TeleCMI derives
 * an agent id as `<extension>_<appid>` (see addAgent in lib/ct/telecmi-api.ts),
 * the appid is ours, and extensions are small consecutive numbers. So 'scan'
 * enumerates the roster by PROBING a bounded range of extensions, one
 * /user/get per candidate: a hit means that agent exists.
 *
 * That is a third-party API being hit N times, so it is fenced:
 *   · admin-only and ONLY on an explicit button press — never on page load,
 *     never on a timer, never as a side effect of add/update/refresh;
 *   · at most MAX_SCAN_EXTENSIONS (200) candidates per scan, a wider range is
 *     refused with the number to narrow to;
 *   · the same ENRICH_CONCURRENCY pool the GET uses, under a wall-clock budget;
 *     past the deadline the scan returns what it found plus `timed_out` and
 *     `last_ext` — the last extension it actually reached — so the admin
 *     resumes from there instead of the scan silently under-reporting;
 *   · a "not found" is the NORMAL answer for most candidates: it costs one
 *     request, logs nothing, and is never surfaced as an error.
 *
 * ── 'verify' — THE OTHER HALF: an id that lingers after being removed ───────
 * /user/get each id already in agent_map and report live / missing. The rule
 * that matters: a TRANSPORT failure (timeout, network, 5xx, rate limit, bad
 * credentials) is reported as `unknown`, NEVER as missing. Calling a working
 * agent dead because the network hiccuped is how a real GRE gets deleted from
 * the roster.
 *
 * BOTH SCAN AND VERIFY ARE READ-ONLY. Neither writes agent_map or any setting;
 * discovery is a read, and adding a found agent to the roster stays the
 * admin's explicit next step.
 *
 * ── SECRETS ────────────────────────────────────────────────────────────────
 * /user/get returns the agent's PASSWORD. Rows are therefore built by an
 * explicit whitelist (toRow) rather than by spreading the upstream object —
 * spreading would ship that password to the browser the day TeleCMI adds a
 * field, and nobody would notice. Scan returns rows through that same toRow, so
 * a probe cannot leak what the roster does not. Nothing here logs a request
 * body either.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Concurrent /user/get lookups. TeleCMI is a shared account-wide endpoint and
 *  a roster is tens of rows, so a small pool keeps the page fast without
 *  hammering the provider. */
const ENRICH_CONCURRENCY = 5;

/** Whole-GET budget for enrichment. Each lookup can burn the client's 8s
 *  timeout; with a large map that multiplies into minutes of a held-open page.
 *  Past the deadline the remaining ids return unenriched rather than hanging.
 *  'verify' reuses it — it is the same workload as the GET's enrichment pass. */
const ENRICH_BUDGET_MS = 20_000;

/** Hard cap on candidates in ONE scan. 200 extensions at ENRICH_CONCURRENCY is
 *  ~40 sequential round trips against a shared provider — enough to cover two
 *  whole 100-blocks, small enough that a fat-fingered 1..99999 is refused
 *  rather than fired. */
const MAX_SCAN_EXTENSIONS = 200;

/** Sibling of ENRICH_BUDGET_MS for the scan, which probes up to 200 candidates
 *  instead of a roster's worth. Past it the scan reports `timed_out` and the
 *  last extension reached; it never keeps a request open indefinitely. */
const SCAN_BUDGET_MS = 30_000;

/** Extensions are dialled numbers, not ids — reject anything that isn't one. */
const MAX_EXTENSION = 99_999_999;

/** Extensions are handed out in hundreds ("the 5000s"), which is what makes a
 *  bounded probe viable at all. Used to widen a derived range to a whole block. */
const SCAN_BLOCK = 100;

/** Last-resort range when NOTHING is known — no mapping, no call history. The
 *  owner's handsets are 5002..5007, and TeleCMI's own onboarding hands out the
 *  5000s, so this is the block worth guessing before asking for a range. */
const DEFAULT_SCAN_FROM = 5000;

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

/* ── DISCOVERY (scan) + ROSTER HEALTH (verify) ────────────────────────────── */

/**
 * The three answers a /user/get can give, and the ONLY place the difference is
 * decided — scan and verify must not each invent their own rule.
 *
 *   'exists'  — TeleCMI returned an agent record with something identifying in
 *               it. This extension is taken; for scan, that IS the discovery.
 *   'absent'  — TeleCMI answered, understood us, and has no such agent. The
 *               normal answer for most probed candidates.
 *   'unknown' — WE DO NOT KNOW. Reported, never conflated with 'absent'.
 */
type LookupVerdict = 'exists' | 'absent' | 'unknown';

/**
 * Errors that say nothing about whether the agent exists. Matched on the
 * provider's message because TeleCMI answers HTTP 200 with a non-200 `code` for
 * most failures (see post() in lib/ct/telecmi-api.ts), so status alone would
 * read an "Authentication Failed" as "this agent is gone" — and verify would
 * then hand an admin a list of live GREs to delete.
 */
const AMBIGUOUS_ERROR = /auth|credential|secret|appid|token|forbid|denied|permission|parameter missing|rate|too many|timed? ?out|did not respond|request failed|internal|server error|unavailable|try again/i;

/** Did TeleCMI hand back an actual agent, or a 200 with nothing in it? */
function hasAgentIdentity(a: TelecmiAgent | null): boolean {
  if (!a) return false;
  return !!(strOrNull(a.name) || strOrNull(a.agent_id) || strOrNull(a.phone) || numOrNull(a.extension) != null);
}

function classifyLookup(res: TelecmiResult<{ agent: TelecmiAgent }>): { verdict: LookupVerdict; agent: TelecmiAgent | null } {
  if (res.ok) {
    const agent = pickAgent(res.data);
    // A 200 carrying no agent record is NOT proof of absence — the GET treats
    // the same shape as a failed row rather than an empty agent, and so must
    // this. If a provider change ever makes that the miss response, a scan
    // reports the candidates as unreachable, which is visible; claiming the
    // extensions are free would not be.
    return hasAgentIdentity(agent) ? { verdict: 'exists', agent } : { verdict: 'unknown', agent: null };
  }
  // status 0 = the request never completed (network / 8s abort). 429 / 5xx are
  // the provider refusing to answer. None of them are evidence about the agent.
  if (res.status === 0 || res.status >= 500 || res.status === 429 || res.status === 401 || res.status === 403) {
    return { verdict: 'unknown', agent: null };
  }
  if (AMBIGUOUS_ERROR.test(String(res.error || ''))) return { verdict: 'unknown', agent: null };
  return { verdict: 'absent', agent: null };
}

/**
 * Leading extension of a TeleCMI identity: '5004_33338614' → 5004, '101' → 101,
 * 'gre.ravi' → null. Anchored and terminated so '5002abc' is not read as 5002.
 */
function leadingExtension(id: string): number | null {
  const m = /^(\d{1,8})(?:_|$)/.exec(String(id || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n <= MAX_EXTENSION ? n : null;
}

/**
 * Every extension we already have a reason to believe in: the agent_map keys an
 * admin typed, PLUS the TeleCMI ids that have actually appeared on calls
 * (describeCallAgents) — an agent can be answering calls while absent from the
 * map, which is precisely the case this feature exists for. App-login values
 * are excluded there by `kind`, so an email never becomes an extension.
 * Call history is a HINT: if it cannot be read the scan still works.
 */
function knownExtensions(db: ReturnType<typeof getDb>, map: Record<string, string>): number[] {
  const out = new Set<number>();
  for (const key of Object.keys(map)) {
    const e = leadingExtension(key);
    if (e) out.add(e);
  }
  try {
    for (const a of describeCallAgents(db)) {
      if (a.kind !== 'telecmi') continue;
      const e = leadingExtension(a.id);
      if (e) out.add(e);
    }
  } catch { /* history is a hint, never a hard dependency */ }
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * The range to probe when the caller names none.
 *
 * DERIVATION: take the lowest extension we know of and widen DOWN to its
 * hundred-block — floor(min/100)*100 .. +99 — because that block is where the
 * neighbours of a known handset live (know 5002, and 5007 is worth probing).
 * When the known extensions straddle more than one block the top is widened to
 * cover the highest known one too, so a default scan can never fail to reach an
 * extension we already knew about; that widening is clamped to
 * MAX_SCAN_EXTENSIONS, and anything beyond it needs an explicit range.
 * Knowing nothing at all falls back to DEFAULT_SCAN_FROM's block.
 */
function defaultScanRange(known: number[]): { from: number; to: number } {
  if (!known.length) return { from: DEFAULT_SCAN_FROM, to: DEFAULT_SCAN_FROM + SCAN_BLOCK - 1 };
  const min = known[0];
  const max = known[known.length - 1];
  const from = Math.max(1, Math.floor(min / SCAN_BLOCK) * SCAN_BLOCK);
  let to = from + SCAN_BLOCK - 1;
  if (max > to) {
    to = Math.min(Math.floor(max / SCAN_BLOCK) * SCAN_BLOCK + SCAN_BLOCK - 1, from + MAX_SCAN_EXTENSIONS - 1);
  }
  return { from, to };
}

/** null = the caller named no range (derive one). Otherwise a validated range
 *  or the reason it was refused — including the cap, which says what to do. */
function parseScanRange(body: any): { error: string } | { from: number; to: number } | null {
  const rawFrom = body?.from;
  const rawTo = body?.to;
  const hasFrom = rawFrom != null && rawFrom !== '';
  const hasTo = rawTo != null && rawTo !== '';
  if (!hasFrom && !hasTo) return null;
  if (!hasFrom || !hasTo) {
    return { error: 'Give both from and to, or neither — with neither, the range is derived from the extensions already known.' };
  }
  const from = Number(rawFrom);
  const to = Number(rawTo);
  if (!Number.isInteger(from) || from < 1 || from > MAX_EXTENSION) {
    return { error: `from must be a whole extension number between 1 and ${MAX_EXTENSION}.` };
  }
  if (!Number.isInteger(to) || to < 1 || to > MAX_EXTENSION) {
    return { error: `to must be a whole extension number between 1 and ${MAX_EXTENSION}.` };
  }
  if (to < from) return { error: 'to must not be lower than from.' };
  const span = to - from + 1;
  if (span > MAX_SCAN_EXTENSIONS) {
    return {
      error: `A scan checks at most ${MAX_SCAN_EXTENSIONS} extensions at a time, and ${from}–${to} is ${span}. `
        + `Narrow it (e.g. ${from}–${from + MAX_SCAN_EXTENSIONS - 1}) and scan the rest afterwards.`,
    };
  }
  return { from, to };
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
    // This also gates the read-only scan/verify below, correctly: with no
    // credentials there is no account to discover agents in, and a mocked
    // "found nothing" would be indistinguishable from a genuinely empty PBX.
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

  /* ── MAP: put a DISCOVERED agent into the roster ──────────────────────────
   * The other half of `scan`. Scan is read-only and returns agents that exist
   * on TeleCMI; this is the explicit "yes, add that one" — it puts the id in
   * agent_map with an EMPTY value (present in the roster, not yet assigned to
   * a staff member), exactly as the `add` branch does after creating an agent.
   *
   * WHY NOT DO THIS THROUGH THE CRM SETTINGS PUT (/api/crm-calls/settings,
   * key agent_map). Because that validator builds a canonical REPLACEMENT of
   * the whole object and keeps only entries that have BOTH a key and a value
   * (`if (key && val) clean[key] = val`). A freshly discovered agent has no
   * staff member yet, so it would be dropped on the way in — and every other
   * already-discovered-but-unassigned id would be deleted on the way past. In
   * the worst case the map stores '{}' and the roster is wiped. Merge here, on
   * the route that owns the roster, and never route an unassigned id through
   * that PUT.
   *
   * TeleCMI is NOT contacted: scan already proved the agent exists, and a
   * second lookup would double the provider traffic for no new fact. The row
   * comes back unenriched; the next GET enriches it like any other. */
  if (action === 'map') {
    const rawId = String(body?.id ?? '').trim();
    if (!rawId) return Response.json({ error: 'Agent id is required.' }, { status: 400 });
    if (rawId.length > 100) return Response.json({ error: 'Agent id is too long.' }, { status: 400 });

    const { map, error: mapError } = readAgentMap(db);
    if (mapError) {
      return Response.json({
        error: `The roster mapping could not be read, so nothing was changed. ${mapError}`,
      }, { status: 409 });
    }
    const key = mapKey(rawId);
    const already = key in map;
    if (!already) {
      map[key] = '';                 // unassigned until an admin picks a user
      setCtSetting(db, 'agent_map', JSON.stringify(map));
    }
    // Idempotent: adding an id twice (double click, "Add all" re-run) is a
    // no-op that still reports success, so the client never has to special-case it.
    return Response.json({ ok: true, already, agent: toRow(key, map[key], null) });
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

  // ── DISCOVERY — READ-ONLY, EXPLICIT, BOUNDED. See the header docblock. ────
  // Nothing below writes agent_map or any other setting: the admin decides what
  // to do with what is found. Both are one-button admin actions; neither is
  // reachable from a page load or a timer.
  if (action === 'scan') {
    try {
      const appid = telecmiAppId(db);
      if (!appid) {
        // isTelecmiConfigured above already requires it; this is the guard that
        // stops a blank appid turning every probe into a lookup for "5002_".
        return Response.json({ error: 'The TeleCMI App ID is missing, so agent ids cannot be built. Add it in CRM Settings.' }, { status: 400 });
      }

      // A roster we cannot read makes `new_ids` a lie — every found agent would
      // be reported as new, and the admin would re-add agents they already have.
      // Refuse rather than mislead, the same way GET does.
      const { map, error: mapError } = readAgentMap(db);
      if (mapError) return Response.json({ error: mapError }, { status: 400 });

      const asked = parseScanRange(body);
      if (asked && 'error' in asked) return Response.json({ error: asked.error }, { status: 400 });
      const { from, to } = asked ?? defaultScanRange(knownExtensions(db, map));

      const exts: number[] = [];
      for (let e = from; e <= to; e++) exts.push(e);

      const deadline = Date.now() + SCAN_BUDGET_MS;
      // The LOWEST extension the budget stopped us reaching. Everything below it
      // was probed, so `last_ext` below is a resume point that cannot skip a
      // candidate — a pool finishes out of order, so "the highest one probed"
      // would not be safe to resume from.
      let firstSkipped = Number.POSITIVE_INFINITY;

      const probes = await mapWithLimit(exts, ENRICH_CONCURRENCY, async (ext) => {
        const id = `${ext}_${appid}`;
        if (Date.now() > deadline) {
          if (ext < firstSkipped) firstSkipped = ext;
          return { ext, id, verdict: 'skipped' as const, agent: null as TelecmiAgent | null };
        }
        try {
          const res = await fetchAgent(db, id);
          const c = classifyLookup(res);
          return { ext, id, verdict: c.verdict as LookupVerdict | 'skipped', agent: c.agent };
        } catch {
          // fetchAgent already swallows transport errors; an unexpected throw is
          // "we do not know", never "this extension is free".
          return { ext, id, verdict: 'unknown' as const, agent: null as TelecmiAgent | null };
        }
      });

      const found = sortRows(
        probes
          .filter(p => p.verdict === 'exists')
          .map(p => toRow(p.id, map[p.id] ?? map[mapKey(p.id)] ?? '', p.agent)),
      );

      const mapped = new Set(Object.keys(map).map(mapKey));
      const new_ids = found.map(r => r.agent_id).filter(id => !mapped.has(mapKey(id)));

      // Probes that answered nothing usable. Reported for the same reason
      // `timed_out` is: "found 3" after 40 refused requests is under-reporting,
      // and an admin who cannot see that has no reason to scan again.
      const unreachable = probes.filter(p => p.verdict === 'unknown').map(p => p.id);

      const timed_out = Number.isFinite(firstSkipped);
      return Response.json({
        ok: true,
        scanned: probes.filter(p => p.verdict !== 'skipped').length,
        found,
        new_ids,
        unreachable,
        timed_out,
        // Everything up to and including last_ext was actually probed, so
        // "scan again from last_ext + 1" cannot miss a candidate.
        last_ext: timed_out ? firstSkipped - 1 : to,
        range: { from, to },
      });
    } catch (e) {
      reportServerError(e, { url: '/api/telecmi/agents (scan)' });
      return Response.json({ error: 'The agent scan failed unexpectedly. Nothing was changed.' }, { status: 500 });
    }
  }

  if (action === 'verify') {
    try {
      const { map, error: mapError } = readAgentMap(db);
      if (mapError) return Response.json({ error: mapError }, { status: 400 });

      const ids = Object.keys(map);
      if (ids.length === 0) {
        return Response.json({ ok: true, checked: 0, live: [], missing: [], unknown: [], timed_out: false });
      }

      const deadline = Date.now() + ENRICH_BUDGET_MS;
      const results = await mapWithLimit(ids, ENRICH_CONCURRENCY, async (id) => {
        if (Date.now() > deadline) return { id, verdict: 'skipped' as const };
        try {
          return { id, verdict: classifyLookup(await fetchAgent(db, id)).verdict as LookupVerdict | 'skipped' };
        } catch {
          return { id, verdict: 'unknown' as const };
        }
      });

      // THE RULE: only a definite "TeleCMI answered and has no such agent" is
      // `missing`. Transport failures AND ids the budget never reached are
      // `unknown` — an id we did not manage to check must never be offered up
      // for removal.
      const live = results.filter(r => r.verdict === 'exists').map(r => r.id);
      const missing = results.filter(r => r.verdict === 'absent').map(r => r.id);
      const unknown = results.filter(r => r.verdict === 'unknown' || r.verdict === 'skipped').map(r => r.id);

      return Response.json({
        ok: true,
        checked: results.filter(r => r.verdict !== 'skipped').length,
        live,
        missing,
        unknown,
        timed_out: results.some(r => r.verdict === 'skipped'),
      });
    } catch (e) {
      reportServerError(e, { url: '/api/telecmi/agents (verify)' });
      return Response.json({ error: 'The roster check failed unexpectedly. Nothing was changed.' }, { status: 500 });
    }
  }

  return Response.json({ error: "action must be 'add', 'update', 'map', 'refresh', 'scan' or 'verify'." }, { status: 400 });
}
