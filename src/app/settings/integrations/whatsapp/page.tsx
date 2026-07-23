'use client';

/**
 * Settings → Integrations → WhatsApp
 *
 * Central home for ALL current & future WhatsApp features. Four tabs:
 *   1. Configuration — provider + credentials + webhook + test ping
 *   2. Templates     — reusable message bodies with {{placeholder}} vars
 *   3. Notifications — master + per-event toggles (live once provider is set)
 *   4. Coming soon   — automation workflows + AI features roadmap
 *
 * No live Business-API traffic happens until credentials are configured —
 * the Test button returns a clean "not configured" until then. The existing
 * wa.me review-request links elsewhere in the app are independent of this.
 *
 * Admin-only (client gate here + requireRole('admin') on every API).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  MessageCircle, Save, Loader2, CheckCircle2, AlertTriangle, Send, Copy,
  Plus, Pencil, Trash2, Eye, Bell, Sparkles, Settings2, LayoutTemplate,
  ArrowLeft, Bot, Workflow,
} from 'lucide-react';
import { api } from '@/lib/api';
import PhoneField from '@/components/PhoneField';

type Tab = 'config' | 'templates' | 'notifications' | 'soon';

interface WaConfigDto {
  wa_api_provider: string;
  wa_phone_number_id: string;
  wa_business_account_id: string;
  wa_access_token: string;            // masked ••••last4
  wa_access_token_set: boolean;
  wa_webhook_verify_token: string;    // masked
  wa_webhook_verify_token_set: boolean;
  wa_interakt_api_key: string;        // masked ••••last4
  wa_interakt_api_key_set: boolean;
  wa_notifications_enabled: boolean;
  configured: boolean;
  notify: Record<string, boolean>;
  recipients: Record<string, string[]>;
}

interface WaTemplate {
  id: string; name: string; category: string; language: string;
  body: string; is_active: number; created_at: string; updated_at: string;
  // Provider approved-template routing (added for template-send path)
  send_as_template?: number;
  provider_template_name?: string;
  provider_language?: string;
  param_order?: string; // JSON array of var names, in {{1}},{{2}}… order
}

/**
 * Positional {{1}},{{2}}… var order per built-in notify event — mirrors
 * WA_EVENT_PARAM_ORDER in lib/whatsapp.ts. Used only to hint the default
 * "Parameter order" when a template's provider name matches a known event.
 */
const WA_EVENT_PARAM_ORDER: Record<string, string[]> = {
  requisition_approved: ['req_number', 'department', 'approved_by'],
  discount_decided:     ['order', 'pct', 'decision', 'decided_by'],
  low_stock_daily:      ['date', 'count', 'summary'],
  digest_daily:         ['date', 'content'],
};

/** Client-side mirror of lib/whatsapp renderTemplate() for the live preview. */
function renderPreview(body: string, vars: Record<string, string>): string {
  return String(body ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole);
}

const SAMPLE_VARS: Record<string, string> = {
  name: 'Shashank', guest_name: 'Shashank', amount: '1,250', date: new Date().toLocaleDateString('en-IN'),
  outlet: 'AKAN', item: 'Paneer Tikka', status: 'Approved', table: 'T-12', points: '48',
};

const NOTIFY_EVENTS: { key: string; label: string; hint: string }[] = [
  { key: 'requisition_approved', label: 'Requisition approved', hint: 'Ping the raising department when HOD/Mgmt approves their requisition.' },
  { key: 'discount_decided',     label: 'Discount request decided', hint: 'Ping the requesting cashier when a remote discount request is approved / rejected.' },
  { key: 'low_stock_daily',      label: 'Low-stock daily summary', hint: 'One morning message listing materials at/below reorder level.' },
  { key: 'digest_daily',         label: 'Daily digest', hint: 'Send the AKAN daily owner briefing to configured numbers.' },
];

