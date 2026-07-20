'use client';

/**
 * CRM — Call-to-Table Settings (admin only).
 *
 * Master spec 5.7. Everything here is NON-SECRET config stored in ct_settings
 * (key/value). TeleCMI appid/secret live ONLY in server env vars
 * (TELECMI_APPID / TELECMI_SECRET / TELECMI_WEBHOOK_SECRET) — this page just
 * reports whether they are present and hands the admin the webhook URLs to
 * paste into the TeleCMI CHUB dashboard.
 *
 * GET /api/crm-calls/settings  → { settings, webhook urls/token, configured }
 * PUT /api/crm-calls/settings  → changed keys only
 * POST /api/crm-calls/seed     → demo data (confirm first, show counts)
 * POST /api/telecmi/backfill   → historical CDR pull ({ days })
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Settings as SettingsIcon, PlugZap, Webhook, Copy, Check, Clock, UserCheck,
  Loader2, AlertCircle, CheckCircle2, Save, Lock, Database, DownloadCloud,
  MessageCircle, RefreshCw, Sparkles, Zap, Users, Plus, Trash2,
} from 'lucide-react';
import { api } from '@/lib/api';

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
  auto_analyze: '0',
  analysis_retention: 'permanent',
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

export default function CtSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [saved, setSaved] = useState<Record<string, string>>({ ...DEFAULTS });
  const [form, setForm] = useState<Record<string, string>>({ ...DEFAULTS });
  const [configured, setConfigured] = useState(false);
  const [paths, setPaths] = useState<{ live: string; cdr: string }>({ live: '', cdr: '' });
  const [origin, setOrigin] = useState('');

  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'live' | 'cdr' | null>(null);
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

  const set = (key: string, value: string) => setForm(prev => ({ ...prev, [key]: value }));

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
        if (k === 'auto_analyze') v = v === '1' ? '1' : '0';
        if (k === 'analysis_retention') v = v === 'ephemeral' ? 'ephemeral' : 'permanent';
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
            {configured ? 'Configured (env)' : 'Not configured'}
          </span>
        </div>
        <div className="p-3 sm:p-4 space-y-3">
          <p className="text-xs text-[#6B5744]">
            The TeleCMI <strong>appid</strong> and <strong>secret</strong> live only in server
            environment variables (<code className="text-[11px] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1">TELECMI_APPID</code>,{' '}
            <code className="text-[11px] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1">TELECMI_SECRET</code>) — they are
            never stored in the database and never shown here. The badge above just reports whether
            they are present. Click-to-call and backfill run in mock mode until they are set.
          </p>
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
            Paste these into the TeleCMI <strong>CHUB dashboard</strong> under your business number
            → webhooks (method <strong>POST</strong>). The long token in the path is the shared
            secret — treat these URLs like passwords.
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
            <li>CHUB dashboard → your business number → call flow / webhooks.</li>
            <li>Add a webhook node of type <strong>call report</strong> → paste the CDR URL.</li>
            <li>Add a webhook node of type <strong>notify</strong> → paste the Live events URL.</li>
            <li>Save the flow, then test with a real call (or <code>npm run simulate:call</code> in dev).</li>
          </ol>
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

          <div className="border-t border-[#E8D5C4]/60 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <MessageCircle className="w-3.5 h-3.5 text-[#af4408]" />
              <span className="text-xs font-semibold text-[#2D1B0E]">After-hours auto-WhatsApp to missed callers</span>
              <span className="px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-800 text-[10px] font-medium">
                stub — logged only, not sent in Phase 1
              </span>
              <button type="button" role="switch" aria-checked={whatsappOn}
                      aria-label="After-hours auto-WhatsApp to missed callers"
                      onClick={() => set('after_hours_whatsapp', whatsappOn ? '0' : '1')}
                      className={`ml-auto relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${whatsappOn ? 'bg-[#af4408]' : 'bg-gray-300'}`}>
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${whatsappOn ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
            </div>
            <p className="text-[10px] text-[#6B5744] mt-1">
              When ON (and once WhatsApp sending is wired up in a later phase), callers missed
              outside business hours get this message automatically. Placeholders:{' '}
              <code className="bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1">{'{open}'}</code>{' '}
              <code className="bg-[#FFF8F0] border border-[#E8D5C4] rounded px-1">{'{link}'}</code>
            </p>
            <textarea value={form.after_hours_template ?? ''}
                      onChange={e => set('after_hours_template', e.target.value)}
                      rows={3} disabled={!whatsappOn}
                      placeholder="Sorry we missed your call! We open at {open}. Book a table: {link}"
                      className={`${inputCls} mt-2 resize-y ${whatsappOn ? '' : 'opacity-50'}`} />
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
              <button type="button" role="switch" aria-checked={autoAnalyzeOn} disabled={ephemeral}
                      aria-label="Auto-score every recorded call"
                      onClick={() => set('auto_analyze', autoAnalyzeOn ? '0' : '1')}
                      className={`ml-auto relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${autoAnalyzeOn ? 'bg-[#af4408]' : 'bg-gray-300'} ${ephemeral ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${autoAnalyzeOn ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
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
            <button onClick={() => setForm({ ...saved })} disabled={saving}
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
