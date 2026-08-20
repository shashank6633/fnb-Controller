'use client';

/**
 * CRM — Telephony console (admin only).
 *
 * The owner-facing view of the TeleCMI ACCOUNT itself, as opposed to
 * /crm-calls/settings which configures how this app reacts to calls. Five
 * things live here because each of them fails silently in production:
 *
 *   1 Account balance — TeleCMI simply stops connecting calls when the wallet
 *     empties. Nothing in the app announces that; the phones just go quiet.
 *   2 Call analysis vs OUR ct_calls — the single most valuable number on this
 *     page is the GAP between them. TeleCMI's own count is ground truth; ours
 *     comes from the CDR webhook. When they diverge, webhooks are not arriving
 *     and every downstream feature (recovery queue, attribution, win-back) is
 *     quietly working off half the calls.
 *   3 Agents — extensions, working hours and SMS notify, plus whether each one
 *     is mapped to an FNB user (an unmapped GRE cannot click-to-call). TeleCMI
 *     publishes NO list-users endpoint, so this roster can only ever be the
 *     agents someone added here. That is a silent failure mode of its own: an
 *     extension that exists on TeleCMI but was never added is invisible on this
 *     page forever. Two controls close that gap and neither runs on its own —
 *     "Scan TeleCMI for agents" probes a bounded range of candidate extensions
 *     to find agents we are missing, and "Check roster against TeleCMI" asks the
 *     reverse question, which of our ids TeleCMI no longer recognises.
 *   4 Caller ID — which outbound number an agent presents.
 *   5 Recordings — whether a CDR webhook has EVER arrived, and what TeleCMI
 *     actually puts in its recording field. Read-only. The player fails with a
 *     flat "invalid" that cannot distinguish three completely different
 *     problems: a value that is a filename rather than a URL, an account with
 *     recording switched off, and a CDR webhook that has never reached us at
 *     all. The last of those is not a code problem, and only this panel can
 *     say so. It also carries the one control on this page that reaches
 *     TeleCMI: "Try playback now", which fetches a stored recording and reports
 *     the status, content type and error body. Opt-in, never on mount — a URL
 *     can pass every shape check and still point at a path the vendor does not
 *     serve, and nothing but asking can tell those apart. The panel opens with
 *     the PRECONDITION (CredentialsStrip): are the App ID and secret set, and
 *     does TeleCMI accept them? Nothing else in the panel can be true while the
 *     answer is no, and playback is the only feature that fails silently on it.
 *     Neither credential is rendered here in any form, masked or otherwise.
 *   6 Recording retention — the one WRITABLE control on this page that is not
 *     a TeleCMI account setting: how long a recording stays reachable through
 *     this app (7 / 15 / 30 days). It sits here rather than in CRM Settings
 *     because it belongs beside the recording diagnostic it constrains, and
 *     because the panel has to state plainly what it does and does not do —
 *     no audio is stored on this server, so the window governs playability,
 *     not files. See src/lib/ct/retention.ts.
 *
 * WHY CALLER ID NEEDS A PASSWORD: TeleCMI scopes caller-ID to the USER, not the
 * account, so the app secret cannot read or set it (see src/lib/ct/telecmi-api.ts
 * — the "two auth worlds" note). It needs a 30-day user token minted from that
 * agent's own id + password. The password is typed here, posted once, and never
 * kept in the browser; the token lives server-side.
 *
 * APIs (all admin-gated, all POSTs CSRF-protected via @/lib/api):
 *   GET  /api/telecmi/balance
 *   GET  /api/telecmi/analysis?days=N
 *   GET  /api/telecmi/agents      POST /api/telecmi/agents   (add|update|refresh|scan|verify|map)
 *   POST /api/telecmi/callerid    (login|list|set)
 *   GET  /api/telecmi/recording-diagnostic         (+ ?probe=1 for the upstream try)
 *   GET  /api/telecmi/recording-retention   PUT /api/telecmi/recording-retention
 *   GET  /api/crm-calls/settings  — READ ONLY, and only for the reconciliation
 *     line under the roster (agent_map + agents_seen). This page never writes
 *     that route: agent mapping is edited in CRM Settings, and the one write
 *     this page makes to agent_map goes through the agents route's `map` action
 *     for the reason documented on addToRoster().
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Phone, Wallet, BarChart3, Users, PhoneOutgoing, Loader2, AlertCircle,
  AlertTriangle, CheckCircle2, RefreshCw, Lock, Plus, Pencil, KeyRound,
  Link2Off, PlugZap, X, Save, Info, FileAudio, Timer,
  ScanSearch, ListChecks, UserPlus, ChevronDown, ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';

/* ── Contracts (mirrors the API routes; kept loose where TeleCMI is loose) ── */

type BalanceResp = {
  configured: boolean;
  balance: number | null;
  sms: number | null;
  expire: number | null;
  error?: string;
};

type AnalysisResp = {
  configured: boolean;
  days: number;
  start: number;
  end: number;
  total: number | null;
  answered: number | null;
  missed: number | null;
  /** 0..100, one decimal. null when TeleCMI reported no calls at all. */
  answer_rate: number | null;
  local: { total: number; answered: number; missed: number };
  error?: string;
};

type AgentRow = {
  agent_id: string;
  name: string;
  extension: number | null;
  phone: string;
  notify: boolean | null;
  start_time: number | null;
  end_time: number | null;
  /** The FNB user this TeleCMI agent is mapped to, from ct_settings.agent_map. */
  mapped_email: string | null;
  /**
   * Set when THIS row alone failed to enrich (the route keeps one dead agent id
   * from blanking the whole roster). It must be rendered: without it the row
   * shows empty name/phone/hours, which reads as "this agent has no details"
   * when the truth is we never got an answer from TeleCMI about them.
   */
  error: string | null;
};

type AgentsResp = { configured: boolean; agents: AgentRow[]; error?: string };

/* ── Discovery: POST { action: 'scan' } ───────────────────────────────────────
 *
 * WHY A SCAN HAS TO EXIST. TeleCMI publishes no list-users endpoint — /user/add,
 * /user/update and /user/get are the whole API, and /user/get needs an id you
 * already know. So the roster is not "the agents on this account", it is "the
 * agents somebody typed into agent_map", and an extension that exists upstream
 * but was never added here can never appear. The one lever the provider leaves
 * us is that an agent id is `<extension>_<appid>` and extensions are small
 * consecutive numbers, so the SERVER probes a bounded range of candidates, one
 * /user/get each, and reports which ones answer. A "not found" is the normal
 * answer for most candidates and is not an error anywhere in this flow.
 *
 * EVERY FIELD IS OPTIONAL AND EVERY READ GOES THROUGH A NORMALIZER. This page
 * and the route behind it are written at the same time by different people; a
 * field that has not landed yet must degrade to "not stated", never to a
 * TypeError inside render on the one screen an admin opens BECAUSE the phone
 * system is misbehaving.
 */
type ScanFound = {
  extension: number | null;
  agent_id: string;
  /** TeleCMI's own name for this agent — the whole point of showing the row. */
  name: string;
  phone: string;
  /** The route's verdict on whether this id is already mapped; null = not stated. */
  in_roster: boolean | null;
};

type ScanState = {
  /** Candidate extensions actually probed. */
  scanned: number | null;
  from: number | null;
  to: number | null;
  found: ScanFound[];
  /**
   * The scan hit its time budget. Everything past `last_extension` was NOT
   * looked at, so the result is a floor and not a roster — rendered as such,
   * because a truncated scan presented as complete would "prove" an agent does
   * not exist on TeleCMI when nobody ever asked about them.
   */
  timed_out: boolean;
  last_extension: number | null;
};

/* ── Roster verification: POST { action: 'verify' } ───────────────────────────
 * The reverse question: of the ids WE hold, which does TeleCMI still recognise?
 * "Not recognised" and "could not be checked" are kept apart all the way to the
 * screen — the first is a removed extension, the second is a transport failure
 * that says nothing at all about the id, and merging them would invite an admin
 * to clear a live agent because the network hiccuped. */
type VerifyRow = {
  agent_id: string;
  extension: number | null;
  name: string;
  mapped_email: string | null;
  /** Why it could not be checked; only meaningful on the `unchecked` list. */
  reason: string;
};

type VerifyState = {
  checked: number | null;
  live: number | null;
  missing: VerifyRow[];
  unchecked: VerifyRow[];
};

/** Hard client-side cap on one scan, mirroring the route's own. One candidate
 *  is one request to a third party, so a fat-fingered range is refused here
 *  rather than fired at the provider and refused there. */
const SCAN_MAX_CANDIDATES = 200;

/** How many mapping-only ids are named in full before the line says "and N
 *  more". Naming them is the whole point — a count alone sends the owner back
 *  to the other screen to work out WHICH ids — but a wall of eighty is a wall. */
const MAPPING_ONLY_NAMED = 12;

type CallerIdEntry = { pstn: number; price: number; capacity: number; profile: string };

/**
 * The machine-readable failure kind from /api/telecmi/callerid.
 *
 * It exists so this page never has to match on the route's prose to tell three
 * completely different things apart, and above all so it can tell a DEAD
 * SIGN-IN from a caller-ID feature that is simply not provisioned. TeleCMI
 * answers both with the same auth-shaped status, which is how a sign-in that
 * had just succeeded came to be reported as no longer accepted on the very same
 * card. Absent on an older server — every read below falls back to the
 * behaviour this page had before the discriminator existed.
 */
type CallerIdReason = 'not_signed_in' | 'token_stale' | 'callerid_unavailable' | 'transport';

const CALLERID_REASONS: readonly string[] = ['not_signed_in', 'token_stale', 'callerid_unavailable', 'transport'];

/** Per-agent caller-ID session. The password is deliberately NOT in here — it
 *  lives in a field-local state that is wiped the moment the login returns. */
type CallerIdSession = {
  expires_at: number | string | null;
  callerids: CallerIdEntry[] | null;
  selected: number | null;
  busy: 'login' | 'list' | 'set' | null;
  /**
   * The card's primary failure: an action the admin asked for that did not
   * happen. Red, and mutually exclusive with `flash` — every write of one
   * clears the other, because a card that shows "Signed in" and "sign this
   * agent in again" at once is not two facts, it is a bug the owner has to
   * guess his way out of.
   */
  error: string | null;
  /**
   * A failure of the CALLER-ID LOOKUP, which says nothing at all about the
   * sign-in. Neutral, secondary, and allowed to sit under a green "Signed in"
   * chip — because after a successful login that combination is the truth.
   */
  callerid_note: string | null;
  flash: string | null;
};

const DAY_CHOICES = [1, 7, 30, 90] as const;

/** Below this the wallet is close enough to empty that calls will start
 *  failing before anyone thinks to check — worth an amber shout. */
const LOW_BALANCE_INR = 500;

/* ── Recording diagnostic contracts (GET /api/telecmi/recording-diagnostic) ──
 * Everything is optional because that route answers 200-with-`error` rather
 * than a 500, exactly as /balance does: a diagnostic that dies silently is
 * worse than no diagnostic. */

type DiagField = {
  /** Original spelling as TeleCMI sent it, e.g. filename or data.filename. */
  path: string;
  recording_key: boolean;
  /** The one the mapper actually used (first recognised key wins). */
  winner: boolean;
  value: string;
  redacted: boolean;
  truncated: boolean;
  /** Type + length + a coarse hint. Never the value — see the route's leak note. */
  shape: string;
};

type DiagCdr = {
  log_id: string;
  received_at: string;
  telecmi_call_id: string;
  processed: boolean;
  ingest_error: string;
  payload_readable: boolean;
  field_count: number;
  recording_fields: DiagField[];
  other_fields: { path: string; shape: string }[];
  normalized_recording_url: string;
  /** none | passthrough (already a URL) | joined (filename + base) | dropped. */
  transform: 'none' | 'passthrough' | 'joined' | 'dropped';
  applied_base: string;
  validation: { checked: boolean; ok: boolean; error: string; host: string };
  /** Plain-language verdict. Owned by the ROUTE so there is one wording, not two. */
  headline: string;
};

/* One upstream attempt against one stored recording. This is the only part of
 * the diagnostic that leaves the server, and the only part that can tell a
 * SHAPE that validates from a DESTINATION that serves audio.
 *
 * EVERY FIELD IS OPTIONAL AND EVERY READ IS GUARDED. This panel and the route
 * that feeds it are being changed at the same time by different people; a
 * field that has not landed yet must degrade to "not stated", never to a blank
 * page. `c.retention.expired` on a payload without a retention block is a
 * TypeError inside render, which unmounts the whole Telephony console — the
 * one screen an admin opens BECAUSE something is broken. */
type DiagProbeCall = {
  call_id?: string;
  started_at?: string;
  /** Demo/simulator row rather than a real recording. */
  fixture?: boolean;
  /** Credential-masked, both of them. */
  stored_url?: string;
  fetched_url?: string;
  rewritten?: boolean;
  rewrite_note?: string;
  credentialed?: boolean;
  retention?: { expired?: boolean; reason?: string; days?: number; expires_at?: string };
  /** False when the retention gate refused before any upstream call. */
  attempted?: boolean;
  upstream_status?: number | null;
  upstream_content_type?: string;
  /** First bytes of a non-audio answer, verbatim. '' when audio came back. */
  body_preview?: string;
  is_audio?: boolean;
  error?: string;
  headline?: string;
};

type DiagProbe = {
  ran?: boolean;
  limit?: number;
  candidates?: number;
  calls?: DiagProbeCall[];
  headline?: string;
};

/**
 * Whether the TeleCMI App ID and secret are set — NEVER their values.
 *
 * Optional because the diagnostic route may not send it yet. When it does not,
 * the strip falls back to the account check (see credState below), which is a
 * live use of the very same pair and therefore better evidence than any flag.
 * `masked` is deliberately NOT read anywhere in this file: a boolean and a
 * source answer every question an admin has here, and a tail of a secret in a
 * screenshot answers none of them.
 */
type DiagCredentials = {
  configured?: boolean;
  appid?: { set?: boolean; source?: string };
  secret?: { set?: boolean; source?: string };
};

type RecordingDiagResp = {
  generated_at: string;
  error?: string;
  /** Present only on the opt-in probe request; null on a normal panel load. */
  probe?: DiagProbe | null;
  /** Optional — see DiagCredentials. Booleans only, never a credential. */
  credentials?: DiagCredentials | null;
  webhooks?: {
    cdr_count: number;
    cdr_newest_at: string;
    cdr_processed: number;
    cdr_errored: number;
    live_count: number;
    live_newest_at: string;
    token_configured: boolean;
    headline: string;
  };
  latest_cdr?: DiagCdr | null;
  recording_scan?: {
    limit: number;
    scanned: number;
    with_recording_value: number;
    sample: DiagCdr | null;
    sample_is_latest: boolean;
  };
  allowlist?: string[];
  stored?: {
    calls_total: number;
    with_recording_url: number;
    fixture_recordings: number;
    real_recordings: number;
    headline: string;
  };
};

/* ── Recording retention (GET/PUT /api/telecmi/recording-retention) ────────
 * `stores_audio` is the one field the copy in this panel hangs off: it is the
 * server saying whether any recording bytes are kept on this box. It is false
 * today, and the panel must SAY so rather than imply files are being deleted
 * on a schedule that never deletes anything. */
type RetentionResp = {
  days: number;
  choices: number[];
  default_days: number;
  source: 'db' | 'default';
  swept_to: string | null;
  local_store: string;
  stores_audio: boolean;
  /** `capped` = the real number is higher; the count stops early on purpose. */
  expired_recordings: { count: number; capped: boolean };
  error?: string;
};

/* ── Formatting helpers ───────────────────────────────────────────────────── */

