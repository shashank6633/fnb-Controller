import { requireRole } from '@/lib/auth';
import {
  getWaConfig, setWaConfig, isWaSecretKey, sendWhatsAppMessage, sendWhatsAppTemplate,
  WA_CONFIG_KEYS, WA_NOTIFY_EVENTS, getWaNotifyRecipients, setWaNotifyRecipients,
} from '@/lib/whatsapp';
import { getDb } from '@/lib/db';

/**
 * WhatsApp Integration — configuration (admin only).
 *
 *   GET  /api/whatsapp/config
 *        → masked config (secrets come back as ••••last4, never raw)
 *   POST /api/whatsapp/config   body { action:'save', config:{ wa_* } }
 *        Save any subset of wa_* keys. For secret keys an empty string is
 *        IGNORED unless clear:true — so re-saving the form never wipes a
 *        stored token that the UI only ever saw masked.
 *   POST /api/whatsapp/config   body { action:'test', to:'98xxxxxxxx' }
 *        Fires sendWhatsAppMessage() — returns its result verbatim, so an
 *        unconfigured provider yields a clean { ok:false, reason:'not_configured' }.
 *   POST /api/whatsapp/config   body { action:'test_template', to, template_name,
 *        language?, params?:(string|number)[], header_params?:(string|number)[] }
 *        Fires sendWhatsAppTemplate() — proves an approved template delivers
 *        anytime (outside the 24h window). Interakt sends templates only.
 *
 * Notification prefs (wa_notify_<event>) are saved through here too so the
 * whole module round-trips over one endpoint.
 */
export const dynamic = 'force-dynamic';

function readNotifyPrefs(): Record<string, boolean> {
  const db = getDb();
  const out: Record<string, boolean> = {};
  for (const ev of WA_NOTIFY_EVENTS) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`wa_notify_${ev}`) as any;
    out[ev] = row?.value === '1';
  }
  return out;
}

export async function GET() {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    return Response.json({ ...getWaConfig(), notify: readNotifyPrefs(), recipients: getWaNotifyRecipients() });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const b = await request.json().catch(() => ({}));

    if (b?.action === 'test') {
      const to = String(b?.to || '').trim();
      if (!to) return Response.json({ error: 'Enter a mobile number to test with.' }, { status: 400 });
      const result = await sendWhatsAppMessage(to, b?.message || '✅ Test ping from F&B Controller — WhatsApp integration is working.');
      return Response.json({ ok: true, result });
    }

    if (b?.action === 'test_template') {
      const to = String(b?.to || '').trim();
      const templateName = String(b?.template_name || '').trim();
      if (!to) return Response.json({ error: 'Enter a mobile number to test with.' }, { status: 400 });
      if (!templateName) return Response.json({ error: 'Enter an approved template name to test with.' }, { status: 400 });
      const language = String(b?.language || 'en').trim() || 'en';
      const params = Array.isArray(b?.params) ? b.params : [];
      const headerParams = Array.isArray(b?.header_params) ? b.header_params : undefined;
      const result = await sendWhatsAppTemplate(to, templateName, language, params, { headerParams });
      return Response.json({ ok: true, result });
    }

    if (b?.action === 'save') {
      const cfg = (b?.config && typeof b.config === 'object') ? b.config : {};
      const saved: string[] = [];
      for (const key of WA_CONFIG_KEYS) {
        if (!(key in cfg)) continue;
        const value = String(cfg[key] ?? '');
        // Secrets: blank means "keep existing" (the UI only ever sees the mask).
        // Explicit clear comes via clear_<key>: true.
        if (isWaSecretKey(key) && value === '' && !b?.[`clear_${key}`]) continue;
        setWaConfig(key, value);
        saved.push(key);
      }
      // Per-event notification toggles
      if (cfg.notify && typeof cfg.notify === 'object') {
        const db = getDb();
        for (const ev of WA_NOTIFY_EVENTS) {
          if (!(ev in cfg.notify)) continue;
          db.prepare(`
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).run(`wa_notify_${ev}`, cfg.notify[ev] ? '1' : '0');
          saved.push(`wa_notify_${ev}`);
        }
      }
      // Per-event recipient lists (comma-separated strings or arrays; partial
      // maps merge — only the events present are overwritten)
      if (cfg.notify_recipients && typeof cfg.notify_recipients === 'object') {
        setWaNotifyRecipients(cfg.notify_recipients);
        saved.push('wa_notify_recipients');
      }
      return Response.json({ ok: true, saved, ...getWaConfig(), notify: readNotifyPrefs(), recipients: getWaNotifyRecipients() });
    }

    return Response.json({ error: 'Unknown action. Use action:"save", "test" or "test_template".' }, { status: 400 });
  } catch (e: any) {
    console.error('[/api/whatsapp/config]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