export default function WhatsAppIntegrationPage() {
  const [me, setMe] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('config');
  const [cfg, setCfg] = useState<WaConfigDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user));
  }, []);

  const loadCfg = () =>
    fetch('/api/whatsapp/config').then(r => r.json()).then(d => { if (!d.error) setCfg(d); }).catch(() => {});
  useEffect(() => { loadCfg(); }, []);

  if (me && me.role !== 'admin') {
    return (
      <div className="p-6">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 <AlertTriangle size={16} className="inline mr-1" /> Admin only.
        </div>
      </div>
    );
  }

  const TABS: { id: Tab; label: string; icon: any }[] = [
    { id: 'config',        label: 'Configuration', icon: Settings2 },
    { id: 'templates',     label: 'Templates',     icon: LayoutTemplate },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'soon',          label: 'Coming soon',   icon: Sparkles },
  ];

  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-4">
      <div>
        <a href="/settings/integrations" className="text-xs text-[#af4408] inline-flex items-center gap-1 hover:underline">
          <ArrowLeft size={12} /> Integrations
        </a>
        <h1 className="text-xl font-semibold text-[#2D1B0E] flex items-center gap-2 mt-1">
          <MessageCircle size={20} className="text-emerald-600" /> WhatsApp Integration
          {cfg && (cfg.configured
            ? <span className="text-[10px] font-normal px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">● Configured</span>
            : <span className="text-[10px] font-normal px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">○ Not configured</span>)}
        </h1>
        <p className="text-xs text-[#8B7355] mt-1">
          Central home for every WhatsApp feature — provider credentials, message templates,
          notification rules, and (soon) automations & AI. Nothing sends until a provider is configured.
        </p>
      </div>

      {/* Tabs — horizontally scrollable so 375px screens work */}
      <div className="flex gap-1 overflow-x-auto border-b border-[#E8D5C4] -mx-1 px-1">
        {TABS.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setError(null); setOkMsg(null); }}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${
                    tab === t.id
                      ? 'border-[#af4408] text-[#af4408] font-medium'
                      : 'border-transparent text-[#6B5744] hover:text-[#2D1B0E]'}`}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'config' && <ConfigTab cfg={cfg} reload={loadCfg} onError={setError} onOk={setOkMsg} />}
      {tab === 'templates' && <TemplatesTab onError={setError} onOk={setOkMsg} />}
      {tab === 'notifications' && <NotificationsTab cfg={cfg} reload={loadCfg} onError={setError} onOk={setOkMsg} />}
      {tab === 'soon' && <ComingSoonTab />}

      {(error || okMsg) && (
        <div className={`rounded p-2 text-sm ${error ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-emerald-50 border border-emerald-200 text-emerald-800'}`}>
          {error || okMsg}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Configuration ───────────────────────── */

function ConfigTab({ cfg, reload, onError, onOk }: {
  cfg: WaConfigDto | null; reload: () => void;
  onError: (m: string | null) => void; onOk: (m: string | null) => void;
}) {
  const [provider, setProvider] = useState('meta_cloud');
  const [phoneId, setPhoneId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [token, setToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [interaktKey, setInteraktKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testResult, setTestResult] = useState<any>(null);
  const [seeded, setSeeded] = useState(false);

  // Send-test-template card state
  const [tplTo, setTplTo] = useState('');
  const [tplName, setTplName] = useState('');
  const [tplLang, setTplLang] = useState('');
  const [tplParams, setTplParams] = useState('');
  const [tplBusy, setTplBusy] = useState(false);
  const [tplResult, setTplResult] = useState<any>(null);

  // Meta approved-template fetch (best-effort reference list)
  const [metaTpls, setMetaTpls] = useState<any[] | null>(null);
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaErr, setMetaErr] = useState<string | null>(null);

  const isMeta = provider === 'meta_cloud';
  const isInterakt = provider === 'interakt';

  useEffect(() => {
    if (cfg && !seeded) {
      setProvider(cfg.wa_api_provider || 'meta_cloud');
      setPhoneId(cfg.wa_phone_number_id || '');
      setWabaId(cfg.wa_business_account_id || '');
      setSeeded(true);
    }
  }, [cfg, seeded]);

  // Resolved after mount (SSR can't know the origin — avoids hydration mismatch)
  const [webhookUrl, setWebhookUrl] = useState('/api/whatsapp/webhook');
  useEffect(() => { setWebhookUrl(`${window.location.origin}/api/whatsapp/webhook`); }, []);

  const save = async () => {
    setBusy(true); onError(null); onOk(null);
    try {
      const r = await api('/api/whatsapp/config', {
        method: 'POST',
        body: {
          action: 'save',
          config: {
            wa_api_provider: provider,
            wa_phone_number_id: phoneId.trim(),
            wa_business_account_id: wabaId.trim(),
            // Blank secrets are ignored server-side (keep the stored value)
            wa_access_token: token.trim(),
            wa_webhook_verify_token: verifyToken.trim(),
            wa_interakt_api_key: interaktKey.trim(),
          },
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      setToken(''); setVerifyToken(''); setInteraktKey('');
      onOk('✓ WhatsApp configuration saved.');
      reload();
    } finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); onError(null); onOk(null); setTestResult(null);
    try {
      const r = await api('/api/whatsapp/config', { method: 'POST', body: { action: 'test', to: testTo } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      setTestResult(j.result);
      if (j.result?.ok) onOk('✓ Test message sent — check the phone.');
    } finally { setBusy(false); }
  };

  const testTemplate = async () => {
    setTplBusy(true); onError(null); onOk(null); setTplResult(null);
    try {
      const params = tplParams.split(',').map(s => s.trim()).filter(Boolean);
      const r = await api('/api/whatsapp/config', {
        method: 'POST',
        body: {
          action: 'test_template',
          to: tplTo.trim(),
          template_name: tplName.trim(),
          language: tplLang.trim(),
          params,
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      setTplResult(j.result);
      if (j.result?.ok) onOk('✓ Test template accepted — check the phone.');
    } finally { setTplBusy(false); }
  };

  const fetchMetaTemplates = async () => {
    setMetaBusy(true); setMetaErr(null); setMetaTpls(null);
    try {
      const r = await fetch('/api/whatsapp/meta-templates');
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setMetaErr(j?.detail || j?.error || 'Could not fetch templates from Meta. Check the token has whatsapp_business_management scope.');
        return;
      }
      setMetaTpls(Array.isArray(j.templates) ? j.templates : []);
    } catch {
      setMetaErr('Could not reach Meta. Try again.');
    } finally { setMetaBusy(false); }
  };

  const copyWebhook = async () => {
    try { await navigator.clipboard.writeText(webhookUrl); onOk('✓ Webhook URL copied.'); } catch { /* no-op */ }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-[#2D1B0E]">Provider & credentials</h2>

        <label className="block text-xs text-[#6B5744]">
          Provider
          <select value={provider} onChange={e => setProvider(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm">
            <option value="meta_cloud">Meta Cloud API (WhatsApp Business Platform)</option>
            <option value="interakt">Interakt (WhatsApp BSP)</option>
            <option value="twilio" disabled>Twilio — coming soon</option>
            <option value="wame">wa.me links only (no API — manual tap-to-send)</option>
          </select>
        </label>

        {isMeta && (
          <div className="text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
            <b>24-hour rule:</b> free-form text replies deliver only within 24 h of the guest's last
            message. <b>Approved templates deliver anytime</b> — set a provider template name on each
            notification (Templates tab) so proactive pings always land.
          </div>
        )}

        {isInterakt && (
          <div className="text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
            <b>Templates only:</b> Interakt sends <b>approved templates</b> and has no free-form text send —
            configure each notification as an approved template (Templates tab). Interakt manages the
            business number & webhook on their side, so no Phone Number ID / webhook is needed here.
          </div>
        )}

        {provider === 'wame' && (
          <div className="text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
            wa.me mode needs no credentials — messages open in WhatsApp pre-filled and a human taps send.
            Automated sending stays disabled.
          </div>
        )}

        {isInterakt && (
          <label className="block text-xs text-[#6B5744]">
            Interakt API key{' '}
            {cfg?.wa_interakt_api_key_set
              ? <span className="text-emerald-700 font-mono">(saved: {cfg.wa_interakt_api_key})</span>
              : <span className="text-amber-700">(not set)</span>}
            <input type="password" value={interaktKey} onChange={e => setInteraktKey(e.target.value)}
                   placeholder={cfg?.wa_interakt_api_key_set ? 'Leave blank to keep the saved key' : 'Paste the Interakt Secret Key (Settings → Developer)'}
                   className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
          </label>
        )}

        {isMeta && (
          <>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block text-xs text-[#6B5744]">
                Phone Number ID
                <input value={phoneId} onChange={e => setPhoneId(e.target.value)} placeholder="e.g. 123456789012345"
                       className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
              </label>
              <label className="block text-xs text-[#6B5744]">
                Business Account ID (WABA)
                <input value={wabaId} onChange={e => setWabaId(e.target.value)} placeholder="e.g. 987654321098765"
                       className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
              </label>
            </div>

            <label className="block text-xs text-[#6B5744]">
              Access token{' '}
              {cfg?.wa_access_token_set
                ? <span className="text-emerald-700 font-mono">(saved: {cfg.wa_access_token})</span>
                : <span className="text-amber-700">(not set)</span>}
              <input type="password" value={token} onChange={e => setToken(e.target.value)}
                     placeholder={cfg?.wa_access_token_set ? 'Leave blank to keep the saved token' : 'Paste the permanent access token'}
                     className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
            </label>

            <label className="block text-xs text-[#6B5744]">
              Webhook verify token{' '}
              {cfg?.wa_webhook_verify_token_set
                ? <span className="text-emerald-700 font-mono">(saved: {cfg.wa_webhook_verify_token})</span>
                : <span className="text-amber-700">(not set)</span>}
              <input type="password" value={verifyToken} onChange={e => setVerifyToken(e.target.value)}
                     placeholder={cfg?.wa_webhook_verify_token_set ? 'Leave blank to keep the saved token' : 'Any secret string — you type the same one into Meta'}
                     className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
            </label>

            <div className="text-xs text-[#6B5744]">
              <div className="mb-1">Webhook URL (paste into Meta App Dashboard → WhatsApp → Configuration):</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate bg-[#FFF8F0] border border-[#E8D5C4] rounded px-2 py-1.5 text-[11px]">{webhookUrl}</code>
                <button onClick={copyWebhook} className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 border border-[#D4B896] rounded text-[11px] text-[#6B5744] hover:bg-[#FFF1E3]">
                  <Copy size={11} /> Copy
                </button>
              </div>
            </div>
          </>
        )}

        <button onClick={save} disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#933807] text-white text-sm rounded disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save configuration
        </button>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-[#2D1B0E]">Test the connection</h2>
        {isInterakt ? (
          <p className="text-xs text-[#8B7355]">
            Interakt sends <b>approved templates only</b> — there's no free-form text send to test here.
            Save the Interakt API key above, then use <b>Send a test template</b> below to verify the connection.
          </p>
        ) : (
          <>
            <p className="text-xs text-[#8B7355]">
              Sends a real message via the configured provider. Until credentials are saved this
              reports “not configured” — nothing is ever attempted blind.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <PhoneField value={testTo} onChange={setTestTo} placeholder="mobile number"
                     ariaLabel="Test recipient mobile number" className="flex-1"
                     inputClassName="flex-1 min-w-0 px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm text-[#2D1B0E] font-mono focus:outline-none focus:border-[#af4408]" />
              <button onClick={test} disabled={busy || !testTo.trim()}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 border border-emerald-600 text-emerald-700 hover:bg-emerald-50 text-sm rounded disabled:opacity-50">
                <Send size={12} /> Send test message
              </button>
            </div>
            {testResult && (
              testResult.ok
                ? <div className="text-[11px] rounded p-2 bg-emerald-50 border border-emerald-200 text-emerald-800">
                    <CheckCircle2 size={11} className="inline mr-1" /> Sent via {testResult.provider}{testResult.message_id ? <> · id <code className="bg-white px-1 rounded">{testResult.message_id}</code></> : null}
                  </div>
                : testResult.reason === 'not_configured'
                  ? <div className="text-[11px] rounded p-2 bg-amber-50 border border-amber-200 text-amber-900">
                      {isMeta
                        ? <>○ Not configured yet — choose <b>Meta Cloud API</b>, fill <b>Phone Number ID</b> + <b>Access token</b>, save, then test again.</>
                        : <>○ Not configured yet — save the provider credentials above, then test again.</>}
                    </div>
                  : <div className="text-[11px] rounded p-2 bg-red-50 border border-red-200 text-red-700">
                      ✗ Send failed{testResult.detail ? <>: {testResult.detail}</> : null}
                    </div>
            )}
          </>
        )}
      </div>

      {/* Send an approved template — the only path that delivers outside the 24h window (and the only path Interakt supports). */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-[#2D1B0E]">Send a test template</h2>
        <p className="text-xs text-[#8B7355]">
          Fires a provider-approved template — works anytime (no 24 h window). The name & language
          must match a template already approved on {isMeta ? 'Meta' : isInterakt ? 'Interakt' : 'the configured provider'}.
          Parameters map to <code className="bg-[#FFF1E3] px-1 rounded">{'{{1}},{{2}}…'}</code> in body order.
        </p>
        <div className="grid sm:grid-cols-2 gap-2">
          <PhoneField value={tplTo} onChange={setTplTo} placeholder="mobile number"
                 ariaLabel="Test template recipient mobile number"
                 inputClassName="flex-1 min-w-0 px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm text-[#2D1B0E] font-mono focus:outline-none focus:border-[#af4408]" />
          <input value={tplName} onChange={e => setTplName(e.target.value)} placeholder="Approved template name"
                 aria-label="Approved template name"
                 className="px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm" />
          <input value={tplLang} onChange={e => setTplLang(e.target.value)} placeholder="Language e.g. en_US (Meta) / en (Interakt)"
                 aria-label="Template language code"
                 className="px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm" />
          <input value={tplParams} onChange={e => setTplParams(e.target.value)} placeholder="Params, comma-separated (v1, v2, …)"
                 aria-label="Template parameters, comma-separated"
                 className="px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm" />
        </div>
        <button onClick={testTemplate} disabled={tplBusy || !tplTo.trim() || !tplName.trim()}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 border border-emerald-600 text-emerald-700 hover:bg-emerald-50 text-sm rounded disabled:opacity-50">
          {tplBusy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send test template
        </button>
        {tplResult && (
          tplResult.ok
            ? <div className="text-[11px] rounded p-2 bg-emerald-50 border border-emerald-200 text-emerald-800">
                <CheckCircle2 size={11} className="inline mr-1" /> Accepted via {tplResult.provider}{tplResult.message_id ? <> · id <code className="bg-white px-1 rounded">{tplResult.message_id}</code></> : null}
              </div>
            : tplResult.reason === 'not_configured'
              ? <div className="text-[11px] rounded p-2 bg-amber-50 border border-amber-200 text-amber-900">
                  ○ Not configured yet — save the provider credentials above, then try again.
                </div>
              : <div className="text-[11px] rounded p-2 bg-red-50 border border-red-200 text-red-700">
                  ✗ Send failed{tplResult.detail ? <>: {tplResult.detail}</> : null}
                </div>
        )}
      </div>

      {/* Reference list of approved templates straight from Meta (best-effort). */}
      {isMeta && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-[#2D1B0E]">Approved templates on Meta</h2>
            <button onClick={fetchMetaTemplates} disabled={metaBusy}
                    className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 border border-[#D4B896] rounded text-xs text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50">
              {metaBusy ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />} Fetch from Meta
            </button>
          </div>
          <p className="text-xs text-[#8B7355]">
            Reference only — lists templates approved on your WABA so you can copy the exact name & language
            into the Templates tab. Needs the token to carry the <code className="bg-[#FFF1E3] px-1 rounded">whatsapp_business_management</code> scope.
          </p>
          {metaErr && (
            <div className="text-[11px] rounded p-2 bg-amber-50 border border-amber-200 text-amber-900">{metaErr}</div>
          )}
          {metaTpls && metaTpls.length === 0 && !metaErr && (
            <div className="text-[11px] text-[#8B7355]">No approved templates found on this WABA.</div>
          )}
          {metaTpls && metaTpls.length > 0 && (
            <div className="space-y-1.5">
              {metaTpls.map((t, i) => (
                <div key={t.id || t.name || i} className="flex items-center gap-2 flex-wrap border border-[#E8D5C4] rounded p-2">
                  <span className="text-xs font-mono text-[#2D1B0E]">{t.name}</span>
                  {t.language && <span className="text-[10px] text-[#8B7355] uppercase">{t.language}</span>}
                  {t.category && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-700 border border-stone-300">{String(t.category).toLowerCase()}</span>}
                  {t.status && <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">{t.status}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Templates ───────────────────────── */

const CATEGORY_BADGE: Record<string, string> = {
  notification: 'bg-sky-100 text-sky-800 border-sky-300',
  marketing:    'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300',
  approval:     'bg-emerald-100 text-emerald-800 border-emerald-300',
  general:      'bg-stone-100 text-stone-700 border-stone-300',
};

function TemplatesTab({ onError, onOk }: { onError: (m: string | null) => void; onOk: (m: string | null) => void }) {
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Partial<WaTemplate> | null>(null); // null = closed, {} = new
  const [previewId, setPreviewId] = useState<string | null>(null);

  const reload = () =>
    fetch('/api/whatsapp/templates').then(r => r.json()).then(d => setTemplates(d.templates || [])).catch(() => {});
  useEffect(() => { reload(); }, []);

  const save = async () => {
    if (!editing) return;
    setBusy(true); onError(null); onOk(null);
    try {
      const isNew = !editing.id;
      const r = await api('/api/whatsapp/templates', {
        method: isNew ? 'POST' : 'PUT',
        body: {
          id: editing.id, name: editing.name, category: editing.category || 'general',
          language: editing.language || 'en', body: editing.body,
          is_active: editing.is_active !== 0,
          send_as_template: editing.send_as_template ? 1 : 0,
          provider_template_name: (editing.provider_template_name || '').trim(),
          provider_language: (editing.provider_language || '').trim(),
          param_order: (editing.param_order || '').trim(),
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      onOk(isNew ? '✓ Template created.' : '✓ Template updated.');
      setEditing(null);
      reload();
    } finally { setBusy(false); }
  };

  const toggleActive = async (t: WaTemplate) => {
    setBusy(true); onError(null);
    try {
      const r = await api('/api/whatsapp/templates', { method: 'PUT', body: { id: t.id, is_active: !t.is_active } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); onError(j.error || `HTTP ${r.status}`); return; }
      reload();
    } finally { setBusy(false); }
  };

  const del = async (t: WaTemplate) => {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    setBusy(true); onError(null);
    try {
      const r = await api(`/api/whatsapp/templates?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); onError(j.error || `HTTP ${r.status}`); return; }
      onOk('✓ Template deleted.');
      reload();
    } finally { setBusy(false); }
  };

  const previewText = useMemo(() => {
    if (!editing?.body) return '';
    return renderPreview(editing.body, SAMPLE_VARS);
  }, [editing?.body]);

  // If the template's provider name (or its own name) matches a built-in notify
  // event, surface that event's positional var order as a hint.
  const paramHintEvent = useMemo(() => {
    const cand = (editing?.provider_template_name || editing?.name || '').trim();
    return cand && WA_EVENT_PARAM_ORDER[cand] ? cand : '';
  }, [editing?.provider_template_name, editing?.name]);
  const paramHint = paramHintEvent ? WA_EVENT_PARAM_ORDER[paramHintEvent].join(', ') : '';

  return (
    <div className="space-y-4">
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Message templates</h2>
          <button onClick={() => setEditing({ category: 'general', language: 'en', is_active: 1 })}
                  className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 bg-[#af4408] hover:bg-[#933807] text-white text-xs rounded">
            <Plus size={12} /> New template
          </button>
        </div>
        <p className="text-xs text-[#8B7355]">
          Reusable bodies with <code className="bg-[#FFF1E3] px-1 rounded">{'{{placeholders}}'}</code> —
          e.g. <code className="bg-[#FFF1E3] px-1 rounded">{'Hi {{name}}, your bill of ₹{{amount}} is settled.'}</code>{' '}
          Placeholders are filled at send time.
        </p>

        {templates.length === 0 && !editing && (
          <div className="text-xs text-[#8B7355] bg-[#FFF8F0] border border-dashed border-[#D4B896] rounded p-4 text-center">
            No templates yet. Create the first one — they'll be ready the moment the provider goes live.
          </div>
        )}

        <div className="space-y-2">
          {templates.map(t => (
            <div key={t.id} className="border border-[#E8D5C4] rounded-lg p-2.5 space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-[#2D1B0E]">{t.name}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${CATEGORY_BADGE[t.category] || CATEGORY_BADGE.general}`}>{t.category}</span>
                <span className="text-[10px] text-[#8B7355] uppercase">{t.language}</span>
                {!!t.send_as_template && !!(t.provider_template_name || '').trim() && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300 inline-flex items-center gap-1" title={`Provider template: ${t.provider_template_name}`}>
                    <Send size={9} /> template
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                  <label className="inline-flex items-center gap-1 text-[10px] text-[#6B5744] cursor-pointer">
                    <input type="checkbox" checked={!!t.is_active} onChange={() => toggleActive(t)} disabled={busy} />
                    active
                  </label>
                  <button onClick={() => setPreviewId(previewId === t.id ? null : t.id)} title="Preview"
                          className="p-1 text-[#6B5744] hover:text-[#2D1B0E]"><Eye size={13} /></button>
                  <button onClick={() => setEditing({ ...t })} title="Edit"
                          className="p-1 text-[#6B5744] hover:text-[#2D1B0E]"><Pencil size={13} /></button>
                  <button onClick={() => del(t)} title="Delete"
                          className="p-1 text-red-500 hover:text-red-700"><Trash2 size={13} /></button>
                </div>
              </div>
              <div className="text-[11px] text-[#6B5744] whitespace-pre-wrap break-words">{t.body}</div>
              {previewId === t.id && (
                <div className="text-[11px] bg-emerald-50 border border-emerald-200 rounded p-2 whitespace-pre-wrap break-words">
                  <div className="text-[9px] uppercase tracking-wide text-emerald-700 mb-1">Preview with sample values</div>
                  {renderPreview(t.body, SAMPLE_VARS)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <div className="bg-white border border-[#af4408]/40 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-semibold text-[#2D1B0E]">{editing.id ? 'Edit template' : 'New template'}</h3>
          <div className="grid sm:grid-cols-3 gap-3">
            <label className="block text-xs text-[#6B5744] sm:col-span-1">
              Name
              <input value={editing.name || ''} onChange={e => setEditing({ ...editing, name: e.target.value })}
                     placeholder="e.g. bill_settled_thanks"
                     className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm" />
            </label>
            <label className="block text-xs text-[#6B5744]">
              Category
              <select value={editing.category || 'general'} onChange={e => setEditing({ ...editing, category: e.target.value })}
                      className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm">
                <option value="notification">notification</option>
                <option value="marketing">marketing</option>
                <option value="approval">approval</option>
                <option value="general">general</option>
              </select>
            </label>
            <label className="block text-xs text-[#6B5744]">
              Language
              <input value={editing.language || 'en'} onChange={e => setEditing({ ...editing, language: e.target.value })}
                     placeholder="en / te / hi"
                     className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm" />
            </label>
          </div>
          <label className="block text-xs text-[#6B5744]">
            Body — use <code className="bg-[#FFF1E3] px-1 rounded">{'{{name}}'}</code>-style placeholders
            <textarea value={editing.body || ''} onChange={e => setEditing({ ...editing, body: e.target.value })} rows={4}
                      placeholder={'Hi {{name}}, thanks for dining at {{outlet}}! Your bill of ₹{{amount}} is settled.'}
                      className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
          </label>
          {previewText && (
            <div className="text-[11px] bg-emerald-50 border border-emerald-200 rounded p-2 whitespace-pre-wrap break-words">
              <div className="text-[9px] uppercase tracking-wide text-emerald-700 mb-1">Live preview (sample values)</div>
              {previewText}
            </div>
          )}

          {/* Provider approved-template routing — needed to deliver outside the 24h window / for Interakt. */}
          <div className="border-t border-[#E8D5C4] pt-3 space-y-3">
            <label className="flex items-start gap-2 cursor-pointer text-xs text-[#6B5744]">
              <input type="checkbox" checked={!!editing.send_as_template}
                     onChange={e => setEditing({ ...editing, send_as_template: e.target.checked ? 1 : 0 })} className="mt-0.5" />
              <span>
                <span className="font-medium text-[#2D1B0E]">Send as approved template</span>
                <span className="block text-[10px] text-[#8B7355] mt-0.5">
                  Routes through the provider's approved-template API (delivers anytime; required for Interakt).
                  When off, the plain body above is sent as free-form text (Meta 24 h window only).
                </span>
              </span>
            </label>

            {!!editing.send_as_template && (
              <div className="space-y-3 pl-6">
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="block text-xs text-[#6B5744]">
                    Provider template name
                    <input value={editing.provider_template_name || ''}
                           onChange={e => setEditing({ ...editing, provider_template_name: e.target.value })}
                           placeholder="exact name approved on Meta / Interakt"
                           className={`mt-1 w-full px-3 py-2 border rounded bg-[#FFF1E3] text-sm font-mono ${(editing.provider_template_name || '').trim() ? 'border-[#D4B896]' : 'border-red-400'}`} />
                    {!(editing.provider_template_name || '').trim() && (
                      <span className="block text-[10px] text-red-600 mt-1">
                        Required when “Send as approved template” is on — without it the row falls back to free-form text and never delivers as a template.
                      </span>
                    )}
                  </label>
                  <label className="block text-xs text-[#6B5744]">
                    Provider language
                    <input value={editing.provider_language || ''}
                           onChange={e => setEditing({ ...editing, provider_language: e.target.value })}
                           placeholder="en_US (Meta) / en (Interakt)"
                           className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
                  </label>
                </div>
                <label className="block text-xs text-[#6B5744]">
                  Parameter order — variable names in <code className="bg-[#FFF1E3] px-1 rounded">{'{{1}},{{2}}…'}</code> order (comma-separated or JSON array)
                  <input value={editing.param_order || ''}
                         onChange={e => setEditing({ ...editing, param_order: e.target.value })}
                         placeholder="e.g. req_number, department, approved_by"
                         className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
                  {paramHint && (
                    <span className="block text-[10px] text-[#8B7355] mt-1">
                      Default order for “{paramHintEvent}”: <code className="bg-[#FFF1E3] px-1 rounded">{paramHint}</code>
                      {' '}— leave blank to use it.
                    </span>
                  )}
                </label>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-xs text-[#6B5744] cursor-pointer">
              <input type="checkbox" checked={editing.is_active !== 0}
                     onChange={e => setEditing({ ...editing, is_active: e.target.checked ? 1 : 0 })} />
              Active
            </label>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => setEditing(null)} className="text-xs text-[#6B5744]">Cancel</button>
              <button onClick={save} disabled={busy || !(editing.name || '').trim() || !(editing.body || '').trim() || (!!editing.send_as_template && !(editing.provider_template_name || '').trim())}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#933807] text-white text-sm rounded disabled:opacity-50">
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save template
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Notifications ───────────────────────── */

function NotificationsTab({ cfg, reload, onError, onOk }: {
  cfg: WaConfigDto | null; reload: () => void;
  onError: (m: string | null) => void; onOk: (m: string | null) => void;
}) {
  const [master, setMaster] = useState(false);
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [recips, setRecips] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (cfg && !seeded) {
      setMaster(cfg.wa_notifications_enabled);
      setPrefs(cfg.notify || {});
      const r: Record<string, string> = {};
      for (const ev of NOTIFY_EVENTS) r[ev.key] = (cfg.recipients?.[ev.key] || []).join(', ');
      setRecips(r);
      setSeeded(true);
    }
  }, [cfg, seeded]);

  const save = async () => {
    setBusy(true); onError(null); onOk(null);
    try {
      const r = await api('/api/whatsapp/config', {
        method: 'POST',
        body: {
          action: 'save',
          config: {
            wa_notifications_enabled: master ? '1' : '0',
            notify: prefs,
            // Comma-separated per-event mobiles — server splits + trims.
            notify_recipients: recips,
          },
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      onOk('✓ Notification preferences saved.');
      reload();
    } finally { setBusy(false); }
  };

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-[#2D1B0E]">WhatsApp notifications</h2>
        {!cfg?.configured && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
            takes effect when provider configured
          </span>
        )}
      </div>
      <p className="text-xs text-[#8B7355]">
        Choose which events should ping via WhatsApp. Settings save now and simply lie dormant
        until credentials are configured — nothing to redo later.
      </p>

      <label className="flex items-start gap-3 cursor-pointer text-sm border-b border-[#E8D5C4] pb-3">
        <input type="checkbox" checked={master} onChange={e => setMaster(e.target.checked)} className="mt-0.5" />
        <div className="flex-1">
          <div className="font-medium text-[#2D1B0E]">Enable WhatsApp notifications (master switch)</div>
          <div className="text-[11px] text-[#8B7355] mt-0.5">
            OFF silences every WhatsApp event below regardless of individual toggles.
          </div>
        </div>
      </label>

      {NOTIFY_EVENTS.map(ev => (
        <div key={ev.key} className={`text-sm ${!master ? 'opacity-50' : ''}`}>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={!!prefs[ev.key]} disabled={!master}
                   onChange={e => setPrefs({ ...prefs, [ev.key]: e.target.checked })} className="mt-0.5" />
            <div className="flex-1">
              <div className="font-medium text-[#2D1B0E]">{ev.label}</div>
              <div className="text-[11px] text-[#8B7355] mt-0.5">{ev.hint}</div>
            </div>
          </label>
          <label className="block mt-1.5 ml-7 text-[11px] text-[#6B5744]">
            Recipients — comma-separated mobiles (used when the event has no direct target)
            <input value={recips[ev.key] || ''} disabled={!master}
                   onChange={e => setRecips({ ...recips, [ev.key]: e.target.value })}
                   placeholder="e.g. 98xxxxxxxx, 91xxxxxxxxxx"
                   className="mt-1 w-full px-2.5 py-1.5 border border-[#D4B896] rounded bg-[#FFF1E3] text-xs font-mono disabled:cursor-not-allowed" />
          </label>
        </div>
      ))}

      <button onClick={save} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#933807] text-white text-sm rounded disabled:opacity-50">
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save preferences
      </button>
    </div>
  );
}

/* ───────────────────────── Coming soon ───────────────────────── */

function ComingSoonTab() {
  return (
    <div className="bg-white border border-dashed border-[#D4B896] rounded-xl p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-[#af4408]" />
        <h2 className="text-sm font-semibold text-[#2D1B0E]">Coming soon</h2>
      </div>
      <p className="text-xs text-[#8B7355]">
        This module is the foundation. Once the Business API is live, these ship on top of the
        same config + templates you set up today:
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="border border-[#E8D5C4] rounded-lg p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-[#2D1B0E]"><Workflow size={14} className="text-sky-700" /> Automation workflows</div>
          <ul className="text-[11px] text-[#6B5744] list-disc pl-4 space-y-0.5">
            <li>Auto-send bill + review link on settle</li>
            <li>Requisition / discount approval pings to the right person</li>
            <li>Birthday & loyalty-tier greetings from the CRM guest book</li>
            <li>Low-stock and end-of-day summaries on a schedule</li>
          </ul>
        </div>
        <div className="border border-[#E8D5C4] rounded-lg p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-[#2D1B0E]"><Bot size={14} className="text-emerald-700" /> AI features</div>
          <ul className="text-[11px] text-[#6B5744] list-disc pl-4 space-y-0.5">
            <li>AI concierge replying to guest WhatsApp queries (menu, timings, bookings)</li>
            <li>Natural-language ordering routed through Captain approval</li>
            <li>Sentiment tagging of inbound guest messages</li>
            <li>AI-drafted campaign messages from templates</li>
          </ul>
        </div>
      </div>
      <p className="text-[10px] text-[#8B7355]">
        Inbound events already land in the webhook log, so future features can replay history from day one.
      </p>
    </div>
  );
}
