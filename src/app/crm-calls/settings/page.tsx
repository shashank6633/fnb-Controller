'use client';

/**
 * CRM — Call-to-Table Settings (admin only).
 *
 * Master spec 5.7. Everything here is NON-SECRET config stored in ct_settings
 * (key/value). TeleCMI appid/secret live ONLY in server env vars
 * (TELECMI_APPID / TELECMI_SECRET / TELECMI_WEBHOOK_SECRET) — this page just
 * reports whether they are present and hands the admin the webhook URLs to
 * paste into the TeleCMI dashboard (SETTINGS → WEBHOOKS: type "call report" for
 * the CDR URL, "notify" for the Live URL).
 *
 * GET /api/crm-calls/settings  → { settings, webhook urls/token, configured,
 *                                  agents_seen/_detail, agent_hidden, staff }
 * PUT /api/crm-calls/settings  → changed keys only (the Agent-mapping editor
 *                                sends agent_map + agent_hidden together)
 * POST /api/crm-calls/seed     → demo data (confirm first, show counts)
 * POST /api/telecmi/backfill   → historical CDR pull ({ days })
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Settings as SettingsIcon, PlugZap, Webhook, Copy, Check, Clock, UserCheck, AlertTriangle,
  Loader2, AlertCircle, CheckCircle2, Save, Lock, Database, DownloadCloud,
  MessageCircle, RefreshCw, Sparkles, Zap, Users, Plus, Trash2, MonitorPlay, Crown,
  Eraser, Eye, EyeOff, ScanSearch, UserPlus,
} from 'lucide-react';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';
import SpecialsManager from './SpecialsManager';

// Mirrors CT_SETTING_DEFAULTS in src/lib/ct/settings.ts (that lib is
// server-only — it imports node crypto — so we keep a local copy here).
const DEFAULTS: Record<string, string> = {
  telecmi_base_url: '',
  sla_minutes: '30',
  attribution_hours: '48',
  business_open: '12:00',
  business_close: '23:30',
  auto_assign: 'off',
  after_hours_whatsapp: '0',
  after_hours_template: 'Sorry we missed your call! We open at {open}. Book a table: {link}',
  // Instant missed-call acknowledgement — OFF by default (src/lib/ct/missed-ack.ts).
  missed_call_whatsapp: '0',
  missed_call_wa_text: 'Sorry we missed your call. Reply here and we will help you book.',
  auto_analyze: '0',
  analysis_retention: 'permanent',
  quick_send_links: '[]',
  // GRE "What's On" board config (mirrors CT_SETTING_DEFAULTS).
  whatson_panels: '{"entertainment":true,"parties":true,"reservations":true,"specials":true,"capacity":true,"call_context":true}',
  whatson_specials: '',
  whatson_capacity: '0',
  whatson_entertainment_mode: 'dj_only',
  // Live Calls "who should take this call" hints — both OFF by default.
  sticky_agent: '0',
  vip_routing: '0',
  vip_min_visits: '5',
  vip_min_spend: '25000',
};

const EDITABLE_KEYS = Object.keys(DEFAULTS);

/** Pull the two webhook paths out of the settings GET payload, tolerating a
 *  few reasonable envelope shapes (urls object, flat keys, or bare token). */
function extractWebhookPaths(j: any): { live: string; cdr: string } {
  const pick = (...vals: any[]): string =>
    (vals.find(v => typeof v === 'string' && v.trim().length > 0) as string) || '';
  let live = pick(j?.webhook_live_url, j?.webhook_urls?.live, j?.webhooks?.live, j?.urls?.live, j?.webhook_live, j?.live_webhook_url);
  let cdr  = pick(j?.webhook_cdr_url,  j?.webhook_urls?.cdr,  j?.webhooks?.cdr,  j?.urls?.cdr,  j?.webhook_cdr,  j?.cdr_webhook_url);
  if (!live || !cdr) {
    const token = pick(j?.webhook_token, j?.token, j?.settings?.webhook_token);
    if (token) {
      if (!live) live = `/api/telecmi/webhook/live/${token}`;
      if (!cdr)  cdr  = `/api/telecmi/webhook/cdr/${token}`;
    }
  }
  return { live, cdr };
}

/** Parse settings.agent_map (JSON string OR object) → { rawAgentId: email },
 *  dropping blank keys/values. Tolerant of a bad blob (returns {}). */
function parseAgentMap(v: any): Record<string, string> {
  let obj: any = v;
  if (typeof v === 'string') { try { obj = JSON.parse(v || '{}'); } catch { return {}; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj)) {
    const key = String(k).trim();
    // KEEP AN UNASSIGNED AGENT. This used to require an email
    // (`if (key && email)`), which silently dropped every roster agent that
    // had no staff member yet — and an agent added on the Telephony page
    // lands in agent_map with EXACTLY that shape (id -> ''). The owner's
    // recreated extensions 5008..5012 were all in the saved map and none of
    // them reached this editor, so the page showed only the old ids derived
    // from call history and the two screens disagreed. An empty value is
    // meaningful: "in the roster, not yet mapped".
    if (key) out[key] = String(val ?? '').trim();
  }
  return out;
}

/** Canonical form of a TeleCMI agent id — trimmed + lowercased. This is exactly
 *  how the server stores agent_map KEYS and agent_hidden entries, so every
 *  membership test on this page goes through it rather than re-lowercasing
 *  inline and drifting. */
