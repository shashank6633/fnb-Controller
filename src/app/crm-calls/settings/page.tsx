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
 * GET /api/crm-calls/settings  → { settings, webhook urls/token, configured }
 * PUT /api/crm-calls/settings  → changed keys only
 * POST /api/crm-calls/seed     → demo data (confirm first, show counts)
 * POST /api/telecmi/backfill   → historical CDR pull ({ days })
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Settings as SettingsIcon, PlugZap, Webhook, Copy, Check, Clock, UserCheck, AlertTriangle,
  Loader2, AlertCircle, CheckCircle2, Save, Lock, Database, DownloadCloud,
  MessageCircle, RefreshCw, Sparkles, Zap, Users, Plus, Trash2, MonitorPlay, Crown,
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
    const email = String(val ?? '').trim();
    if (key && email) out[key] = email;
  }
  return out;
}

/** One editor row per agent id: the union of (agents seen on calls) and
 *  (existing map keys), seen ones first & in the order the API returned them. */
function buildAgentRows(mapObj: Record<string, string>, seen: string[]): Array<{ id: string; email: string }> {
  const rows: Array<{ id: string; email: string }> = [];
  const used = new Set<string>();
  for (const a of seen) {
    const key = String(a || '').trim();
    if (!key || used.has(key.toLowerCase())) continue;
    used.add(key.toLowerCase());
    rows.push({ id: key, email: mapObj[key] ?? mapObj[key.toLowerCase()] ?? '' });
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
  const [agentRows, setAgentRows] = useState<Array<{ id: string; email: string }>>([]);
  const [savedAgentMap, setSavedAgentMap] = useState<Record<string, string>>({});
  const [savingAgents, setSavingAgents] = useState(false);
  const [agentFlash, setAgentFlash] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin);
  }, []);

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
        const seen = Array.isArray(j?.agents_seen)
          ? (j.agents_seen as any[]).map(a => String(a || '').trim()).filter(Boolean)
          : [];
        const mapObj = parseAgentMap(src?.agent_map);
        setStaff(staffList);
        setAgentsSeen(seen);
        setSavedAgentMap(mapObj);
        setAgentRows(buildAgentRows(mapObj, seen));
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
  const agentDirty = useMemo(() => {
    const a = agentMapDraft, b = savedAgentMap;
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return true;
    return ak.some(k => a[k] !== b[k]);
  }, [agentMapDraft, savedAgentMap]);
  const unmappedSeenCount = useMemo(
    () => agentRows.filter(r => !r.email.trim() && seenSet.has(r.id.trim().toLowerCase())).length,
    [agentRows, seenSet],
  );

  const setAgentRow = (idx: number, patch: Partial<{ id: string; email: string }>) =>
    setAgentRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const addAgentRow = () => setAgentRows(prev => [...prev, { id: '', email: '' }]);
  const removeAgentRow = (idx: number) => setAgentRows(prev => prev.filter((_, i) => i !== idx));

  const saveAgentMap = async () => {
    if (savingAgents) return;
    setSavingAgents(true); setAgentError(null); setAgentFlash(null);
    try {
      const agent_map = agentMapDraft; // already omits blank / unmapped rows
      const r = await api('/api/crm-calls/settings', { method: 'PUT', body: { agent_map } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setAgentError(j?.error || `HTTP ${r.status}`); return; }
      setSavedAgentMap(agent_map);
      const n = Object.keys(agent_map).length;
      setAgentFlash(`✓ Saved — ${n} agent${n === 1 ? '' : 's'} mapped to staff`);
    } catch (e: any) {
      setAgentError(e?.message || 'Save failed');
    } finally {
      setSavingAgents(false);
    }
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
            round-robin recovery assignment. Ids seen on real calls are pre-listed below; unmapped
            ones are flagged. Leave a row on <em>— Unmapped —</em> to keep showing its raw id.
          </p>

          {agentRows.length === 0 ? (
            <p className="text-xs text-[#6B5744] italic">
              No TeleCMI agents have appeared on a call yet. Add ids manually below, or run a
              backfill / take a call first, then refresh.
            </p>
          ) : (
            <div className="space-y-2">
              {/* header row (hidden on narrow screens) */}
              <div className="hidden sm:flex items-center gap-2 px-0.5">
                <span className={`${labelCls} flex-1 min-w-[8rem]`}>TeleCMI agent id</span>
                <span className="w-4 shrink-0" />
                <span className={`${labelCls} flex-1 min-w-[10rem]`}>Staff member</span>
                <span className="w-7 shrink-0" />
              </div>
              {agentRows.map((row, idx) => {
                const isUnmappedSeen = !row.email.trim() && seenSet.has(row.id.trim().toLowerCase());
                const emailKnown = row.email
                  && staff.some(s => s.email.toLowerCase() === row.email.toLowerCase());
                return (
                  <div key={idx} className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
                    <div className="flex-1 min-w-[8rem] w-full sm:w-auto">
                      <input value={row.id} onChange={e => setAgentRow(idx, { id: e.target.value })}
                             placeholder="e.g. 101 or gre.ravi" aria-label="TeleCMI agent id"
                             className={`${inputCls} ${isUnmappedSeen ? 'border-amber-300' : ''}`} />
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
                    {isUnmappedSeen && (
                      <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 shrink-0">
                        unmapped
                      </span>
                    )}
                    <button type="button" onClick={() => removeAgentRow(idx)} title="Remove row"
                            className="p-1.5 text-[#8B7355] hover:text-red-600 hover:bg-red-50 rounded shrink-0">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" onClick={addAgentRow}
                    className="px-2.5 py-1.5 border border-[#E8D5C4] rounded text-xs text-[#6B5744] hover:bg-[#FFF8F0] flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Add agent id
            </button>
            <button onClick={saveAgentMap} disabled={!agentDirty || savingAgents}
                    className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-sm flex items-center gap-1.5 disabled:opacity-50">
              {savingAgents ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save mapping
            </button>
            {agentDirty && !savingAgents && (
              <span className="text-[10px] text-[#6B5744]">unsaved changes</span>
            )}
          </div>

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
