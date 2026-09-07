/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  getWaConfigRaw, isWaConfigured, renderTemplate,
  sendWhatsAppMessage, sendWhatsAppTemplate,
} from '@/lib/whatsapp';
import { assessReply, recordOutbound, windowState } from '@/lib/wa-inbox';

/**
 * POST /api/crm-calls/inbox/[id]/reply — send a WhatsApp reply into a thread.
 *
 * Body: { text: string }                                → free-form text
 *   or  { template_id: string, params?: string[] }      → approved template
 *
 * ENFORCED SERVER-SIDE (assessReply in src/lib/wa-inbox.ts — the client UI is
 * a convenience, never the boundary):
 *   • free-form text only while the 24h customer-service window is open
 *     (last inbound < 24h). Closed window → 409 { error: 'window_closed' }
 *     naming when it closed.
 *   • Interakt provider → free-form refused (template-only API).
 *   • templates deliver any time, via the EXISTING sendWhatsAppTemplate path.
 *
 * Gate: any signed-in member — this is 1:1 guest service (the GRE desk), not
 * bulk messaging; campaigns/win-back keep their isManagement gates. Every
 * send records sent_by. Sits under the /api/crm-calls protected prefix
 * (session + CSRF via proxy.ts).
 *
 * Failed sends are recorded in the thread (status='failed' + error_detail) so
 * the conversation shows what was attempted — mirroring how the notify rail
 * logs every attempt.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const { id } = await params;
    const convId = Number(id);
    if (!Number.isFinite(convId) || convId <= 0) return Response.json({ error: 'Bad conversation id' }, { status: 400 });

    const db = getDb();
    const conv = db.prepare('SELECT * FROM wa_conversations WHERE id = ?').get(convId) as any;
    if (!conv) return Response.json({ error: 'Conversation not found' }, { status: 404 });

    const b = await request.json().catch(() => ({}));
    const templateId = String(b?.template_id || '').trim();
    const text = String(b?.text || '').trim();
    const kind: 'text' | 'template' = templateId ? 'template' : 'text';
    if (kind === 'text' && !text) {
      return Response.json({ error: 'empty_message', detail: 'Reply text is required.' }, { status: 400 });
    }

    const raw = getWaConfigRaw();
    const gate = assessReply(kind, raw.wa_api_provider, conv.last_inbound_at);
    if (!gate.allowed) {
      return Response.json(
        { error: gate.error, detail: gate.detail, window: windowState(conv.last_inbound_at) },
        { status: gate.status },
      );
    }
    if (!isWaConfigured(raw)) {
      return Response.json({
        error: 'not_configured',
        detail: 'WhatsApp is not configured for the current provider — an admin must complete Settings → Integrations → WhatsApp before replies can be sent.',
      }, { status: 409 });
    }

    // Send target: the raw msisdn Meta reported; fall back to the join key
    // (normalizeWaNumber inside the send path adds the 91 country code).
    const to = String(conv.wa_id || '').trim() || String(conv.phone_key);

    let res: any;
    let bodyForThread = text;
    let msgType = 'text';

    if (kind === 'template') {
      const tpl = db.prepare('SELECT * FROM whatsapp_templates WHERE id = ? AND is_active = 1').get(templateId) as any;
      if (!tpl) return Response.json({ error: 'template_not_found', detail: 'No active template with that id.' }, { status: 404 });
      if (!Number(tpl.send_as_template) || !String(tpl.provider_template_name || '').trim()) {
        return Response.json({
          error: 'template_not_approved',
          detail: `Template '${tpl.name}' is not mapped to a provider-approved template (send_as_template + provider_template_name) — it cannot deliver outside the free-form path.`,
        }, { status: 400 });
      }
      const paramsIn: string[] = Array.isArray(b?.params) ? b.params.map((p: any) => String(p ?? '')) : [];
      const lang = String(tpl.provider_language || '').trim() || String(tpl.language || 'en');
      msgType = 'template';
      // Best-effort rendered body for the thread record (param_order maps the
      // template's named {{placeholders}} to the positional params).
      bodyForThread = String(tpl.body || '');
      try {
        const order = JSON.parse(String(tpl.param_order || '[]'));
        if (Array.isArray(order) && order.length) {
          const vars: Record<string, string> = {};
          order.forEach((name: any, i: number) => { vars[String(name)] = paramsIn[i] ?? ''; });
          bodyForThread = renderTemplate(String(tpl.body || ''), vars);
        }
      } catch { /* keep raw body */ }
      bodyForThread = `[template: ${tpl.provider_template_name}] ${bodyForThread}`.trim();

      res = await sendWhatsAppTemplate(to, String(tpl.provider_template_name).trim(), lang, paramsIn);
    } else {
      res = await sendWhatsAppMessage(to, text);
    }

    if (res?.ok) {
      const message = recordOutbound(db, {
        conversationId: convId,
        wamid: res.message_id || null,
        msgType,
        body: bodyForThread,
        status: 'sent',
        sentBy: me.id,
      });
      return Response.json({ ok: true, message, window: windowState(conv.last_inbound_at) });
    }

    const message = recordOutbound(db, {
      conversationId: convId,
      wamid: null,
      msgType,
      body: bodyForThread,
      status: 'failed',
      errorDetail: `${res?.reason || 'send_failed'}${res?.detail ? `: ${res.detail}` : ''}`,
      sentBy: me.id,
    });
    return Response.json({
      ok: false,
      error: res?.reason || 'send_failed',
      detail: res?.detail || 'The provider rejected the send.',
      message,
    }, { status: 502 });
  } catch (e: any) {
    console.error('POST /api/crm-calls/inbox/[id]/reply failed:', e);
    return Response.json({ error: e?.message || 'Reply failed' }, { status: 500 });
  }
}