function canonAgentId(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * Parse the admin's dismiss list → canonical ids, de-duplicated, order kept.
 *
 * The current server sends it top-level as a real array (`agent_hidden`); an
 * older/echoed payload can carry it as the raw ct_settings JSON string, so both
 * shapes are accepted and a malformed blob simply reads as "nothing hidden"
 * rather than throwing the whole settings load away.
 */
function parseHiddenIds(v: unknown): string[] {
  let arr: unknown = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v || '[]'); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  const used = new Set<string>();
  for (const raw of arr) {
    const id = canonAgentId(raw);
    if (!id || used.has(id)) continue;
    used.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Is this agent id an app LOGIN EMAIL rather than a TeleCMI id?
 *
 * ct_calls.agent_user legitimately holds two kinds of value: a TeleCMI agent id
 * (from the PBX) and — when a GRE logs a callback dialled from their own phone
 * — that GRE's app login email. Attribution handles both (the email resolves to
 * the user's name), but an email can never be *mapped* to a TeleCMI id, so it
 * has no business sitting in this editor as a phantom "unmapped" row.
 *
 * The server now filters those out of agents_seen (src/lib/ct/agents.ts
 * isAppLoginAgent — same pragmatic `local@domain.tld` shape, kept in step here
 * so this page behaves identically against an older server that still sends
 * them, and so a legacy email key already in the SAVED map can be labelled for
 * what it is instead of being badged "unmapped").
 */
function isAppLoginId(v: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim());
}

/** One agent as TeleCMI knows it: the raw id plus the NAME on the PBX. */
interface TelecmiAgentLite { id: string; name: string }

/**
 * Rows out of /api/telecmi/agents (GET) or a scan's `found` list.
 *
 * Returns null when the payload carries no list at all — "we were not given a
 * roster" and "the roster is empty" are different facts and the callers below
 * must be able to tell them apart. `agents[]` holds row objects and the older
 * `agent_ids[]` bare strings; both are accepted, ids are de-duplicated in
 * canonical form, and a missing name is simply '' (an id TeleCMI does not name
 * keeps today's presentation rather than inventing one).
 */
function parseRosterAgents(j: any): TelecmiAgentLite[] | null {
  const raw = Array.isArray(j?.agents) ? j.agents
    : Array.isArray(j?.agent_ids) ? j.agent_ids
    : null;
  if (!raw) return null;
  const out: TelecmiAgentLite[] = [];
  const used = new Set<string>();
  for (const v of raw as unknown[]) {
    const obj = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    const id = String((obj ? obj.agent_id : v) ?? '').trim();
    if (!id) continue;
    const key = canonAgentId(id);
    if (used.has(key)) continue;
    used.add(key);
    out.push({ id, name: obj ? String(obj.name ?? '').trim() : '' });
  }
  return out;
}

/** Comparable form of a person's name: trimmed, lowercased, inner runs of
 *  whitespace collapsed. Used ONLY to suggest a match, never to store one. */
function normPersonName(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function firstNameWord(v: unknown): string {
  return normPersonName(v).split(' ')[0] || '';
}

/**
 * A CONFIDENT staff match for a TeleCMI agent name, or null.
 *
 * The rule, deliberately conservative — this only ever fills a dropdown that
 * the admin still has to Save, but a wrong guess that looks authoritative is
 * worse than no guess at all:
 *   1. exact full-name match wins, and only when EXACTLY ONE staff member has
 *      that name (two "Ravi"s is an ambiguity, not a suggestion);
 *   2. otherwise a both-ways startsWith on the FIRST word ("Bharath" vs
 *      "Bharath D"), again only when it singles out one staff member;
 *   3. anything shorter than 3 characters on either side is not evidence.
 * Everything else returns null and the row renders exactly as it does today.
 */
function suggestStaffForName(
  telecmiName: string,
  staff: Array<{ email: string; name: string }>,
): { email: string; name: string } | null {
  const n = normPersonName(telecmiName);
  if (n.length < 3 || !staff.length) return null;

  const exact = staff.filter(s => normPersonName(s.name) === n);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // ambiguous — say nothing

  const f = firstNameWord(telecmiName);
  if (f.length < 3) return null;
  const near = staff.filter(s => {
    const sf = firstNameWord(s.name);
    if (sf.length < 3) return false;
    return sf === f || sf.startsWith(f) || f.startsWith(sf);
  });
  return near.length === 1 ? near[0] : null;
}

/** Per-agent usage from the API's additive `agents_detail`. Absent on an older
 *  server → no stats, and the editor simply renders no stale chip. */
interface AgentDetail { calls: number; lastSeenMs: number | null }

/** Parse a stored ct_calls timestamp. These are ISO strings today; tolerate the
 *  bare-SQLite 'YYYY-MM-DD HH:MM:SS' form (read as UTC) rather than treating an
 *  unparseable value as "ancient" and mislabelling a live extension. */
function parseAgentTs(v: string): number | null {
  const s = String(v || '').trim();
  if (!s) return null;
  let d = new Date(s);
  if (isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) d = new Date(`${s.replace(' ', 'T')}Z`);
  return isNaN(d.getTime()) ? null : d.getTime();
}

/** agents_detail → { idLower: { calls, lastSeenMs } }. Tolerates a missing /
 *  malformed block (older server) by returning {}. */
function parseAgentDetails(v: unknown): Record<string, AgentDetail> {
  const out: Record<string, AgentDetail> = {};
  if (!Array.isArray(v)) return out;
  for (const raw of v as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const it = raw as Record<string, unknown>;
    const id = String(it.id ?? '').trim();
    if (!id) continue;
    const n = Number(it.calls);
    out[id.toLowerCase()] = {
      calls: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0,
      lastSeenMs: parseAgentTs(String(it.last_seen ?? '')),
    };
  }
  return out;
}

/** An id with no call in this many days is history (a removed extension), not a
 *  mapping gap the admin still has to close. */
const AGENT_STALE_DAYS = 90;

/** One editor row per agent id: the union of (agents seen on calls) and
 *  (existing map keys), seen ones first & in the order the API returned them.
 *  A seen id that is an app login email is skipped — it is not mappable — but a
 *  legacy email key already SAVED in the map is still listed, so the admin can
 *  see it and remove it. */
function buildAgentRows(mapObj: Record<string, string>, seen: string[]): Array<{ id: string; email: string }> {
  const rows: Array<{ id: string; email: string }> = [];
  const used = new Set<string>();
  for (const a of seen) {
    const key = String(a || '').trim();
    if (!key || used.has(key.toLowerCase())) continue;
    const mapped = mapObj[key] ?? mapObj[key.toLowerCase()] ?? '';
    if (isAppLoginId(key) && !mapped) continue; // login email, never mappable
    used.add(key.toLowerCase());
    rows.push({ id: key, email: mapped });
  }
  for (const [k, v] of Object.entries(mapObj)) {
    const key = String(k).trim();
    if (!key || used.has(key.toLowerCase())) continue;
    used.add(key.toLowerCase());
    rows.push({ id: key, email: v });
  }
  return rows;
}

/** Write-only credential status. The server sends a boolean, where the value
 *  came from, and the last 4 characters — never the value. */
interface CredField { set: boolean; source: 'env' | 'db' | 'none'; masked: string }
interface CredStatus { configured: boolean; appid: CredField; secret: CredField }

const EMPTY_CREDS: CredStatus = {
  configured: false,
  appid:  { set: false, source: 'none', masked: '' },
  secret: { set: false, source: 'none', masked: '' },
};

/**
 * App ID + Secret entry.
 *
 * SEPARATE FROM THE MAIN FORM ON PURPOSE. Every other field on this page is
 * round-tripped: loaded into `saved`, compared against `form`, and only the
 * difference is sent. A write-only credential can never be loaded, so it would
 * read as permanently dirty and keep the sticky Save bar up forever. It also
 * must not be swept into a bulk save of unrelated settings — a credential write
 * is its own deliberate act, with its own confirmation.
 *
 * The input is emptied immediately after a successful save so the typed secret
 * does not linger in the DOM, and so the field's resting state always shows the
 * masked stored value rather than something that looks editable but is stale.
 */
function CredentialFields({ status, onSaved }: { status: CredStatus; onSaved: (s: CredStatus) => void }) {
  const [appid, setAppid] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const inputCls = 'w-full mt-0.5 px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]';
  const labelCls = 'text-[10px] uppercase tracking-wide text-[#6B5744]';

  const badge = (f: CredField) => {
    if (f.source === 'env') {
      return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-800">from environment · {f.masked}</span>;
    }
    if (f.source === 'db') {
      return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-800">saved · {f.masked}</span>;
    }
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-50 border border-gray-200 text-gray-500">not set</span>;
  };

  const save = async () => {
    const a = appid.trim();
    const s = secret.trim();
    if (!a && !s) { setErr('Enter an App ID or a Secret to save.'); return; }
    // Digits-only mirrors the server rule. Caught here too so the owner is told
    // before a round trip, not after.
    if (a && !/^\d+$/.test(a)) { setErr('App ID must be digits only — it is the number under the App ID label, not the UUID.'); return; }
    setBusy(true); setErr(null); setOk(null);
    try {
      const body: Record<string, string> = {};
      if (a) body.telecmi_appid = a;
      if (s) body.telecmi_secret = s;
      const r = await api('/api/crm-calls/settings', { method: 'PUT', body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
      // Clear the boxes so a secret does not sit in the DOM after saving.
      setAppid(''); setSecret('');
      const fresh: CredStatus = j?.telecmi_credentials || EMPTY_CREDS;
      onSaved(fresh);
      setOk(fresh.configured
        ? '✓ Saved — TeleCMI is connected. No restart needed.'
        : '✓ Saved. Still missing the other value before calls can be placed.');
    } catch (e: any) {
      setErr(e?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] p-3 space-y-3 max-w-xl">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className={labelCls}>App ID</label>
          {badge(status.appid)}
        </div>
        <input
          value={appid}
          onChange={e => { setAppid(e.target.value); setErr(null); setOk(null); }}
          inputMode="numeric"
          autoComplete="off"
          placeholder={status.appid.set ? 'Enter a new App ID to replace it' : 'e.g. 33338614'}
          className={inputCls}
        />
      </div>

      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className={labelCls}>App Secret</label>
          {badge(status.secret)}
        </div>
        <input
          value={secret}
          onChange={e => { setSecret(e.target.value); setErr(null); setOk(null); }}
          type="password"
          autoComplete="new-password"
          placeholder={status.secret.set ? 'Enter a new Secret to replace it' : 'the UUID from APP SECRET'}
          className={inputCls}
        />
      </div>

      {status.appid.source === 'env' || status.secret.source === 'env' ? (
        <p className="text-[10px] text-blue-800 bg-blue-50 border border-blue-200 rounded px-2 py-1.5">
          A value marked <em>from environment</em> is fixed on the server and wins over anything
          saved here. Remove the variable and restart if you want to manage it from this screen.
        </p>
      ) : null}

      {err && <p className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">{err}</p>}
      {ok && <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5">{ok}</p>}

      <button
        onClick={save}
        disabled={busy || (!appid.trim() && !secret.trim())}
        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#af4408] text-white hover:bg-[#8f3606] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? 'Saving…' : 'Save credentials'}
      </button>
      <p className="text-[10px] text-[#6B5744]">
        Leave a box blank to keep the value already stored. Saving only replaces what you type.
      </p>
    </div>
  );
}

export default function CtSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [saved, setSaved] = useState<Record<string, string>>({ ...DEFAULTS });
  const [form, setForm] = useState<Record<string, string>>({ ...DEFAULTS });
  const [configured, setConfigured] = useState(false);
  const [creds, setCreds] = useState<CredStatus>(EMPTY_CREDS);
  const [paths, setPaths] = useState<{ live: string; cdr: string }>({ live: '', cdr: '' });

  /** Mint a new webhook token and swap the displayed URLs to the new ones.
   *  The response carries them, so there is no refetch and no window in which
   *  the screen shows a URL that no longer works. */
  const rotateToken = async () => {
    setRotating(true); setRotateErr('');
    try {
      const r = await api('/api/crm-calls/settings/rotate-webhook', {
        method: 'POST', body: { confirm: true },
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        // The 409 for a deployment pinned to TELECMI_WEBHOOK_SECRET lands here,
        // and its message is the actionable one — show it verbatim.
        setRotateErr(String(j?.error || `Rotate failed (HTTP ${r.status})`));
        return;
      }
      setPaths(extractWebhookPaths(j));
      setRotatedAt(new Date().toISOString());
      setRotateArmed(false);
    } catch (e: any) {
      setRotateErr(e?.message || 'Rotate failed');
    } finally {
      setRotating(false);
    }
  };
  const [origin, setOrigin] = useState('');

  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'live' | 'cdr' | null>(null);
  // Rotate is two-step: `rotateArmed` is the confirm, and the server ALSO
  // requires { confirm: true } — belt and braces, because the cost of an
  // accidental rotate is a silently dropped evening of calls.
  const [rotateArmed, setRotateArmed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateErr, setRotateErr] = useState('');
  const [rotatedAt, setRotatedAt] = useState('');
  const [apkCopyState, setApkCopyState] = useState<'idle' | 'ok' | 'err'>('idle');

  // Data tools
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<{ counts: [string, number][]; note: string } | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillDays, setBackfillDays] = useState('7');
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

  // AI call scoring — on-demand batch analyze
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeResult, setAnalyzeResult] = useState<string | null>(null);

  // Agent mapping — TeleCMI raw agent id → staff member (own save, not the
  // sticky-bar; agent_map is a JSON blob, not a flat EDITABLE_KEY).
  const [staff, setStaff] = useState<Array<{ email: string; name: string }>>([]);
  const [agentsSeen, setAgentsSeen] = useState<string[]>([]);
  const [agentDetails, setAgentDetails] = useState<Record<string, AgentDetail>>({});
  const [agentRows, setAgentRows] = useState<Array<{ id: string; email: string }>>([]);
  const [savedAgentMap, setSavedAgentMap] = useState<Record<string, string>>({});
  // The admin's dismiss list (ct_settings 'agent_hidden').
  //
  // WHY IT EXISTS. Rows here have two different origins: ids TYPED into this
  // editor (they live only in agent_map, so removing one is a real delete) and
  // ids DERIVED from real calls (agents_seen). A derived id cannot be deleted —
  // it is on ct_calls rows, so the next GET derives it again — which is exactly
  // what read as "delete did not save". Hiding is the only thing that takes one
  // off this list, and it is presentation only: the calls, their agent_user
  // values and resolveAgentLabel() are untouched.
  // Draft + saved are kept apart because Save must arm when ONLY the hidden set
  // changed; watching agent_map alone was the direct cause of the bug.
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [savedHidden, setSavedHidden] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  // Ids proven DERIVED this session, even once they leave the dismiss list.
  // Only a derived id can be hidden, so an id that has been on that list must
  // never fall back to being treated as a typed row — after an un-hide is saved
  // it is gone from agent_hidden but not yet back in agents_seen (that needs a
  // reload), and a trash button there would promise a delete that cannot stick.
  const [everHidden, setEverHidden] = useState<string[]>([]);
  const [savingAgents, setSavingAgents] = useState(false);
  const [agentFlash, setAgentFlash] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  /**
   * The CURRENT TeleCMI roster — the ids that exist on the PBX right now.
   *
   * WHY THIS PAGE NEEDS IT. The Telephony screen lists the roster; this editor
   * lists ids seen on real ct_calls rows. Those are different things and neither
   * screen said so, which is exactly the owner's question: recreate the venue's
   * extensions and the old ones (5002..5006) live on in call history forever
   * while the new ones (5008..5012) are on TeleCMI and nowhere in that history.
   * Knowing the roster is what lets this list separate "current agent" from
   * "id that only exists in old calls".
   *
   * null = WE DO NOT KNOW — not loaded yet, not permitted, or the roster could
   * not be read. Grouping is then skipped and the flat list renders exactly as
   * before; a guessed grouping would file a live agent under "From past calls",
   * which is worse than no grouping at all.
   */
  const [rosterIds, setRosterIds] = useState<string[] | null>(null);

  /**
   * TeleCMI's own NAME for an agent id, canonical id → name.
   *
   * WHY. A raw id says nothing about who it is: mapping "5008_33338614" means
   * remembering that 5008 is Bharath D. This is a DISPLAY HINT ONLY — it is
   * never stored, never sent back, and an id TeleCMI does not name simply
   * renders as it does today. Filled from the roster GET below and topped up by
   * a scan; merged, never replaced, so one failed refresh cannot blank names
   * that were already on screen.
   */
  const [telecmiNames, setTelecmiNames] = useState<Record<string, string>>({});
  /**
   * Whether asking TeleCMI for agents is possible at all.
   *   'unknown'     — not answered yet: render nothing, promise nothing.
   *   'ready'       — the roster GET worked; the fetch controls are shown.
   *   'unavailable' — not configured / not permitted / could not be read. The
   *                   editor stays EXACTLY as it is today plus a one-line note;
   *                   no button is offered that would only 403 or 400.
   */
  const [agentSource, setAgentSource] = useState<{ status: 'unknown' | 'ready' | 'unavailable'; note: string }>(
    { status: 'unknown', note: '' },
  );
  // "Get agents from TeleCMI" / "Scan TeleCMI for more". Nothing here runs on
  // load, on a timer, or as a side effect of anything else: every request to
  // TeleCMI below is one deliberate press.
  const [pullingAgents, setPullingAgents] = useState(false);
  const [scanningAgents, setScanningAgents] = useState(false);
  const [pulledOnce, setPulledOnce] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  /** Agents a scan found that are on TeleCMI but not on this list — the admin
   *  picks which to add. null = no scan has run in this session. */
  const [scanFound, setScanFound] = useState<TelecmiAgentLite[] | null>(null);
  const [addingAgentId, setAddingAgentId] = useState<string | null>(null);
  const [addingAllAgents, setAddingAllAgents] = useState(false);
  /**
   * Ids we know are KEYS in the stored agent_map right now — including the ones
   * stored with no staff member ("in the roster, not yet assigned").
   *
   * Needed because "Save mapping" PUTs the map as a whole and the settings route
   * keeps only entries that have BOTH an id and a value, so an unassigned id
   * silently drops out of the roster on the next save. That is pre-existing
   * behaviour; this set is what lets the card SAY so before the press instead of
   * letting the owner discover it afterwards.
   */
  const [knownMapIds, setKnownMapIds] = useState<string[]>([]);

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin);
  }, []);

  // Roster lookup, deliberately SEPARATE from the settings load below: it talks
  // to TeleCMI, so it is slower and far likelier to fail, and a failure here
  // must cost nothing but the grouping.
  useEffect(() => {
    let cancelled = false;
    setRosterIds(null);
    setAgentSource({ status: 'unknown', note: '' });
    // Both this effect and the settings load below merge into knownMapIds; the
    // reset lives here, in the effect body, so it always lands before either
    // fetch resolves rather than racing one of them.
    setKnownMapIds([]);
    setScanFound(null);
    setPulledOnce(false);
    setFetchNote(null);
    setFetchError(null);
    setScanNote(null);
    api('/api/telecmi/agents')
      .then(async r => {
        if (cancelled) return;
        // 401/403 (not admin) or any other non-OK answer → roster UNKNOWN.
        if (!r.ok) {
          // A control that can only 403 must not be offered at all. Same for a
          // provider that is simply not answering: the editor below is fully
          // usable without it, so this costs a note, never a banner.
          setAgentSource({
            status: 'unavailable',
            note: r.status === 401 || r.status === 403
              ? 'Fetching agents from TeleCMI is not available for this login.'
              : `TeleCMI could not be reached (HTTP ${r.status}), so agents cannot be fetched right now. The list below is unaffected.`,
          });
          return;
        }
        const j = await r.json().catch(() => null);
        if (cancelled || !j) {
          setAgentSource({ status: 'unavailable', note: 'TeleCMI did not return a readable answer, so agents cannot be fetched right now. The list below is unaffected.' });
          return;
        }
        if (j.configured === false) {
          setAgentSource({ status: 'unavailable', note: 'TeleCMI is not configured, so there are no agents to fetch. The list below is unaffected.' });
          return;
        }
        // `error` means the roster could not be read (mock mode, unparseable
        // agent_map, every lookup failed). agents:[] alongside it is a failure,
        // not the fact that this venue has no agents — never group on it.
        if (j.error) {
          setAgentSource({ status: 'unavailable', note: `Agents could not be read from TeleCMI: ${String(j.error)}` });
          return;
        }
        const rows = parseRosterAgents(j);
        if (!rows) {
          setAgentSource({ status: 'unavailable', note: 'TeleCMI returned no agent list, so agents cannot be fetched right now. The list below is unaffected.' });
          return;
        }
        setAgentSource({ status: 'ready', note: '' });
        // Names are a display hint and are recorded even when every id here is
        // already listed — that is precisely the case this feature exists for.
        const named: Record<string, string> = {};
        for (const a of rows) if (a.name) named[canonAgentId(a.id)] = a.name;
        if (Object.keys(named).length) setTelecmiNames(prev => ({ ...prev, ...named }));
        // The roster IS the agent_map key set (that route has no other source),
        // so these ids are known to be stored — including the unassigned ones.
        setKnownMapIds(prev => {
          const set = new Set(prev);
          for (const a of rows) { const k = canonAgentId(a.id); if (k) set.add(k); }
          return Array.from(set);
        });
        const ids = rows.map(a => a.id);
        // AN EMPTY ROSTER IS NOT A ROSTER. TeleCMI has no list-users endpoint, so
        // that route builds the roster out of agent_map — an empty one means
        // "nobody has been added here yet", NOT "TeleCMI has no agents". Grouping
        // on it would file every id on this page under "From past calls" and
        // declare live extensions dead. Stay unknown; render the flat list.
        if (!ids.length) return;
        setRosterIds(ids);
      })
      .catch(() => {
        // unknown roster → flat list, never a broken page
        if (!cancelled) {
          setAgentSource({ status: 'unavailable', note: 'TeleCMI could not be reached, so agents cannot be fetched right now. The list below is unaffected.' });
        }
      });
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(null);
    fetch('/api/crm-calls/settings')
      .then(async r => {
        if (cancelled) return;
        if (r.status === 401 || r.status === 403) { setLocked(true); return; }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { setLoadError(j?.error || `HTTP ${r.status}`); return; }
        const src = (j?.settings && typeof j.settings === 'object') ? j.settings : j;
        const next: Record<string, string> = {};
        for (const k of EDITABLE_KEYS) {
          const v = src?.[k];
          next[k] = v === undefined || v === null ? (DEFAULTS[k] ?? '') : String(v);
        }
        setSaved(next);
        setForm(next);
        setConfigured(Boolean(j?.configured ?? j?.telecmi_configured ?? src?.configured));
        // Write-only status: boolean + source + masked tail, never the value.
        // Falls back to EMPTY_CREDS so an older server that does not send the
        // block yet renders "not set" rather than crashing on undefined.
        setCreds((j?.telecmi_credentials as CredStatus) || EMPTY_CREDS);
        setPaths(extractWebhookPaths(j));

        // Agent mapping: staff picker + rows for every agent seen / mapped.
        const staffList = Array.isArray(j?.staff)
          ? (j.staff as any[])
              .map(s => ({ email: String(s?.email || '').trim(), name: String(s?.name || s?.email || '').trim() }))
              .filter(s => s.email)
          : [];
        // agents_seen = TeleCMI ids seen on calls (the server keeps app-login
        // emails out); agents_detail is additive usage for the same ids and is
        // simply absent on an older server.
        const seen = Array.isArray(j?.agents_seen)
          ? (j.agents_seen as any[]).map(a => String(a || '').trim()).filter(Boolean)
          : [];
        const mapObj = parseAgentMap(src?.agent_map);
        setStaff(staffList);
        setAgentsSeen(seen);
        setAgentDetails(parseAgentDetails(j?.agents_detail));
        setSavedAgentMap(mapObj);
        // Every key stored in agent_map, assigned or not — see knownMapIds.
        setKnownMapIds(prev => {
          const set = new Set(prev);
          for (const k of Object.keys(mapObj)) { const c = canonAgentId(k); if (c) set.add(c); }
          return Array.from(set);
        });
        setAgentRows(buildAgentRows(mapObj, seen));
        // The dismiss list. agents_seen above is ALREADY filtered by it
        // server-side, so a hidden id simply does not arrive as a row — the
        // hidden block below is rendered from this list, not from the rows.
        const hidden = parseHiddenIds(j?.agent_hidden ?? src?.agent_hidden);
        setHiddenIds(hidden);
        setSavedHidden(hidden);
        setEverHidden(hidden);
        setShowHidden(false);
      })
      .catch(e => { if (!cancelled) setLoadError(e?.message || 'Failed to load settings'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // Editing any field retires the previous save's verdict. Without this the red
  // banner from a rejected PUT (e.g. "telecmi_base_url must be an http(s) URL")
  // outlives the mistake: the owner clears the offending field, the form matches
  // `saved` again, `dirty` goes false, the sticky Save bar unmounts — and there
  // is then no save left to run that could clear the error. The result is a
  // permanent red banner complaining about a visibly empty box. The green flash
  // is stale for the same reason: it describes the last save, not this edit.
  const set = (key: string, value: string) => {
    setError(null);
    setFlash(null);
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const changedKeys = useMemo(
    () => EDITABLE_KEYS.filter(k => (form[k] ?? '') !== (saved[k] ?? '')),
    [form, saved],
  );
  const dirty = changedKeys.length > 0;

  const saveChanges = async () => {
    if (!dirty || saving) return;
    setSaving(true); setError(null); setFlash(null);
    try {
      // Normalize numeric fields before sending; PUT carries ONLY changed keys.
      const body: Record<string, string> = {};
      for (const k of changedKeys) {
        let v = (form[k] ?? '').trim();
        if (k === 'sla_minutes') v = String(Math.max(1, Math.round(Number(v) || 30)));
        if (k === 'attribution_hours') v = String(Math.max(1, Math.round(Number(v) || 48)));
        if (k === 'auto_assign' && v !== 'round_robin') v = 'off';
        if (k === 'after_hours_whatsapp') v = v === '1' ? '1' : '0';
        if (k === 'missed_call_whatsapp') v = v === '1' ? '1' : '0';
        if (k === 'auto_analyze') v = v === '1' ? '1' : '0';
        if (k === 'analysis_retention') v = v === 'ephemeral' ? 'ephemeral' : 'permanent';
        if (k === 'sticky_agent' || k === 'vip_routing') v = v === '1' ? '1' : '0';
        if (k === 'vip_min_visits') v = String(Math.max(0, Math.round(Number(v) || 0)));
        if (k === 'vip_min_spend') v = String(Math.max(0, Math.round(Number(v) || 0)));
        body[k] = v;
      }
      const r = await api('/api/crm-calls/settings', { method: 'PUT', body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j?.error || `HTTP ${r.status}`); return; }
      setSaved(prev => ({ ...prev, ...body }));
      setForm(prev => ({ ...prev, ...body }));
      setFlash(`✓ Saved ${Object.keys(body).length} setting${Object.keys(body).length === 1 ? '' : 's'}`);
    } catch (e: any) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const fullUrl = (path: string) => {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    return `${origin}${path}`;
  };

  const copy = async (which: 'live' | 'cdr', text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can be unavailable on http:// LAN — textarea fallback.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* best effort */ }
      document.body.removeChild(ta);
    }
    setCopied(which);
    setTimeout(() => setCopied(prev => (prev === which ? null : prev)), 2000);
  };

  // APK share link — local, in-place feedback (the top-of-page flash is far
  // above this button). Only report success when a copy actually happened;
  // http:// LAN often lacks the Clipboard API, so fall back to execCommand.
  const copyApkLink = async () => {
    const link = `${origin}/downloads/AKAN-Captain.apk`;
    let ok = false;
    try {
      await navigator.clipboard.writeText(link);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { /* best effort */ }
      document.body.removeChild(ta);
    }
    setApkCopyState(ok ? 'ok' : 'err');
    setTimeout(() => setApkCopyState('idle'), 2000);
  };

  const loadDemoData = async (force: boolean) => {
    if (seeding) return;
    const msg = force
      ? 'FORCE re-seed demo data? This re-runs the seed even though it already ran once.'
      : 'Load demo data? This inserts ~25 fake guests, ~120 calls, ~40 bookings and recovery rows for testing. Continue?';
    if (!window.confirm(msg)) return;
    setSeeding(true); setError(null); setSeedResult(null);
    try {
      const r = await api('/api/crm-calls/seed', { method: 'POST', body: force ? { force: true } : {} });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j?.error || `Seed failed (HTTP ${r.status})`); return; }
      const counts = Object.entries(j)
        .filter((e): e is [string, number] => typeof e[1] === 'number')
        .map(([k, v]) => [k.replace(/_/g, ' '), v] as [string, number]);
      const skipped = Boolean(j?.skipped ?? j?.already_seeded ?? (j?.seeded === false));
      setSeedResult({
        counts,
        note: skipped
          ? 'Seed already ran before — nothing inserted (use Force re-seed to run again).'
          : 'Demo data loaded.',
      });
    } catch (e: any) {
      setError(e?.message || 'Seed failed');
    } finally {
      setSeeding(false);
    }
  };

  const runBackfill = async () => {
    if (backfilling) return;
    setBackfilling(true); setError(null); setBackfillResult(null);
    try {
      const days = Math.min(90, Math.max(1, Math.round(Number(backfillDays) || 7)));
      const r = await api('/api/telecmi/backfill', { method: 'POST', body: { days } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j?.error || `Backfill failed (HTTP ${r.status})`); return; }
      if (j?.mocked) {
        setBackfillResult('TeleCMI credentials are not configured — mocked run, nothing pulled. Set TELECMI_APPID / TELECMI_SECRET on the server to enable real backfills.');
      } else {
        const parts = [
          `Ingested ${j?.ingested ?? 0} CDR${(j?.ingested ?? 0) === 1 ? '' : 's'}`,
          `${j?.created ?? 0} new`,
          j?.pages ? `${j.pages} page${j.pages === 1 ? '' : 's'}` : '',
          `last ${j?.days ?? days} day${(j?.days ?? days) === 1 ? '' : 's'}`,
        ].filter(Boolean);
        setBackfillResult(parts.join(' · ') + (j?.error ? ` — stopped early: ${j.error}` : ''));
      }
    } catch (e: any) {
      setError(e?.message || 'Backfill failed');
    } finally {
      setBackfilling(false);
    }
  };

  const analyzeRecent = async () => {
    if (analyzing) return;
    setAnalyzing(true); setError(null); setAnalyzeResult(null);
    // Each call is a sequential LLM request, so keep the batch small (matches
    // the route default) to stay well under gateway/proxy timeouts.
    const softNote = 'Started — some may still be processing; refresh the Call Log in a minute.';
    try {
      const r = await api('/api/crm-calls/calls/analyze-batch', { method: 'POST', body: { limit: 5 } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // A gateway/proxy timeout (502/504/408/524) doesn't mean nothing ran —
        // some calls may have been scored before the connection dropped. Show a
        // soft note instead of a hard error; keep hard errors for real failures
        // (e.g. 403 not-management, 400 bad request).
        if ([408, 502, 503, 504, 524].includes(r.status)) setAnalyzeResult(softNote);
        else setError(j?.error || `Analyze failed (HTTP ${r.status})`);
        return;
      }
      const analyzed = Number(j?.analyzed ?? 0);
      const failed = Number(j?.failed ?? 0);
      const rateLimited = Boolean(j?.rate_limited);
      if (analyzed === 0 && failed === 0 && !rateLimited) {
        setAnalyzeResult('No un-scored recordings found — everything is already analyzed.');
      } else {
        const parts = [
          `Scored ${analyzed} call${analyzed === 1 ? '' : 's'}`,
          failed ? `${failed} failed` : '',
          rateLimited ? 'rate-limited — some calls deferred, run again shortly' : '',
        ].filter(Boolean);
        setAnalyzeResult(parts.join(' · '));
      }
    } catch {
      // Network drop / client-side timeout — the request may still be running
      // server-side, so don't scare the admin with a hard error.
      setAnalyzeResult(softNote);
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Agent mapping helpers ─────────────────────────────────────────────────
  // Lowercased set of ids that actually appeared on calls — used to flag rows
  // that are seen-on-calls but still unmapped.
  const seenSet = useMemo(
    () => new Set(agentsSeen.map(a => a.trim().toLowerCase())),
    [agentsSeen],
  );
  // "Stale" = seen on calls, but the last one is older than AGENT_STALE_DAYS →
  // a removed extension living on in history, not a gap to fill. Returns null
  // when the server sent no usage (older build) so nothing extra is rendered.
  const staleInfo = useMemo(() => {
    const cutoff = Date.now() - AGENT_STALE_DAYS * 86_400_000;
    return (id: string): { lastSeenMs: number; calls: number } | null => {
      const d = agentDetails[id.trim().toLowerCase()];
      if (!d || d.lastSeenMs === null) return null;
      return d.lastSeenMs < cutoff ? { lastSeenMs: d.lastSeenMs, calls: d.calls } : null;
    };
  }, [agentDetails]);
  const lastSeenLabel = (ms: number) =>
    new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  // The map we would PUT: only rows with both an id and a staff email.
  const agentMapDraft = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of agentRows) {
      // Keys are stored lowercased server-side (canonical) — lowercase here too
      // so the dirty-check matches the saved map and a case-collision can't
      // spawn a spurious "unsaved" row or silently drop an existing mapping.
      const key = r.id.trim().toLowerCase();
      const email = r.email.trim();
      if (key && email) out[key] = email;
    }
    return out;
  }, [agentRows]);
  /**
   * The saved map as it can be COMPARED to the draft: canonical keys, and only
   * the entries that actually carry a staff member.
   *
   * WHY THE FILTER. parseAgentMap deliberately keeps an unassigned id (`id` →
   * ''), because that is how an agent added on the Telephony page — or by "Get
   * agents from TeleCMI" below — sits in the roster. The draft, by design, only
   * ever contains assigned rows. Comparing the two raw therefore reported
   * "unsaved changes" the moment the page loaded with any unassigned agent in
   * the map, arming a Save the admin never asked for. Comparing like with like
   * keeps Save armed by real edits only.
   */
  const savedAssignedMap = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(savedAgentMap)) {
      const key = canonAgentId(k);
      const val = String(v ?? '').trim();
      if (key && val) out[key] = val;
    }
    return out;
  }, [savedAgentMap]);
  const agentDirty = useMemo(() => {
    const a = agentMapDraft, b = savedAssignedMap;
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return true;
    return ak.some(k => a[k] !== b[k]);
  }, [agentMapDraft, savedAssignedMap]);
  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  /** A row is DERIVED when its id came from real calls — either it is in
   *  agents_seen, or it is on the dismiss list (the server filters hidden ids
   *  OUT of agents_seen, and only a derived id can ever get onto that list).
   *  Everything else is MANUAL: it exists only in the saved map. */
  const derivedSet = useMemo(
    () => new Set<string>([...seenSet, ...hiddenIds, ...savedHidden, ...everHidden]),
    [seenSet, hiddenIds, savedHidden, everHidden],
  );
  // Hiding/un-hiding must arm Save on its own. Without this the whole point is
  // lost: the trash on an unmapped derived row changed nothing savable, the
  // dirty-check stayed false, and the id came back on the next load.
  const hiddenDirty = useMemo(() => {
    const a = [...hiddenIds].sort(), b = [...savedHidden].sort();
    return a.length !== b.length || a.some((v, i) => v !== b[i]);
  }, [hiddenIds, savedHidden]);
  const agentsChanged = agentDirty || hiddenDirty;
  /** Rows on screen. A hidden id drops out — but ONLY while it is unmapped, so
   *  a mapping can never disappear silently behind the dismiss list. */
  const visibleAgentRows = useMemo(
    () => agentRows
      .map((row, idx) => ({ row, idx }))
      .filter(({ row }) => !(hiddenSet.has(canonAgentId(row.id)) && !row.email.trim())),
    [agentRows, hiddenSet],
  );
  // Honest count: only TeleCMI ids that appeared on a call and still have no
  // staff member. An app-login email can never be mapped, so it is never a gap —
  // and neither is an id the admin has just hidden, so the chip counts what is
  // actually on screen rather than something the owner can no longer see.
  const unmappedSeenCount = useMemo(
    () => visibleAgentRows.filter(
      ({ row }) => !row.email.trim() && !isAppLoginId(row.id) && seenSet.has(row.id.trim().toLowerCase()),
    ).length,
    [visibleAgentRows, seenSet],
  );

  /** Roster ids in canonical form, or null when the roster is unknown. An app
   *  login email can never be a TeleCMI agent, so a legacy one sitting in
   *  agent_map is not allowed to count as roster membership. */
  const rosterSet = useMemo(() => {
    if (rosterIds === null) return null;
    const ids = rosterIds.map(canonAgentId).filter(id => id && !isAppLoginId(id));
    // Same rule as the fetch: nothing left to compare against is UNKNOWN, never
    // "no agent on this page is current".
    return ids.length ? new Set(ids) : null;
  }, [rosterIds]);

  /**
   * The two labelled groups. null = roster unknown → render the flat list.
   *
   *   past    — DERIVED from real calls and NOT on TeleCMI now. Precisely the
   *             recreated-extension case the owner is asking about.
   *   current — everything else: ids that really are on the roster, plus a row
   *             just typed here (unsaved, so it cannot be in the roster yet —
   *             and calling something the admin is adding "from past calls"
   *             would simply be false).
   */
  const agentGroups = useMemo(() => {
    if (!rosterSet) return null;
    const current: Array<{ row: { id: string; email: string }; idx: number }> = [];
    const past: Array<{ row: { id: string; email: string }; idx: number }> = [];
    for (const entry of visibleAgentRows) {
      const id = canonAgentId(entry.row.id);
      const isPast = !rosterSet.has(id) && derivedSet.has(id) && !isAppLoginId(entry.row.id);
      (isPast ? past : current).push(entry);
    }
    return { current, past };
  }, [rosterSet, visibleAgentRows, derivedSet]);

  /** Roster ids with no row on this list at all — the concrete half of the
   *  answer to "how can Telephony and Agent mapping show different ids". */
  const rosterOnlyIds = useMemo(() => {
    if (!rosterSet) return [] as string[];
    const onList = new Set(agentRows.map(r => canonAgentId(r.id)));
    return [...rosterSet].filter(id => !onList.has(id));
  }, [rosterSet, agentRows]);

  const setAgentRow = (idx: number, patch: Partial<{ id: string; email: string }>) =>
    setAgentRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const addAgentRow = () => setAgentRows(prev => [...prev, { id: '', email: '' }]);
  const removeAgentRow = (idx: number) => setAgentRows(prev => prev.filter((_, i) => i !== idx));

  /** DERIVED row that has a name: drop the NAME only. The id stays on screen
   *  because it stays on real calls; Save removes it from agent_map. Removal is
   *  then available on the next render — that two-step is the truth, not a
   *  hoop: a mapping must never vanish behind a removal. */
  const clearAgentName = (idx: number) => {
    setAgentFlash(null); setAgentError(null);
    setAgentRow(idx, { email: '' });
  };
  /** DERIVED row with no name: take it off this list. Presentation only. */
  const hideAgentRow = (id: string) => {
    const key = canonAgentId(id);
    if (!key) return;
    setAgentFlash(null); setAgentError(null);
    setHiddenIds(prev => (prev.includes(key) ? prev : [...prev, key]));
    setEverHidden(prev => (prev.includes(key) ? prev : [...prev, key]));
  };
  /**
   * THE REMOVAL THE OWNER WAS LOOKING FOR.
   *
   * Same mechanism as before (the agent_hidden dismiss list — a derived id is on
   * real ct_calls rows and the next load derives it again, so there is nothing
   * else a removal could mean here). What changed is that it now READS as a
   * removal: a trash control, and a confirm that states exactly what survives it.
   */
  const removeDerivedRow = (id: string) => {
    const key = canonAgentId(id);
    if (!key) return;
    const ok = window.confirm(
      `Remove ${id} from this list — the id stays in call history and past calls are unchanged.\n\n`
      + 'It is listed under "hidden" below and can be brought back at any time. '
      + 'Press "Save mapping" afterwards to keep it off the list.',
    );
    if (!ok) return;
    hideAgentRow(id);
  };
  /** Put a hidden id back on the list. It may have no row left (the server
   *  filters hidden ids out of agents_seen), so re-create one rather than let
   *  "Unhide" appear to do nothing until the next reload. */
  const unhideAgentId = (id: string) => {
    const key = canonAgentId(id);
    if (!key) return;
    setAgentFlash(null); setAgentError(null);
    setHiddenIds(prev => prev.filter(h => h !== key));
    setAgentRows(prev => (
      prev.some(r => canonAgentId(r.id) === key) ? prev : [...prev, { id: key, email: '' }]
    ));
  };

  const saveAgentMap = async () => {
    if (savingAgents) return;
    setSavingAgents(true); setAgentError(null); setAgentFlash(null);
    try {
      const agent_map = agentMapDraft; // already omits blank / unmapped rows
      // The dismiss list rides along on every save — the two are one editor
      // state, and the PUT ignores an unknown non-secret key, so an older
      // server just stores the map exactly as it does today.
      const agent_hidden = hiddenIds;
      const r = await api('/api/crm-calls/settings', { method: 'PUT', body: { agent_map, agent_hidden } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setAgentError(j?.error || `HTTP ${r.status}`); return; }
      setSavedAgentMap(agent_map);
      // The PUT stores a canonical REPLACEMENT that keeps only assigned entries,
      // so after this the stored map holds exactly these keys — anything that
      // was in the roster unassigned is no longer there. Say that in state too,
      // or the "will drop out of the roster" note would keep naming ids that
      // already have.
      setKnownMapIds(Object.keys(agent_map).map(canonAgentId).filter(Boolean));
      // Prefer the server's echo (canonical + de-duped) so the screen shows what
      // was actually stored — including a normalization we did not predict.
      // Only an older server that echoes nothing falls back to the draft.
      const storedHidden = j?.agent_hidden === undefined ? agent_hidden : parseHiddenIds(j.agent_hidden);
      setHiddenIds(storedHidden);
      setSavedHidden(storedHidden);
      const n = Object.keys(agent_map).length;
      const h = storedHidden.length;
      setAgentFlash(
        `✓ Saved — ${n} agent${n === 1 ? '' : 's'} mapped to staff`
        + (h ? ` · ${h} id${h === 1 ? '' : 's'} hidden from this list` : ''),
      );
    } catch (e: any) {
      setAgentError(e?.message || 'Save failed');
    } finally {
      setSavingAgents(false);
    }
  };

  /* ── Get agents FROM TeleCMI ──────────────────────────────────────────────
   *
   * The owner's problem, in his words: an agent who has never taken a call is
   * not listed at all, so there is nothing to map until they do — and even when
   * listed, a raw id ("5008_33338614") does not say who it is.
   *
   * Two steps, both explicit, cheapest first:
   *   1. "Get agents from TeleCMI" — a GET of /api/telecmi/agents. That is the
   *      ROSTER, i.e. the ids already stored in agent_map, enriched with the
   *      TeleCMI name. It costs no discovery traffic, so it is the first press,
   *      and every id it returns that has no row here gets one immediately.
   *   2. "Scan TeleCMI for more" — POST { action:'scan' }. TeleCMI has NO
   *      list-users endpoint, so this PROBES a bounded extension range, one
   *      request per candidate. Read-only: it writes nothing. Whatever it finds
   *      that is not in the roster is listed, and only the ones the admin picks
   *      are added, via POST { action:'map', id }.
   *
   * Nothing here runs by itself. Adding rows locally is not a write — a roster
   * id is ALREADY a key in agent_map — so no press below silently changes the
   * stored mapping except 'map', which is the admin choosing a named agent.
   */

  /** Record TeleCMI's names for later rows. Merge only: a name already on
   *  screen must not be blanked because one later answer omitted it. */
  const mergeTelecmiNames = (rows: TelecmiAgentLite[]) => {
    const named: Record<string, string> = {};
    for (const a of rows) {
      const key = canonAgentId(a.id);
      if (key && a.name) named[key] = a.name;
    }
    if (Object.keys(named).length) setTelecmiNames(prev => ({ ...prev, ...named }));
  };

  /** Give these ids a row if they have none. Returns what it actually did, so
   *  the report can be honest rather than optimistic. */
  const addRosterRows = (rows: TelecmiAgentLite[]): { added: number; skippedHidden: number } => {
    const have = new Set(agentRows.map(r => canonAgentId(r.id)));
    const hiddenNow = new Set(hiddenIds);
    const fresh: Array<{ id: string; email: string }> = [];
    let skippedHidden = 0;
    for (const a of rows) {
      const key = canonAgentId(a.id);
      if (!key || have.has(key)) continue;
      // An app login is not a TeleCMI agent and can never be mapped to one.
      if (isAppLoginId(key)) continue;
      // The admin dismissed this id explicitly. Bringing it back silently would
      // undo that decision on their behalf — report it instead; "Show hidden"
      // below is one click and un-hides it deliberately.
      if (hiddenNow.has(key)) { skippedHidden++; continue; }
      have.add(key);
      // Canonical (lowercased) id — the same form the server stores, so this row
      // can never save as a second copy of an id already in the map.
      fresh.push({ id: key, email: '' });
    }
    if (fresh.length) setAgentRows(prev => [...prev, ...fresh]);
    return { added: fresh.length, skippedHidden };
  };

  const getAgentsFromTelecmi = async () => {
    if (pullingAgents || scanningAgents || addingAllAgents || addingAgentId) return;
    setPullingAgents(true);
    setFetchError(null); setFetchNote(null); setScanNote(null);
    try {
      // House convention: bare fetch for GETs, api() for mutations.
      const r = await fetch('/api/telecmi/agents');
      if (!r.ok) {
        setFetchError(r.status === 401 || r.status === 403
          ? 'Not permitted to read TeleCMI agents. Nothing was changed.'
          : `TeleCMI agents could not be read (HTTP ${r.status}). Nothing was changed.`);
        return;
      }
      const j = await r.json().catch(() => null);
      if (!j) { setFetchError('TeleCMI did not return a readable answer. Nothing was changed.'); return; }
      if (j.configured === false) {
        setFetchError(String(j.error || 'TeleCMI is not configured, so there are no agents to fetch.'));
        return;
      }
      const rows = parseRosterAgents(j);
      if (!rows) {
        setFetchError(String(j.error || 'TeleCMI returned no agent list. Nothing was changed.'));
        return;
      }
      mergeTelecmiNames(rows);
      setKnownMapIds(prev => {
        const set = new Set(prev);
        for (const a of rows) { const k = canonAgentId(a.id); if (k) set.add(k); }
        return Array.from(set);
      });
      const { added, skippedHidden } = addRosterRows(rows);
      setPulledOnce(true);
      const named = rows.filter(a => a.name).length;
      const parts = [
        added > 0
          ? `Added ${added} agent${added === 1 ? '' : 's'} from the roster`
          : (rows.length === 0
            ? 'The TeleCMI roster is empty — nothing to add'
            : `Added nothing new — all ${rows.length} roster agent${rows.length === 1 ? '' : 's'} already listed`),
        named ? `${named} named by TeleCMI` : '',
        skippedHidden ? `${skippedHidden} left hidden (use “Show hidden” to bring one back)` : '',
      ].filter(Boolean);
      // A partial failure upstream (some ids could not be enriched) must not
      // read as a clean result.
      setFetchNote(parts.join(' · ') + (j.error ? ` — ${String(j.error)}` : ''));
    } catch (e: any) {
      setFetchError(e?.message || 'TeleCMI could not be reached. Nothing was changed.');
    } finally {
      setPullingAgents(false);
    }
  };

  const scanTelecmiForMore = async () => {
    if (pullingAgents || scanningAgents || addingAllAgents || addingAgentId) return;
    setScanningAgents(true);
    setFetchError(null); setScanNote(null);
    try {
      // No range is sent: the route derives one from the extensions it already
      // knows about, so "the usual extensions" has ONE definition, not two that
      // can drift apart. The advanced range picker lives on the Telephony page.
      const r = await api('/api/telecmi/agents', { method: 'POST', body: { action: 'scan' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setFetchError(String(j?.error || `The scan failed (HTTP ${r.status}). Nothing was changed.`));
        return;
      }
      if (j?.configured === false) {
        setFetchError(String(j?.error || 'TeleCMI is not configured, so there is nothing to scan.'));
        return;
      }
      const found = parseRosterAgents({ agents: Array.isArray(j?.found) ? j.found : [] }) ?? [];
      mergeTelecmiNames(found);

      const have = new Set(agentRows.map(r2 => canonAgentId(r2.id)));
      const hiddenNow = new Set(hiddenIds);
      // Offer only what this list does not already carry, and never an id the
      // admin has dismissed — adding that one would write to the roster and
      // still show nothing, because a hidden unassigned row is filtered out.
      const more = found.filter(a => {
        const k = canonAgentId(a.id);
        return k && !have.has(k) && !hiddenNow.has(k) && !isAppLoginId(k);
      });
      setScanFound(more);

      const scanned = Number.isFinite(Number(j?.scanned)) ? Number(j.scanned) : null;
      const from = j?.range?.from, to = j?.range?.to;
      const unreachable = Array.isArray(j?.unreachable) ? j.unreachable.length : 0;
      const parts = [
        `Scan found ${more.length} more agent${more.length === 1 ? '' : 's'}`,
        scanned != null ? `${scanned} extension${scanned === 1 ? '' : 's'} asked${from != null && to != null ? ` (${from}–${to})` : ''}` : '',
        // A truncated scan is a FLOOR, never a roster: "nothing found" after an
        // early stop is not evidence that there is nothing there.
        j?.timed_out ? `stopped early at ${j?.last_ext ?? 'an unstated point'} — there may be more beyond it` : '',
        unreachable ? `${unreachable} did not answer` : '',
      ].filter(Boolean);
      setScanNote(parts.join(' · '));
      if (j?.error) setFetchError(String(j.error));
    } catch (e: any) {
      setFetchError(e?.message || 'The scan could not be run. Nothing was changed.');
    } finally {
      setScanningAgents(false);
    }
  };

  /**
   * Put ONE discovered agent into the roster.
   *
   * Deliberately NOT through the CRM-settings PUT: that route stores a canonical
   * replacement of agent_map and keeps only entries that have a staff member, so
   * a freshly discovered agent (no staff member yet) would be dropped on the way
   * in and every other unassigned id deleted on the way past. The agents route
   * merges one id into the stored map instead. Returns an error string, or null.
   */
  const addDiscoveredAgent = async (id: string): Promise<string | null> => {
    const key = canonAgentId(id);
    if (!key) return 'That agent id is empty.';
    try {
      const r = await api('/api/telecmi/agents', { method: 'POST', body: { action: 'map', id: key } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        return String(j?.error || `${id} could not be added to the roster (HTTP ${r.status}).`);
      }
      setAgentRows(prev => (prev.some(x => canonAgentId(x.id) === key) ? prev : [...prev, { id: key, email: '' }]));
      setKnownMapIds(prev => (prev.includes(key) ? prev : [...prev, key]));
      setScanFound(prev => (prev ? prev.filter(a => canonAgentId(a.id) !== key) : prev));
      return null;
    } catch (e: any) {
      return e?.message || `${id} could not be added to the roster.`;
    }
  };

  const addOneDiscovered = async (id: string) => {
    if (addingAgentId || addingAllAgents || pullingAgents || scanningAgents) return;
    setAddingAgentId(id); setFetchError(null);
    const err = await addDiscoveredAgent(id);
    if (err) setFetchError(err);
    else setFetchNote(`✓ ${id} added to the roster — pick a staff member below, then press “Save mapping”.`);
    setAddingAgentId(null);
  };

  /** Sequential, and it STOPS at the first failure: these are writes to one
   *  settings row, and racing them would have the merges overwrite each other. */
  const addAllDiscovered = async () => {
    if (addingAgentId || addingAllAgents || pullingAgents || scanningAgents) return;
    const list = scanFound ?? [];
    if (!list.length) return;
    setAddingAllAgents(true); setFetchError(null);
    let ok = 0;
    for (const a of list) {
      const err = await addDiscoveredAgent(a.id);
      if (err) {
        setFetchError(`${err} ${ok} of ${list.length} were added before this.`);
        break;
      }
      ok++;
    }
    if (ok) setFetchNote(`✓ ${ok} agent${ok === 1 ? '' : 's'} added to the roster — pick staff members below, then press “Save mapping”.`);
    setAddingAllAgents(false);
  };

  // ── Locked (non-admin) ────────────────────────────────────────────────────
  if (locked) {
    return (
      <div className="p-4 sm:p-6 max-w-2xl mx-auto">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <div className="w-12 h-12 mx-auto rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center mb-3">
            <Lock className="w-5 h-5 text-amber-600" />
          </div>
          <h1 className="text-lg font-bold text-[#2D1B0E]">Admin only</h1>
          <p className="text-sm text-[#8B7355] mt-1">
            CRM settings (TeleCMI connection, webhooks, SLA rules) are restricted to admins.
            Ask an admin if something here needs changing.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading settings…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-4 sm:p-6 max-w-2xl mx-auto">
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {loadError}
          <button onClick={() => setRefreshKey(k => k + 1)}
                  className="ml-auto px-2.5 py-1 bg-white border border-red-200 rounded text-xs flex items-center gap-1 hover:bg-red-100">
            <RefreshCw className="w-3 h-3" /> Retry
          </button>
        </div>
      </div>
    );
  }

  const inputCls = 'w-full mt-0.5 px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]';
  const labelCls = 'text-[10px] uppercase tracking-wide text-[#6B5744]';
  const whatsappOn = form.after_hours_whatsapp === '1';
  const missedAckOn = form.missed_call_whatsapp === '1';
  const stickyOn = form.sticky_agent === '1';
  const vipOn = form.vip_routing === '1';
  const autoAnalyzeOn = form.auto_analyze === '1';
  const ephemeral = form.analysis_retention === 'ephemeral';

  // ── Agent-mapping renderers ───────────────────────────────────────────────
  // Pulled out so the two grouped sections and the ungrouped fallback render
  // identical rows. The grouping is presentation only — every control, every
  // badge and every save path is the same in all three places.

  /** Right-hand controls share one shape so no row's actions read as a mystery
   *  icon; only the colour and the words differ. */
  const rowActionCls = 'px-2 py-1.5 rounded shrink-0 flex items-center gap-1.5 text-[11px] font-medium border border-[#E8D5C4] bg-white';

  const agentColumnHeader = (
    <div className="hidden sm:flex items-center gap-2 px-0.5">
      <span className={`${labelCls} flex-1 min-w-[8rem]`}>TeleCMI agent id</span>
      <span className="w-4 shrink-0" />
      <span className={`${labelCls} flex-1 min-w-[10rem]`}>Staff member</span>
      <span className="w-[6.5rem] shrink-0" />
    </div>
  );

  const renderAgentRow = ({ row, idx }: { row: { id: string; email: string }; idx: number }) => {
    // A legacy app-login email still sitting in the SAVED map: keep the row
    // visible so it can be removed, but say what it is rather than badging it
    // as a mapping gap.
    const isLoginId = isAppLoginId(row.id);
    const isUnmappedSeen = !row.email.trim() && !isLoginId
      && seenSet.has(row.id.trim().toLowerCase());
    // Which removal this row can actually honour. MANUAL rows live only in
    // agent_map, so deleting one is a real delete. A DERIVED id is on real
    // calls: the name can go, and the id can come off THIS LIST — nothing can
    // take it out of history, which is what the wording below has to admit.
    const isDerived = derivedSet.has(canonAgentId(row.id));
    const hasName = Boolean(row.email.trim());
    const stale = isLoginId ? null : staleInfo(row.id);
    const emailKnown = row.email
      && staff.some(s => s.email.toLowerCase() === row.email.toLowerCase());
    // WHO THIS ID IS. TeleCMI's own name for the agent, when we have been told
    // it. Display only — nothing about the stored map changes — and an id
    // TeleCMI does not know simply renders exactly as it did before.
    const telecmiName = isLoginId ? '' : (telecmiNames[canonAgentId(row.id)] || '');
    // Confirm-only suggestion: never applied on its own, and never shown at all
    // without a confident, unambiguous match.
    const suggestion = !row.email.trim() && telecmiName
      ? suggestStaffForName(telecmiName, staff)
      : null;
    return (
      <div key={idx} className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
        <div className="flex-1 min-w-[8rem] w-full sm:w-auto">
          <input value={row.id} onChange={e => setAgentRow(idx, { id: e.target.value })}
                 placeholder="e.g. 101 or gre.ravi" aria-label="TeleCMI agent id"
                 className={`${inputCls} ${isUnmappedSeen ? 'border-amber-300' : ''}`} />
          {telecmiName && (
            <div className="text-[10px] text-[#6B5744] mt-0.5 truncate"
                 title={`TeleCMI calls ${row.id} “${telecmiName}”`}>
              · {telecmiName} <span className="text-[#C9A98A]">on TeleCMI</span>
            </div>
          )}
        </div>
        <span className="text-[#C9A98A] shrink-0 text-sm hidden sm:inline">→</span>
        <div className="flex-1 min-w-[10rem] w-full sm:w-auto">
          <select value={row.email} onChange={e => setAgentRow(idx, { email: e.target.value })}
                  aria-label="Staff member"
                  className={`${inputCls} ${isUnmappedSeen ? 'border-amber-300 bg-amber-50/50' : ''}`}>
            <option value="">— Unmapped —</option>
            {staff.map(s => (
              <option key={s.email} value={s.email}>{s.name} · {s.email}</option>
            ))}
            {/* a previously-mapped email that isn't in the active staff list — keep it selectable */}
            {row.email && !emailKnown && (
              <option value={row.email}>{row.email} (inactive)</option>
            )}
          </select>
        </div>
        {suggestion && (
          /* One click FILLS the dropdown — it saves nothing. Getting it wrong
             costs one click back to "— Unmapped —", and the admin still has to
             press "Save mapping" for anything to be stored. */
          <button type="button"
                  onClick={() => { setAgentFlash(null); setAgentError(null); setAgentRow(idx, { email: suggestion.email }); }}
                  title={`TeleCMI calls this agent “${telecmiName}”. This only fills the box — press “Save mapping” to store it.`}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-[#E8D5C4] bg-[#FFF1E3] text-[#af4408] hover:bg-[#FFE4CC] shrink-0 flex items-center gap-1">
            <Sparkles className="w-3 h-3" /> Map to {suggestion.name}?
          </button>
        )}
        {isUnmappedSeen && (
          <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 shrink-0">
            unmapped
          </span>
        )}
        {isLoginId && (
          <span className="text-[10px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1.5 py-0.5 shrink-0">
            logged from the app, not TeleCMI
          </span>
        )}
        {stale && (
          <span title={`Last call ${lastSeenLabel(stale.lastSeenMs)} · ${stale.calls} call${stale.calls === 1 ? '' : 's'} on record`}
                className="text-[10px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1.5 py-0.5 shrink-0">
            no calls in {AGENT_STALE_DAYS} days — likely a removed extension
          </span>
        )}
        {!isDerived ? (
          <button type="button" onClick={() => removeAgentRow(idx)}
                  title="Remove this row — you typed this id, so nothing else refers to it"
                  aria-label="Remove this row"
                  className={`${rowActionCls} text-[#8B7355] hover:text-red-600 hover:border-red-200 hover:bg-red-50`}>
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Remove</span>
          </button>
        ) : hasName ? (
          <button type="button" onClick={() => clearAgentName(idx)}
                  title="Clear the mapped name. The id itself stays — it is on real calls — and can be removed from this list once it has no name."
                  aria-label="Clear the mapped name"
                  className={`${rowActionCls} text-[#8B7355] hover:text-[#af4408] hover:bg-[#FFF1E3]`}>
            <Eraser className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Clear name</span>
          </button>
        ) : (
          <button type="button" onClick={() => removeDerivedRow(row.id)}
                  title="Remove from this list — the id stays in call history and past calls are unchanged"
                  aria-label="Remove from this list"
                  className={`${rowActionCls} text-[#8B7355] hover:text-red-600 hover:border-red-200 hover:bg-red-50`}>
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Remove</span>
          </button>
        )}
      </div>
    );
  };

  const renderAgentRows = (entries: Array<{ row: { id: string; email: string }; idx: number }>) => (
    <div className="space-y-2">
      {agentColumnHeader}
      {entries.map(entry => renderAgentRow(entry))}
    </div>
  );

  const groupHeading = (title: string, note: string) => (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[#2D1B0E]">{title}</h3>
      <span className="text-[10px] text-[#6B5744] normal-case">{note}</span>
    </div>
  );

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-4 pb-24">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <SettingsIcon className="w-6 h-6 text-[#af4408]" /> CRM Settings
        </h1>
        <p className="text-xs text-[#6B5744] mt-0.5">
          TeleCMI connection, webhook URLs, missed-call SLA rules and assignment for the
          Call-to-Table module. Admin only — changes apply immediately.
        </p>
      </div>

      {flash && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-3 text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" /> {flash}
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* ── 1 · TeleCMI connection ── */}
      <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex flex-wrap items-center gap-2">
          <PlugZap className="w-4 h-4 text-[#af4408]" />
          <h2 className="text-sm font-semibold text-[#2D1B0E]">TeleCMI connection</h2>
          <span className={`ml-auto px-2 py-0.5 rounded-full text-[10px] font-medium border flex items-center gap-1 ${
            configured
              ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
              : 'bg-gray-50 border-gray-200 text-gray-500'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${configured ? 'bg-emerald-500' : 'bg-gray-400'}`} />
            {configured
              ? `Configured${creds.secret.source === 'env' || creds.appid.source === 'env' ? ' (env)' : ''}`
              : 'Not configured'}
          </span>
        </div>
        <div className="p-3 sm:p-4 space-y-3">
          <p className="text-xs text-[#6B5744]">
            Enter the <strong>App ID</strong> and <strong>Secret</strong> from the TeleCMI dashboard
            (click your business number → <strong>DEVELOPER</strong> tab → <strong>APP SECRET</strong>).
            They are stored <strong>write-only</strong>: saved values are never sent back to this
            screen and never appear in any API response — you will only ever see the last four
            characters. A saved value takes effect on the next request, with no restart.
          </p>
          <p className="text-[10px] text-[#6B5744]">
            The environment variables{' '}
            <code className="text-[10px] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1">TELECMI_APPID</code> and{' '}
            <code className="text-[10px] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1">TELECMI_SECRET</code>{' '}
            still work and <strong>take priority</strong>. If one is set on the server, the field
            below is marked <em>from environment</em> and anything saved here is ignored until the
            variable is removed — otherwise a typed value would appear to save and change nothing.
          </p>

          <CredentialFields
            status={creds}
            onSaved={s => { setCreds(s); setConfigured(s.configured); }}
          />

          {/* "Not configured" is a dead end without this: the values live three
              clicks deep in a tab most admins never open, and the only place they
              can be entered is a server file this screen deliberately cannot
              write. Shown only while unconfigured — once the badge is green it is
              noise. Never render the values themselves. */}
          {!configured && (
            <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] p-2.5 space-y-2">
              <p className="text-[11px] font-semibold text-[#2D1B0E]">How to configure</p>
              <ol className="text-[11px] text-[#6B5744] list-decimal ml-4 space-y-1.5">
                <li>
                  In the TeleCMI dashboard, click your <strong>business number</strong> → the{' '}
                  <strong>DEVELOPER</strong> tab → <strong>APP SECRET</strong>. That panel holds both values.
                </li>
                <li>
                  Add them to the env file on the <strong>server</strong> (e.g.{' '}
                  <code className="bg-white border border-[#E8D5C4] rounded px-1">.env.local</code> beside the app) —
                  there is deliberately no input for them here, so nothing typed on this screen can set them:
                  <pre className="mt-1 bg-white border border-[#E8D5C4] rounded px-2 py-1.5 font-mono text-[10px] text-[#2D1B0E] leading-relaxed overflow-x-auto">
{`TELECMI_APPID=<your app id>
TELECMI_SECRET=<APP SECRET from the DEVELOPER tab>
TELECMI_WEBHOOK_SECRET=<optional>`}
                  </pre>
                  <span className="block mt-1">
                    <code className="bg-white border border-[#E8D5C4] rounded px-1">TELECMI_WEBHOOK_SECRET</code> is
                    optional and only pins the token inside the webhook URLs below; leave it out and a random one is
                    generated once and kept. It must be <strong>at least 12 characters</strong> — anything shorter is
                    ignored and the generated token stays in use, so the URLs would not change and it would look like
                    the setting did nothing. When it does take effect it <strong>changes those URLs</strong>, so
                    re-paste them into TeleCMI.
                  </span>
                </li>
                <li>
                  <strong>Restart the app.</strong> Env vars are read at boot, so the badge above stays
                  &ldquo;Not configured&rdquo; until it comes back up.
                </li>
                <li>
                  Then map each GRE under <strong>Agent mapping</strong> below — click-to-call rings the mapped
                  TeleCMI agent id first, so an unmapped GRE still cannot dial.
                </li>
              </ol>
              <p className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                Until <strong>both</strong> TELECMI_APPID and TELECMI_SECRET are present, click-to-call and backfill
                run in <strong>mock mode</strong>: they report success but <strong>nothing is dialled and nothing is
                pulled</strong>. Inbound webhooks are unaffected — they never use these credentials.
              </p>
            </div>
          )}

          <div className="max-w-xl">
            <label className={labelCls}>TeleCMI API base URL override (optional)</label>
            <input value={form.telecmi_base_url ?? ''} onChange={e => set('telecmi_base_url', e.target.value)}
                   placeholder="https://rest.telecmi.com/v2 (leave blank for default)"
                   className={inputCls} />
            <p className="text-[10px] text-[#6B5744] mt-1">
              Only needed if your TeleCMI account uses a regional / non-default REST endpoint.
            </p>
          </div>
        </div>
      </section>

      {/* ── 2 · Webhook URLs ── */}
      <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex items-center gap-2">
          <Webhook className="w-4 h-4 text-[#af4408]" />
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Webhook URLs</h2>
        </div>
        <div className="p-3 sm:p-4 space-y-3">
          <p className="text-xs text-[#6B5744]">
            In the TeleCMI dashboard: <strong>SETTINGS → WEBHOOKS → add</strong> (method{' '}
            <strong>POST</strong>) — type <strong>call report</strong> for the CDR URL, type{' '}
            <strong>notify</strong> for the Live URL. Swap those two and neither webhook delivers
            anything we can use, silently.
          </p>
          {/* TeleCMI signs nothing and sends no shared header — the random token
              in the path is the ONLY thing standing between these routes and the
              open internet, which is why they must be handled like passwords. */}
          <p className="text-xs text-[#6B5744]">
            The long token in each path is the shared secret — TeleCMI sends no signature of its own,
            so that token is the entire protection. Treat these URLs like passwords.
          </p>
          {[
            {
              key: 'cdr' as const,
              title: 'CDR webhook',
              hint: 'TeleCMI type: “call report” — fires when a call completes. Source of truth for the call log & missed-call recoveries.',
              path: paths.cdr,
            },
            {
              key: 'live' as const,
              title: 'Live events webhook',
              hint: 'TeleCMI type: “notify” — fires while a call rings/answers. Powers the real-time screen-pop and Live Calls board.',
              path: paths.live,
            },
          ].map(w => (
            <div key={w.key} className="border border-[#E8D5C4] rounded-lg p-2.5 bg-[#FFF8F0]">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="text-xs font-semibold text-[#2D1B0E]">{w.title}</span>
                <span className="text-[10px] text-[#6B5744]">{w.hint}</span>
              </div>
              {w.path ? (
                <div className="flex items-stretch gap-2">
                  <code className="flex-1 min-w-0 text-[11px] text-[#2D1B0E] bg-white border border-[#E8D5C4] rounded px-2 py-1.5 overflow-x-auto whitespace-nowrap">
                    {fullUrl(w.path)}
                  </code>
                  <button onClick={() => copy(w.key, fullUrl(w.path))}
                          className={`px-2.5 rounded text-xs flex items-center gap-1 border shrink-0 ${
                            copied === w.key
                              ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                              : 'bg-[#af4408] hover:bg-[#8a3506] border-[#af4408] text-white'
                          }`}>
                    {copied === w.key ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied === w.key ? 'Copied' : 'Copy'}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-[#6B5744] italic">
                  URL unavailable — the settings API did not return a webhook token.
                </p>
              )}
            </div>
          ))}
          <ol className="text-[11px] text-[#6B5744] list-decimal ml-4 space-y-0.5">
            <li>TeleCMI dashboard → <strong>SETTINGS</strong> → <strong>WEBHOOKS</strong> → add.</li>
            <li>Type <strong>call report</strong>, method <strong>POST</strong> → paste the <strong>CDR</strong> URL.</li>
            <li>Type <strong>notify</strong>, method <strong>POST</strong> → paste the <strong>Live events</strong> URL.</li>
            <li>Save, then test with a real call (or <code>npm run simulate:call</code> in dev).</li>
          </ol>

          {/* ── Rotate ────────────────────────────────────────────────────────
              The token IS the credential — it is the whole of the protection on
              two routes that accept POSTed call data, so a URL that has been
              pasted into a chat, a ticket or an email cannot be un-pasted. This
              is the only thing that revokes it.
              Two-step on purpose. Rotating mid-service silently drops every call
              until TeleCMI is reconfigured: the old URLs are refused the instant
              it returns, and calls in that gap are LOST, not queued. A one-click
              rotate sitting next to a Copy button is a foot-gun. */}
          <div className="border border-amber-200 bg-amber-50 rounded-lg p-2.5 space-y-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
              <div className="text-[11px] text-amber-900">
                <span className="font-semibold">Rotate the token</span> if these URLs have been
                shared anywhere they should not be — a chat, a ticket, an email. Anyone holding one
                can post fabricated calls into the CRM.{' '}
                <span className="font-semibold">TeleCMI stops reaching this app the moment you
                rotate</span>, until you paste both new URLs there. Calls in that gap are lost, not
                queued — so do it outside service hours.
              </div>
            </div>
            {!rotateArmed ? (
              <button onClick={() => { setRotateArmed(true); setRotateErr(''); }}
                      className="text-[11px] px-2.5 py-1.5 rounded border border-amber-400 bg-white text-amber-900 hover:bg-amber-100">
                Rotate webhook token…
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-amber-900 font-semibold">
                  Both TeleCMI URLs will stop working until you update them. Continue?
                </span>
                <button disabled={rotating} onClick={rotateToken}
                        className="text-[11px] px-2.5 py-1.5 rounded bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white">
                  {rotating ? 'Rotating…' : 'Yes, rotate now'}
                </button>
                <button disabled={rotating} onClick={() => setRotateArmed(false)}
                        className="text-[11px] px-2.5 py-1.5 rounded border border-[#E0D0BE] bg-white text-[#6B5744]">
                  Cancel
                </button>
              </div>
            )}
            {rotateErr && <p className="text-[11px] text-red-700">{rotateErr}</p>}
            {rotatedAt && !rotateErr && (
              <p className="text-[11px] text-emerald-800 font-medium">
                Rotated. The URLs above are the new ones — copy BOTH into TeleCMI now. The old ones
                are already refused.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ── 3 · SLA & business hours ── */}
      <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex items-center gap-2">
          <Clock className="w-4 h-4 text-[#af4408]" />
          <h2 className="text-sm font-semibold text-[#2D1B0E]">SLA & business hours</h2>
        </div>
        <div className="p-3 sm:p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className={labelCls}>Missed-call SLA (minutes)</label>
              <input type="number" min={1} max={1440} value={form.sla_minutes ?? ''}
                     onChange={e => set('sla_minutes', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Opens at (IST)</label>
              <input type="time" value={form.business_open ?? ''}
                     onChange={e => set('business_open', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Closes at (IST)</label>
              <input type="time" value={form.business_close ?? ''}
                     onChange={e => set('business_close', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Attribution window (hours)</label>
              <input type="number" min={1} max={336} value={form.attribution_hours ?? ''}
                     onChange={e => set('attribution_hours', e.target.value)} className={inputCls} />
            </div>
          </div>
          <p className="text-[10px] text-[#6B5744] mt-2">
            The callback SLA clock runs inside business hours: a call missed after closing is due
            at <em>next opening + SLA</em>. The attribution window links a booking back to the
            guest&apos;s most recent answered call (default 48h) — that link is the
            &ldquo;call-to-table&rdquo; conversion.
          </p>
        </div>
      </section>

      {/* ── What's On board (GRE) ── */}
      <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex items-center gap-2">
          <MonitorPlay className="w-4 h-4 text-[#af4408]" />
          <h2 className="text-sm font-semibold text-[#2D1B0E]">What&apos;s On board</h2>
        </div>
        <div className="p-3 sm:p-4 space-y-4">
          <p className="text-xs text-[#6B5744]">
            Controls the GRE <strong>What&apos;s On</strong> board (<code className="text-[11px] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1">/crm-calls/whats-on</code>) —
            the at-a-glance view of a day&apos;s entertainment, parties, reservations and specials for
            call handlers. Pick which panels appear, set the day&apos;s talking points, and set the seat
            capacity for the &ldquo;how full is this date&rdquo; gauge.
          </p>

          {/* Panels shown on the board */}
          <div>
            <label className={labelCls}>Panels shown on the board</label>
            {(() => {
              const PANELS: [string, string][] = [
                ['entertainment', 'Entertainment'],
                ['parties', 'Parties'],
                ['reservations', 'Reservations'],
                ['specials', 'Specials / talking points'],
                ['capacity', 'Capacity gauge'],
                ['call_context', 'Live call context'],
              ];
              let panels: Record<string, boolean> = {};
              try {
                const o = JSON.parse(form.whatson_panels || '{}');
                if (o && typeof o === 'object' && !Array.isArray(o)) panels = o;
              } catch { /* keep {} → all default ON */ }
              const isOn = (k: string) => panels[k] !== false;
              const toggle = (k: string, v: boolean) => {
                const next: Record<string, boolean> = {};
                for (const [pk] of PANELS) next[pk] = pk === k ? v : isOn(pk);
                set('whatson_panels', JSON.stringify(next));
              };
              return (
                <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {PANELS.map(([k, lbl]) => (
                    <div key={k} className="flex items-center gap-2 border border-[#E8D5C4] rounded-lg bg-[#FFFDFB] px-3 py-2">
                      <span className="text-xs text-[#2D1B0E] flex-1">{lbl}</span>
                      <Toggle checked={isOn(k)} onChange={(v) => toggle(k, v)} size="sm" label={lbl} />
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Specials / talking points */}
          <div className="border-t border-[#E8D5C4]/60 pt-3">
            <label className={labelCls}>Today&apos;s specials / talking points</label>
            <textarea value={form.whatson_specials ?? ''}
                      onChange={e => set('whatson_specials', e.target.value)}
                      rows={4}
                      placeholder={'e.g.\nChef’s special: Hyderabadi Haleem\nHappy hours 5–7pm on all cocktails\nPush the new rooftop seating'}
                      className={`${inputCls} mt-0.5 resize-y`} />
            <p className="text-[10px] text-[#6B5744] mt-1">
              Free text shown on the board so GREs can mention the day&apos;s highlights on a call. Line
              breaks are preserved. Up to 4000 characters. Saved with the <strong>Save</strong> button below.
            </p>
          </div>

          {/* Specials, workshops & notices manager (saves itself — separate from the form) */}
          <SpecialsManager />

          {/* Daily seat capacity */}
          <div className="border-t border-[#E8D5C4]/60 pt-3 max-w-xs">
            <label className={labelCls}>Daily seat capacity</label>
            <input type="number" min={0} max={100000} value={form.whatson_capacity ?? ''}
                   onChange={e => set('whatson_capacity', e.target.value)} className={inputCls} />
            <p className="text-[10px] text-[#6B5744] mt-1">
              Total covers the outlet can seat in a day. The board&apos;s capacity gauge compares reserved
              covers + party pax against this. Set to <strong>0</strong> to hide the gauge.
            </p>
          </div>

          {/* Party entertainment on the board */}
          <div className="border-t border-[#E8D5C4]/60 pt-3 max-w-md">
            <label className={labelCls}>Party entertainment in the Entertainment panel</label>
            <select
              value={['manual_only', 'dj_only', 'all_notes'].includes(form.whatson_entertainment_mode) ? form.whatson_entertainment_mode : 'dj_only'}
              onChange={e => set('whatson_entertainment_mode', e.target.value)}
              className={inputCls}
            >
              <option value="manual_only">Only events I add manually (parties never appear)</option>
              <option value="dj_only">Only parties with a booked DJ / artist</option>
              <option value="all_notes">Any party with an entertainment / decor / note</option>
            </select>
            <p className="text-[10px] text-[#6B5744] mt-1">
              Controls whether party functions show up as cards in the <strong>Entertainment</strong> panel.
              &ldquo;Only events I add manually&rdquo; keeps it to the Add-event calendar;
              &ldquo;booked DJ/artist&rdquo; also shows parties that have a DJ filled in;
              &ldquo;any note&rdquo; shows every party carrying entertainment/decor text.
              Parties always remain in the <strong>Parties &amp; Events</strong> panel regardless.
            </p>
          </div>
        </div>
      </section>

      {/* ── Quick-send documents (Live Calls "Send" action) ── */}
      <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex items-center gap-2">
          <MessageCircle className="w-4 h-4 text-[#af4408]" />
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Quick-send documents</h2>
        </div>
        <div className="p-3 sm:p-4 space-y-3">
          <p className="text-[11px] text-[#6B5744] leading-relaxed">
            Things a GRE can WhatsApp a caller straight from Live Calls (the <b>Send</b> button).
            Each row can carry a <b>link</b>, a <b>message</b>, or both:
          </p>
          <ul className="text-[11px] text-[#6B5744] list-disc pl-4 space-y-0.5 -mt-1">
            <li><b>Menu</b> → paste your online-menu <b>link</b> in the Link field.</li>
            <li><b>Corporate Menu (PDF)</b> → upload the PDF somewhere public (your website, Google&nbsp;Drive/Dropbox “anyone with the link”) and paste that <b>link</b>.</li>
            <li><b>Band List</b> → type the schedule as plain text in the <b>Message</b> field (a link is optional).</li>
          </ul>
          <p className="text-[10px] text-[#8B7355] -mt-1">A row needs a link <i>or</i> a message to appear in the Send menu. Leave the message blank and it auto-writes “Here’s our {'{label}'}: {'{link}'}”.</p>
          {(() => {
            type Row = { label: string; url: string; message: string };
            let rows: Row[] = [];
            try { const a = JSON.parse(form.quick_send_links || '[]'); if (Array.isArray(a)) rows = a.map((x: any) => ({ label: String(x?.label || ''), url: String(x?.url || ''), message: String(x?.message || '') })); } catch { /* keep [] */ }
            const write = (next: Row[]) => set('quick_send_links', JSON.stringify(next));
            const upd = (i: number, patch: Partial<Row>) => { const n = rows.map((r, j) => j === i ? { ...r, ...patch } : r); write(n); };
            return (
              <div className="space-y-3">
                {rows.map((r, i) => (
                  <div key={i} className="rounded-lg border border-[#E8D5C4] bg-[#FFFDFB] p-3 space-y-2.5">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0 space-y-2.5">
                        <div>
                          <label className={labelCls}>Button label</label>
                          <input value={r.label} placeholder="e.g. Menu"
                                 onChange={e => upd(i, { label: e.target.value })} className={inputCls} />
                        </div>
                        <div>
                          <label className={labelCls}>Link <span className="text-[#B0987F] normal-case">(online menu or public PDF URL — optional)</span></label>
                          <input value={r.url} placeholder="https://…" inputMode="url"
                                 onChange={e => upd(i, { url: e.target.value })} className={inputCls} />
                        </div>
                        <div>
                          <label className={labelCls}>Message <span className="text-[#B0987F] normal-case">(free text, e.g. this week’s bands — optional)</span></label>
                          <textarea value={r.message} placeholder="Leave blank to auto-write &ldquo;Here&rsquo;s our Menu: …&rdquo;" rows={2}
                                    onChange={e => upd(i, { message: e.target.value })} className={`${inputCls} resize-y`} />
                        </div>
                      </div>
                      <button type="button" onClick={() => write(rows.filter((_, j) => j !== i))}
                              className="text-red-600 hover:text-red-700 p-1 shrink-0 mt-4" aria-label={`Remove ${r.label || 'document'}`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
                <button type="button" onClick={() => write([...rows, { label: '', url: '', message: '' }])}
                        className="text-xs text-[#af4408] hover:underline inline-flex items-center gap-1">
                  <Plus className="w-3.5 h-3.5" /> Add document
                </button>
              </div>
            );
          })()}
        </div>
      </section>

      {/* ── 4 · Assignment & escalation ── */}
      <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex items-center gap-2">
          <UserCheck className="w-4 h-4 text-[#af4408]" />
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Assignment & escalation</h2>
        </div>
        <div className="p-3 sm:p-4 space-y-4">
          <div className="max-w-xs">
            <label className={labelCls}>Auto-assign missed-call recoveries</label>
            <select value={form.auto_assign === 'round_robin' ? 'round_robin' : 'off'}
                    onChange={e => set('auto_assign', e.target.value)} className={inputCls}>
              <option value="off">Off — unassigned pool (anyone picks up)</option>
              <option value="round_robin">Round-robin across GRE users</option>
            </select>
          </div>

          {/* Instant acknowledgement — every missed call, any time of day. */}
          <div className="border-t border-[#E8D5C4]/60 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <MessageCircle className="w-3.5 h-3.5 text-[#af4408]" />
              <span className="text-xs font-semibold text-[#2D1B0E]">Instantly WhatsApp a missed caller</span>
              <Toggle checked={missedAckOn}
                      onChange={(v) => set('missed_call_whatsapp', v ? '1' : '0')}
                      size="sm"
                      label="Instantly WhatsApp a missed caller"
                      className="ml-auto" />
            </div>
            <p className="text-[10px] text-[#6B5744] mt-1">
              OFF by default. When ON, an <strong>inbound</strong> call we miss gets this message
              the moment it is detected — once per missed call, ever. If the guest replies, their
              reply opens WhatsApp&rsquo;s free 24-hour service window, so the GRE can then chat in
              plain text at no per-message cost. Outbound calls are never messaged.
            </p>
            <textarea value={form.missed_call_wa_text ?? ''}
                      onChange={e => set('missed_call_wa_text', e.target.value)}
                      rows={2} disabled={!missedAckOn}
                      placeholder="Sorry we missed your call. Reply here and we will help you book."
                      className={`${inputCls} mt-2 resize-y ${missedAckOn ? '' : 'opacity-50'}`} />
            {missedAckOn && (
              <p className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-2">
                <strong>Meta rule:</strong> a phone call does <em>not</em> open the 24-hour window —
                only a WhatsApp message from the guest does. So the first message to a guest who has
                never messaged us must be an <strong>approved template</strong>. Add one under
                Settings → Integrations → WhatsApp → Templates, named exactly{' '}
                <code className="bg-white border border-amber-200 rounded px-1">ct_missed_call_ack</code>,
                with &ldquo;Send as approved template&rdquo; on. Without it this text is sent as
                free-form, which only reaches guests already inside a live 24-hour window.
              </p>
            )}
          </div>

          <div className="border-t border-[#E8D5C4]/60 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <MessageCircle className="w-3.5 h-3.5 text-[#af4408]" />
              <span className="text-xs font-semibold text-[#2D1B0E]">After-hours auto-WhatsApp to missed callers</span>
              <Toggle checked={whatsappOn}
                      onChange={(v) => set('after_hours_whatsapp', v ? '1' : '0')}
                      size="sm"
                      label="After-hours auto-WhatsApp to missed callers"
                      className="ml-auto" />
            </div>
            <p className="text-[10px] text-[#6B5744] mt-1">
              When ON, callers missed <em>outside</em> business hours get this message instead of the
              one above (it can tell them when we open). Placeholders:{' '}
              <code className="bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1">{'{open}'}</code>{' '}
              = opening time,{' '}
              <code className="bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1">{'{link}'}</code>{' '}
              = the first link in Quick-send documents above (the sentence is dropped if none is set).
            </p>
            <textarea value={form.after_hours_template ?? ''}
                      onChange={e => set('after_hours_template', e.target.value)}
                      rows={3} disabled={!whatsappOn}
                      placeholder="Sorry we missed your call! We open at {open}. Book a table: {link}"
                      className={`${inputCls} mt-2 resize-y ${whatsappOn ? '' : 'opacity-50'}`} />
          </div>
        </div>
      </section>

      {/* ── 4b · Call hints: sticky agent + VIP (Live Calls board) ── */}
      <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex items-center gap-2">
          <Crown className="w-4 h-4 text-[#af4408]" />
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Call hints — sticky agent &amp; VIP</h2>
        </div>
        <div className="p-3 sm:p-4 space-y-4">
          <p className="text-xs text-[#6B5744]">
            Extra context on the <strong>Live Calls</strong> board
            (<code className="text-[11px] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1">/crm-calls/live</code>)
            for whoever is about to pick up. <strong>These are hints, not routing</strong> — this app does
            not control the phone system, so it cannot ring a different extension or move a caller up the
            queue. It can only make the right answer obvious to the human. Both are OFF until you turn
            them on here; with both off the board looks exactly as it does today.
          </p>

          {/* Sticky agent */}
          <div className="border-t border-[#E8D5C4]/60 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <UserCheck className="w-3.5 h-3.5 text-[#af4408]" />
              <span className="text-xs font-semibold text-[#2D1B0E]">Sticky agent — &ldquo;last handled by&hellip;&rdquo;</span>
              <Toggle checked={stickyOn}
                      onChange={(v) => set('sticky_agent', v ? '1' : '0')}
                      size="sm"
                      label="Show the GRE who last handled this caller"
                      className="ml-auto" />
            </div>
            <p className="text-[10px] text-[#6B5744] mt-1">
              When a guest who has called before rings again, the ringing card names the GRE who last
              <strong> answered</strong> them, so a regular keeps talking to the person who knows them.
              Only answered <em>incoming</em> calls count — a missed call is not a conversation, and our
              own outbound callbacks are handed out by the round-robin, so they would just echo the
              rotation back. The hint expires after <strong>180 days</strong> (three times the win-back
              window), past which nobody remembers the call and the GRE may have left.
            </p>
          </div>

          {/* VIP */}
          <div className="border-t border-[#E8D5C4]/60 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Crown className="w-3.5 h-3.5 text-[#af4408]" />
              <span className="text-xs font-semibold text-[#2D1B0E]">VIP badge — answer these first</span>
              <Toggle checked={vipOn}
                      onChange={(v) => set('vip_routing', v ? '1' : '0')}
                      size="sm"
                      label="Show a VIP badge for high-value callers"
                      className="ml-auto" />
            </div>
            <p className="text-[10px] text-[#6B5744] mt-1">
              Flags high-value callers on the ringing card <strong>with the numbers behind it</strong>{' '}
              (&ldquo;VIP · 12 visits · Rs 48,000 spend&rdquo;) so the badge is auditable, never a
              mysterious star. Visits and spend come from the guest 360 — the loyalty desk and settled
              dining bills, matched on the last 10 digits of the phone. A caller qualifies on{' '}
              <strong>either</strong> threshold. Set a threshold to <strong>0</strong> to ignore that
              criterion (0 for both = nobody is a VIP).
            </p>
            <div className="grid grid-cols-2 gap-3 mt-2 max-w-sm">
              <div>
                <label className={labelCls}>Min visits</label>
                <input type="number" min={0} max={10000} value={form.vip_min_visits ?? ''}
                       onChange={e => set('vip_min_visits', e.target.value)}
                       disabled={!vipOn}
                       className={`${inputCls} ${vipOn ? '' : 'opacity-50'}`} />
              </div>
              <div>
                <label className={labelCls}>Min spend (Rs)</label>
                <input type="number" min={0} max={100000000} value={form.vip_min_spend ?? ''}
                       onChange={e => set('vip_min_spend', e.target.value)}
                       disabled={!vipOn}
                       className={`${inputCls} ${vipOn ? '' : 'opacity-50'}`} />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 5 · Agent mapping ── */}
      <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex flex-wrap items-center gap-2">
          <Users className="w-4 h-4 text-[#af4408]" />
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Agent mapping</h2>
          {/* Offered ONLY when the roster GET actually worked. Not configured,
              not permitted, or unreachable → no button at all (one that could
              only 403 is worse than none) and a one-line note in the body. */}
          {agentSource.status === 'ready' && (
            <button type="button" onClick={() => void getAgentsFromTelecmi()}
                    disabled={pullingAgents || scanningAgents || addingAllAgents || Boolean(addingAgentId)}
                    title="Ask TeleCMI which agents exist and list any that are missing here. Nothing is saved until you press “Save mapping”."
                    className="ml-auto px-2.5 py-1 rounded text-[11px] font-medium border border-[#E8D5C4] bg-white text-[#af4408] hover:bg-[#FFF1E3] flex items-center gap-1.5 disabled:opacity-50">
              {pullingAgents ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
              {pullingAgents ? 'Asking TeleCMI…' : 'Get agents from TeleCMI'}
            </button>
          )}
          {unmappedSeenCount > 0 && (
            <span className="ml-auto px-2 py-0.5 rounded-full text-[10px] font-medium border bg-amber-50 border-amber-300 text-amber-800">
              {unmappedSeenCount} unmapped
            </span>
          )}
        </div>
        <div className="p-3 sm:p-4 space-y-3">
          <p className="text-xs text-[#6B5744]">
            Map each TeleCMI agent id / extension to a staff member so the{' '}
            <strong>Call Log</strong>, <strong>Guest 360</strong> and the{' '}
            <strong>leaderboard</strong> show their name instead of a raw id — this also feeds
            round-robin recovery assignment. Leave a row on <em>— Unmapped —</em> to keep showing
            its raw id.
          </p>
          <p className="text-xs text-[#6B5744]">
            The ids below come from calls actually seen — an agent who has not taken a call yet is
            not listed by call history, so fetch them with <strong>Get agents from TeleCMI</strong>{' '}
            (top right) or type one in with <strong>Add agent id</strong> to name them in advance.
            Callbacks a GRE logs from their own phone are recorded against their app login, not a
            TeleCMI id; those are attributed by name already and are not shown here.
          </p>
          {/* The one thing that was never said on screen — and the reason the
              trash button looked broken. */}
          <p className="text-xs text-[#6B5744]">
            The ids on this list are the ones <strong>seen on real calls</strong> plus the ones{' '}
            <strong>you typed</strong>. Clearing a name leaves the id here — it is still in call
            history and cannot be deleted from it — and <strong>Remove</strong> takes an id off
            this list only (it is listed under <em>hidden</em> below and can be brought back);
            nothing about the calls themselves changes.
          </p>

          {/* ── Get agents from TeleCMI ──────────────────────────────────────
              Degrading gracefully is the whole point of this block: when the
              provider cannot be asked, the editor above and below is EXACTLY
              what it is today plus this one line. Never a banner over a page
              that works. */}
          {agentSource.status === 'unavailable' && agentSource.note && (
            <p className="text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-2 py-1.5">
              {agentSource.note}
            </p>
          )}

          {agentSource.status === 'ready' && (
            <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] p-2.5 space-y-2">
              <p className="text-[11px] text-[#6B5744]">
                <strong className="text-[#2D1B0E]">Get agents from TeleCMI</strong> (top right) lists the agents
                TeleCMI already knows about — with their names — so an agent who has never taken a call can still
                be mapped. TeleCMI cannot list its own users, so anything beyond that roster has to be found by
                asking about candidate extensions one at a time: that is the scan. Nothing on TeleCMI is changed
                either way. <strong>Add</strong> puts a found id into the roster straight away; the staff member
                you pick for it is stored when you press <strong>Save mapping</strong>.
              </p>

              {(fetchNote || scanNote) && (
                <div className="bg-white border border-[#E8D5C4] rounded px-2 py-1.5 text-[11px] text-[#2D1B0E] space-y-0.5">
                  {fetchNote && <div>{fetchNote}</div>}
                  {scanNote && <div className="text-[#6B5744]">{scanNote}</div>}
                </div>
              )}
              {fetchError && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded px-2 py-1.5 text-[11px] flex items-start gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" /> {fetchError}
                </div>
              )}

              {/* The scan is offered only AFTER the cheap roster pull — it is a
                  request to TeleCMI per candidate extension, so it should never
                  be the first thing anyone presses. */}
              {pulledOnce && (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => void scanTelecmiForMore()}
                          disabled={pullingAgents || scanningAgents || addingAllAgents || Boolean(addingAgentId)}
                          className="px-2.5 py-1 rounded text-[11px] font-medium border border-[#E8D5C4] bg-white text-[#6B5744] hover:bg-[#FFF1E3] flex items-center gap-1.5 disabled:opacity-50">
                    {scanningAgents ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
                    {scanningAgents ? 'Scanning TeleCMI…' : 'Scan TeleCMI for more'}
                  </button>
                  <span className="text-[10px] text-[#6B5744]">
                    finds agents that are on TeleCMI but not in the roster yet — a few seconds, and it changes nothing
                  </span>
                </div>
              )}

              {scanFound !== null && !scanningAgents && (
                scanFound.length === 0 ? (
                  <p className="text-[11px] text-[#6B5744] italic">
                    The scan found no agent that is not already on this list.
                  </p>
                ) : (
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-medium text-[#2D1B0E]">
                        {scanFound.length} on TeleCMI, not on this list
                      </span>
                      <button type="button" onClick={() => void addAllDiscovered()}
                              disabled={addingAllAgents || Boolean(addingAgentId) || pullingAgents || scanningAgents}
                              className="text-[11px] px-2 py-1 rounded border border-[#E8D5C4] bg-white text-[#af4408] hover:bg-[#FFF1E3] flex items-center gap-1 disabled:opacity-50">
                        {addingAllAgents ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        Add all
                      </button>
                    </div>
                    {scanFound.map(a => (
                      <div key={canonAgentId(a.id)} className="flex flex-wrap items-center gap-2">
                        <code className="flex-1 min-w-[8rem] text-[11px] text-[#2D1B0E] bg-white border border-[#E8D5C4] rounded px-2 py-1 overflow-x-auto whitespace-nowrap">
                          {a.id}{a.name ? <span className="text-[#6B5744]"> · {a.name}</span> : null}
                        </code>
                        <button type="button" onClick={() => void addOneDiscovered(a.id)}
                                disabled={addingAllAgents || Boolean(addingAgentId) || pullingAgents || scanningAgents}
                                title="Add this agent to the roster so it can be mapped to a staff member"
                                className="text-[11px] px-2 py-1 rounded border border-[#E8D5C4] bg-white text-[#6B5744] hover:bg-[#FFF1E3] flex items-center gap-1 shrink-0 disabled:opacity-50">
                          {addingAgentId === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                          Add
                        </button>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          )}

          {visibleAgentRows.length === 0 ? (
            <p className="text-xs text-[#6B5744] italic">
              {hiddenIds.length > 0
                ? 'Every agent id is hidden — use “Show hidden” below to bring one back.'
                : 'No TeleCMI agents have appeared on a call yet. Add ids manually below, or run a backfill / take a call first, then refresh.'}
            </p>
          ) : agentGroups ? (
            /* GROUPED. Only rendered when the CURRENT TeleCMI roster is known —
               this is the whole answer to "how can Telephony and Agent mapping
               show the same ids": it names which ids the two screens share and
               which exist only inside old calls. */
            <div className="space-y-4">
              <div className="space-y-2">
                {groupHeading(
                  'Current TeleCMI agents',
                  'on the TeleCMI roster right now — the same ids the Telephony page lists',
                )}
                {agentGroups.current.length > 0 ? renderAgentRows(agentGroups.current) : (
                  <p className="text-[11px] text-[#6B5744] italic">
                    None of the current agents is on this list yet.
                  </p>
                )}
                {rosterOnlyIds.length > 0 && (
                  <p className="text-[10px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-2 py-1.5">
                    On TeleCMI but not on this list yet: <strong>{rosterOnlyIds.join(', ')}</strong> — they have
                    not answered a call through this system, so no call history names them. Use{' '}
                    <strong>Add agent id</strong> below to map one in advance.
                  </p>
                )}
              </div>

              {agentGroups.past.length > 0 && (
                <div className="space-y-2">
                  {groupHeading(
                    'From past calls',
                    `${agentGroups.past.length} id${agentGroups.past.length === 1 ? '' : 's'} not on TeleCMI now`,
                  )}
                  <p className="text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-2 py-1.5">
                    These extensions answered calls in the past but are not agents on TeleCMI now —
                    recreating extensions does this. Map them to keep old calls named, or remove them
                    from this list.
                  </p>
                  {renderAgentRows(agentGroups.past)}
                </div>
              )}
            </div>
          ) : (
            /* Roster unknown (not loaded, not permitted, or TeleCMI could not be
               read) — today's flat list, rather than a guessed grouping that
               could file a live agent under "From past calls". */
            renderAgentRows(visibleAgentRows)
          )}

          {/* Nothing is ever lost silently: whatever was hidden stays one click
              from coming back, and says so even while collapsed. */}
          {hiddenIds.length > 0 && (
            <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] p-2.5 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium text-[#2D1B0E]">{hiddenIds.length} hidden</span>
                <span className="text-[11px] text-[#C9A98A]">·</span>
                <button type="button" onClick={() => setShowHidden(v => !v)}
                        className="text-[11px] px-2 py-1 rounded border border-[#E8D5C4] bg-white text-[#6B5744] hover:bg-[#FFF1E3] flex items-center gap-1">
                  {showHidden
                    ? <><EyeOff className="w-3 h-3" /> Hide again</>
                    : <><Eye className="w-3 h-3" /> Show hidden</>}
                </button>
                <span className="text-[10px] text-[#6B5744]">
                  off this list only — their calls are untouched and still show as before
                </span>
              </div>
              {showHidden && (
                <div className="space-y-1">
                  {hiddenIds.map(id => (
                    <div key={id} className="flex flex-wrap items-center gap-2 opacity-60">
                      <code className="flex-1 min-w-[8rem] text-[11px] text-[#2D1B0E] bg-white border border-[#E8D5C4] rounded px-2 py-1 overflow-x-auto whitespace-nowrap">
                        {id}
                      </code>
                      <button type="button" onClick={() => unhideAgentId(id)}
                              title="Put this id back on the list"
                              className="text-[11px] px-2 py-1 rounded border border-[#E8D5C4] bg-white text-[#6B5744] hover:bg-[#FFF1E3] flex items-center gap-1 shrink-0">
                        <Eye className="w-3 h-3" /> Unhide
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" onClick={addAgentRow}
                    className="px-2.5 py-1.5 border border-[#E8D5C4] rounded text-xs text-[#6B5744] hover:bg-[#FFF8F0] flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Add agent id
            </button>
            <button onClick={saveAgentMap} disabled={!agentsChanged || savingAgents}
                    className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-sm flex items-center gap-1.5 disabled:opacity-50">
              {savingAgents ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save mapping
            </button>
            {agentsChanged && !savingAgents && (
              <span className="text-[10px] text-[#6B5744]">unsaved changes</span>
            )}
          </div>

          {/* A warning used to stand here saying an unassigned id would drop out
              of the roster on save. That was true, and it is not any more: the
              settings PUT now preserves a key whose value is empty (see the
              'agent_map' case in src/app/api/crm-calls/settings/route.ts), which
              is what "in the roster, not yet assigned" is stored as. Saving is
              no longer destructive to a discovered agent, so there is nothing
              left to admit before the press. */}

          {agentFlash && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-2.5 text-xs flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {agentFlash}
            </div>
          )}
          {agentError && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-2.5 text-xs flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {agentError}
            </div>
          )}
        </div>
      </section>

      {/* ── 6 · AI call scoring ── */}
      <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[#af4408]" />
          <h2 className="text-sm font-semibold text-[#2D1B0E]">AI Call Scoring</h2>
        </div>
        <div className="p-3 sm:p-4 space-y-4">
          {/* Scorecard storage */}
          <div>
            <label className={labelCls}>Scorecard storage</label>
            <select value={ephemeral ? 'ephemeral' : 'permanent'}
                    onChange={e => set('analysis_retention', e.target.value)}
                    className={`${inputCls} max-w-md`}>
              <option value="permanent">Keep permanently (Recommended)</option>
              <option value="ephemeral">On-demand only</option>
            </select>
            <p className="text-[10px] text-[#6B5744] mt-1">
              {ephemeral
                ? 'On-demand only — click Enhance to view a scorecard; it is NOT saved (re-runs the AI each time, so auto-scoring is off).'
                : 'Keep permanently — analyzed scorecards are saved and viewable anytime, and auto-scoring is available.'}
            </p>
          </div>

          {/* Auto-analyze toggle */}
          <div className="border-t border-[#E8D5C4]/60 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-xs font-semibold text-[#2D1B0E] ${ephemeral ? 'opacity-50' : ''}`}>Auto-score every recorded call</span>
              <Toggle checked={autoAnalyzeOn}
                      onChange={(v) => set('auto_analyze', v ? '1' : '0')}
                      disabled={ephemeral}
                      size="sm"
                      label="Auto-score every recorded call"
                      className="ml-auto" />
            </div>
            <p className="text-[10px] text-[#6B5744] mt-1">
              Automatically score every recorded call with AI (transcript, /100 score, coaching). Uses
              your existing Gemini/Claude provider — incurs an LLM cost per call. Off = score on demand
              from the Call Log.
            </p>
            {ephemeral && (
              <p className="text-[10px] text-amber-700 mt-1">Turn on permanent storage to enable auto-scoring.</p>
            )}
          </div>

          {/* Analyze recent recordings now */}
          <div className="border-t border-[#E8D5C4]/60 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={analyzeRecent} disabled={analyzing || ephemeral}
                      className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-sm flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed">
                {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Analyze recent recordings now
              </button>
              <span className="text-[10px] text-[#6B5744]">
                Scores up to 5 recent recorded calls that have not been analysed yet. Handy for a
                one-off backfill, or right after turning auto-scoring on — run it again to score more.
              </span>
            </div>
            {analyzeResult && (
              <div className="mt-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-2.5 text-xs text-[#2D1B0E] flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" /> {analyzeResult}
              </div>
            )}
          </div>

          {/* Provider note */}
          <div className="border-t border-[#E8D5C4]/60 pt-3">
            <p className="text-[10px] text-[#6B5744]">
              The AI provider and API keys are configured under the existing{' '}
              <strong>AKAN CRM settings</strong> (<code className="bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1">crm_llm_provider</code>{' '}
              / Gemini keys). When Claude is the provider it uses Gemini to transcribe the recording
              first, then scores the transcript.
            </p>
          </div>
        </div>
      </section>

      {/* ── Mobile app (Android) download ── */}
      <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex items-center gap-2">
          <DownloadCloud className="w-4 h-4 text-[#af4408]" />
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Mobile app (Android)</h2>
        </div>
        <div className="p-3 sm:p-4 space-y-2">
          <p className="text-sm text-[#3D2614]">
            One app for all staff — everyone signs in with their own account and lands on their role&apos;s home
            (captains → POS, GREs → Recovery Queue, managers → dashboard). Exact call-back durations are captured on Android.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <a href="/downloads/AKAN-Captain.apk" download
               className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-sm inline-flex items-center gap-1.5">
              <DownloadCloud className="w-3.5 h-3.5" /> Download APK
            </a>
            <button
              onClick={copyApkLink}
              className={`px-3 py-1.5 border rounded text-sm inline-flex items-center gap-1.5 ${
                apkCopyState === 'ok'
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                  : apkCopyState === 'err'
                  ? 'bg-red-50 border-red-300 text-red-700'
                  : 'border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744]'
              }`}>
              {apkCopyState === 'ok' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {apkCopyState === 'ok' ? 'Copied' : apkCopyState === 'err' ? 'Copy failed — copy manually below' : 'Copy link to share'}
            </button>
          </div>
          <p className="text-[11px] text-[#6B5744] font-mono break-all">{origin}/downloads/AKAN-Captain.apk</p>
          <p className="text-[11px] text-[#6B5744]">
            On the phone: open the link → Download → tap the file → allow &quot;install from this source&quot; → Install.
            Updates the existing app in place; on the first callback, tap Allow for call-log access.
          </p>
        </div>
      </section>

      {/* ── 7 · Data tools ── */}
      <section className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-3 sm:px-4 py-2.5 bg-[#FFF1E3] border-b border-[#E8D5C4] flex items-center gap-2">
          <Database className="w-4 h-4 text-[#af4408]" />
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Data tools</h2>
        </div>
        <div className="p-3 sm:p-4 space-y-4">
          {/* Demo seed */}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => loadDemoData(false)} disabled={seeding}
                      className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-sm flex items-center gap-1.5 disabled:opacity-50">
                {seeding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
                Load demo data
              </button>
              <span className="text-[10px] text-[#6B5744]">
                ~25 guests · ~120 calls · ~40 bookings · recoveries in mixed states. Idempotent —
                safe to click twice.
              </span>
            </div>
            {seedResult && (
              <div className="mt-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-2.5 text-xs text-[#2D1B0E]">
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> {seedResult.note}
                </div>
                {seedResult.counts.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {seedResult.counts.map(([k, v]) => (
                      <span key={k} className="px-2 py-0.5 bg-white border border-[#E8D5C4] rounded-full text-[10px]">
                        <strong>{v}</strong> {k}
                      </span>
                    ))}
                  </div>
                )}
                <button onClick={() => loadDemoData(true)} disabled={seeding}
                        className="mt-1.5 text-[10px] text-[#af4408] hover:underline disabled:opacity-50">
                  Force re-seed
                </button>
              </div>
            )}
          </div>

          {/* Backfill */}
          <div className="border-t border-[#E8D5C4]/60 pt-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-24">
                <label className={labelCls}>Days back</label>
                <input type="number" min={1} max={90} value={backfillDays}
                       onChange={e => setBackfillDays(e.target.value)} className={inputCls} />
              </div>
              <button onClick={runBackfill} disabled={backfilling}
                      className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-sm flex items-center gap-1.5 disabled:opacity-50">
                {backfilling ? <Loader2 className="w-4 h-4 animate-spin" /> : <DownloadCloud className="w-4 h-4" />}
                Run backfill
              </button>
              <span className="text-[10px] text-[#6B5744]">
                Pull historical CDRs from TeleCMI and ingest them (idempotent — never duplicates
                calls; creates recoveries for untracked missed calls). Mocked without env credentials.
              </span>
            </div>
            {backfillResult && (
              <div className="mt-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-2.5 text-xs text-[#2D1B0E] flex items-start gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" /> {backfillResult}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Sticky save bar */}
      {dirty && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-2rem)] max-w-md">
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-lg px-3 py-2.5 flex items-center gap-3">
            <span className="text-xs text-[#6B5744] flex-1">
              {changedKeys.length} unsaved change{changedKeys.length === 1 ? '' : 's'}
            </span>
            {/* Discard is the other way the bar can unmount, so it has to retire
                the last save's banner too — otherwise the rejected value is gone
                but its red complaint stays on screen with no save left to clear it. */}
            <button onClick={() => { setError(null); setFlash(null); setForm({ ...saved }); }} disabled={saving}
                    className="px-2.5 py-1.5 border border-[#E8D5C4] rounded text-xs text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-50">
              Discard
            </button>
            <button onClick={saveChanges} disabled={saving}
                    className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-sm flex items-center gap-1.5 disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
