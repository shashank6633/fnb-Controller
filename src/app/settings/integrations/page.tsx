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
import { Send, Save, Loader2, CheckCircle2, AlertTriangle, RefreshCw, FileSpreadsheet, XCircle, KeyRound } from 'lucide-react';
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
        ? '✓ Mgmt approval REQUIRED — party requisitions now need Chef + Mgmt before reaching the store.'
        : '✓ Mgmt approval OPTIONAL — once Chef approves, the requisition goes directly to the store.');
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
              ? '✓ ON. Flow: Department → Chef → Mgmt → Store. Mgmt Approve button appears on /party-approvals for admins; party reqs are held at "With Mgmt" status until Mgmt acts.'
              : '✓ OFF (default). Flow: Department → Chef → Store. Once Chef approves, the requisition goes directly to the store inbox — no second gate.'}
            {' '}Internal kitchen requisitions are never gated by Mgmt regardless of this setting (Chef approval alone is always enough for kitchen restocks).
          </div>
        </div>
      </label>

      {requireMgmt && (
        <div className="bg-indigo-50 border border-indigo-200 rounded p-2 text-[11px] text-indigo-900">
          🛡 Mgmt gate is active. Already chef-approved party requisitions sitting in the queue
          will remain at "With Mgmt" until an admin approves them on <code>/party-approvals</code>.
          Internal kitchen reqs continue to flow Chef → Store without any change.
        </div>
      )}
    </div>
  );
}
