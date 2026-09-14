'use client';

/**
 * Settings → Integrations
 *
 * Configure outbound notification channels. Currently:
 *   - Slack incoming webhook (instant pings on party-approval-within-24h)
 *
 * Future: email (SMTP / SES), WhatsApp Business, Telegram bot.
 *
 * Admin-only.
 */

import { useEffect, useState } from 'react';
import { Send, Save, Loader2, CheckCircle2, AlertTriangle, RefreshCw, FileSpreadsheet, XCircle, KeyRound, MapPin, Star, Copy, Check } from 'lucide-react';
import { api } from '@/lib/api';

export default function IntegrationsPage() {
  const [me, setMe] = useState<any>(null);
  const [configured, setConfigured] = useState(false);
  const [masked, setMasked] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [schedulerStatus, setSchedulerStatus] = useState<any>(null);

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user));
    refresh();
  }, []);

  const refresh = async () => {
    const r = await fetch('/api/admin/slack-webhook').then(r => r.json()).catch(() => ({}));
    setConfigured(!!r.configured);
    setMasked(r.masked || '');
    const s = await fetch('/api/cron/refresh-parties').then(r => r.json()).catch(() => ({}));
    setSchedulerStatus(s.scheduler);
  };

  const save = async () => {
    setBusy(true); setError(null); setOkMsg(null);
    try {
      const r = await api('/api/admin/slack-webhook', { method: 'POST', body: { url } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setOkMsg(url ? '✓ Saved' : '✓ Cleared');
      setUrl('');
      await refresh();
    } finally { setBusy(false); }
  };

  const sendTest = async () => {
    setBusy(true); setError(null); setOkMsg(null);
    try {
      const r = await api('/api/admin/slack-webhook?test=1', { method: 'POST', body: {} });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setOkMsg('✓ Test message sent. Check your Slack channel.');
    } finally { setBusy(false); }
  };

  const triggerRefreshNow = async () => {
    setBusy(true); setError(null); setOkMsg(null);
    try {
      const r = await api('/api/cron/refresh-parties', { method: 'POST', body: {} });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setOkMsg(`✓ Refresh: ${j.result?.fetched_parties} parties · ${j.result?.status_changes} status changes · ${j.result?.notifications_created} notifications · ${j.result?.slack_sent} slack sent`);
      await refresh();
    } finally { setBusy(false); }
  };

  if (me && me.role !== 'admin') {
    return (
      <div className="p-6">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          <AlertTriangle size={16} className="inline mr-1" /> Admin only.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[#2D1B0E] flex items-center gap-2">
          <Send size={20} className="text-[#af4408]" /> Integrations
        </h1>
        <p className="text-xs text-[#8B7355] mt-1">
          Configure outbound notifications. New channels (email, WhatsApp) can be added later.
        </p>
      </div>

      {/* Scheduler status */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-2">
        <div className="flex items-center gap-2">
          <RefreshCw size={14} className="text-emerald-700" />
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Sheet refresh scheduler</h2>
        </div>
        <div className="text-xs text-[#6B5744]">
          Status: {schedulerStatus?.started
            ? <span className="text-emerald-700">● running</span>
            : <span className="text-amber-700">○ not started yet (will start on first /api/upcoming-parties request)</span>}
          {schedulerStatus?.lastRun && (
            <> · last ran {new Date(schedulerStatus.lastRun).toLocaleString('en-IN')}</>
          )}
        </div>
        {schedulerStatus?.lastResult && (
          <div className="text-[10px] font-mono text-[#8B7355] bg-[#FFF8F0] px-2 py-1 rounded">
            {JSON.stringify(schedulerStatus.lastResult)}
          </div>
        )}
        <button onClick={triggerRefreshNow} disabled={busy}
                className="text-xs px-2.5 py-1 bg-[#af4408] hover:bg-[#933807] text-white rounded disabled:opacity-50">
          {busy ? 'Refreshing…' : 'Refresh now'}
        </button>
        <p className="text-[10px] text-[#8B7355]">
          Auto-poll runs every 15 minutes. It re-fetches the AKAN Party Manager sheet, writes
          status-change audit rows, and sends Slack pings for events approved within 24h of start.
        </p>
      </div>

      {/* Google Sheets — auth status, test, paste-key (the resilient setup) */}
      <GoogleSheetsCard onError={setError} onOk={setOkMsg} />

      {/* Slack webhook config */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Slack webhook</h2>
          <p className="text-xs text-[#8B7355]">
            Paste the incoming-webhook URL from your Slack workspace. The system pings the channel
            tied to that webhook whenever a party flips to <strong>Approved</strong> within 24h
            of the event date.
          </p>
        </div>

        <div className="text-xs text-[#6B5744]">
          Currently: {configured
            ? <span className="text-emerald-700 font-mono inline-flex items-center gap-1"><CheckCircle2 size={11} /> {masked}</span>
            : <span className="text-amber-700">Not configured</span>}
        </div>

        <input type="url" value={url} onChange={e => setUrl(e.target.value)}
               placeholder="https://hooks.slack.com/services/T0.../B0.../..."
               className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />

        <div className="flex items-center gap-2">
          <button onClick={save} disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#933807] text-white text-sm rounded disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            Save
          </button>
          {configured && (
            <button onClick={sendTest} disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-emerald-600 text-emerald-700 hover:bg-emerald-50 text-sm rounded disabled:opacity-50">
              <Send size={12} /> Send test message
            </button>
          )}
          {configured && (
            <button onClick={() => { setUrl(''); save(); }} disabled={busy}
                    className="text-xs text-red-600 hover:underline ml-auto">
              Clear
            </button>
          )}
        </div>

        <details className="text-[11px] text-[#8B7355] mt-2">
          <summary className="cursor-pointer text-[#6B5744]">How to get a webhook URL</summary>
          <ol className="list-decimal pl-5 mt-1 space-y-1">
            <li>In Slack: <strong>Apps → Incoming Webhooks → Add to Slack</strong></li>
            <li>Pick the channel (e.g. <code className="bg-[#FFF1E3] px-1 rounded">#kitchen-alerts</code>)</li>
            <li>Copy the Webhook URL — paste it above + Save</li>
            <li>Click <strong>Send test message</strong> to verify</li>
          </ol>
        </details>
      </div>

      {/* WhatsApp Integration — config/templates/notifications live in their own module */}
      <WhatsAppCard />

      {/* Google Business Profile — the client ID + secret the Reviews page cannot ask for itself */}
      <GoogleReviewsCard onError={setError} onOk={setOkMsg} />

      {/* Captain area lock — restrict captains to their assigned floors/tables */}
      <CaptainAreaLockCard onError={setError} onOk={setOkMsg} />

      {/* Party rules — global toggle for FP approval requirement */}
      <PartyRulesCard onError={setError} onOk={setOkMsg} />

      {(error || okMsg) && (
        <div className={`rounded p-2 text-sm ${error ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-emerald-50 border border-emerald-200 text-emerald-800'}`}>
          {error || okMsg}
        </div>
      )}
    </div>
  );
}

/**
 * Google Sheets integration — the resilient setup.
 *
 * Shows live auth status, lets an admin TEST the connection (reads a row),
 * and PASTE the service-account JSON key (stored in the DB, used immediately).
 * This means Sheets access can be fixed entirely from the UI — no SSH, no file
 * juggling — which is exactly what kept breaking after the AWS migration.
 */
interface SheetsStatus {
  spreadsheet_id: string;
  auth_mode: 'db-json' | 'keyfile' | 'adc-metadata' | 'unknown';
  service_account_email: string | null;
  key_file_path: string | null;
  db_key_configured: boolean;
  last_test: { ok: boolean; rows_read?: number; error?: string; tested_at?: string } | null;
}
function GoogleSheetsCard({ onError, onOk }: { onError: (m: string) => void; onOk: (m: string) => void }) {
  const [status, setStatus] = useState<SheetsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; rows_read?: number; error?: string; service_account_email?: string | null } | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [keyJson, setKeyJson] = useState('');

  const reload = () => fetch('/api/admin/google-sheets').then(r => r.json()).then(setStatus).catch(() => {});
  useEffect(() => { reload(); }, []);

  const test = async () => {
    setBusy(true); setTestResult(null); onError(''); onOk('');
    try {
      const r = await api('/api/admin/google-sheets', { method: 'POST', body: { action: 'test' } });
      const j = await r.json();
      setTestResult(j);
      if (j.ok) onOk(`✓ Google Sheets connected — read ${j.rows_read} row(s) as ${j.service_account_email || 'metadata SA'}.`);
      else onError(`Sheet read failed: ${j.error}`);
      reload();
    } finally { setBusy(false); }
  };

  const saveKey = async () => {
    if (!keyJson.trim()) { onError('Paste the service-account JSON first.'); return; }
    setBusy(true); onError(''); onOk('');
    try {
      const r = await api('/api/admin/google-sheets', { method: 'POST', body: { action: 'save_key', json: keyJson } });
      const j = await r.json();
      if (!r.ok) { onError(j.error || 'Failed to save key'); return; }
      setKeyJson(''); setShowPaste(false);
      onOk(j.note || 'Key saved.');
      setTestResult(j.test ? { ok: j.test.ok, rows_read: j.test.rows_read, error: j.test.error, service_account_email: j.client_email } : null);
      reload();
    } finally { setBusy(false); }
  };

  const clearKey = async () => {
    if (!window.confirm('Remove the stored service-account key? Sheets auth will fall back to the env var / metadata server.')) return;
    setBusy(true); onError(''); onOk('');
    try {
      const r = await api('/api/admin/google-sheets', { method: 'POST', body: { action: 'clear_key' } });
      const j = await r.json();
      if (!r.ok) { onError(j.error || 'Failed'); return; }
      onOk(j.note || 'Key removed.');
      reload();
    } finally { setBusy(false); }
  };

  const connected = status?.last_test?.ok || testResult?.ok;
  const modeLabel: Record<string, string> = {
    'db-json': 'Pasted key (stored in app)',
    'keyfile': 'JSON key file on server',
    'adc-metadata': 'GCP metadata server',
    'unknown': 'Not configured',
  };

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <FileSpreadsheet size={16} className="text-emerald-700" />
        <h2 className="text-sm font-semibold text-[#2D1B0E]">Google Sheets access</h2>
        {connected
          ? <span className="ml-auto text-[11px] inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} /> Connected</span>
          : <span className="ml-auto text-[11px] inline-flex items-center gap-1 text-amber-700"><AlertTriangle size={12} /> Needs check</span>}
      </div>

      <p className="text-xs text-[#8B7355]">
        The app reads the AKAN Party Manager sheet for upcoming parties. On AWS there is no
        Google metadata server, so paste a service-account key here and share the sheet with it.
      </p>

      {/* Status grid */}
      <div className="text-xs text-[#6B5744] grid grid-cols-1 gap-1 bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
        <div>Auth mode: <b>{status ? modeLabel[status.auth_mode] : '…'}</b></div>
        <div>
          Service account:{' '}
          {status?.service_account_email
            ? <code className="bg-white px-1 rounded">{status.service_account_email}</code>
            : <span className="text-amber-700">none detected</span>}
        </div>
        {status?.last_test && (
          <div>
            Last test:{' '}
            {status.last_test.ok
              ? <span className="text-emerald-700">✓ read {status.last_test.rows_read} row(s)</span>
              : <span className="text-red-700">✗ {status.last_test.error}</span>}
            {status.last_test.tested_at && <span className="text-[#8B7355]"> · {new Date(status.last_test.tested_at).toLocaleString('en-IN')}</span>}
          </div>
        )}
      </div>

      {/* Share reminder */}
      {status?.service_account_email && (
        <div className="text-[11px] text-[#6B5744] bg-amber-50 border border-amber-200 rounded p-2">
          📋 Share the sheet (Viewer) with{' '}
          <code className="bg-white px-1 rounded">{status.service_account_email}</code>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={test} disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#933807] text-white text-sm rounded disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Test connection
        </button>
        <button onClick={() => setShowPaste(s => !s)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 text-sm rounded">
          <KeyRound size={12} /> {status?.db_key_configured ? 'Replace key' : 'Paste key'}
        </button>
        {status?.db_key_configured && (
          <button onClick={clearKey} disabled={busy}
                  className="text-xs text-red-600 hover:underline ml-auto inline-flex items-center gap-1">
            <XCircle size={11} /> Remove stored key
          </button>
        )}
      </div>

      {/* Inline test result */}
      {testResult && (
        <div className={`text-[11px] rounded p-2 ${testResult.ok ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-red-50 border border-red-200 text-red-700'}`}>
          {testResult.ok
            ? <>✓ Success — read {testResult.rows_read} row(s).</>
            : <>✗ {testResult.error}{testResult.service_account_email && <> · share the sheet with <code className="bg-white px-1 rounded">{testResult.service_account_email}</code></>}</>}
        </div>
      )}

      {/* Paste key textarea */}
      {showPaste && (
        <div className="space-y-2 border-t border-[#E8D5C4] pt-3">
          <label className="text-xs text-[#6B5744]">
            Paste the full service-account JSON key (from Google Cloud Console → IAM → Service Accounts → Keys → JSON):
          </label>
          <textarea value={keyJson} onChange={e => setKeyJson(e.target.value)} rows={6}
                    placeholder='{ "type": "service_account", "project_id": "...", "client_email": "...@...iam.gserviceaccount.com", "private_key": "-----BEGIN PRIVATE KEY-----..." }'
                    className="w-full px-2 py-1.5 border border-[#D4B896] rounded bg-[#FFF8F0] text-[10px] font-mono" />
          <div className="flex items-center gap-2">
            <button onClick={saveKey} disabled={busy || !keyJson.trim()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded disabled:opacity-50">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save & verify
            </button>
            <button onClick={() => { setShowPaste(false); setKeyJson(''); }} className="text-xs text-[#6B5744]">Cancel</button>
          </div>
          <p className="text-[10px] text-[#8B7355]">
            Stored in the app database (same place as other settings) and used immediately —
            no server restart, no SSH. After saving, it auto-tests the connection.
          </p>
        </div>
      )}

      <details className="text-[11px] text-[#8B7355]">
        <summary className="cursor-pointer text-[#6B5744]">How to create a service-account key</summary>
        <ol className="list-decimal pl-5 mt-1 space-y-1">
          <li>Google Cloud Console → <strong>APIs & Services → Library</strong> → enable <strong>Google Sheets API</strong></li>
          <li><strong>IAM & Admin → Service Accounts</strong> → create or pick one → <strong>Keys → Add key → JSON</strong></li>
          <li>Open the downloaded JSON, copy everything, paste it above → Save & verify</li>
          <li>Share the AKAN Party Manager sheet (Viewer) with the <code className="bg-[#FFF1E3] px-1 rounded">client_email</code> shown above</li>
        </ol>
      </details>
    </div>
  );
}

/**
 * WhatsApp Integration — entry card. The actual module (provider config,
 * templates, notification toggles, coming-soon roadmap) lives at
 * /settings/integrations/whatsapp; this card just shows a live status pill.
 */
function WhatsAppCard() {
  const [cfg, setCfg] = useState<{ configured: boolean; wa_api_provider: string } | null>(null);

  useEffect(() => {
    fetch('/api/whatsapp/config').then(r => r.json()).then(d => { if (!d.error) setCfg(d); }).catch(() => {});
  }, []);

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Send size={16} className="text-emerald-600" />
        <h2 className="text-sm font-semibold text-[#2D1B0E]">WhatsApp</h2>
        {cfg?.configured
          ? <span className="ml-auto text-[11px] inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} /> Configured</span>
          : <span className="ml-auto text-[11px] inline-flex items-center gap-1 text-amber-700"><AlertTriangle size={12} /> Not configured</span>}
      </div>
      <p className="text-xs text-[#8B7355]">
        Central home for all WhatsApp features — Business API credentials, message templates,
        notification rules, webhook, and upcoming automations & AI. Configure once; every
        future WhatsApp feature plugs into it.
      </p>
      <a href="/settings/integrations/whatsapp"
         className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#933807] text-white text-sm rounded">
        Open WhatsApp module →
      </a>
    </div>
  );
}

/**
 * Google Business Profile — the OAuth client behind the Google Reviews module.
 *
 * WHY THIS CARD EXISTS. /crm-calls/reviews does everything else itself — connect,
 * authorise, choose the listing, fetch, analyse — but it deliberately refuses to
 * ask for the client SECRET, because a screen that asks for a secret is a screen
 * that then has to display one. It says so on the page ("set in Settings, not
 * here"), and until now the Settings screen it defers to did not exist, so the
 * built feature could not be switched on by any screen at all. This card is that
 * missing half, and nothing more.
 *
 * WHERE THE VALUES COME FROM AND GO.
 *   READ  GET /api/crm-calls/reviews/connect -> setup{} (admin-only there, and it
 *         returns PRESENCE for the secret, never the value, no prefix, no length).
 *         The same endpoint the Reviews page reads, so the two screens can never
 *         disagree about what is configured — and it is the ONLY correct source
 *         for the redirect URI, which is callbackUrl() server-side and must not
 *         be rebuilt here from window.location (behind the proxy it differs, and
 *         an admin may have pinned it outright).
 *   WRITE PUT /api/settings, one key per call, gated admin-only on the SERVER
 *         (reviews_gbp_client_secret by shape via SECRET_KEY_RE; the client ID by
 *         its KEY_POLICY row). The client gate at the top of this page hides the
 *         panel from a non-admin; it does not defend it.
 *
 * NEVER READ THE SECRET BACK. GET /api/settings?key=reviews_gbp_client_secret
 * hands an ADMIN the raw value — that is why this card reads the connect route's
 * presence flag instead and only ever writes that key. Nothing here puts a secret
 * in a response body, in state after a save, or on screen.
 *
 * NO REFRESH-TOKEN FIELD, deliberately: reviews_gbp_refresh_token is what the
 * Connect button obtains from Google, not something a human types.
 */
interface GbpSetup {
  oauth_app_configured: boolean;
  client_id: string;
  client_secret_set: boolean;
  redirect_uri: string;
}
/** The fixed-width mask, same shape as MASK in src/lib/secret-keys.ts: a stored
 *  secret must read as "there is one", never as how long it is. Hard-coded
 *  rather than imported because we hold no value to mask — only a boolean. */
const SECRET_MASK = '••••••••';

function GoogleReviewsCard({ onError, onOk }: { onError: (m: string) => void; onOk: (m: string) => void }) {
  const [setup, setSetup] = useState<GbpSetup | null>(null);
  const [loaded, setLoaded] = useState(false);
  // WHY the empty state is split in two: the server sends setup:null both to a
  // manager (not allowed) and never to a failed request (couldn't ask). Collapsing
  // them would tell an admin whose network hiccuped that he is not an admin, and
  // he would go looking for a permissions problem that does not exist.
  const [blocked, setBlocked] = useState<'' | 'denied' | 'failed'>('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const reload = async () => {
    try {
      const r = await fetch('/api/crm-calls/reviews/connect');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setSetup(null);
        setBlocked(r.status === 401 || r.status === 403 ? 'denied' : 'failed');
        return;
      }
      const s: GbpSetup | null = d?.setup ?? null;
      setSetup(s);
      setBlocked(s ? '' : 'denied');
      // Prefilled because the client ID is public in OAuth and the Reviews page
      // already prints it in full — the owner must be able to correct one wrong
      // character in a 70-character string without retyping it.
      setClientId(s?.client_id || '');
    } catch {
      setSetup(null);
      setBlocked('failed');
    } finally { setLoaded(true); }
  };
  useEffect(() => { reload(); }, []);

  /** Save. A BLANK SECRET BOX MEANS "LEAVE THE SAVED SECRET ALONE" — the key is
   *  not sent at all in that case. PUT /api/settings stores whatever it is given,
   *  including '', and a stored '' reads back as unset: one careless save with an
   *  empty box would disconnect a working integration and silently fall back to
   *  whatever the server's environment holds. The same rule applies to the client
   *  ID box; clearing is the explicit button below, never a side effect of Save. */
  const save = async () => {
    const nextId = clientId.trim();
    const nextSecret = secret.trim();
    const idChanged = !!nextId && nextId !== (setup?.client_id || '');
    const hasSecret = nextSecret.length > 0;

    if (!idChanged && !hasSecret) {
      onError(!nextId && !setup?.client_secret_set
        ? 'Paste the Client ID and the Client secret from Google first.'
        : 'Nothing to save — the Client ID is unchanged and the secret box is empty. An empty secret box leaves the saved secret exactly as it is.');
      return;
    }

    setBusy(true); onError(''); onOk('');
    try {
      if (idChanged) {
        const r = await api('/api/settings', { method: 'PUT', body: { key: 'reviews_gbp_client_id', value: nextId } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { onError(j.error || `Could not save the Client ID (HTTP ${r.status})`); return; }
      }
      if (hasSecret) {
        const r = await api('/api/settings', { method: 'PUT', body: { key: 'reviews_gbp_client_secret', value: nextSecret } });
        const j = await r.json().catch(() => ({}));
        // j echoes back what was sent; it is deliberately not read, stored or shown.
        if (!r.ok) { onError(j.error || `Could not save the Client secret (HTTP ${r.status})`); return; }
      }
      setSecret('');
      onOk(idChanged && hasSecret ? '✓ Client ID and secret saved.'
        : hasSecret ? '✓ Client secret saved. The saved Client ID was left as it is.'
        : '✓ Client ID saved. The saved secret was left as it is.');
      await reload();
    } finally { setBusy(false); }
  };

  /** The deliberate counterpart to "blank means keep": the only way to remove. */
  const clearAll = async () => {
    if (!window.confirm(
      'Remove the saved Client ID and Client secret?\n\n'
      + 'The Reviews page will go back to "Google is not set up yet" and its Connect button '
      + 'will switch off until both are entered again. Reviews already imported are kept.'
    )) return;
    setBusy(true); onError(''); onOk('');
    try {
      for (const key of ['reviews_gbp_client_secret', 'reviews_gbp_client_id']) {
        const r = await api('/api/settings', { method: 'PUT', body: { key, value: '' } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { onError(j.error || `Could not remove ${key} (HTTP ${r.status})`); return; }
      }
      setSecret('');
      onOk('✓ Removed. The Reviews page can no longer connect until a Client ID and secret are saved again.');
      await reload();
    } finally { setBusy(false); }
  };

  const copyRedirect = () => {
    if (!setup?.redirect_uri) return;
    navigator.clipboard?.writeText(setup.redirect_uri).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1800); },
      () => onError('Could not copy — select the line and copy it by hand.'),
    );
  };

  if (!loaded) return null;

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Star size={16} className="text-amber-600" />
        <h2 className="text-sm font-semibold text-[#2D1B0E]">Google Business Profile (Reviews)</h2>
        {setup?.oauth_app_configured
          ? <span className="ml-auto text-[11px] inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} /> Configured</span>
          : <span className="ml-auto text-[11px] inline-flex items-center gap-1 text-amber-700"><AlertTriangle size={12} /> Not configured</span>}
      </div>

      <p className="text-xs text-[#8B7355]">
        The Reviews page reads what guests write about the restaurant on Google. Google will not
        hand those reviews over until this app is registered with it, and registering gives you two
        strings — a <strong>Client ID</strong> and a <strong>Client secret</strong>. They go here.
        This is the one part the Reviews page cannot ask for itself: it will not take a secret it
        would then have to show back to you.
      </p>

      {/* setup is null for anyone who is not an admin — the server decides that,
          not this card, and an empty card is the honest thing to draw. */}
      {!setup ? (
        <div className="text-[11px] text-[#6B5744] bg-amber-50 border border-amber-200 rounded p-2">
          {blocked === 'failed'
            ? 'Could not read the Google settings just now. Reload the page — nothing has been changed.'
            : 'Only an admin can see or change the Google credentials.'}
        </div>
      ) : (
        <>
          {/* What is stored now. The secret is a fixed mask and a yes/no — this
              card never receives its value, so there is nothing here to leak. */}
          <div className="text-xs text-[#6B5744] grid grid-cols-1 gap-1 bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
            <div>
              Client ID:{' '}
              {setup.client_id
                ? <code className="bg-white px-1 rounded break-all">{setup.client_id}</code>
                : <span className="text-amber-700">not saved yet</span>}
            </div>
            <div>
              Client secret:{' '}
              {setup.client_secret_set
                ? <span className="text-emerald-700 font-mono inline-flex items-center gap-1"><CheckCircle2 size={11} /> {SECRET_MASK} saved (never shown)</span>
                : <span className="text-amber-700">not saved yet</span>}
            </div>
          </div>

          {/* The redirect URI. Taken verbatim from the server (callbackUrl()), never
              rebuilt from window.location: behind the proxy they differ, and this is
              the exact string Google compares character by character. */}
          <div>
            <p className="text-[11px] font-semibold text-[#6B5744]">
              Paste this line into Google as the authorised redirect URI — exactly, character for character
            </p>
            <div className="flex items-center gap-2 mt-1">
              <code className="flex-1 min-w-0 bg-[#FFF8F0] border border-[#E8D5C4] rounded px-2 py-1.5 text-[11px] break-all">
                {setup.redirect_uri}
              </code>
              <button onClick={copyRedirect} title="Copy"
                      className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 border border-[#E0D0BE] rounded hover:bg-[#FFF1E3] text-[11px] text-[#6B5744]">
                {copied ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-[10px] text-[#8B7355] mt-1">
              If a single character differs, Google refuses the sign-in with
              &ldquo;redirect_uri_mismatch&rdquo; — which reads like a fault in this app and is not one.
            </p>
          </div>

          {/* Fields */}
          <div className="space-y-2 border-t border-[#E8D5C4] pt-3">
            <label className="block text-xs text-[#6B5744]">
              Client ID
              <input type="text" value={clientId} onChange={e => setClientId(e.target.value)}
                     placeholder="000000000000-xxxxxxxxxxxxxxxx.apps.googleusercontent.com"
                     className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
            </label>
            <label className="block text-xs text-[#6B5744]">
              Client secret{' '}
              {setup.client_secret_set
                ? <span className="text-emerald-700 font-mono">({SECRET_MASK} saved)</span>
                : <span className="text-amber-700">(not saved yet)</span>}
              <input type="password" value={secret} onChange={e => setSecret(e.target.value)}
                     autoComplete="new-password"
                     placeholder={setup.client_secret_set ? 'Leave blank to keep the saved secret' : 'Paste the Client secret from Google'}
                     className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
            </label>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={save} disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#933807] text-white text-sm rounded disabled:opacity-50">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save
            </button>
            {setup.oauth_app_configured && (
              <a href="/crm-calls/reviews"
                 className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 text-sm rounded">
                Open Reviews to connect →
              </a>
            )}
            {(setup.client_id || setup.client_secret_set) && (
              <button onClick={clearAll} disabled={busy}
                      className="text-xs text-red-600 hover:underline ml-auto inline-flex items-center gap-1">
                <XCircle size={11} /> Remove saved credentials
              </button>
            )}
          </div>

          <p className="text-[11px] text-[#6B5744]">
            {setup.oauth_app_configured
              ? '✓ Both are saved. Open the Reviews page and press "Connect Google Business Profile", signing in as the Google account that manages the AKAN listing.'
              : 'Both are needed before the Reviews page will let you connect. Saving one of the two is not enough.'}
          </p>

          <details className="text-[11px] text-[#8B7355]">
            <summary className="cursor-pointer text-[#6B5744]">Where to get the Client ID and Client secret</summary>
            <ol className="list-decimal pl-5 mt-1 space-y-1">
              <li>Wait for Google&rsquo;s approval email for the Business Profile API application. Until it arrives, these two strings cannot be created.</li>
              <li>In <strong>Google Cloud Console</strong>, open <strong>APIs &amp; Services → Credentials → Create credentials → OAuth client ID</strong>.</li>
              <li>For <strong>Application type</strong> choose <strong>Web application</strong>. No other type works here.</li>
              <li>Under <strong>Authorised redirect URIs</strong> press <strong>Add URI</strong> and paste the line shown above, exactly as it appears — no extra slash, no http in place of https.</li>
              <li>Press <strong>Create</strong>. Google shows a <strong>Client ID</strong> and a <strong>Client secret</strong>; copy each into the box above and press <strong>Save</strong>.</li>
              <li>Then open <a href="/crm-calls/reviews" className="text-[#af4408] underline">Reviews</a> and press <strong>Connect Google Business Profile</strong>. Sign in with the Google account that <em>manages</em> the listing — an account that can only see it on Maps cannot release the reviews.</li>
            </ol>
            <p className="mt-1">
              The secret is stored the same way as the other credentials on this page and is never
              shown again — not on this page, not on the Reviews page. If you lose it, create a new
              one in Google Cloud Console and save that instead.
            </p>
          </details>
        </>
      )}
    </div>
  );
}

/**
 * Captain area lock — when ON, a captain only sees / works the floors + tables
 * assigned to them (set per-user on the Users page). When OFF, every captain can
 * work any table. Reads/writes the 'captain_area_lock' setting ('1'/'0').
 */
function CaptainAreaLockCard({ onError, onOk }: { onError: (m: string) => void; onOk: (m: string) => void }) {
  const [locked, setLocked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/settings?key=captain_area_lock')
      .then(r => r.json())
      .then(d => { setLocked(d?.value === '1'); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  const toggle = async () => {
    const next = !locked;
    setBusy(true); onError(''); onOk('');
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { key: 'captain_area_lock', value: next ? '1' : '0' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      setLocked(next);
      onOk(next
        ? '✓ Captains are now restricted to their assigned floors / tables.'
        : '✓ Area lock OFF — every captain can work any table.');
    } finally { setBusy(false); }
  };

  if (!loaded) return null;

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <MapPin size={16} className="text-[#af4408]" />
        <h2 className="text-sm font-semibold text-[#2D1B0E]">Captain area assignment</h2>
      </div>

      <label className="flex items-start gap-3 cursor-pointer text-sm">
        <input type="checkbox" checked={locked} onChange={toggle} disabled={busy} className="mt-0.5" />
        <div className="flex-1">
          <div className="font-medium text-[#2D1B0E]">
            Restrict captains to their assigned area
          </div>
          <div className="text-[11px] text-[#8B7355] mt-0.5">
            {locked
              ? '✓ ON. A captain only sees and can open tables on the floors / specific tables assigned to them (set per-user on the Users page). Managers and admins are never restricted.'
              : '✓ OFF (default). Every captain can work any table regardless of their assigned floors / tables.'}
          </div>
        </div>
      </label>

      <p className="text-[11px] text-[#8B7355]">
        Assign each captain their floors and tables under <a href="/users" className="text-[#af4408] underline">Users</a> → edit → Captain Area.
      </p>
    </div>
  );
}

/** Toggle: require FP 'Approved' status before kitchen/bar can raise reqs.
 *  Also: allow past-day party requisitions (for next-day emergency top-ups). */
function PartyRulesCard({ onError, onOk }: { onError: (m: string) => void; onOk: (m: string) => void }) {
  const [requireApproval, setRequireApproval] = useState(true);
  const [allowPastDay, setAllowPastDay] = useState(false);
  const [requireMgmt, setRequireMgmt] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/admin/party-rules').then(r => r.json()).then(d => {
      setRequireApproval(d?.require_fp_approval_for_req !== false);
      setAllowPastDay(d?.allow_past_day_party_req === true);
      setRequireMgmt(d?.require_mgmt_approval === true);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const toggle = async () => {
    const next = !requireApproval;
    setBusy(true);
    try {
      const r = await api('/api/admin/party-rules', {
        method: 'POST',
        body: { require_fp_approval_for_req: next },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      setRequireApproval(next);
      onOk(next
        ? '✓ Approval gate ON — only Approved FPs can have requisitions raised.'
        : '✓ Approval gate OFF — kitchen/bar can raise reqs on ANY party regardless of FP status.');
    } finally { setBusy(false); }
  };

  const togglePastDay = async () => {
    const next = !allowPastDay;
    setBusy(true);
    try {
      const r = await api('/api/admin/party-rules', {
        method: 'POST',
        body: { allow_past_day_party_req: next },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      setAllowPastDay(next);
      onOk(next
        ? '✓ Past-day requisitions ENABLED — kitchen/bar can raise reqs for yesterday\'s parties (emergency use).'
        : '✓ Past-day requisitions DISABLED — only today/future parties can have reqs raised by non-admins.');
    } finally { setBusy(false); }
  };

  const toggleRequireMgmt = async () => {
    const next = !requireMgmt;
    setBusy(true);
    try {
      const r = await api('/api/admin/party-rules', {
        method: 'POST',
        body: { require_mgmt_approval: next },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      setRequireMgmt(next);
      onOk(next
        ? '✓ Mgmt approval REQUIRED — party requisitions now need HOD + Mgmt before reaching the store.'
        : '✓ Mgmt approval OPTIONAL — once HOD approves, the requisition goes directly to the store.');
    } finally { setBusy(false); }
  };

  if (!loaded) return null;

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-[#2D1B0E]">Party requisition rules</h2>
        <p className="text-xs text-[#8B7355]">
          Controls whether kitchen / bar can raise requisitions on any party, or only ones the
          sales team has marked <strong>Approved</strong> on the AKAN Party Manager sheet.
        </p>
      </div>

      <label className="flex items-start gap-3 cursor-pointer text-sm">
        <input type="checkbox" checked={requireApproval} onChange={toggle} disabled={busy}
               className="mt-0.5" />
        <div className="flex-1">
          <div className="font-medium text-[#2D1B0E]">
            Require FP status = <code className="bg-[#FFF1E3] px-1 rounded text-xs">Approved</code> before raising
          </div>
          <div className="text-[11px] text-[#8B7355] mt-0.5">
            {requireApproval
              ? '✓ ON (default). Draft / Pending parties show "⏳ Awaiting approval" instead of the Raise Req button.'
              : '⚠ OFF. The button is shown on every party regardless of FP status — use sparingly.'}
            {' '}Admins always bypass this gate independently.
          </div>
        </div>
      </label>

      {!requireApproval && (
        <div className="bg-amber-50 border border-amber-200 rounded p-2 text-[11px] text-amber-900">
          🚨 With the gate OFF, kitchen / bar can raise requisitions for parties that sales hasn't
          formally confirmed yet. Make sure they understand the implication before turning this on
          for the whole team.
        </div>
      )}

      {/* Separator */}
      <hr className="border-t border-[#E8D5C4]" />

      {/* Past-day raise toggle. Default OFF — preserves the rule that requisitions
          are forward-planning artefacts. Enable for next-day emergency situations
          where yesterday's party needs additional items (e.g. food restock that
          carries into post-event cleanup). */}
      <label className="flex items-start gap-3 cursor-pointer text-sm">
        <input type="checkbox" checked={allowPastDay} onChange={togglePastDay} disabled={busy}
               className="mt-0.5" />
        <div className="flex-1">
          <div className="font-medium text-[#2D1B0E]">
            Allow requisitions for <strong>past-day parties</strong> (last 3 days only — emergency use)
          </div>
          <div className="text-[11px] text-[#8B7355] mt-0.5">
            {allowPastDay
              ? '✓ ON. Kitchen / bar can raise reqs for parties in the last 3 days (yesterday, 2 days ago, 3 days ago). An "EMERGENCY · Nd ago" badge is shown on the Raise Req button. Parties older than 3 days still require admin override.'
              : '✓ OFF (default). Raise Req button is hidden on past-day parties for non-admins. Admins always retain the ability to raise.'}
            {' '}Admins always bypass this gate (and the 3-day limit) independently.
          </div>
        </div>
      </label>

      {allowPastDay && (
        <div className="bg-amber-50 border border-amber-200 rounded p-2 text-[11px] text-amber-900">
          🚨 Past-day reqs (within the 3-day window) can distort planning analytics. Use only
          for genuine post-event emergencies (forgotten items, late top-ups) and turn this off
          again once handled. Parties older than 3 days are never raise-able by non-admins.
        </div>
      )}

      <hr className="border-t border-[#E8D5C4]" />

      {/* Mgmt approval gate toggle. Default OFF so chef approval alone is enough
          for routine ops — store sees the requisition immediately after chef
          signs off. Admins can flip this on for periods (audit / festive season)
          when they want a second pair of eyes on every party requisition. */}
      <label className="flex items-start gap-3 cursor-pointer text-sm">
        <input type="checkbox" checked={requireMgmt} onChange={toggleRequireMgmt} disabled={busy}
               className="mt-0.5" />
        <div className="flex-1">
          <div className="font-medium text-[#2D1B0E]">
            Require <strong>Management approval</strong> on party requisitions (2nd gate)
          </div>
          <div className="text-[11px] text-[#8B7355] mt-0.5">
            {requireMgmt
              ? '✓ ON. Flow: Department → HOD → Mgmt → Store. Mgmt Approve button appears on /party-approvals for admins; party reqs are held at "With Mgmt" status until Mgmt acts.'
              : '✓ OFF (default). Flow: Department → HOD → Store. Once HOD approves, the requisition goes directly to the store inbox — no second gate.'}
            {' '}Internal kitchen requisitions are never gated by Mgmt regardless of this setting (HOD approval alone is always enough for kitchen restocks).
          </div>
        </div>
      </label>

      {requireMgmt && (
        <div className="bg-indigo-50 border border-indigo-200 rounded p-2 text-[11px] text-indigo-900">
          🛡 Mgmt gate is active. Already HOD-approved party requisitions sitting in the queue
          will remain at "With Mgmt" until an admin approves them on <code>/party-approvals</code>.
          Internal kitchen reqs continue to flow HOD → Store without any change.
        </div>
      )}
    </div>
  );
}
