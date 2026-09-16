'use client';

/**
 * Settings → Integrations → WhatsApp
 *
 * Central home for ALL current & future WhatsApp features. Five tabs:
 *   1. Configuration — provider + credentials + webhook + test ping
 *   2. Templates     — the TEMPLATE STUDIO: author a Meta template (header /
 *                      body / footer / buttons, positional variables with
 *                      example values, a live guest-eye preview), submit it for
 *                      approval, and track its status — plus the plain local
 *                      free-form bodies that were always here.
 *                      (src/components/whatsapp/TemplateStudio.tsx)
 *   3. Notifications — master + per-event toggles (live once provider is set)
 *   4. Broadcasts    — the campaign engine's delivery + safety knobs
 *   5. Coming soon   — automation workflows + AI features roadmap
 *
 * No live Business-API traffic happens until credentials are configured —
 * the Test button returns a clean "not configured" until then. The existing
 * wa.me review-request links elsewhere in the app are independent of this.
 *
 * Admin-only (client gate here + requireRole('admin') on every API).
 */

import { useEffect, useState } from 'react';
import {
  MessageCircle, Save, Loader2, CheckCircle2, AlertTriangle, Send, Copy,
  Bell, Sparkles, Settings2, LayoutTemplate,
  ArrowLeft, Bot, Workflow, Megaphone,
} from 'lucide-react';
import { api } from '@/lib/api';
import PhoneField from '@/components/PhoneField';
import TemplateStudio from '@/components/whatsapp/TemplateStudio';

type Tab = 'config' | 'templates' | 'notifications' | 'broadcasts' | 'soon';

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

/**
 * THE SERVER BROKE AND DID NOT SAY WHY.
 *
 * Every call on this page reads `j.error` first — the API's own plain sentence.
 * This is only the fallback for a response with no readable error at all, where
 * the screen used to show the literal words "HTTP 500". The status code belongs in
 * the console, not in front of a restaurant owner.
 *
 * It does not claim "nothing was saved": the same fallback covers saving
 * credentials, rotating the app secret AND firing a test message to a real phone,
 * and this page is not in a position to know which of those landed.
 */
function serverTrouble(status: number, what: string): string {
  console.error(`[WhatsApp settings] ${what} failed with HTTP ${status}`);
  return 'Something went wrong at our end. Reload this page to see where things stand, then try again.';
}

