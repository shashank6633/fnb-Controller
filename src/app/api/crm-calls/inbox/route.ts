/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getWaConfigRaw, isWaConfigured } from '@/lib/whatsapp';
import { guestDirectoryFor, providerNotice, windowState } from '@/lib/wa-inbox';

/**
 * GET /api/crm-calls/inbox — WhatsApp conversation list.
 *
 * Gate: any signed-in member (matches the unified Guests 360 — customer data
 * is open to all members by owner policy; loyalty figures are not exposed
 * here). Sits under the /api/crm-calls protected prefix (proxy.ts), so CSRF
 * and session rules ride along automatically.
 *
 * Each row joins to the guest 360 via norm10: guest_handle is a real
 * ct_guests id when the caller CRM knows the phone, else the synthetic
 * 'phone:<key>' handle /crm-calls/guests/[id] already resolves.
 *
 * The 24h customer-service window is computed per conversation at read time
 * (never stored). provider.notice explains an empty inbox on non-Meta
 * providers instead of leaving the page silent.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const url = new URL(request.url);
    const q = String(url.searchParams.get('q') || '').trim();
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

    const db = getDb();
    const where = q ? 'WHERE (phone_key LIKE @q OR wa_id LIKE @q OR profile_name LIKE @q COLLATE NOCASE)' : '';
    const args: any = { q: `%${q}%`, limit, offset };
    const rows = db.prepare(`
      SELECT id, phone_key, wa_id, profile_name, last_inbound_at, last_outbound_at,
             last_message_at, last_message_preview, unread_count, created_at
      FROM wa_conversations ${where}
      ORDER BY COALESCE(last_message_at, created_at) DESC
      LIMIT @limit OFFSET @offset
    `).all(args) as any[];
    const total = Number((db.prepare(`SELECT COUNT(*) AS c FROM wa_conversations ${where}`).get(args) as any)?.c) || 0;
    const unreadTotal = Number((db.prepare('SELECT COUNT(*) AS c FROM wa_conversations WHERE unread_count > 0').get() as any)?.c) || 0;

    const guests = guestDirectoryFor(db, rows.map(r => String(r.phone_key)));
    const now = Date.now();
    const conversations = rows.map(r => {
      const g = guests.get(String(r.phone_key));
      return {
        id: Number(r.id),
        phone_key: String(r.phone_key),
        wa_id: String(r.wa_id || ''),
        profile_name: String(r.profile_name || ''),
        // Curated CRM name first, WhatsApp push name as fallback.
        display_name: g?.guest_name || String(r.profile_name || '') || String(r.phone_key),
        guest_handle: g?.guest_handle || `phone:${r.phone_key}`,
        unread_count: Number(r.unread_count) || 0,
        last_message_preview: String(r.last_message_preview || ''),
        last_message_at: r.last_message_at || null,
        last_inbound_at: r.last_inbound_at || null,
        last_outbound_at: r.last_outbound_at || null,
        window: windowState(r.last_inbound_at, now),
      };
    });

    const raw = getWaConfigRaw();
    const configured = isWaConfigured(raw);
    return Response.json({
      conversations,
      total,
      unread_total: unreadTotal,
      limit,
      offset,
      provider: {
        provider: raw.wa_api_provider,
        configured,
        notice: providerNotice(raw.wa_api_provider, configured),
      },
    });
  } catch (e: any) {
    console.error('GET /api/crm-calls/inbox failed:', e);
    return Response.json({ error: e?.message || 'Failed to load inbox' }, { status: 500 });
  }
}