const money = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const count = (n: number) => Number(n || 0).toLocaleString('en-IN');

/** TeleCMI is inconsistent about epochs (seconds vs ms) and our own routes may
 *  pass an ISO string through, so accept all three rather than print "Invalid
 *  Date" at an owner who is trying to work out when a login stops working. */
function fmtWhen(v: number | string | null | undefined): string {
  if (v == null || v === '') return '—';
  let ms: number;
  if (typeof v === 'number') ms = v < 1e11 ? v * 1000 : v;
  else {
    const asNum = Number(v);
    if (Number.isFinite(asNum) && String(v).trim() !== '') ms = asNum < 1e11 ? asNum * 1000 : asNum;
    else ms = Date.parse(v);
  }
  if (!Number.isFinite(ms)) return String(v);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/** Working hours as TeleCMI stores them. It returns bare numbers whose meaning
 *  is the 24-hour clock, so 9 → 9:00 and 22 → 22:00; anything that is clearly
 *  not an hour is shown raw instead of being mangled into a fake time. */
function fmtHour(h: number | null | undefined): string | null {
  if (h == null || !Number.isFinite(Number(h))) return null;
  const n = Number(h);
  if (n >= 0 && n <= 24 && Number.isInteger(n)) return `${String(n).padStart(2, '0')}:00`;
  return String(n);
}

function fmtHours(a: AgentRow): string {
  const s = fmtHour(a.start_time);
  const e = fmtHour(a.end_time);
  if (!s && !e) return '—';
  return `${s ?? '—'} – ${e ?? '—'}`;
}

/** A percentage we may genuinely not know. Never render "0%" for "no calls" —
 *  a zero answer-rate reads as a catastrophe when it actually means silence. */
function fmtPct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(Number(p))) return '—';
  return `${Number(p).toFixed(1)}%`;
}

/** Coerce whatever the route sends into a usable AgentRow (TeleCMI's own
 *  payload is loosely typed and a missing extension must not print "NaN"). */
function normalizeAgent(a: any): AgentRow {
  const num = (v: any): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    agent_id: String(a?.agent_id ?? ''),
    name: String(a?.name ?? ''),
    extension: num(a?.extension),
    phone: String(a?.phone ?? ''),
    // NULLABLE ON PURPOSE. TeleCMI omits `notify` when it does not know, and
    // collapsing that to false here would make the edit form show SMS alerts as
    // OFF and then POST sms_alert:false — silently disabling a real agent's
    // alerts as a side effect of renaming them. Unknown must stay unknown until
    // the admin actually chooses.
    notify: a?.notify == null ? null : Boolean(a.notify),
    start_time: num(a?.start_time),
    end_time: num(a?.end_time),
    mapped_email: a?.mapped_email ? String(a.mapped_email) : null,
    error: a?.error ? String(a.error) : null,
  };
}

/** The one key form for comparing agent ids anywhere on this page. It matches
 *  the canonical agent_map key the server stores (trim + lowercase), so a
 *  discovered "5007_APPID" and a mapped "5007_appid" are one agent, not two. */
const canonAgentId = (id: unknown): string => String(id ?? '').trim().toLowerCase();

const numOrNull = (v: unknown): number | null =>
  (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** First value that is actually stated. Used to accept a couple of spellings
 *  from a route being written in parallel without pretending a missing field
 *  is a false/zero. */
const firstDefined = (...vals: unknown[]): unknown => vals.find(v => v != null);

function normalizeScanRow(f: any): ScanFound {
  const inRoster = firstDefined(f?.in_roster, f?.in_map, f?.mapped);
  return {
    extension: numOrNull(f?.extension),
    agent_id: String(f?.agent_id ?? f?.id ?? '').trim(),
    name: String(f?.name ?? ''),
    phone: String(f?.phone ?? ''),
    in_roster: typeof inRoster === 'boolean' ? inRoster : null,
  };
}

function normalizeScan(j: any): ScanState {
  const rows = Array.isArray(j?.found) ? j.found : Array.isArray(j?.agents) ? j.agents : [];
  return {
    scanned: numOrNull(firstDefined(j?.scanned, j?.candidates)),
    from: numOrNull(j?.from),
    to: numOrNull(j?.to),
    found: rows.map(normalizeScanRow),
    // Strictly true-only: an absent flag means "the route did not say", which
    // must read as a complete scan, not as a truncated one.
    timed_out: j?.timed_out === true,
    last_extension: numOrNull(firstDefined(j?.last_extension, j?.reached_extension, j?.last_reached)),
  };
}

/** A row may arrive as a bare id string — that is still a usable answer. */
function normalizeVerifyRow(r: any): VerifyRow {
  if (typeof r === 'string') {
    return { agent_id: r.trim(), extension: null, name: '', mapped_email: null, reason: '' };
  }
  return {
    agent_id: String(r?.agent_id ?? r?.id ?? '').trim(),
    extension: numOrNull(r?.extension),
    name: String(r?.name ?? ''),
    mapped_email: r?.mapped_email ? String(r.mapped_email) : null,
    reason: String(firstDefined(r?.reason, r?.error) ?? ''),
  };
}

function normalizeVerify(j: any): VerifyState {
  const arr = (v: unknown): VerifyRow[] => (Array.isArray(v) ? v.map(normalizeVerifyRow) : []);
  const missing = arr(firstDefined(j?.missing, j?.unrecognised, j?.not_found));
  const unchecked = arr(firstDefined(j?.unchecked, j?.could_not_check, j?.failed));
  const checked = numOrNull(firstDefined(j?.checked, j?.total));
  // live is derived only when the route did not state it: every checked id is
  // exactly one of live / not-recognised / not-checked, so the subtraction is
  // an identity rather than a guess. Still null when there is no total to
  // subtract from — an invented count is worse than a dash.
  const stated = numOrNull(firstDefined(j?.live, j?.recognised, j?.ok_count));
  return {
    checked,
    live: stated ?? (checked == null ? null : Math.max(0, checked - missing.length - unchecked.length)),
    missing,
    unchecked,
  };
}

type GetResult<T> = { ok: true; data: T } | { ok: false; error: string; locked?: boolean };

/** One GET path for every section: a failed load must never fall through and
 *  render as a tidy empty success state ("0 agents", "₹0 balance"). */
async function getJson<T>(url: string): Promise<GetResult<T>> {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'Admin only', locked: true };
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (j as any)?.error || `HTTP ${r.status}` };
    return { ok: true, data: j as T };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Network error' };
  }
}

/* ── Caller-ID failures: which of the two states is being reported ──────────
 *
 * The whole point of this pair of helpers is that "the sign-in is dead" and
 * "TeleCMI would not hand over caller IDs" are DIFFERENT sentences with
 * different remedies, and were previously the same red box. See the note on
 * CallerIdSession.error / .callerid_note.
 */

/** The route's `reason`, or null when it did not state one (older server). */
function readReason(j: unknown): CallerIdReason | null {
  const r = String((j as { reason?: unknown } | null | undefined)?.reason ?? '').trim();
  return CALLERID_REASONS.includes(r) ? (r as CallerIdReason) : null;
}

/** callerIdPost() hangs the reason off the Error it throws, so every catch on
 *  this page can read it without a second return channel. */
type CallerIdFailure = Error & { reason?: CallerIdReason | null };

const reasonOf = (e: unknown): CallerIdReason | null => {
  const r = (e as CallerIdFailure)?.reason;
  return r == null ? null : r;
};

/**
 * The wording for the secondary, caller-ID-only line.
 *
 * `afterSignIn` is not cosmetic: a login that JUST succeeded is evidence the
 * credentials work, so the sentence has to LEAD with that. Anything that reads
 * "sign this agent in again" printed a second after "Signed in" sends an owner
 * to re-type a password that was never wrong.
 */
function callerIdNoteFor(reason: CallerIdReason | null, detail: string, afterSignIn: boolean): string {
  const lead = afterSignIn ? 'Signed in. ' : '';
  switch (reason) {
    case 'callerid_unavailable':
      return `${lead}TeleCMI did not return caller IDs for this agent — they may not be enabled on this account. Click-to-call is unaffected.`;
    case 'transport':
      return `${lead}TeleCMI could not be asked for this agent’s caller IDs just now, so the list below is not their real one. Try Reload in a moment. TeleCMI said: ${detail}`;
    case 'token_stale':
      // Only reachable straight after a login — outside that window a stale
      // token is a sign-in failure and is reported as one. Here it would
      // contradict the sign-in TeleCMI accepted seconds ago.
      return `${lead}TeleCMI would not accept that sign-in when reading caller IDs. The sign-in itself was accepted, so try Reload before signing in again.`;
    default:
      // No reason stated: say the one thing that is certainly true and carry
      // the server's own message rather than inventing a diagnosis.
      return `${lead}TeleCMI did not return caller IDs for this agent (click-to-call is unaffected). TeleCMI said: ${detail}`;
  }
}

/** What to call a mapping-only agent id on screen: the extension when the id is
 *  the usual `<extension>_<appid>`, otherwise the id itself. The full id is kept
 *  in a title so the row can still be matched in CRM Settings. */
function agentIdLabel(id: string): string {
  const m = /^(\d+)_/.exec(String(id).trim());
  return m ? m[1] : String(id).trim();
}

/* ── Small presentational pieces ──────────────────────────────────────────── */