const NOTIFY_EVENTS: { key: string; label: string; hint: string }[] = [
  { key: 'requisition_approved', label: 'Requisition approved', hint: 'Ping the raising department when HOD/Mgmt approves their requisition.' },
  { key: 'discount_decided',     label: 'Discount request decided', hint: 'Ping the requesting cashier when a remote discount request is approved / rejected.' },
  { key: 'low_stock_daily',      label: 'Low-stock daily summary', hint: 'One morning message listing materials at/below reorder level.' },
  { key: 'digest_daily',         label: 'Daily digest', hint: 'Send the AKAN daily owner briefing to configured numbers.' },
  { key: 'calls_daily',          label: 'Daily calls analytics', hint: "Yesterday's reservations line to the owner: calls, answered %, missed, bookings, busiest hour and the top agents." },
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
    { id: 'broadcasts',    label: 'Broadcasts',    icon: Megaphone },
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
      {tab === 'templates' && <TemplateStudio onError={setError} onOk={setOkMsg} />}
      {tab === 'notifications' && <NotificationsTab cfg={cfg} reload={loadCfg} onError={setError} onOk={setOkMsg} />}
      {tab === 'broadcasts' && <BroadcastsTab onError={setError} onOk={setOkMsg} />}
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

  /**
   * IS THE WEBHOOK ADDRESS PROTECTED?
   *
   * The webhook URL has to be reachable without a login, so the only thing that
   * separates Meta from a stranger is the signature Meta puts on every request.
   * Without the app secret that signature cannot be checked, and invented guest
   * messages and delivery reports would be stored as real. That is not something
   * to leave silent on the one screen where this integration is set up.
   */
  const [webhookSec, setWebhookSec] = useState<
    {
      signature_enforced: boolean; source: string; headline: string; detail: string;
      can_set_here?: boolean; warn?: boolean; last_verified_at?: string;
    } | null
  >(null);
  useEffect(() => {
    fetch('/api/whatsapp/templates/sync')
      .then(r => r.json())
      .then(d => { if (d?.webhook_security) setWebhookSec(d.webhook_security); })
      .catch(() => {});
  }, []);

  /**
   * THE APP SECRET IS TYPED HERE, and that is the whole point of this field.
   *
   * The signature check itself shipped correct and DORMANT: the secret could only
   * come from a server environment variable, none was set, and nothing in the app
   * could write one — so the forgery hole the check exists to close stayed wide
   * open after the deploy that "closed" it. A control nobody can switch on is not
   * a control. Saved write-only through its own admin route; it is never read back
   * to this screen, and the server environment still wins over it.
   */
  const [appSecret, setAppSecret] = useState('');
  const [secretBusy, setSecretBusy] = useState(false);

  const saveAppSecret = async () => {
    setSecretBusy(true); onError(null); onOk(null);
    try {
      const r = await api('/api/whatsapp/templates/sync/webhook-secret', {
        method: 'POST', body: { secret: appSecret.trim() },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || serverTrouble(r.status, 'saving the app secret')); return; }
      setAppSecret('');
      if (j?.webhook_security) setWebhookSec(j.webhook_security);
      onOk(`✓ ${j.note || 'App secret saved.'}`);
    } finally { setSecretBusy(false); }
  };

  const removeAppSecret = async () => {
    setSecretBusy(true); onError(null); onOk(null);
    try {
      const r = await api('/api/whatsapp/templates/sync/webhook-secret?confirm=1', { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || serverTrouble(r.status, 'removing the app secret')); return; }
      if (j?.webhook_security) setWebhookSec(j.webhook_security);
      onOk(`✓ ${j.note || 'App secret removed.'}`);
    } finally { setSecretBusy(false); }
  };

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
      if (!r.ok) { onError(j.error || serverTrouble(r.status, 'saving the WhatsApp configuration')); return; }
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
      if (!r.ok) { onError(j.error || serverTrouble(r.status, 'the test message')); return; }
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
      if (!r.ok) { onError(j.error || serverTrouble(r.status, 'the test template')); return; }
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

        {/* ── WEBHOOK AUTHENTICITY ──────────────────────────────────────────
            OUTSIDE the Meta-only block on purpose. The webhook address is public
            and this app ingests whatever reaches it regardless of which provider
            is selected, so hiding this while the provider is set to Interakt hid
            the warning without closing the hole. */}
        {webhookSec && (
          <div className={`text-[11px] rounded p-2 border space-y-2 ${
            !webhookSec.signature_enforced
              ? 'bg-red-50 border-red-200 text-red-800'
              : webhookSec.warn
                ? 'bg-amber-50 border-amber-200 text-amber-900'
                : 'bg-emerald-50 border-emerald-200 text-emerald-900'}`}>
            <div>
              {webhookSec.signature_enforced && !webhookSec.warn
                ? <CheckCircle2 size={11} className="inline mr-1" />
                : <AlertTriangle size={11} className="inline mr-1" />}
              <b>{webhookSec.headline}.</b> {webhookSec.detail}
            </div>

            {webhookSec.can_set_here === false ? (
              <div className="text-[10px] opacity-80">
                The secret comes from the server environment, so it cannot be changed from this screen.
              </div>
            ) : (
              <div className="flex items-end gap-2 flex-wrap">
                <label className="block text-[11px] flex-1 min-w-[220px]">
                  {webhookSec.signature_enforced ? 'Replace the app secret' : 'App secret'}
                  <input type="password" value={appSecret} onChange={e => setAppSecret(e.target.value)}
                         placeholder="Meta App Dashboard → Settings → Basic → App secret"
                         className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
                </label>
                <button onClick={saveAppSecret} disabled={secretBusy || !appSecret.trim()}
                        className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#af4408] hover:bg-[#933807] text-white text-xs rounded disabled:opacity-50">
                  {secretBusy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save app secret
                </button>
                {webhookSec.signature_enforced && (
                  <button onClick={removeAppSecret} disabled={secretBusy}
                          className="px-3 py-2 border border-[#D4B896] rounded text-xs text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50"
                          title="Switches signature checking off — forged WhatsApp events would be accepted again">
                    Remove
                  </button>
                )}
              </div>
            )}
          </div>
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
          The values you type below fill <code className="bg-[#FFF1E3] px-1 rounded">{'{{1}},{{2}}…'}</code> in the order they appear in the message.
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
          <input value={tplParams} onChange={e => setTplParams(e.target.value)} placeholder="Values to fill in, separated by commas"
                 aria-label="Values to fill into the message, separated by commas"
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
      if (!r.ok) { onError(j.error || serverTrouble(r.status, 'saving the notification preferences')); return; }
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

/* ───────────────────────── Broadcasts (campaign engine knobs) ───────────────────────── */

interface BroadcastSettingsDto {
  enabled: boolean;
  msgs_per_min: number;
  cooldown_days: number;
  daily_cap: number;
  cost_per_msg: number;
  confirm_threshold: number;
}

/**
 * The queued-broadcast engine's knobs (ct_settings, feature-owned keys) —
 * lives beside the provider config because these decide whether, how fast and
 * at what recorded cost /crm-calls/broadcasts campaigns actually deliver.
 * GET is management; PUT is ADMIN-ONLY server-side (requireRole('admin')).
 */
function BroadcastsTab({ onError, onOk }: {
  onError: (m: string | null) => void; onOk: (m: string | null) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [msgsPerMin, setMsgsPerMin] = useState(20);
  const [cooldownDays, setCooldownDays] = useState(7);
  const [dailyCap, setDailyCap] = useState(500);
  const [costPerMsg, setCostPerMsg] = useState(0.8);
  const [confirmThreshold, setConfirmThreshold] = useState(50);
  const [stopKeywords, setStopKeywords] = useState('');
  const [defaultsHint, setDefaultsHint] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/crm-calls/broadcasts/settings');
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { onError(j.error || serverTrouble(r.status, 'loading the broadcast settings')); return; }
        const s: BroadcastSettingsDto = j.settings;
        setEnabled(!!s.enabled);
        setMsgsPerMin(s.msgs_per_min);
        setCooldownDays(s.cooldown_days);
        setDailyCap(s.daily_cap);
        setCostPerMsg(s.cost_per_msg);
        setConfirmThreshold(s.confirm_threshold);
        setStopKeywords(Array.isArray(j.stop_keywords) ? j.stop_keywords.join(', ') : '');
        setDefaultsHint(Array.isArray(j.stop_keywords_default) ? j.stop_keywords_default : []);
        setLoaded(true);
      } catch {
        onError('Could not load broadcast settings');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setBusy(true); onError(null); onOk(null);
    try {
      const r = await api('/api/crm-calls/broadcasts/settings', {
        method: 'PUT',
        body: {
          enabled: enabled ? '1' : '0',
          msgs_per_min: msgsPerMin,
          cooldown_days: cooldownDays,
          daily_cap: dailyCap,
          cost_per_msg: costPerMsg,
          confirm_threshold: confirmThreshold,
          stop_keywords: stopKeywords.split(/[,\n]/).map(k => k.trim()).filter(Boolean),
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || serverTrouble(r.status, 'saving the broadcast settings')); return; }
      onOk('✓ Broadcast settings saved.');
      if (j.settings) {
        setMsgsPerMin(j.settings.msgs_per_min);
        setCooldownDays(j.settings.cooldown_days);
        setDailyCap(j.settings.daily_cap);
        setCostPerMsg(j.settings.cost_per_msg);
        setConfirmThreshold(j.settings.confirm_threshold);
      }
      if (Array.isArray(j.stop_keywords)) setStopKeywords(j.stop_keywords.join(', '));
    } finally { setBusy(false); }
  };

  if (!loaded) {
    return <div className="py-10 text-center"><Loader2 size={20} className="animate-spin text-[#af4408] mx-auto" /></div>;
  }

  const numField = (label: string, hint: string, value: number, set: (n: number) => void, min: number, max: number, step = 1) => (
    <label className="block text-xs text-[#6B5744]">
      {label}
      <input type="number" min={min} max={max} step={step} value={value}
             onChange={e => set(Number(e.target.value))}
             className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm" />
      <span className="text-[10px] text-[#8B7355]">{hint}</span>
    </label>
  );

  return (
    <div className="space-y-4">
      <div className={`border rounded-xl p-4 space-y-3 ${enabled ? 'bg-amber-50 border-amber-200' : 'bg-white border-[#E8D5C4]'}`}>
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="accent-[#af4408] mt-0.5" />
          <span>
            <span className="text-sm font-semibold text-[#2D1B0E] block">Enable broadcast sending (master switch)</span>
            <span className="text-[11px] text-[#6B5744]">
              OFF: campaigns can be built, previewed and even started, but the queue never moves — nothing is delivered.
              ON: started campaigns drain at the throttle below, with consent, cooldown and the daily cap re-checked on
              every single message. Turning this on does not send anything by itself.
            </span>
          </span>
        </label>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-[#2D1B0E]">Delivery & safety knobs</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          {numField('Messages per minute', 'The drain budget — the queue never sends faster than this (1–240).', msgsPerMin, setMsgsPerMin, 1, 240)}
          {numField('Per-guest cooldown (days)', 'One marketing message per guest per window, across ALL campaigns and win-back. 0 disables.', cooldownDays, setCooldownDays, 0, 365)}
          {numField('Daily cap (messages/day)', 'Marketing messages per IST calendar day across everything. 0 or -1 disables the cap.', dailyCap, setDailyCap, -1, 100000)}
          {numField('Cost per message (₹)', 'The Meta marketing-conversation rate — used for the "Meta will bill approximately ₹X" estimates.', costPerMsg, setCostPerMsg, 0, 100, 0.01)}
          {numField('Typed-confirmation threshold', 'Starting a campaign with MORE than this many recipients demands a typed confirmation. 0 = always typed.', confirmThreshold, setConfirmThreshold, 0, 100000)}
        </div>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-2">
        <h2 className="text-sm font-semibold text-[#2D1B0E]">STOP keywords (opt-out detection)</h2>
        <p className="text-[11px] text-[#6B5744]">
          An inbound message that IS exactly one of these (whole-message match, case/punctuation ignored) opts the guest
          out of ALL marketing immediately. “please stop by at 8” never matches. There is deliberately no inbound
          re-opt-in keyword — opting back in is a manual, audited management action on the Broadcasts page.
        </p>
        <textarea value={stopKeywords} onChange={e => setStopKeywords(e.target.value)} rows={3}
                  className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm"
                  placeholder={defaultsHint.slice(0, 6).join(', ') + ', …'} />
        <p className="text-[10px] text-[#8B7355]">Comma or newline separated. Clearing the box restores the defaults (English + Hindi + Telugu) — the STOP door can never be left unlocked.</p>
      </div>

      <button onClick={save} disabled={busy}
              className="flex items-center gap-2 px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium">
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save broadcast settings
      </button>
    </div>
  );
}
