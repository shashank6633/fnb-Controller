/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getWaConfigRaw, isWaConfigured } from '@/lib/whatsapp';
import { guestDirectoryFor, providerNotice, windowState } from '@/lib/wa-inbox';

/**
 * GET /api/crm-calls/inbox/[id] — one conversation thread. MARKS IT READ.
 *
 * Gate: any signed-in member (same openness as the conversation list and the
 * unified Guests 360).
 *
 * Embeds the approved-template list (whatsapp_templates rows with
 * send_as_template=1 + a provider_template_name) the same way the win-back
 * GET does — so a non-admin GRE gets the template picker without touching the
 * admin-only /api/whatsapp/templates routes. The window state decides whether
 * the composer offers free-form text or templates only; the reply API
 * re-checks SERVER-SIDE regardless.
 *
 * Paging: newest page by default; ?before_id=<message id> walks older.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const { id } = await params;
    const convId = Number(id);
    if (!Number.isFinite(convId) || convId <= 0) return Response.json({ error: 'Bad conversation id' }, { status: 400 });

    const db = getDb();
    const conv = db.prepare('SELECT * FROM wa_conversations WHERE id = ?').get(convId) as any;
    if (!conv) return Response.json({ error: 'Conversation not found' }, { status: 404 });

    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    const beforeId = Number(url.searchParams.get('before_id')) || 0;

    const rows = db.prepare(`
      SELECT id, wamid, direction, msg_type, body, media_id, media_status, media_error,
             status, status_at, error_detail, reply_to_wamid, wa_timestamp, sent_by, created_at
      FROM wa_messages
      WHERE conversation_id = @conv ${beforeId > 0 ? 'AND id < @before' : ''}
      ORDER BY id DESC LIMIT @limit
    `).all({ conv: convId, before: beforeId, limit }) as any[];
    rows.reverse(); // chronological for the thread view

    // Thread fetch marks the conversation read.
    if (Number(conv.unread_count) > 0) {
      db.prepare('UPDATE wa_conversations SET unread_count = 0 WHERE id = ?').run(convId);
      conv.unread_count = 0;
    }

    // Approved-template list for the composer (win-back embedding pattern —
    // the provider is the real authority on approval; these rows are the
    // venue's record of the approved name/language/param order).
    let templates: any[] = [];
    try {
      templates = db.prepare(`
        SELECT id, name, category, language, body, provider_template_name, provider_language, param_order
        FROM whatsapp_templates
        WHERE is_active = 1 AND send_as_template = 1 AND COALESCE(provider_template_name, '') <> ''
        ORDER BY category, name
      `).all() as any[];
    } catch { templates = []; }

    const g = guestDirectoryFor(db, [String(conv.phone_key)]).get(String(conv.phone_key));
    const raw = getWaConfigRaw();
    const configured = isWaConfigured(raw);

    return Response.json({
      conversation: {
        id: Number(conv.id),
        phone_key: String(conv.phone_key),
        wa_id: String(conv.wa_id || ''),
        profile_name: String(conv.profile_name || ''),
        display_name: g?.guest_name || String(conv.profile_name || '') || String(conv.phone_key),
        guest_handle: g?.guest_handle || `phone:${conv.phone_key}`,
        unread_count: 0,
        last_inbound_at: conv.last_inbound_at || null,
        last_outbound_at: conv.last_outbound_at || null,
        last_message_at: conv.last_message_at || null,
      },
      messages: rows.map(m => ({
        id: Number(m.id),
        wamid: m.wamid || null,
        direction: String(m.direction),
        msg_type: String(m.msg_type),
        body: String(m.body || ''),
        media_id: m.media_id != null ? Number(m.media_id) : null,
        media_url: m.media_id != null ? `/api/crm-calls/inbox/media/${m.media_id}` : null,
        media_status: String(m.media_status || ''),
        media_error: String(m.media_error || ''),
        status: String(m.status || ''),
        status_at: m.status_at || null,
        error_detail: String(m.error_detail || ''),
        reply_to_wamid: String(m.reply_to_wamid || ''),
        wa_timestamp: m.wa_timestamp || null,
        sent_by: String(m.sent_by || ''),
        created_at: m.created_at,
      })),
      has_more: rows.length === limit,
      window: windowState(conv.last_inbound_at),
      templates,
      provider: {
        provider: raw.wa_api_provider,
        configured,
        notice: providerNotice(raw.wa_api_provider, configured),
      },
    });
  } catch (e: any) {
    console.error('GET /api/crm-calls/inbox/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to load thread' }, { status: 500 });
  }
}