function SectionCard({
  icon, title, subtitle, right, children,
}: {
  icon: React.ReactNode; title: string; subtitle?: string;
  right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex flex-wrap items-center gap-2">
        {icon}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[#2D1B0E]">{title}</h2>
          {subtitle && <p className="text-[10px] text-[#6B5744] mt-0.5">{subtitle}</p>}
        </div>
        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}

/** "Not configured" is a state, not a failure — say what to do about it. */
function NotConfigured({ what }: { what: string }) {
  return (
    <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] p-3 flex items-start gap-2">
      <PlugZap className="w-4 h-4 text-[#8B7355] shrink-0 mt-0.5" />
      <p className="text-xs text-[#6B5744]">
        <strong className="text-[#2D1B0E]">TeleCMI is not configured</strong> — {what} needs the
        account App ID and Secret. Add them under{' '}
        <a href="/crm-calls/settings" className="text-[#af4408] underline underline-offset-2">CRM Settings</a>{' '}
        (TeleCMI connection), then reload this page. Nothing here is guessed while it is unset:
        an invented balance or call count is worse than an honest blank.
      </p>
    </div>
  );
}

function ErrorBox({ msg, onRetry }: { msg: string; onRetry?: () => void }) {
  return (
    <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-center gap-2">
      <AlertCircle className="w-4 h-4 shrink-0" />
      <span className="min-w-0 break-words">{msg}</span>
      {onRetry && (
        <button onClick={onRetry}
                className="ml-auto shrink-0 px-2.5 py-1 bg-white border border-red-200 rounded text-xs flex items-center gap-1 hover:bg-red-100">
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      )}
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <p className="text-sm text-[#8B7355] flex items-center gap-2 py-2">
      <Loader2 className="w-4 h-4 animate-spin" /> {label}
    </p>
  );
}

/**
 * The precondition for playback, stated in one line above the diagnostic.
 *
 * "Set" and "accepted" are separated on purpose — see credState(). A pair that
 * is saved but refused is the failure that looks most like a working system,
 * and it is the state this deployment has actually been in: a placeholder
 * secret, every screen reporting "configured", and not one recording ever
 * playing.
 *
 * IT RENDERS NO CREDENTIAL, MASKED OR OTHERWISE. Six words about whether the
 * phone system accepts us is the entire useful content; a tail of a secret in
 * an admin's screenshot is not content, it is exposure. `detail` is the vendor
 * or transport message from src/lib/ct/telecmi-api.ts, which is documented
 * never to carry the secret.
 */
function CredentialsStrip({
  state, onRecheck, busy,
}: {
  state: { verdict: 'loading' | 'unknown' | 'missing' | 'rejected' | 'unreachable' | 'accepted'; detail: string };
  onRecheck: () => void;
  busy: boolean;
}) {
  if (state.verdict === 'loading') {
    return (
      <p className="text-[11px] text-[#8B7355] flex items-center gap-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] px-2.5 py-1.5">
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        Checking whether TeleCMI accepts this app&rsquo;s App ID and secret…
      </p>
    );
  }

  const tone =
    state.verdict === 'accepted' ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
      : state.verdict === 'missing' || state.verdict === 'rejected' ? 'bg-red-50 border-red-300 text-red-800'
        : 'bg-amber-50 border-amber-300 text-amber-900';

  const Icon =
    state.verdict === 'accepted' ? CheckCircle2
      : state.verdict === 'missing' ? PlugZap
        : AlertTriangle;

  const title =
    state.verdict === 'accepted' ? 'TeleCMI accepts this app’s credentials'
      : state.verdict === 'missing' ? 'TeleCMI App ID and secret are not set'
        : state.verdict === 'rejected' ? 'TeleCMI rejected this app’s App ID and secret'
          : state.verdict === 'unreachable' ? 'TeleCMI could not be reached to check the credentials'
            : 'Whether TeleCMI accepts this app’s credentials is unknown';

  const body =
    state.verdict === 'accepted'
      ? 'Credentials are not the reason a recording will not play — read the rest of this panel.'
      : state.verdict === 'missing'
        ? 'Recordings cannot be fetched from TeleCMI without them, so every player will refuse with a reason and no audio.'
        : state.verdict === 'rejected'
          ? 'Every recording will refuse to play until a pair TeleCMI accepts is saved. Recordings are the only feature that fails silently on this, which is why it is stated here.'
          : state.verdict === 'unreachable'
            ? 'A pair is saved. Whether TeleCMI accepts it cannot be established while TeleCMI is unreachable, so treat playback failures as unexplained for now.'
            : 'The account check did not answer, so this panel cannot say whether the credentials are the problem.';

  return (
    <div className={`rounded-lg border p-2.5 text-[11px] flex items-start gap-2 ${tone}`}>
      <Icon className="w-4 h-4 shrink-0 mt-px" />
      <div className="min-w-0 space-y-1">
        <p className="font-semibold">{title}</p>
        <p>{body}</p>
        {state.detail && <p className="break-words">TeleCMI said: {state.detail}</p>}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
          {state.verdict !== 'accepted' && (
            <a href="/crm-calls/settings" className="font-semibold underline underline-offset-2">
              Set the App ID and secret in CRM Settings
            </a>
          )}
          <button
            type="button"
            onClick={onRecheck}
            disabled={busy}
            className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} /> Re-check
          </button>
        </p>
      </div>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function TelephonyPage() {
  const [locked, setLocked] = useState(false);

  // 1 · Account
  const [bal, setBal] = useState<BalanceResp | null>(null);
  const [balLoading, setBalLoading] = useState(true);
  const [balError, setBalError] = useState<string | null>(null);

  // 2 · Call analysis
  const [days, setDays] = useState<number>(7);
  const [an, setAn] = useState<AnalysisResp | null>(null);
  const [anLoading, setAnLoading] = useState(true);
  const [anError, setAnError] = useState<string | null>(null);

  // 3 · Agents
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsConfigured, setAgentsConfigured] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsWarn, setAgentsWarn] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ mode: 'add' } | { mode: 'edit'; agent: AgentRow } | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [agentFlash, setAgentFlash] = useState<string | null>(null);

  // 3b · Discovery + verification. Separate state from the roster on purpose:
  // both are opt-in, both cost real TeleCMI requests, and neither may change
  // what the roster shows unless the admin actually maps something.
  const [scan, setScan] = useState<ScanState | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  /** The id currently being written into agent_map (also the busy marker). */
  const [mappingId, setMappingId] = useState<string | null>(null);
  const [mappingAll, setMappingAll] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyState | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // 3c · The CRM agent-mapping id list, read ONLY to reconcile it with this
  // roster. Nothing on this page writes it.
  //
  // WHY THIS IS HERE AT ALL. The two screens list two different things and
  // neither said so. This roster is agent_map — the agents TeleCMI has now.
  // CRM Settings lists that map UNIONED with every agent id seen on a real
  // call, so when a venue's extensions are deleted and re-created upstream the
  // old ones live on there forever, on ct_calls rows that really happened. An
  // owner comparing the two screens can only conclude that one of them is
  // wrong, so this page says out loud which ids are history and where to
  // manage them.
  const [mapIds, setMapIds] = useState<string[] | null>(null);
  const [mapIdsError, setMapIdsError] = useState<string | null>(null);

  // 4 · Caller ID
  const [sessions, setSessions] = useState<Record<string, CallerIdSession>>({});
  const [pwDraft, setPwDraft] = useState<Record<string, string>>({});

  // 5 · Recording diagnostic
  const [diag, setDiag] = useState<RecordingDiagResp | null>(null);
  const [diagLoading, setDiagLoading] = useState(true);
  const [diagError, setDiagError] = useState<string | null>(null);
  // 5b · Upstream playback probe — separate state because it is a separate,
  // opt-in request that DOES call TeleCMI. It must never load with the panel.
  const [probe, setProbe] = useState<DiagProbe | null>(null);
  const [probeLoading, setProbeLoading] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  // 6 · Recording retention
  const [ret, setRet] = useState<RetentionResp | null>(null);
  const [retLoading, setRetLoading] = useState(true);
  const [retError, setRetError] = useState<string | null>(null);
  const [retSaving, setRetSaving] = useState<number | null>(null);
  const [retFlash, setRetFlash] = useState<string | null>(null);

  const loadBalance = useCallback(async () => {
    setBalLoading(true); setBalError(null);
    const r = await getJson<BalanceResp>('/api/telecmi/balance');
    if (!r.ok) {
      if (r.locked) setLocked(true);
      setBalError(r.error);
      setBal(null);
    } else {
      setBal(r.data);
    }
    setBalLoading(false);
  }, []);

  const loadAnalysis = useCallback(async (d: number) => {
    setAnLoading(true); setAnError(null);
    const r = await getJson<AnalysisResp>(`/api/telecmi/analysis?days=${d}`);
    if (!r.ok) {
      if (r.locked) setLocked(true);
      setAnError(r.error);
      setAn(null);
    } else {
      setAn(r.data);
    }
    setAnLoading(false);
  }, []);

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true); setAgentsError(null); setAgentsWarn(null);
    const r = await getJson<AgentsResp>('/api/telecmi/agents');
    if (!r.ok) {
      if (r.locked) setLocked(true);
      setAgentsError(r.error);
      setAgents([]);
    } else {
      const list = Array.isArray(r.data?.agents) ? r.data.agents.map(normalizeAgent) : [];
      setAgents(list);
      setAgentsConfigured(r.data?.configured !== false);
      // A 200 carrying an `error` means "we reached the route but not TeleCMI" —
      // the list may be stale or partial, so say so instead of showing it clean.
      if (r.data?.error) setAgentsWarn(String(r.data.error));
    }
    setAgentsLoading(false);
  }, []);

  /* ── The CRM mapping's ids, for the reconciliation line only ──────────────
   * Read-only, and it must never take the page over: a footnote that cannot
   * load is a missing footnote, not a broken console. So a 401/403 here does
   * NOT call setLocked() the way every other loader on this page does — the
   * page's own admin gate is already answered by the telephony routes. */
  const loadMappingIds = useCallback(async () => {
    setMapIdsError(null);
    const r = await getJson<Record<string, unknown>>('/api/crm-calls/settings');
    if (!r.ok) {
      setMapIds(null);
      setMapIdsError(r.error);
      return;
    }
    const data = r.data ?? {};
    // The route nests the settings object; older shapes put the keys at the top
    // level. Accept both rather than render a silent empty reconciliation.
    const nested = data.settings;
    const src = (nested && typeof nested === 'object' ? nested : data) as Record<string, unknown>;
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (v: unknown) => {
      const id = String(v ?? '').trim();
      const key = canonAgentId(id);
      if (!id || seen.has(key)) return;
      seen.add(key);
      out.push(id);
    };
    // agent_map KEYS, not entries: a key whose FNB user is still blank is a row
    // in that editor all the same, and it is exactly the kind being asked about.
    let map: unknown = src.agent_map;
    if (typeof map === 'string') { try { map = JSON.parse(map || '{}'); } catch { map = null; } }
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      Object.keys(map as Record<string, unknown>).forEach(push);
    }
    // agents_seen = ids on real ct_calls rows. The server has already filtered
    // this by the admin's own hide list, so an id he has dismissed over there is
    // not named again over here.
    const seenIds = data.agents_seen;
    if (Array.isArray(seenIds)) seenIds.forEach(push);
    setMapIds(out);
  }, []);

  useEffect(() => { void loadBalance(); void loadAgents(); void loadMappingIds(); }, [loadBalance, loadAgents, loadMappingIds]);
  useEffect(() => { void loadAnalysis(days); }, [days, loadAnalysis]);

  /* ── 5 · Recording diagnostic ─────────────────────────────────────────────
   * Its own loader and its own effect rather than a line added to the one
   * above: this is a purely additive panel, and nothing already on this page
   * should change shape because it exists. Reads local tables only — no
   * TeleCMI round trip — so it is cheap enough to run on mount. The one part
   * that DOES call TeleCMI is runProbe() below, which is opt-in and never
   * fires on mount. */
  const loadDiag = useCallback(async () => {
    setDiagLoading(true); setDiagError(null);
    const r = await getJson<RecordingDiagResp>('/api/telecmi/recording-diagnostic');
    if (!r.ok) {
      if (r.locked) setLocked(true);
      setDiagError(r.error);
      setDiag(null);
    } else {
      setDiag(r.data);
    }
    setDiagLoading(false);
  }, []);

  useEffect(() => { void loadDiag(); }, [loadDiag]);

  /* ── 5b · Upstream playback probe ─────────────────────────────────────────
   * The one control on this page that reaches TeleCMI. It is a BUTTON and not
   * an effect on purpose: everything else here is free, this costs a real
   * request, and a diagnostic that fires on every page open is a diagnostic
   * someone eventually disables. The server bounds it to a couple of calls with
   * a short timeout and asks for a single byte; see the route. */
  const runProbe = useCallback(async () => {
    setProbeLoading(true); setProbeError(null);
    const r = await getJson<RecordingDiagResp>('/api/telecmi/recording-diagnostic?probe=1');
    if (!r.ok) {
      if (r.locked) setLocked(true);
      setProbeError(r.error);
      setProbe(null);
    } else if (r.data?.error) {
      setProbeError(r.data.error);
      setProbe(null);
    } else {
      setProbe(r.data?.probe ?? null);
    }
    setProbeLoading(false);
  }, []);

  /* ── 6 · Recording retention ──────────────────────────────────────────────
   * Its own loader for the same reason as the diagnostic above: additive, and
   * nothing already on this page changes shape because it exists. Reads
   * ct_settings plus one capped count — no TeleCMI round trip. */
  const loadRetention = useCallback(async () => {
    setRetLoading(true); setRetError(null);
    const r = await getJson<RetentionResp>('/api/telecmi/recording-retention');
    if (!r.ok) {
      if (r.locked) setLocked(true);
      setRetError(r.error);
      setRet(null);
    } else {
      setRet(r.data);
    }
    setRetLoading(false);
  }, []);

  useEffect(() => { void loadRetention(); }, [loadRetention]);

  const saveRetention = async (days: number) => {
    if (retSaving != null) return;
    setRetSaving(days); setRetError(null); setRetFlash(null);
    try {
      const r = await api('/api/telecmi/recording-retention', { method: 'PUT', body: { days } });
      const j = (await r.json().catch(() => ({}))) as Partial<RetentionResp>;
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      // The route answers with the freshly-read state, so the panel shows what
      // the server actually holds rather than what was clicked.
      setRet(j as RetentionResp);
      setRetFlash(`Saved — recordings stay reachable for ${days} days after the call.`);
    } catch (e) {
      setRetError(e instanceof Error ? e.message : 'Could not save the retention period');
    } finally {
      setRetSaving(null);
    }
  };

  /* ── Analysis drift ──────────────────────────────────────────────────────
   * TeleCMI's count is ground truth; ours comes from the CDR webhook. A gap
   * means webhooks are being dropped, and everything built on ct_calls is
   * silently incomplete. Require BOTH a relative and an absolute gap so a
   * single in-flight call on a one-day window is not reported as an outage. */
  const drift = useMemo(() => {
    if (!an || an.total == null) return null;
    const remote = Number(an.total) || 0;
    const local = Number(an.local?.total) || 0;
    const diff = remote - local;
    const base = Math.max(remote, local);
    if (base === 0) return null;
    const pct = (Math.abs(diff) / base) * 100;
    return { remote, local, diff, pct, bad: Math.abs(diff) >= 2 && pct > 5 };
  }, [an]);

  const localRate = useMemo(() => {
    const t = Number(an?.local?.total) || 0;
    if (!an || t === 0) return null;
    return ((Number(an.local.answered) || 0) / t) * 100;
  }, [an]);

  /* ── Are the TeleCMI credentials set, and does TeleCMI accept them? ───────
   *
   * WHY THIS SITS ON THE RECORDINGS PANEL. Playback is the one feature whose
   * failure mode for a bad credential is completely silent: the GRE gets a
   * player that will not start, with no error anywhere. Every other consumer
   * of these credentials (balance, call analysis, agents) already shouts. So
   * the precondition is stated where the symptom is reported.
   *
   * WHERE THE ANSWER COMES FROM, in order:
   *   1 the diagnostic route, if it grows a `credentials` block — a direct
   *     statement of whether the pair is stored.
   *   2 the ACCOUNT CHECK, which is better evidence and already on this page.
   *     /api/telecmi/balance spends the very same appid + secret against the
   *     vendor on every load, so its answer is not "are they set" but "does
   *     TeleCMI accept them" — the question that actually decides playback.
   *     `configured:false` is the route's word for "nothing is stored".
   *
   * "Set" and "accepted" are reported as different things because they fail
   * differently and are fixed differently, and because the placeholder secret
   * this deployment shipped with is precisely the case that looks configured
   * and is not accepted.
   *
   * NOTHING HERE READS A CREDENTIAL VALUE. bal.error is built by
   * src/lib/ct/telecmi-api.ts, which documents that it never contains the
   * secret; the masked tails the settings API can return are not requested,
   * not stored and not rendered anywhere on this page.
   */
  const credState = useMemo((): {
    verdict: 'loading' | 'unknown' | 'missing' | 'rejected' | 'unreachable' | 'accepted';
    detail: string;
  } => {
    const declared = diag?.credentials;
    const configured =
      typeof declared?.configured === 'boolean' ? declared.configured
        : typeof bal?.configured === 'boolean' ? bal.configured
          : null;

    if (configured === false) return { verdict: 'missing', detail: '' };

    // Still waiting on the only live check we have.
    if (balLoading && !bal) return { verdict: 'loading', detail: '' };

    if (bal?.configured === true) {
      const err = String(bal.error || '').trim();
      if (err) {
        // A refusal and an outage both come back as `error`. Only the first is
        // a credential problem, so they are not merged: telling an owner their
        // App ID is wrong when TeleCMI was simply down sends them to re-type a
        // working secret.
        return /auth|credential|invalid|forbidden|denied|\b40[137]\b/i.test(err)
          ? { verdict: 'rejected', detail: err }
          : { verdict: 'unreachable', detail: err };
      }
      if (bal.balance != null) return { verdict: 'accepted', detail: '' };
    }

    // Stored (or not even that much) but nothing has confirmed it either way —
    // most often the account check itself failed. Say so rather than guess.
    return { verdict: 'unknown', detail: balError || '' };
  }, [diag, bal, balLoading, balError]);

  /* ── Agent save (modal submit) ───────────────────────────────────────────── */
  const submitAgent = async (body: Record<string, unknown>): Promise<string | null> => {
    const r = await api('/api/telecmi/agents', { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return j?.error || `HTTP ${r.status}`;
    const saved = j?.agent ? normalizeAgent(j.agent) : null;
    if (saved) {
      setAgents(prev => {
        const i = prev.findIndex(a => a.agent_id === saved.agent_id);
        if (i === -1) return [...prev, saved];
        return prev.map((a, k) => (k === i ? saved : a));
      });
    } else {
      // The route answered ok but did not echo the row — re-pull rather than
      // leave the table showing pre-save values that look like a failed save.
      void loadAgents();
    }
    setAgentFlash(body.action === 'add' ? '✓ Agent created on TeleCMI' : '✓ Agent updated on TeleCMI');
    setTimeout(() => setAgentFlash(null), 4000);
    return null;
  };

  const refreshAgent = async (id: string) => {
    if (refreshingId) return;
    setRefreshingId(id); setAgentsError(null);
    try {
      const r = await api('/api/telecmi/agents', { method: 'POST', body: { action: 'refresh', id } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setAgentsError(j?.error || `Refresh failed (HTTP ${r.status})`); return; }
      if (j?.agent) {
        const saved = normalizeAgent(j.agent);
        setAgents(prev => prev.map(a => (a.agent_id === saved.agent_id ? saved : a)));
      }
    } catch (e: any) {
      setAgentsError(e?.message || 'Refresh failed');
    } finally {
      setRefreshingId(null);
    }
  };

  /* ── 3b · Discovery, mapping and verification ─────────────────────────────
   *
   * All three below are BUTTON-ONLY. Nothing here runs on mount, on a timer, or
   * as a side effect of anything else on this page: a scan is up to a couple of
   * hundred requests at a third party, and a diagnostic that fires on every page
   * open is a diagnostic somebody eventually rips out.
   */

  /** Ids the roster already holds, in canonical form. */
  const rosterIds = useMemo(
    () => new Set(agents.map(a => canonAgentId(a.agent_id))),
    [agents],
  );

  /**
   * Ids the CRM agent mapping holds that are NOT agents on TeleCMI.
   *
   * Almost always historical extensions: the venue's TeleCMI users were
   * re-created, so 5002–5006 exist on real past calls and nowhere else. This is
   * a statement about the two LISTS, never an instruction — nothing here
   * deletes, hides or maps anything, because a derived id cannot be deleted at
   * all (it is on ct_calls rows) and hiding it is CRM Settings' own decision.
   *
   * Only meaningful once the roster has actually loaded: with `agents` empty
   * every mapped id looks unknown, which is why the block that renders this is
   * gated on a non-empty roster.
   */
  const mappingOnlyIds = useMemo(
    () => (mapIds ?? []).filter(id => !rosterIds.has(canonAgentId(id))),
    [mapIds, rosterIds],
  );
  const mappingOnlyShown = mappingOnlyIds.slice(0, MAPPING_ONLY_NAMED);
  const mappingOnlyRest = mappingOnlyIds.length - mappingOnlyShown.length;

  /** One POST path for the three new actions, so 401/403 locks the page exactly
   *  as every GET on it does rather than surfacing as a puzzling error string. */
  const postAgents = async (
    body: Record<string, unknown>,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> => {
    try {
      const r = await api('/api/telecmi/agents', { method: 'POST', body });
      if (r.status === 401 || r.status === 403) {
        setLocked(true);
        return { ok: false, error: 'Admin only' };
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: String(j?.error || `HTTP ${r.status}`) };
      return { ok: true, data: j };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Network error' };
    }
  };

  /**
   * Scan a bounded range of candidate extensions.
   *
   * The range is validated HERE as well as on the server because the cost of a
   * wide range is paid at TeleCMI, not by us: 5000–9999 is five thousand
   * requests to somebody else's account, and it should never leave the browser.
   * With no range typed, nothing is sent and the route's own default governs —
   * one definition of "the usual extensions", not two that can drift apart.
   */
  const runScan = async (override?: { from: number; to: number }) => {
    if (scanning) return;
    setScanError(null); setMapError(null);

    const body: Record<string, unknown> = { action: 'scan' };
    if (override) {
      body.from = override.from;
      body.to = override.to;
    } else {
      const rawFrom = rangeFrom.trim();
      const rawTo = rangeTo.trim();
      if (rawFrom || rawTo) {
        const f = Number(rawFrom);
        const t = Number(rawTo);
        if (!Number.isInteger(f) || f <= 0 || !Number.isInteger(t) || t <= 0) {
          setScanError('Give both a from and a to extension as whole numbers — for example 5000 and 5010.');
          return;
        }
        if (t < f) {
          setScanError('The “to” extension must not be lower than the “from” extension.');
          return;
        }
        if (t - f + 1 > SCAN_MAX_CANDIDATES) {
          setScanError(
            `That range is ${count(t - f + 1)} extensions. A scan asks TeleCMI once per extension, so it is capped at ${SCAN_MAX_CANDIDATES} — narrow the range and scan again for the rest.`,
          );
          return;
        }
        body.from = f;
        body.to = t;
      }
    }

    setScanning(true);
    const r = await postAgents(body);
    if (!r.ok) {
      setScanError(r.error);
      setScan(null);
    } else if (r.data?.configured === false) {
      setScanError(String(r.data?.error || 'TeleCMI is not configured, so there is nothing to scan.'));
      setScan(null);
    } else if (r.data?.error && !Array.isArray(r.data?.found) && !Array.isArray(r.data?.agents)) {
      // A 200 carrying an error and no list is a failure wearing a success code.
      setScanError(String(r.data.error));
      setScan(null);
    } else {
      setScan(normalizeScan(r.data));
      // A 200 that DID list agents but also carried an error is a partial scan;
      // show both rather than choosing one.
      setScanError(r.data?.error ? String(r.data.error) : null);
    }
    setScanning(false);
  };

  /**
   * Map one discovered id into agent_map so it joins the roster.
   *
   * WHY THIS DOES NOT PUT agent_map THROUGH THE CRM SETTINGS ROUTE. That route
   * stores a canonical REPLACEMENT of the whole object and drops every entry
   * whose value is empty — and a freshly discovered agent has no FNB user yet,
   * so it would be dropped on the way in while every other unassigned agent
   * already in the map would be deleted on the way past. The agents route
   * merges a single id into the stored map exactly as `add` already does.
   */
  const addToRoster = async (id: string): Promise<string | null> => {
    const r = await postAgents({ action: 'map', id });
    if (!r.ok) {
      return /action must be/i.test(r.error)
        ? `${id} could not be added to the roster mapping — this app's agent API does not accept a mapping write. Nothing was changed on TeleCMI or here.`
        : r.error;
    }
    const saved = r.data?.agent ? normalizeAgent(r.data.agent) : null;
    if (saved) {
      setAgents(prev => (prev.some(a => canonAgentId(a.agent_id) === canonAgentId(saved.agent_id))
        ? prev.map(a => (canonAgentId(a.agent_id) === canonAgentId(saved.agent_id) ? saved : a))
        : [...prev, saved]));
    } else {
      // The route said yes but did not echo the row — re-pull rather than paint
      // a roster entry we were never actually given.
      await loadAgents();
    }
    return null;
  };

  const mapOne = async (id: string) => {
    if (mappingId || mappingAll) return;
    setMappingId(id); setMapError(null);
    const err = await addToRoster(id);
    if (err) setMapError(err);
    else {
      setAgentFlash(`✓ ${id} added to the roster`);
      setTimeout(() => setAgentFlash(null), 4000);
    }
    setMappingId(null);
  };

  /** Sequential, and it STOPS at the first failure. Racing a dozen writes at one
   *  ct_settings row would have them overwrite each other's merges, and carrying
   *  on past an error would bury the one message that explains the gap. */
  const mapAllNew = async (ids: string[]) => {
    if (mappingId || mappingAll) return;
    setMappingAll(true); setMapError(null);
    let done = 0;
    for (const id of ids) {
      setMappingId(id);
      const err = await addToRoster(id);
      if (err) {
        setMapError(done > 0 ? `Added ${count(done)} of ${count(ids.length)}, then stopped: ${err}` : err);
        break;
      }
      done += 1;
    }
    setMappingId(null);
    setMappingAll(false);
    if (done > 0) {
      setAgentFlash(`✓ ${count(done)} agent${done === 1 ? '' : 's'} added to the roster`);
      setTimeout(() => setAgentFlash(null), 4000);
    }
  };

  /** Ask TeleCMI about every id we already hold. */
  const runVerify = async () => {
    if (verifying) return;
    setVerifying(true); setVerifyError(null);
    const r = await postAgents({ action: 'verify' });
    if (!r.ok) {
      setVerifyError(r.error);
      setVerify(null);
    } else if (r.data?.configured === false) {
      setVerifyError(String(r.data?.error || 'TeleCMI is not configured, so the roster could not be checked.'));
      setVerify(null);
    } else {
      setVerify(normalizeVerify(r.data));
      setVerifyError(r.data?.error ? String(r.data.error) : null);
    }
    setVerifying(false);
  };

  /* Found rows, each answered against the roster we are actually rendering.
   * The route's own `in_roster` is trusted when it states one, but the local
   * check is ORed in so a row flips to "In roster" the instant it is mapped —
   * without it the chip would still read "New" after a successful add. */
  const scanRows = (scan?.found ?? []).map(f => ({
    ...f,
    inRoster: f.in_roster === true || rosterIds.has(canonAgentId(f.agent_id)),
  }));
  const newRows = scanRows.filter(r => !r.inRoster && r.agent_id);

  /* ── Caller ID ───────────────────────────────────────────────────────────── */
  // Hoisted rather than written inline: as object-literal keys sitting BEFORE
  // the two spreads, TypeScript reads them as being overwritten and errors
  // (TS2783). Same precedence either way — defaults, then whatever the session
  // already holds, then the patch — but expressed so the compiler agrees.
  const BLANK_SESSION: CallerIdSession = {
    expires_at: null, callerids: null, selected: null, busy: null,
    error: null, callerid_note: null, flash: null,
  };
  const patchSession = (id: string, patch: Partial<CallerIdSession>) =>
    setSessions(prev => ({
      ...prev,
      [id]: { ...BLANK_SESSION, ...(prev[id] || {}), ...patch },
    }));

  const callerIdPost = async (body: Record<string, unknown>) => {
    const r = await api('/api/telecmi/callerid', { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    // THE TRAP: this route answers HTTP 200 with { ok:false, error } for states
    // it does not treat as server failures — above all "TeleCMI is not
    // configured". Checking only r.ok reads that as a successful sign-in, then
    // reports the resulting empty caller-ID list as fact and lets "Set caller
    // ID" claim success for a call that never left the building. Both flags.
    if (!r.ok || j?.ok === false) {
      const err: CallerIdFailure = new Error(j?.error || `HTTP ${r.status}`);
      // Carried on the Error rather than returned separately so every existing
      // catch on this page keeps working and can ask what kind of failure it was.
      err.reason = readReason(j);
      throw err;
    }
    return j;
  };

  /** The one shape a red caller-ID failure takes: no flash beside it, and —
   *  when the server has told us there is no usable token any more — the card
   *  goes back to the password box, because a green "Signed in" chip above a red
   *  "sign this agent in again" is the exact contradiction being fixed here.
   *  Only those two verdicts retire the sign-in; on anything else this browser
   *  has learned nothing about the token and must not throw the session away. */
  const failSession = (id: string, message: string, reason: CallerIdReason | null) =>
    patchSession(id, {
      busy: null,
      error: message,
      flash: null,
      callerid_note: null,
      ...(reason === 'token_stale' || reason === 'not_signed_in'
        ? { expires_at: null, callerids: null, selected: null }
        : {}),
    });

  const signIn = async (id: string) => {
    const password = (pwDraft[id] || '').trim();
    if (!password) { patchSession(id, { error: 'Enter this agent’s TeleCMI password.', flash: null }); return; }
    patchSession(id, { busy: 'login', error: null, callerid_note: null, flash: null });
    try {
      const j = await callerIdPost({ action: 'login', id, password });
      // Wipe the typed password the instant it has been used — it is never
      // stored, never re-sent, and must not sit in a field for a passer-by.
      setPwDraft(prev => ({ ...prev, [id]: '' }));
      patchSession(id, {
        busy: null,
        expires_at: j?.expires_at ?? null,
        // A sign-in that succeeded RETIRES whatever the last attempt left on
        // this card. Without these two the old red line survives beside the new
        // green one and the owner is looking at both verdicts at once.
        error: null,
        callerid_note: null,
        flash: 'Signed in — this token lasts 30 days.',
      });
      // The caller-ID lookup that follows is a DIFFERENT call. Whatever it does
      // next, it may not touch the sign-in verdict above — see listCallerIds.
      await listCallerIds(id, { afterSignIn: true });
    } catch (e: any) {
      failSession(id, e?.message || 'Sign-in failed', reasonOf(e));
    }
  };

  /**
   * Read this agent's caller IDs.
   *
   * `afterSignIn` marks the call the sign-in makes on its own behalf, and it
   * changes exactly one thing: a failure is reported as a caller-ID note, never
   * as a sign-in error. A login that has just returned a token is evidence the
   * credentials work; a later, different call failing is not evidence that they
   * do not, and rendering it as one is what put "Signed in", "expires 19 Sept
   * 2026" and "sign this agent in again" on one card.
   */
  const listCallerIds = async (id: string, opts?: { afterSignIn?: boolean }) => {
    const afterSignIn = opts?.afterSignIn === true;
    // After a sign-in, `flash` and `expires_at` are the truth about the SIGN-IN
    // and this call has no business clearing either.
    patchSession(id, afterSignIn
      ? { busy: 'list', callerid_note: null }
      : { busy: 'list', error: null, flash: null, callerid_note: null });
    try {
      const j = await callerIdPost({ action: 'list', id });
      const list: CallerIdEntry[] = Array.isArray(j?.callerid)
        ? j.callerid.map((c: any) => ({
            pstn: Number(c?.pstn) || 0,
            price: Number(c?.price) || 0,
            capacity: Number(c?.capacity) || 0,
            profile: String(c?.profile ?? ''),
          }))
        : [];
      patchSession(id, {
        busy: null, callerids: list, selected: list[0]?.pstn ?? null,
        error: null, callerid_note: null,
      });
    } catch (e: any) {
      const reason = reasonOf(e);
      const detail = e?.message || 'Could not list caller IDs';
      // `callerid_unavailable` is the server saying in so many words that the
      // sign-in is fine and the FEATURE is not, so it can never be dressed as a
      // sign-in failure either. Everything else keeps this page's previous
      // behaviour, which is what an older server without `reason` gets.
      if (afterSignIn || reason === 'callerid_unavailable') {
        patchSession(id, { busy: null, callerid_note: callerIdNoteFor(reason, detail, afterSignIn) });
        return;
      }
      failSession(id, detail, reason);
    }
  };

  const applyCallerId = async (id: string) => {
    const s = sessions[id];
    const callerid = s?.selected;
    if (callerid == null) { patchSession(id, { error: 'Pick a caller ID first.', flash: null }); return; }
    patchSession(id, { busy: 'set', error: null, callerid_note: null, flash: null });
    try {
      const j = await callerIdPost({ action: 'set', id, callerid });
      patchSession(id, {
        busy: null,
        error: null,
        flash: `Caller ID set to ${j?.callerid ?? callerid} for outbound calls.`,
      });
    } catch (e: any) {
      // A set that did not happen stays a red failure — it was an explicit
      // request and the number was not changed. What matters is that only a
      // `token_stale` verdict retires the sign-in: on `callerid_unavailable`
      // the route's own message says the sign-in is valid, so the green chip
      // above it is not a contradiction, it is the other half of the sentence.
      failSession(id, e?.message || 'Could not set the caller ID', reasonOf(e));
    }
  };

  /* ── Locked (non-admin) ──────────────────────────────────────────────────── */
  if (locked) {
    return (
      <div className="p-4 sm:p-6 max-w-2xl mx-auto">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <div className="w-12 h-12 mx-auto rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center mb-3">
            <Lock className="w-5 h-5 text-amber-600" />
          </div>
          <h1 className="text-lg font-bold text-[#2D1B0E]">Admin only</h1>
          <p className="text-sm text-[#8B7355] mt-1">
            Telephony spends real money and changes real phone-system config
            (agents, caller IDs), so it is restricted to admins.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4 pb-24">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <Phone className="w-6 h-6 text-[#af4408]" /> Telephony
        </h1>
        <p className="text-xs text-[#6B5744] mt-0.5">
          The TeleCMI account itself — wallet, call totals, agents and caller IDs. Admin only;
          changes here take effect on the live phone system immediately. For how the app{' '}
          <em>reacts</em> to calls (SLA, webhooks, agent mapping) see{' '}
          <a href="/crm-calls/settings" className="text-[#af4408] underline underline-offset-2">CRM Settings</a>.
        </p>
      </div>

      {/* ── 1 · Account ── */}
      <SectionCard
        icon={<Wallet className="w-4 h-4 text-[#af4408]" />}
        title="Account"
        subtitle="Wallet and SMS credits, straight from TeleCMI."
        right={
          <button onClick={() => void loadBalance()} disabled={balLoading}
                  className="px-2.5 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] flex items-center gap-1 hover:bg-[#FFF8F0] disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${balLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        }
      >
        {balLoading ? (
          <Spinner label="Checking the TeleCMI account…" />
        ) : balError ? (
          <ErrorBox msg={balError} onRetry={() => void loadBalance()} />
        ) : !bal ? (
          <ErrorBox msg="No response from the balance API." onRetry={() => void loadBalance()} />
        ) : !bal.configured ? (
          <NotConfigured what="reading the account balance" />
        ) : (
          <div className="space-y-3">
            {bal.error && (
              <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-2.5 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>TeleCMI did not answer cleanly: {bal.error}</span>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Call balance */}
              {(() => {
                const v = bal.balance;
                const low = v != null && v < LOW_BALANCE_INR;
                return (
                  <div className={`rounded-lg border p-3 ${low ? 'bg-amber-50 border-amber-300' : 'bg-[#FFF8F0] border-[#E8D5C4]'}`}>
                    <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Call balance</p>
                    <p className={`text-2xl font-bold mt-0.5 ${low ? 'text-amber-800' : 'text-[#2D1B0E]'}`}>
                      {v == null ? '—' : money(v)}
                    </p>
                    {low ? (
                      <p className="text-[11px] text-amber-900 mt-1 flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                        <span>
                          Low. When the wallet empties TeleCMI stops connecting calls and nothing in
                          this app announces it — the phones simply go quiet. Top up before it hits zero.
                        </span>
                      </p>
                    ) : (
                      <p className="text-[11px] text-[#6B5744] mt-1">
                        Amber below {money(LOW_BALANCE_INR)}.
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* SMS credits */}
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">SMS credits</p>
                <p className="text-2xl font-bold text-[#2D1B0E] mt-0.5">
                  {bal.sms == null ? '—' : count(bal.sms)}
                </p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  Used by TeleCMI&rsquo;s own SMS alerts to agents (the <strong>SMS notify</strong>{' '}
                  column below). Guest WhatsApp does not draw on this.
                </p>
              </div>
            </div>

            {/* Shown RAW on purpose. TeleCMI documents no unit for `expire` and
                we have never confirmed one against a live account — it could be
                epoch seconds, epoch ms, or a day count. Guessing by magnitude
                would print a confident, specific, possibly wrong expiry date
                for the account that runs the restaurant's phones, and a wrong
                date is worse than no date. The number is surfaced so an owner
                can match it against the dashboard; it is not interpreted. */}
            {bal.expire != null && (
              <p className="text-[11px] text-[#6B5744] border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] px-2.5 py-1.5">
                TeleCMI also reports <code className="font-mono text-[#2D1B0E]">expire</code> ={' '}
                <strong className="font-mono text-[#2D1B0E]">{String(bal.expire)}</strong> for this
                account. Its unit is undocumented and unconfirmed, so it is shown exactly as
                received rather than converted into a date — check plan validity in the TeleCMI
                dashboard.
              </p>
            )}
          </div>
        )}
      </SectionCard>

      {/* ── 2 · Call analysis ── */}
      <SectionCard
        icon={<BarChart3 className="w-4 h-4 text-[#af4408]" />}
        title="Call analysis"
        subtitle="TeleCMI's own totals, next to what our CDR webhook actually recorded."
        right={
          <div className="flex items-center gap-1 bg-white border border-[#E8D5C4] rounded-lg p-0.5">
            {DAY_CHOICES.map(d => (
              <button key={d} onClick={() => setDays(d)}
                      className={`px-2.5 py-1 rounded text-xs font-medium ${
                        days === d ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-[#FFF1E3]'
                      }`}>
                {d}d
              </button>
            ))}
          </div>
        }
      >
        {anLoading ? (
          <Spinner label={`Pulling the last ${days} day${days === 1 ? '' : 's'}…`} />
        ) : anError ? (
          <ErrorBox msg={anError} onRetry={() => void loadAnalysis(days)} />
        ) : !an ? (
          <ErrorBox msg="No response from the analysis API." onRetry={() => void loadAnalysis(days)} />
        ) : (
          <div className="space-y-3">
            {!an.configured && <NotConfigured what="reading TeleCMI's call totals" />}
            {an.error && (
              <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-2.5 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>TeleCMI side unavailable: {an.error} — the &ldquo;Ours&rdquo; column below is still real.</span>
              </div>
            )}

            {/* Say the window out loud. It is a ROLLING one ending at the moment
                you loaded the page, not IST calendar days, because TeleCMI's
                /analysis takes a plain epoch range with no notion of our
                timezone. So these totals can legitimately disagree with the
                dashboard's "today"/"this week" at the edges, and an admin who
                does not know that will read the difference as a bug. */}
            <p className="text-[11px] text-[#6B5744]">
              {fmtWhen(an.start)} → {fmtWhen(an.end)}
              <span className="block text-[10px] text-[#8B7355] mt-0.5">
                A rolling {an.days}-day window ending at load time — not IST calendar days, so
                edge counts can differ slightly from the CRM dashboard. Refresh to re-cut it.
              </span>
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[420px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4]">
                    <th className="py-1.5 pr-2 font-medium"></th>
                    <th className="py-1.5 px-2 font-medium">TeleCMI</th>
                    <th className="py-1.5 px-2 font-medium">Ours (call log)</th>
                    <th className="py-1.5 pl-2 font-medium">Gap</th>
                  </tr>
                </thead>
                <tbody className="text-[#2D1B0E]">
                  {([
                    ['Total calls', an.total, an.local?.total ?? 0],
                    ['Answered', an.answered, an.local?.answered ?? 0],
                    ['Missed', an.missed, an.local?.missed ?? 0],
                  ] as [string, number | null, number][]).map(([label, remote, local]) => {
                    const gap = remote == null ? null : remote - local;
                    return (
                      <tr key={label} className="border-b border-[#E8D5C4]/60 last:border-0">
                        <td className="py-2 pr-2 text-[#6B5744]">{label}</td>
                        <td className="py-2 px-2 font-semibold tabular-nums">{remote == null ? '—' : count(remote)}</td>
                        <td className="py-2 px-2 font-semibold tabular-nums">{count(local)}</td>
                        <td className={`py-2 pl-2 tabular-nums ${gap && gap !== 0 ? 'text-amber-800 font-semibold' : 'text-[#8B7355]'}`}>
                          {gap == null ? '—' : gap === 0 ? '0' : `${gap > 0 ? '+' : ''}${count(gap)}`}
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td className="py-2 pr-2 text-[#6B5744]">Answer rate</td>
                    <td className="py-2 px-2 font-semibold tabular-nums">{fmtPct(an.answer_rate)}</td>
                    <td className="py-2 px-2 font-semibold tabular-nums">{fmtPct(localRate)}</td>
                    <td className="py-2 pl-2 text-[#8B7355]">—</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* The whole point of putting the two side by side. */}
            {drift?.bad ? (
              <div className="bg-amber-50 border border-amber-300 text-amber-900 rounded-lg p-3 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <strong>
                    These do not agree — {drift.pct.toFixed(1)}% apart ({count(Math.abs(drift.diff))}{' '}
                    call{Math.abs(drift.diff) === 1 ? '' : 's'}
                    {drift.diff > 0 ? ' missing from our log' : ' extra in our log'}).
                  </strong>{' '}
                  {drift.diff > 0
                    ? 'That normally means the CDR webhook is not reaching us, so the call log, missed-call recovery queue and booking attribution are all working off incomplete data. Re-check the webhook URLs in CRM Settings (type “call report”, method POST) and run a backfill for this window.'
                    : 'We are holding more calls than TeleCMI reports for this window — usually rows carried in by a backfill or a demo seed that fall outside TeleCMI’s own reporting window.'}
                </span>
              </div>
            ) : drift ? (
              <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                TeleCMI and our call log agree within {drift.pct.toFixed(1)}% — CDR webhooks are arriving.
              </p>
            ) : an.configured ? (
              <p className="text-[11px] text-[#6B5744] flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
                {an.total == null
                  ? 'TeleCMI’s own totals are unavailable for this window, so there is nothing to compare our call log against — the webhook-gap check is the reason this section exists, so retry once TeleCMI answers.'
                  : 'No calls in this window on either side, so there is nothing to compare.'}
              </p>
            ) : null}
          </div>
        )}
      </SectionCard>

      {/* ── 3 · Agents ── */}
      <SectionCard
        icon={<Users className="w-4 h-4 text-[#af4408]" />}
        title="Agents"
        subtitle="TeleCMI extensions. Adding or editing here writes to the live phone system."
        right={
          <>
            <button onClick={() => void loadAgents()} disabled={agentsLoading}
                    className="px-2.5 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] flex items-center gap-1 hover:bg-[#FFF8F0] disabled:opacity-50">
              <RefreshCw className={`w-3 h-3 ${agentsLoading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            {/* The two discovery controls. Both reach TeleCMI, so both are
                presses and never effects — see the handlers. */}
            <button onClick={() => void runScan()} disabled={scanning || !agentsConfigured}
                    title="Ask TeleCMI about a bounded range of extensions to find agents that are not in this roster"
                    className="px-2.5 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] flex items-center gap-1 hover:bg-[#FFF8F0] disabled:opacity-50">
              {scanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <ScanSearch className="w-3 h-3" />}
              {scanning ? 'Scanning TeleCMI…' : 'Scan TeleCMI for agents'}
            </button>
            <button onClick={() => void runVerify()} disabled={verifying || !agentsConfigured}
                    title="Ask TeleCMI whether it still recognises every id in this roster"
                    className="px-2.5 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] flex items-center gap-1 hover:bg-[#FFF8F0] disabled:opacity-50">
              {verifying ? <Loader2 className="w-3 h-3 animate-spin" /> : <ListChecks className="w-3 h-3" />}
              {verifying ? 'Checking roster…' : 'Check roster against TeleCMI'}
            </button>
            <button onClick={() => setEditing({ mode: 'add' })} disabled={!agentsConfigured}
                    className="px-2.5 py-1 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded text-xs flex items-center gap-1">
              <Plus className="w-3 h-3" /> Add agent
            </button>
          </>
        }
      >
        {/* THE MODEL, in one line. Everything confusing about this page starts
            with an owner assuming the roster is "the agents on my TeleCMI
            account". It is not, it cannot be, and saying so here is the
            difference between "the app is broken" and "press Scan". */}
        <p className="text-[11px] text-[#6B5744] mb-3">
          TeleCMI provides no list of agents, so this roster is the agents you have added — use{' '}
          <strong className="text-[#2D1B0E]">Scan TeleCMI for agents</strong> to discover any that
          are in TeleCMI but not here yet.
        </p>

        {agentFlash && (
          <div className="mb-3 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-2.5 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> {agentFlash}
          </div>
        )}

        {/* ── Discovery panel ────────────────────────────────────────────────
            OUTSIDE the roster's own loading/error branch below, deliberately:
            when the roster fails to load, scanning is MORE useful, not less,
            and it is a different request against a different failure mode. */}
        <div className="mb-3 rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                <ScanSearch className="w-3.5 h-3.5 text-[#af4408]" /> Discover agents on TeleCMI
              </p>
              <p className="text-[11px] text-[#8B7355] mt-0.5">
                TeleCMI cannot list its own users, so a scan asks about candidate extensions one at
                a time. Most candidates do not exist and simply do not answer — that is the normal
                result, not a failure. Nothing is changed on TeleCMI by scanning.
              </p>
            </div>
            {scan && !scanning && (
              <button onClick={() => { setScan(null); setScanError(null); setMapError(null); }}
                      className="shrink-0 px-2 py-1 bg-white border border-[#E8D5C4] rounded text-[11px] text-[#6B5744] hover:bg-[#FFF8F0]">
                Clear
              </button>
            )}
          </div>

          {scanning && <Spinner label="Asking TeleCMI about each extension — this can take a few seconds…" />}

          {/* No Retry here on purpose: a retry button on a control that spends
              third-party requests invites a double-press. The Scan button is a
              few pixels away and says exactly what it will do. */}
          {scanError && !scanning && <ErrorBox msg={scanError} />}

          {scan && !scanning && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-[#2D1B0E]">
                  Scanned{' '}
                  <strong>{scan.scanned == null ? '—' : count(scan.scanned)}</strong> extension
                  {scan.scanned === 1 ? '' : 's'}
                  {scan.from != null && scan.to != null && (
                    <span className="text-[#8B7355]"> ({scan.from}–{scan.to})</span>
                  )}
                  {' · found '}<strong>{count(scanRows.length)}</strong> agent{scanRows.length === 1 ? '' : 's'}
                  {' · '}
                  <strong className={newRows.length > 0 ? 'text-amber-800' : 'text-[#6B5744]'}>
                    {count(newRows.length)} not in your roster yet
                  </strong>
                </p>
                {newRows.length > 1 && (
                  <button onClick={() => void mapAllNew(newRows.map(r => r.agent_id))}
                          disabled={mappingAll || mappingId != null}
                          className="ml-auto px-2.5 py-1 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded text-xs font-semibold inline-flex items-center gap-1.5">
                    {mappingAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
                    Add all {count(newRows.length)} new
                  </button>
                )}
              </div>

              {mapError && <ErrorBox msg={mapError} />}

              {/* A truncated scan is a FLOOR, never a roster. Said before the
                  table, because "not found" on a scan that stopped early is
                  the one reading that would be flatly wrong. */}
              {scan.timed_out && (() => {
                const from = scan.last_extension != null ? scan.last_extension + 1 : null;
                const to = scan.to ?? numOrNull(rangeTo);
                const canContinue = from != null && to != null && from <= to;
                return (
                  <div className="bg-amber-50 border border-amber-300 text-amber-900 rounded-lg p-2.5 text-[11px] flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                    <span>
                      <strong>This scan stopped early.</strong> It reached extension{' '}
                      <strong>{scan.last_extension ?? 'an unstated point'}</strong> before running out
                      of time, so anything past that was never asked about. The list below is what was
                      found so far — it is not proof that nothing else exists.{' '}
                      {canContinue ? (
                        <button
                          onClick={() => {
                            setRangeOpen(true);
                            setRangeFrom(String(from));
                            setRangeTo(String(to));
                            void runScan({ from, to });
                          }}
                          disabled={scanning}
                          className="font-semibold underline underline-offset-2 disabled:opacity-50"
                        >
                          Continue from {from}
                        </button>
                      ) : (
                        <>Set a range below to carry on from where it stopped.</>
                      )}
                    </span>
                  </div>
                );
              })()}

              {scanRows.length === 0 ? (
                <p className="text-[11px] text-[#8B7355]">
                  No agent answered in that range. If an extension you expect is missing, widen the
                  range below and scan again.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[560px] bg-white border border-[#E8D5C4] rounded-lg">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4]">
                        <th className="py-1.5 px-2 font-medium">Ext</th>
                        <th className="py-1.5 px-2 font-medium">Name on TeleCMI</th>
                        <th className="py-1.5 px-2 font-medium">Agent id</th>
                        <th className="py-1.5 px-2 font-medium">State</th>
                        <th className="py-1.5 px-2 font-medium text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="text-[#2D1B0E]">
                      {scanRows.map((r, i) => (
                        <tr key={r.agent_id || `scan-${r.extension ?? i}`} className="border-b border-[#E8D5C4]/60 last:border-0">
                          <td className="py-2 px-2 font-semibold tabular-nums">{r.extension ?? '—'}</td>
                          <td className="py-2 px-2">
                            {r.name || <span className="text-[#8B7355]">—</span>}
                            {r.phone && <span className="block text-[10px] text-[#8B7355] tabular-nums">{r.phone}</span>}
                          </td>
                          <td className="py-2 px-2 font-mono text-[10px] break-all">
                            {r.agent_id || <span className="font-sans text-[#8B7355]">not returned</span>}
                          </td>
                          <td className="py-2 px-2">
                            {r.inRoster ? (
                              <span className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5 inline-flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> In roster
                              </span>
                            ) : (
                              <span className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 inline-flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" /> New
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-2 text-right">
                            {r.inRoster ? (
                              <span className="text-[11px] text-[#8B7355]">—</span>
                            ) : !r.agent_id ? (
                              // Nothing to write into agent_map. The appid half
                              // of the id is a server-side value, so this page
                              // must not invent one.
                              <span className="text-[11px] text-[#8B7355]"
                                    title="TeleCMI did not return an id for this extension, so there is nothing to map.">
                                No id returned
                              </span>
                            ) : (
                              <button onClick={() => void mapOne(r.agent_id)}
                                      disabled={mappingAll || mappingId != null}
                                      className="px-2 py-1 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded text-xs font-semibold inline-flex items-center gap-1.5">
                                {mappingId === r.agent_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
                                Add to roster
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {newRows.length > 0 && (
                <p className="text-[10px] text-[#8B7355]">
                  Adding puts the agent in this roster with no FNB user assigned yet — they can take
                  calls immediately, but click-to-call needs the mapping finished in{' '}
                  <a href="/crm-calls/settings" className="text-[#af4408] underline underline-offset-2">CRM Settings</a>.
                </p>
              )}
            </div>
          )}

          {/* Advanced range. Collapsed by default and worded so nobody feels
              they are missing a step by ignoring it. */}
          <div>
            <button onClick={() => setRangeOpen(o => !o)}
                    className="text-[11px] text-[#6B5744] hover:text-[#2D1B0E] inline-flex items-center gap-1">
              {rangeOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Advanced: scan a specific extension range
            </button>
            {rangeOpen && (
              <div className="mt-1.5 border border-[#E8D5C4] rounded-lg bg-white p-2.5 flex flex-wrap items-end gap-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide text-[#6B5744]">From extension</span>
                  <input type="number" inputMode="numeric" value={rangeFrom}
                         onChange={e => setRangeFrom(e.target.value)} placeholder="5000"
                         className="w-28 mt-0.5 px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]" />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide text-[#6B5744]">To extension</span>
                  <input type="number" inputMode="numeric" value={rangeTo}
                         onChange={e => setRangeTo(e.target.value)} placeholder="5020"
                         className="w-28 mt-0.5 px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]" />
                </label>
                <button onClick={() => void runScan()} disabled={scanning || !agentsConfigured}
                        className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded text-xs font-semibold inline-flex items-center gap-1.5">
                  {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
                  Scan this range
                </button>
                <button onClick={() => { setRangeFrom(''); setRangeTo(''); }}
                        disabled={scanning || (!rangeFrom && !rangeTo)}
                        className="px-2.5 py-1.5 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-40">
                  Use default range
                </button>
                <p className="w-full text-[10px] text-[#8B7355]">
                  Most venues never need this — the default range covers your existing extensions.
                  Leave both boxes empty to use it. At most {SCAN_MAX_CANDIDATES} extensions per
                  scan, because each one is a separate request to TeleCMI.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ── Roster verification panel ─────────────────────────────────────── */}
        {(verifying || verifyError || verify) && (
          <div className="mb-3 rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-xs font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                <ListChecks className="w-3.5 h-3.5 text-[#af4408]" /> Roster checked against TeleCMI
              </p>
              {verify && !verifying && (
                <button onClick={() => { setVerify(null); setVerifyError(null); }}
                        className="shrink-0 px-2 py-1 bg-white border border-[#E8D5C4] rounded text-[11px] text-[#6B5744] hover:bg-[#FFF8F0]">
                  Clear
                </button>
              )}
            </div>

            {verifying && <Spinner label="Asking TeleCMI about each id in this roster…" />}
            {verifyError && !verifying && <ErrorBox msg={verifyError} />}

            {verify && !verifying && (
              <div className="space-y-2">
                <p className="text-xs text-[#2D1B0E]">
                  TeleCMI recognises <strong>{verify.live == null ? '—' : count(verify.live)}</strong>
                  {verify.checked != null && <> of <strong>{count(verify.checked)}</strong></>} id
                  {verify.checked === 1 ? '' : 's'} in this roster.
                </p>

                {/* KEPT APART FROM THE LIST BELOW. A transport failure says
                    nothing whatsoever about the id, and listing it beside real
                    removals would invite an admin to clear a live agent. */}
                {verify.unchecked.length > 0 && (
                  <div className="rounded-lg border border-[#E8D5C4] bg-white p-2.5 space-y-1.5">
                    <p className="text-[11px] font-semibold text-[#2D1B0E]">
                      Could not check — try again ({count(verify.unchecked.length)})
                    </p>
                    <p className="text-[10px] text-[#8B7355]">
                      TeleCMI did not answer for these. That is a failed lookup, not a verdict — the
                      agents may be perfectly fine. Nothing should be changed on the strength of it.
                    </p>
                    {verify.unchecked.map((r, i) => (
                      <p key={r.agent_id || `unchecked-${i}`} className="text-[11px] text-[#6B5744] break-all">
                        <span className="font-mono text-[#2D1B0E]">{r.agent_id || '—'}</span>
                        {r.extension != null && <> · ext {r.extension}</>}
                        {r.name && <> · {r.name}</>}
                        {r.reason && <span className="block text-[10px] text-[#8B7355]">{r.reason}</span>}
                      </p>
                    ))}
                  </div>
                )}

                {verify.missing.length > 0 ? (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 space-y-1.5">
                    <p className="text-[11px] font-semibold text-amber-900 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      Not recognised by TeleCMI ({count(verify.missing.length)})
                    </p>
                    {verify.missing.map((r, i) => (
                      <p key={r.agent_id || `missing-${i}`} className="text-[11px] text-amber-900 break-all">
                        <span className="font-mono">{r.agent_id || '—'}</span>
                        {r.extension != null && <> · ext {r.extension}</>}
                        {r.mapped_email && <> · mapped to {r.mapped_email}</>}
                        <span className="block text-[10px]">
                          TeleCMI does not recognise this id — likely a removed extension.
                        </span>
                      </p>
                    ))}
                    <p className="text-[10px] text-amber-900">
                      Nothing is removed automatically. Hide or clear these under Agent mapping in{' '}
                      <a href="/crm-calls/settings" className="font-semibold underline underline-offset-2">CRM Settings</a>
                      {' '}— their past calls keep displaying exactly as they do now.
                    </p>
                  </div>
                ) : verify.unchecked.length === 0 ? (
                  <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
                    Every id in this roster is one TeleCMI still recognises.
                  </p>
                ) : null}
              </div>
            )}
          </div>
        )}
        {agentsLoading ? (
          <Spinner label="Loading agents…" />
        ) : agentsError ? (
          <ErrorBox msg={agentsError} onRetry={() => void loadAgents()} />
        ) : !agentsConfigured ? (
          <NotConfigured what="listing and editing agents" />
        ) : (
          <div className="space-y-3">
            {agentsWarn && (
              <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-2.5 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{agentsWarn}</span>
              </div>
            )}

            {agents.length === 0 ? (
              <p className="text-sm text-[#8B7355] py-3 text-center">
                No agents on this TeleCMI account yet. Add one to give a GRE an extension.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[720px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4]">
                      <th className="py-1.5 pr-2 font-medium">Ext</th>
                      <th className="py-1.5 px-2 font-medium">Name</th>
                      <th className="py-1.5 px-2 font-medium">Phone</th>
                      <th className="py-1.5 px-2 font-medium">Mapped FNB user</th>
                      <th className="py-1.5 px-2 font-medium">Hours</th>
                      <th className="py-1.5 px-2 font-medium">SMS notify</th>
                      <th className="py-1.5 pl-2 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="text-[#2D1B0E]">
                    {agents.map(a => (
                      <Fragment key={a.agent_id}>
                      <tr className={`align-middle ${a.error ? '' : 'border-b border-[#E8D5C4]/60'}`}>
                        <td className="py-2 pr-2 font-semibold tabular-nums">{a.extension ?? '—'}</td>
                        <td className="py-2 px-2">
                          <div>{a.name || <span className="text-[#8B7355]">—</span>}</div>
                          <div className="text-[10px] text-[#8B7355] font-mono">{a.agent_id}</div>
                        </td>
                        <td className="py-2 px-2 tabular-nums">{a.phone || '—'}</td>
                        <td className="py-2 px-2">
                          {a.mapped_email ? (
                            <span className="text-xs">{a.mapped_email}</span>
                          ) : (
                            // Unmapped is not cosmetic: click-to-call rings the
                            // MAPPED agent id, so this GRE cannot dial at all.
                            <span className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 inline-flex items-center gap-1">
                              <Link2Off className="w-3 h-3" /> Not mapped
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-xs tabular-nums">{fmtHours(a)}</td>
                        <td className="py-2 px-2 text-xs">
                          {a.notify == null
                            ? <span className="text-[#B8A590]" title="TeleCMI did not report this — editing will leave it unchanged">—</span>
                            : a.notify
                              ? <span className="text-emerald-800">On</span>
                              : <span className="text-[#8B7355]">Off</span>}
                        </td>
                        <td className="py-2 pl-2">
                          <div className="flex items-center gap-1.5 justify-end">
                            <button onClick={() => void refreshAgent(a.agent_id)} disabled={refreshingId === a.agent_id}
                                    title="Re-pull this agent from TeleCMI"
                                    className="px-2 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-50 inline-flex items-center gap-1">
                              <RefreshCw className={`w-3 h-3 ${refreshingId === a.agent_id ? 'animate-spin' : ''}`} />
                            </button>
                            {/* Editing an unenriched row is destructive, not just
                                useless: TeleCMI's update is a FULL REPLACE, so
                                saving would push whatever is in this form over
                                the agent's real name, phone and hours — values
                                we never received and therefore cannot preserve.
                                Refresh first, or fix it in TeleCMI. */}
                            <button onClick={() => setEditing({ mode: 'edit', agent: a })}
                                    disabled={Boolean(a.error)}
                                    title={a.error
                                      ? 'Refresh this agent first — we never got their current details, and saving would overwrite them.'
                                      : 'Edit this agent on TeleCMI'}
                                    className="px-2 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1">
                              <Pencil className="w-3 h-3" /> Edit
                            </button>
                          </div>
                        </td>
                      </tr>
                      {/* The row's own failure, said on the row. Without this the
                          blanks above read as "this agent has no details". */}
                      {a.error && (
                        <tr className="border-b border-[#E8D5C4]/60 last:border-0">
                          <td colSpan={7} className="pb-2 pr-2">
                            <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 flex items-start gap-1.5">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                              <span>
                                <strong>Details not loaded for this agent.</strong> {a.error} The
                                blanks above are unknown values, not empty ones — use Refresh.
                              </span>
                            </p>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-[10px] text-[#6B5744]">
              &ldquo;Mapped FNB user&rdquo; comes from the agent mapping in{' '}
              <a href="/crm-calls/settings" className="text-[#af4408] underline underline-offset-2">CRM Settings</a>.
              An unmapped agent still takes calls, but click-to-call cannot dial for them.
            </p>

            {/* ── This roster vs the CRM agent mapping ────────────────────────
                SILENT WHEN THE TWO AGREE. It exists for the one case that reads
                as a bug and is not: extensions recreated on TeleCMI, so the ids
                that answered last month's calls are still in the mapping editor
                and are no longer agents anywhere. Naming them is the point —
                "the lists differ" without saying WHICH ids just moves the
                puzzle to the other screen. Informational only: this page holds
                no control that could act on them, and a derived id cannot be
                deleted at all (it sits on real ct_calls rows), which is why the
                only thing offered is a link to where it can be dismissed. */}
            {agents.length > 0 && mappingOnlyIds.length > 0 && (
              <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] p-2.5 flex items-start gap-2">
                <Info className="w-4 h-4 text-[#8B7355] shrink-0 mt-0.5" />
                <div className="text-[11px] text-[#6B5744] space-y-1 min-w-0">
                  <p>
                    <strong className="text-[#2D1B0E]">
                      {mappingOnlyIds.length === 1
                        ? '1 id appears in CRM agent mapping but is not an agent on TeleCMI:'
                        : `${count(mappingOnlyIds.length)} ids appear in CRM agent mapping but are not agents on TeleCMI:`}
                    </strong>{' '}
                    {mappingOnlyShown.map((id, i) => (
                      <span key={id} title={id} className="font-mono text-[#2D1B0E]">
                        {agentIdLabel(id)}{i < mappingOnlyShown.length - 1 ? ', ' : ''}
                      </span>
                    ))}
                    {mappingOnlyRest > 0 && <> and {count(mappingOnlyRest)} more</>}
                    {' '}— these are historical extensions from past calls.
                  </p>
                  <p>
                    The two screens are not meant to match. This roster is the agents this app holds
                    on TeleCMI; CRM Settings lists the same mapping <em>plus</em> every agent id that
                    appears on a real call, so an extension deleted and re-created upstream stays
                    there as history. Nothing is broken and nothing here can change them —{' '}
                    <a href="/crm-calls/settings" className="text-[#af4408] underline underline-offset-2">
                      manage them in CRM Settings
                    </a>.
                  </p>
                </div>
              </div>
            )}
            {mapIdsError && (
              <p className="text-[10px] text-[#8B7355]">
                The CRM agent mapping could not be read ({mapIdsError}), so this page cannot say
                whether it holds ids that are no longer agents on TeleCMI.
              </p>
            )}
          </div>
        )}
      </SectionCard>

      {/* ── 4 · Caller ID ── */}
      <SectionCard
        icon={<PhoneOutgoing className="w-4 h-4 text-[#af4408]" />}
        title="Caller ID"
        subtitle="Which number an agent shows when they dial out."
      >
        <div className="space-y-3">
          <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] p-2.5 flex items-start gap-2">
            <KeyRound className="w-4 h-4 text-[#8B7355] shrink-0 mt-0.5" />
            <p className="text-[11px] text-[#6B5744]">
              <strong className="text-[#2D1B0E]">Why this asks for a password.</strong> TeleCMI scopes
              caller-ID to the <em>user</em>, not the account — the App Secret that powers everything
              else on this page cannot read or change it. Each agent must sign in once with their own
              TeleCMI password to mint a user token. <strong>A sign-in lasts 30 days</strong>, after
              which it must be repeated. The password is sent once and never stored in this browser;
              only the token is kept, server-side.
            </p>
          </div>

          {agentsLoading ? (
            <Spinner label="Loading agents…" />
          ) : agentsError ? (
            <ErrorBox msg={agentsError} onRetry={() => void loadAgents()} />
          ) : !agentsConfigured ? (
            <NotConfigured what="managing caller IDs" />
          ) : agents.length === 0 ? (
            <p className="text-sm text-[#8B7355] py-3 text-center">
              No agents yet — add one above, then sign in here to pick their outbound number.
            </p>
          ) : (
            <div className="space-y-2">
              {agents.map(a => {
                const s = sessions[a.agent_id];
                const signedIn = Boolean(s?.expires_at) || Boolean(s?.callerids);
                const busy = s?.busy ?? null;
                return (
                  <div key={a.agent_id} className="border border-[#E8D5C4] rounded-lg bg-white p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-[#2D1B0E]">
                        {a.name || a.agent_id}
                      </span>
                      <span className="text-[10px] text-[#8B7355] font-mono">{a.agent_id}</span>
                      {signedIn && (
                        <span className="ml-auto text-[10px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                          Signed in{s?.expires_at ? ` · expires ${fmtWhen(s.expires_at)}` : ''}
                        </span>
                      )}
                    </div>

                    {!signedIn ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="flex-1 min-w-[200px]">
                          <span className="text-[10px] uppercase tracking-wide text-[#6B5744]">
                            {a.name || 'Agent'}&rsquo;s TeleCMI password
                          </span>
                          <input
                            type="password"
                            autoComplete="off"
                            value={pwDraft[a.agent_id] ?? ''}
                            onChange={e => setPwDraft(prev => ({ ...prev, [a.agent_id]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') void signIn(a.agent_id); }}
                            placeholder="Not saved — used once to mint a 30-day token"
                            className="w-full mt-0.5 px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]"
                          />
                        </label>
                        <button onClick={() => void signIn(a.agent_id)} disabled={busy != null}
                                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded text-xs font-semibold inline-flex items-center gap-1.5">
                          {busy === 'login' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                          Sign in
                        </button>
                        {/* A token already lives server-side for 30 days, but this
                            page cannot see it — so without this button an admin is
                            asked for the password on every single page load, which
                            is precisely what a 30-day token exists to avoid. Try
                            the stored one first; if it is missing or expired the
                            route says so exactly, and the password box is right
                            here. */}
                        <button onClick={() => void listCallerIds(a.agent_id)} disabled={busy != null}
                                title="Reuse the token from a previous sign-in, if it is still valid"
                                className="px-2.5 py-1.5 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-40 inline-flex items-center gap-1.5">
                          {busy === 'list' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                          Use existing sign-in
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="flex-1 min-w-[220px]">
                          <span className="text-[10px] uppercase tracking-wide text-[#6B5744]">Available caller IDs</span>
                          <select
                            value={s?.selected ?? ''}
                            onChange={e => patchSession(a.agent_id, { selected: Number(e.target.value) || null, flash: null })}
                            disabled={!s?.callerids?.length || busy === 'set'}
                            className="w-full mt-0.5 px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]"
                          >
                            {/* Two different empties. "none returned" is an
                                answer from TeleCMI; "not available" is the
                                absence of one, and calling that "none" would
                                state a fact nobody has. */}
                            {!s?.callerids?.length && (
                              <option value="">{s?.callerid_note ? '— not available —' : '— none returned —'}</option>
                            )}
                            {(s?.callerids ?? []).map(c => (
                              <option key={c.pstn} value={c.pstn}>
                                {c.pstn}{c.profile ? ` · ${c.profile}` : ''}{c.capacity ? ` · capacity ${c.capacity}` : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button onClick={() => void listCallerIds(a.agent_id)} disabled={busy === 'list'}
                                className="px-2.5 py-1.5 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-50 inline-flex items-center gap-1">
                          <RefreshCw className={`w-3 h-3 ${busy === 'list' ? 'animate-spin' : ''}`} /> Reload
                        </button>
                        <button onClick={() => void applyCallerId(a.agent_id)}
                                disabled={busy === 'set' || s?.selected == null}
                                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded text-xs font-semibold inline-flex items-center gap-1.5">
                          {busy === 'set' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                          Set caller ID
                        </button>
                      </div>
                    )}

                    {/* The caller-ID line, kept deliberately apart from the red
                        box below. A caller-ID lookup that fails says nothing
                        about the sign-in, so it is neutral, secondary, and
                        allowed to sit under the green "Signed in" chip — which
                        after a successful login is simply the truth. */}
                    {s?.callerid_note && (
                      <p className="text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-2 py-1.5 flex items-start gap-1.5">
                        <Info className="w-3.5 h-3.5 shrink-0 mt-px text-[#8B7355]" /> {s.callerid_note}
                      </p>
                    )}
                    {s?.error && (
                      <p className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 flex items-start gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" /> {s.error}
                      </p>
                    )}
                    {s?.flash && (
                      <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5 flex items-start gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" /> {s.flash}
                      </p>
                    )}
                  </div>
                );
              })}

              {/* Said ONCE, under the whole list, rather than implied on every
                  card. An account with no per-agent caller IDs is a normal
                  account, and a dozen cards each reading "— none returned —"
                  looks like a dozen faults. */}
              <p className="text-[10px] text-[#6B5744]">
                <strong className="text-[#2D1B0E]">&ldquo;— none returned —&rdquo; is a normal answer.</strong>{' '}
                Many TeleCMI accounts publish no per-agent caller IDs at all; those agents simply dial
                out on the account&rsquo;s own number. It is not a failed sign-in and it does not affect
                click-to-call — the only thing it stops is choosing a different outbound number here.
              </p>
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── 5 · Recordings ── */}
      <SectionCard
        icon={<FileAudio className="w-4 h-4 text-[#af4408]" />}
        title="Recordings"
        subtitle="Read-only. Has a CDR ever arrived, and what does TeleCMI actually put in its recording field?"
        right={
          <button onClick={() => void loadDiag()} disabled={diagLoading}
                  className="px-2.5 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] flex items-center gap-1 hover:bg-[#FFF8F0] disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${diagLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        }
      >
        {/* OUTSIDE the diagnostic's own loading/error chain, deliberately: if
            the diagnostic cannot answer, "are the credentials even accepted?"
            is MORE useful, not less, and it is answered from a different
            request. It is also first because it is the precondition — nothing
            below it can be true while TeleCMI is refusing us. */}
        <div className="mb-3">
          <CredentialsStrip state={credState} onRecheck={() => void loadBalance()} busy={balLoading} />
        </div>

        {diagLoading ? (
          <Spinner label="Reading the webhook log…" />
        ) : diagError ? (
          <ErrorBox msg={diagError} onRetry={() => void loadDiag()} />
        ) : !diag ? (
          <ErrorBox msg="No response from the recording diagnostic." onRetry={() => void loadDiag()} />
        ) : diag.error ? (
          <ErrorBox msg={diag.error} onRetry={() => void loadDiag()} />
        ) : !diag.webhooks || !diag.stored ? (
          <ErrorBox msg="The recording diagnostic answered without any figures." onRetry={() => void loadDiag()} />
        ) : (
          <div className="space-y-3">
            {/* THE HEADLINE. Zero CDRs is the most useful answer this panel can
                give and the one nobody guesses, so it is stated first, in red,
                before any field-level detail an owner would otherwise start
                debugging. The sentence itself comes from the route — one
                wording, not two that can drift apart. */}
            {diag.webhooks.cdr_count === 0 ? (
              <div className="bg-red-50 border border-red-300 text-red-800 rounded-lg p-3 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <strong className="block mb-1">No call report has ever reached this app.</strong>
                  {diag.webhooks.headline}{' '}
                  Fix it in the TeleCMI CHUB dashboard, not here: a webhook of type{' '}
                  <em>call report</em>, method POST, pointed at this app&rsquo;s CDR URL. The URL is
                  on{' '}
                  <a href="/crm-calls/settings" className="text-[#af4408] underline underline-offset-2">CRM Settings</a>.
                  {!diag.webhooks.token_configured && (
                    <> No webhook token is configured yet either, so open that page first.</>
                  )}
                </span>
              </div>
            ) : (
              <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>{diag.webhooks.headline}</span>
              </p>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">CDRs received</p>
                <p className={`text-2xl font-bold mt-0.5 ${diag.webhooks.cdr_count === 0 ? 'text-red-700' : 'text-[#2D1B0E]'}`}>
                  {count(diag.webhooks.cdr_count)}
                </p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  {diag.webhooks.cdr_newest_at
                    ? <>Newest {fmtWhen(diag.webhooks.cdr_newest_at)}</>
                    : 'Never'}
                </p>
              </div>

              {/* Live beside CDR on purpose: the PAIR is the diagnosis. Live
                  arriving while CDR is zero rules out the token, the network
                  and the app, and points at one missing URL in TeleCMI. */}
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Live events</p>
                <p className="text-2xl font-bold text-[#2D1B0E] mt-0.5">{count(diag.webhooks.live_count)}</p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  Screen-pop feed. Recordings never arrive on these.
                </p>
              </div>

              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Recording URLs stored</p>
                <p className="text-2xl font-bold text-[#2D1B0E] mt-0.5">{count(diag.stored.with_recording_url)}</p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  of {count(diag.stored.calls_total)} calls in the log
                </p>
              </div>

              <div className={`rounded-lg border p-3 ${diag.stored.real_recordings === 0 && diag.stored.with_recording_url > 0 ? 'bg-amber-50 border-amber-300' : 'border-[#E8D5C4] bg-[#FFF8F0]'}`}>
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Of those, real</p>
                <p className={`text-2xl font-bold mt-0.5 ${diag.stored.real_recordings === 0 && diag.stored.with_recording_url > 0 ? 'text-amber-800' : 'text-[#2D1B0E]'}`}>
                  {count(diag.stored.real_recordings)}
                </p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  {count(diag.stored.fixture_recordings)} demo fixture
                  {diag.stored.fixture_recordings === 1 ? '' : 's'}
                </p>
              </div>
            </div>

            <p className="text-[11px] text-[#6B5744] border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] px-2.5 py-1.5">
              {diag.stored.headline}
            </p>

            {/* Field-level detail. The newest CDR that actually CARRIES a
                recording is shown first when there is one, because the newest
                CDR overall is very often a missed call with no recording at
                all — and reading that as "TeleCMI never sends one" is the
                wrong conclusion this ordering exists to prevent. */}
            {diag.recording_scan?.sample && (
              <CdrDetail
                cdr={diag.recording_scan.sample}
                label={
                  diag.recording_scan.sample_is_latest
                    ? 'Most recent call report'
                    : 'Most recent call report that carries a recording'
                }
                note={
                  diag.recording_scan.sample_is_latest
                    ? undefined
                    : `Found by looking back through the last ${count(diag.recording_scan.scanned)} report${diag.recording_scan.scanned === 1 ? '' : 's'}; ${count(diag.recording_scan.with_recording_value)} of them carry a recording value.`
                }
              />
            )}

            {diag.latest_cdr && !diag.recording_scan?.sample_is_latest && (
              <CdrDetail
                cdr={diag.latest_cdr}
                label="Most recent call report"
                note={
                  diag.recording_scan && diag.recording_scan.with_recording_value === 0
                    ? `None of the last ${count(diag.recording_scan.scanned)} report${diag.recording_scan.scanned === 1 ? '' : 's'} carried a recording value.`
                    : undefined
                }
              />
            )}

            {/* ── The upstream probe ──────────────────────────────────────
                Everything above proves the URL's SHAPE. This is the only thing
                that proves its DESTINATION, which is the distinction a URL that
                validated perfectly and 404ed on every play was hiding. */}
            <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[#2D1B0E]">Does a stored recording actually play?</p>
                  <p className="text-[11px] text-[#8B7355] mt-0.5">
                    Asks TeleCMI for a stored recording and reports what came back. Read-only, at
                    most two calls, one byte each. Nothing else on this page contacts TeleCMI.
                  </p>
                </div>
                <button
                  onClick={() => void runProbe()}
                  disabled={probeLoading}
                  className="shrink-0 px-2.5 py-1 bg-[#af4408] text-white rounded text-xs font-medium flex items-center gap-1 hover:bg-[#8a3506] disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${probeLoading ? 'animate-spin' : ''}`} />
                  {probeLoading ? 'Asking TeleCMI…' : 'Try playback now'}
                </button>
              </div>

              {probeError && (
                <p className="mt-2 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded p-2">{probeError}</p>
              )}

              {/* EVERY FIELD BELOW IS READ DEFENSIVELY — see DiagProbeCall.
                  This panel is the admin's instrument for a broken system; it
                  has to survive a payload that is itself incomplete. */}
              {probe && (() => {
                const calls = Array.isArray(probe.calls) ? probe.calls : [];
                const anyAudio = calls.some(c => c?.is_audio === true);
                return (
                  <div className="mt-3 space-y-2">
                    {probe.headline && (
                      <p className={`text-[11px] rounded p-2 border ${
                        anyAudio
                          ? 'bg-green-50 border-green-300 text-green-900'
                          : 'bg-red-50 border-red-300 text-red-800'
                      }`}>
                        {probe.headline}
                      </p>
                    )}

                    {calls.length === 0 ? (
                      <p className="text-[11px] text-[#8B7355]">No stored recording URL to try.</p>
                    ) : calls.map((c, i) => {
                      // A probe that neither played nor reported a failure has
                      // not answered the question; "Does not play" would be a
                      // verdict nobody gave. Say the truth instead.
                      const verdict: 'plays' | 'no' | 'unknown' =
                        c?.is_audio === true ? 'plays'
                          : c?.is_audio === false ? 'no'
                            : 'unknown';
                      const retention = c?.retention;
                      return (
                        <div key={c?.call_id || `probe-${i}`} className="rounded border border-[#E8D5C4] bg-white p-2.5 text-[11px] text-[#6B5744] space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded font-semibold ${
                              verdict === 'plays' ? 'bg-green-100 text-green-800'
                                : verdict === 'no' ? 'bg-red-100 text-red-800'
                                  : 'bg-[#F0E4D6] text-[#6B5744]'
                            }`}>
                              {verdict === 'plays' ? 'Plays' : verdict === 'no' ? 'Does not play' : 'No verdict'}
                            </span>
                            {c?.fixture && (
                              <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">Demo fixture</span>
                            )}
                            <span className="text-[#8B7355]">{c?.started_at || 'undated'}</span>
                          </div>

                          {c?.headline && <p className="text-[#2D1B0E]">{c.headline}</p>}
                          {!c?.headline && c?.error && <p className="text-[#2D1B0E]">{c.error}</p>}

                          {/* The two URLs side by side are the point of the panel: they
                              are what shows a rewrite happening, and what it produced.
                              Both are masked by the route before they leave the server. */}
                          {c?.stored_url && (
                            <p className="break-all">
                              <span className="text-[#8B7355]">Stored:</span>{' '}
                              <span className="font-mono">{c.stored_url}</span>
                            </p>
                          )}
                          {c?.fetched_url && c.fetched_url !== c.stored_url && (
                            <p className="break-all">
                              <span className="text-[#8B7355]">Fetched:</span>{' '}
                              <span className="font-mono">{c.fetched_url}</span>
                            </p>
                          )}
                          {c?.rewrite_note && (
                            <p className="text-[#8B7355]">{c.rewrite_note}</p>
                          )}
                          {c?.attempted && (
                            <p className="text-[#8B7355]">
                              HTTP {c.upstream_status ?? '—'} · {c.upstream_content_type || 'no content type'}
                              {typeof c.credentialed === 'boolean'
                                ? ` · ${c.credentialed ? 'sent with credentials' : 'sent WITHOUT credentials'}`
                                : ''}
                            </p>
                          )}
                          {c?.body_preview && (
                            <p className="font-mono break-all bg-[#FFF8F0] border border-[#E8D5C4] rounded p-1.5">{c.body_preview}</p>
                          )}
                          {retention?.expired && (
                            <p className="text-amber-800">
                              Retention: refused after {retention.days ?? '—'} days
                              {retention.reason === 'undated' ? ' (this call cannot be dated)' : ''}.
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {diag.allowlist && diag.allowlist.length > 0 && (
              <p className="text-[10px] text-[#8B7355]">
                The player only fetches HTTPS URLs on{' '}
                <span className="font-mono text-[#6B5744]">{diag.allowlist.join(', ')}</span> — set
                by the <span className="font-mono">recording_host_allowlist</span> CRM setting.
                Values are shown here exactly as TeleCMI sent them, with anything that could be a
                credential masked.
              </p>
            )}
          </div>
        )}
      </SectionCard>

      {/* ── 6 · Recording retention ── */}
      <SectionCard
        icon={<Timer className="w-4 h-4 text-[#af4408]" />}
        title="Recording retention"
        subtitle="How long a call recording stays reachable through this app."
        right={
          <button onClick={() => void loadRetention()} disabled={retLoading}
                  className="px-2.5 py-1 bg-white border border-[#E8D5C4] rounded text-xs text-[#6B5744] flex items-center gap-1 hover:bg-[#FFF8F0] disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${retLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        }
      >
        {retLoading ? (
          <Spinner label="Reading the retention policy…" />
        ) : !ret ? (
          <ErrorBox msg={retError || 'No response from the retention API.'} onRetry={() => void loadRetention()} />
        ) : (
          <div className="space-y-3">
            {/* WHAT THIS ACTUALLY DOES. Said first, and said plainly, because a
                retention control that quietly governs nothing is worse than no
                control: an owner would believe recordings are being deleted
                here. They are not stored here to begin with. */}
            <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 flex items-start gap-2">
              <Info className="w-4 h-4 text-[#8B7355] shrink-0 mt-0.5" />
              <div className="text-[11px] text-[#6B5744] space-y-1">
                {ret.stores_audio ? (
                  <p>
                    Recording audio is stored on this server
                    (<span className="font-mono">{ret.local_store}</span>). Files are deleted
                    automatically once they pass the window below, and playback is refused from
                    that moment.
                  </p>
                ) : (
                  <>
                    <p>
                      <strong className="text-[#2D1B0E]">No recording audio is kept on this
                      server.</strong> TeleCMI holds the audio; this app fetches it for each play
                      through an authenticated proxy and writes nothing to disk — so there is no
                      file here to delete, and no storage being consumed.
                    </p>
                    <p>
                      What this window controls today is <strong>reachability</strong>: once a call
                      is older than it, the player refuses the recording for everyone, before any
                      request goes to TeleCMI, and the refusal is written to the audit trail. If
                      recordings are ever stored on this server, the same window and the same
                      expiry job will delete those files — nothing here needs re-configuring.
                    </p>
                  </>
                )}
              </div>
            </div>

            {retError && <ErrorBox msg={retError} onRetry={() => void loadRetention()} />}
            {retFlash && (
              <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" /> <span>{retFlash}</span>
              </p>
            )}

            <div>
              <p className="text-[10px] uppercase tracking-wide text-[#6B5744] mb-1.5">
                Keep recordings reachable for
              </p>
              <div className="flex flex-wrap gap-2">
                {ret.choices.map(d => {
                  const active = d === ret.days;
                  const busy = retSaving === d;
                  return (
                    <button
                      key={d}
                      onClick={() => void saveRetention(d)}
                      disabled={retSaving != null || active}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 disabled:opacity-60 ${
                        active
                          ? 'bg-[#af4408] border-[#af4408] text-white'
                          : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF8F0]'
                      }`}
                    >
                      {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                      {d} days
                      {d === ret.default_days && !active && (
                        <span className="text-[9px] font-normal text-[#8B7355]">default</span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-[#8B7355] mt-1.5">
                In force: <strong className="text-[#2D1B0E]">{ret.days} days</strong>
                {ret.source === 'default'
                  ? ' — the built-in default; nothing has been saved here yet.'
                  : ' — saved on this outlet.'}{' '}
                Shortening the window takes effect immediately, including for calls already logged.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Past the window</p>
                <p className="text-2xl font-bold text-[#2D1B0E] mt-0.5">
                  {count(ret.expired_recordings.count)}{ret.expired_recordings.capped ? '+' : ''}
                </p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  Stored recording links older than {ret.days} days. These no longer play.
                  {ret.expired_recordings.capped && ' Counting stops early on purpose — an exact figure is not worth the query at this size.'}
                </p>
              </div>
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Expiry job last walked to</p>
                <p className="text-sm font-semibold text-[#2D1B0E] mt-1.5">
                  {ret.swept_to ? fmtWhen(ret.swept_to) : 'Not run yet'}
                </p>
                <p className="text-[11px] text-[#6B5744] mt-1">
                  Calls up to this point have already been through an expiry pass. It runs in the
                  background off normal traffic, never on a schedule of its own.
                </p>
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      {editing && (
        <AgentModal
          mode={editing.mode}
          agent={editing.mode === 'edit' ? editing.agent : null}
          onClose={() => setEditing(null)}
          onSubmit={submitAgent}
        />
      )}
    </div>
  );
}

/* ── One call report, field by field ──────────────────────────────────────────
 *
 * The point of this block is to answer, from real data, the question nobody
 * could answer from the player's flat "Recording URL is invalid": what does
 * TeleCMI actually put in that field? So it prints the field NAMES it sent
 * (the spelling matters — the mapper matches on it), the value of any field
 * the mapper reads as a recording, what the mapper turns that into, and
 * whether the proxy would accept the result.
 *
 * Every other field contributes its name and a SHAPE only, never its value —
 * a CDR can carry account identifiers, and "string(37) https URL" is enough to
 * spot a recording hiding under a name the mapper has never heard of.
 */
function CdrDetail({ cdr, label, note }: { cdr: DiagCdr; label: string; note?: string }) {
  const ok = cdr.validation.checked && cdr.validation.ok;
  const bad = cdr.validation.checked && !cdr.validation.ok;
  return (
    <div className="rounded-lg border border-[#E8D5C4] bg-white overflow-hidden">
      <div className="px-3 py-2 bg-[#FFF8F0] border-b border-[#E8D5C4]">
        <p className="text-xs font-semibold text-[#2D1B0E]">{label}</p>
        <p className="text-[10px] text-[#6B5744] mt-0.5">
          Received {fmtWhen(cdr.received_at)}
          {cdr.telecmi_call_id && <> · call <span className="font-mono">{cdr.telecmi_call_id}</span></>}
          {' · '}{cdr.field_count} field{cdr.field_count === 1 ? '' : 's'}
          {!cdr.processed && <> · <span className="text-amber-800 font-semibold">not ingested</span></>}
        </p>
        {note && <p className="text-[10px] text-[#8B7355] mt-0.5">{note}</p>}
      </div>

      <div className="p-3 space-y-2.5">
        {cdr.ingest_error && (
          <p className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>Ingest error on this delivery: {cdr.ingest_error}</span>
          </p>
        )}

        <p className={`text-[11px] rounded px-2 py-1.5 flex items-start gap-1.5 border ${
          ok ? 'text-emerald-800 bg-emerald-50 border-emerald-200'
             : 'text-amber-900 bg-amber-50 border-amber-300'}`}>
          {ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
              : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />}
          <span>{cdr.headline}</span>
        </p>

        {cdr.recording_fields.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[380px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4]">
                  <th className="py-1.5 pr-2 font-medium">Recording field</th>
                  <th className="py-1.5 pl-2 font-medium">Value as sent</th>
                </tr>
              </thead>
              <tbody className="text-[#2D1B0E]">
                {cdr.recording_fields.map(f => (
                  <tr key={f.path} className="border-b border-[#E8D5C4]/60 last:border-0 align-top">
                    <td className="py-2 pr-2 font-mono text-[11px] whitespace-nowrap">
                      {f.path}
                      {f.winner && (
                        <span className="ml-1.5 px-1 py-px rounded bg-[#FFF1E3] border border-[#E8D5C4] text-[9px] font-sans text-[#6B5744] align-middle">
                          used
                        </span>
                      )}
                    </td>
                    <td className="py-2 pl-2 font-mono text-[11px] break-all">
                      {f.value === '' ? <span className="text-[#8B7355] font-sans italic">empty</span> : f.value}
                      {f.truncated && <span className="text-[#8B7355]">…</span>}
                      {f.redacted && (
                        <span className="ml-1.5 text-[10px] font-sans text-[#8B7355]">
                          (masked — looked like a credential)
                        </span>
                      )}
                      <span className="block text-[10px] font-sans text-[#8B7355] mt-0.5">{f.shape}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* What the normalizer produces, and the proxy's own verdict on it —
            the two halves of the chain the player actually runs. */}
        <div className="rounded border border-[#E8D5C4] bg-[#FFF8F0] px-2.5 py-2 space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-[#6B5744]">Normalizer result</p>
          <p className="font-mono text-[11px] text-[#2D1B0E] break-all">
            {cdr.normalized_recording_url || <span className="font-sans italic text-[#8B7355]">nothing — the mapper stores an empty recording_url</span>}
          </p>
          {/* Say what happened to the value, not just what came out. "Joined"
              is the load-bearing one: it means the URL above was BUILT here,
              so it is only as right as the base it was built from. */}
          {cdr.transform === 'joined' && (
            <p className="text-[10px] text-[#6B5744]">
              Built by pasting the filename onto{' '}
              <span className="font-mono text-[#2D1B0E]">{cdr.applied_base || 'the recording base'}</span>
              {' '}— TeleCMI did not send this URL, we assembled it.
            </p>
          )}
          {cdr.transform === 'passthrough' && (
            <p className="text-[10px] text-[#6B5744]">Sent by TeleCMI exactly like this; nothing was added.</p>
          )}
          {cdr.transform === 'dropped' && (
            <p className="text-[10px] text-amber-900">
              A value arrived and was deliberately discarded rather than guessed at
              {cdr.applied_base && <> (it could not be joined onto <span className="font-mono">{cdr.applied_base}</span>)</>}.
            </p>
          )}
          <p className={`text-[11px] ${bad ? 'text-amber-900' : ok ? 'text-emerald-800' : 'text-[#8B7355]'}`}>
            {ok
              ? <>Passes the player&rsquo;s check (host {cdr.validation.host}).</>
              : bad
                ? <>The player would reject it: &ldquo;{cdr.validation.error}&rdquo; — this is the exact message the audio proxy returns.</>
                : <>Nothing to check.</>}
          </p>
        </div>

        {cdr.other_fields.length > 0 && (
          <details className="text-[11px]">
            <summary className="cursor-pointer text-[#6B5744] hover:text-[#2D1B0E]">
              Every other field TeleCMI sent ({cdr.other_fields.length}) — names and shapes only
            </summary>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {cdr.other_fields.map(f => (
                <span key={f.path}
                      className="px-1.5 py-0.5 rounded border border-[#E8D5C4] bg-[#FFF8F0] text-[10px] text-[#6B5744]">
                  <span className="font-mono text-[#2D1B0E]">{f.path}</span> · {f.shape}
                </span>
              ))}
            </div>
            <p className="text-[10px] text-[#8B7355] mt-1.5">
              Values are withheld here on purpose — a report can carry account identifiers. If a
              recording is hiding under a name the mapper does not know, the name and the shape
              above are what give it away.
            </p>
          </details>
        )}

        {!cdr.payload_readable && (
          <p className="text-[11px] text-[#8B7355]">
            The stored copy of this delivery is not a readable JSON object, so no fields could be
            listed.
          </p>
        )}
      </div>
    </div>
  );
}

/* ── Add / Edit agent modal ───────────────────────────────────────────────── */

function AgentModal({
  mode, agent, onClose, onSubmit,
}: {
  mode: 'add' | 'edit';
  agent: AgentRow | null;
  onClose: () => void;
  /** Resolves to an error string, or null on success. */
  onSubmit: (body: Record<string, unknown>) => Promise<string | null>;
}) {
  const [extension, setExtension] = useState(agent?.extension != null ? String(agent.extension) : '');
  const [name, setName] = useState(agent?.name ?? '');
  const [phone, setPhone] = useState(agent?.phone ?? '');
  const [password, setPassword] = useState('');            // edit: blank = keep
  const [startTime, setStartTime] = useState(agent?.start_time != null ? String(agent.start_time) : '');
  const [endTime, setEndTime] = useState(agent?.end_time != null ? String(agent.end_time) : '');
  const [smsAlert, setSmsAlert] = useState(Boolean(agent?.notify));
  // Was the value ever KNOWN, and did the admin change it? If neither, the
  // update omits sms_alert entirely so TeleCMI keeps whatever it already has.
  const [smsTouched, setSmsTouched] = useState(false);
  const smsKnown = agent?.notify != null;
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isAdd = mode === 'add';
  const numOrUndef = (v: string): number | undefined => {
    const t = v.trim();
    if (t === '') return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  };

  const canSave =
    name.trim().length > 0 &&
    phone.trim().length > 0 &&
    (!isAdd || (extension.trim().length > 0 && password.length > 0));

  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true); setErr(null);
    try {
      const common: Record<string, unknown> = {
        name: name.trim(),
        phone_number: phone.trim(),
        // Add always states it — a new agent has no prior value to preserve.
        ...(isAdd || smsTouched || smsKnown ? { sms_alert: smsAlert } : {}),
      };
      const st = numOrUndef(startTime);
      const et = numOrUndef(endTime);
      if (st !== undefined) common.start_time = st;
      if (et !== undefined) common.end_time = et;

      let body: Record<string, unknown>;
      if (isAdd) {
        const ext = numOrUndef(extension);
        if (ext === undefined) { setErr('Extension must be a number.'); setSaving(false); return; }
        body = { action: 'add', extension: ext, password, ...common };
      } else {
        // TeleCMI's update is a FULL REPLACE and demands a password, so a blank
        // box must OMIT the field entirely — that is the server's signal to
        // resend the stored one. Sending "" here would blank the agent's login.
        body = { action: 'update', id: agent!.agent_id, ...common };
        if (password.length > 0) body.password = password;
      }
      const e = await onSubmit(body);
      if (e) { setErr(e); return; }
      onClose();
    } catch (e: any) {
      setErr(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full mt-0.5 px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]';
  const labelCls = 'text-[10px] uppercase tracking-wide text-[#6B5744]';

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto"
         role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl border border-[#E8D5C4] shadow-xl max-w-lg w-full p-5 space-y-4 my-8">
        <div className="flex items-start gap-2">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
              <Users className="w-5 h-5 text-[#af4408]" />
              {isAdd ? 'Add TeleCMI agent' : 'Edit TeleCMI agent'}
            </h3>
            <p className="text-xs text-[#6B5744] mt-1">
              {isAdd
                ? 'Creates a new extension on the live TeleCMI account.'
                : <>Editing <span className="font-mono">{agent?.agent_id}</span> on the live TeleCMI account.</>}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
                  className="ml-auto shrink-0 p-1 text-[#8B7355] hover:text-[#2D1B0E]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          {isAdd ? (
            <label className="block">
              <span className={labelCls}>Extension *</span>
              <input type="number" inputMode="numeric" value={extension}
                     onChange={e => setExtension(e.target.value)} placeholder="101" className={inputCls} />
              <span className="text-[10px] text-[#8B7355]">
                TeleCMI builds the agent id as &lt;extension&gt;_&lt;appid&gt;.
              </span>
            </label>
          ) : (
            <label className="block">
              <span className={labelCls}>Extension</span>
              <input value={agent?.extension ?? ''} disabled className={`${inputCls} opacity-60`} />
              <span className="text-[10px] text-[#8B7355]">Extensions cannot be changed after creation.</span>
            </label>
          )}

          <label className="block">
            <span className={labelCls}>Name *</span>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Priya (GRE)" className={inputCls} />
          </label>

          <label className="block">
            <span className={labelCls}>Phone number *</span>
            <input value={phone} inputMode="tel" onChange={e => setPhone(e.target.value)}
                   placeholder="919876543210" className={inputCls} />
            <span className="text-[10px] text-[#8B7355]">The handset TeleCMI rings for this agent.</span>
          </label>

          <label className="block">
            <span className={labelCls}>Password {isAdd ? '*' : ''}</span>
            <input type="password" autoComplete="new-password" value={password}
                   onChange={e => setPassword(e.target.value)}
                   placeholder={isAdd ? 'Agent’s TeleCMI login password' : 'Leave blank to keep current'}
                   className={inputCls} />
            <span className="text-[10px] text-[#8B7355]">
              {isAdd
                ? 'The agent needs this to sign in for caller ID below.'
                : 'Blank keeps the current password — nothing is sent and the login is untouched.'}
            </span>
          </label>

          <label className="block">
            <span className={labelCls}>Start hour</span>
            <input type="number" min={0} max={24} value={startTime}
                   onChange={e => setStartTime(e.target.value)} placeholder="9" className={inputCls} />
          </label>

          <label className="block">
            <span className={labelCls}>End hour</span>
            <input type="number" min={0} max={24} value={endTime}
                   onChange={e => setEndTime(e.target.value)} placeholder="23" className={inputCls} />
          </label>
        </div>

        {/* Do not promise blank == "keep". TeleCMI's update is a full replace and
            a blank box is simply not sent, so what happens to the stored hours is
            TeleCMI's call, not ours. The boxes are pre-filled from the current
            record precisely so the honest path is to leave them as they are. */}
        <p className="text-[10px] text-[#8B7355] -mt-1">
          Working hours use TeleCMI&rsquo;s 24-hour numbers (9 = 9:00, 23 = 23:00). A blank box is
          not sent at all &mdash; and because TeleCMI replaces the whole agent record on save, the
          safest way to leave hours untouched is to leave the values already filled in above.
        </p>

        <div className="flex items-center gap-2 border border-[#E8D5C4] rounded-lg bg-[#FFFDFB] px-3 py-2">
          <span className="text-xs text-[#2D1B0E] flex-1">
            SMS alert on missed calls
            <span className="block text-[10px] text-[#6B5744]">Draws on the SMS credits shown above.</span>
          </span>
          <Toggle checked={smsAlert} onChange={v => { setSmsAlert(v); setSmsTouched(true); }} size="sm" label="SMS alert on missed calls" />
        </div>

        {err && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {err}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-[#6B5744] hover:bg-[#FFF1E3] rounded-xl">
            Cancel
          </button>
          <button onClick={() => void submit()} disabled={!canSave || saving}
                  className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded-xl text-sm font-semibold">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {isAdd ? 'Create agent' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
