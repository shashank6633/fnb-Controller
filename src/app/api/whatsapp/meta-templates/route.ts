import { requireRole } from '@/lib/auth';
import { getWaConfigRaw } from '@/lib/whatsapp';

/**
 * Meta approved-template listing (admin only) — powers the template-name
 * dropdown in the WhatsApp settings UI so an admin can pick a real, APPROVED
 * template instead of typing its name by hand.
 *
 *   GET /api/whatsapp/meta-templates
 *     → { ok:true, templates:[{ name, language, status, category }] }  (APPROVED only)
 *     → { ok:false, error }  when provider isn't meta_cloud, creds are missing,
 *        or Meta rejects the call (e.g. token lacks whatsapp_business_management
 *        scope). Always HTTP 200 so the UI can show the message cleanly.
 *
 * Best-effort: never throws to the client. GET-only (no CSRF concern), but the
 * Bearer token stays server-side — only name/status/language/category go out.
 */
export const dynamic = 'force-dynamic';

const META_GRAPH_VERSION = 'v23.0';

export async function GET() {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

    const raw = getWaConfigRaw();
    if (raw.wa_api_provider !== 'meta_cloud') {
      return Response.json({ ok: false, error: 'Approved-template listing is only available for the Meta Cloud provider.' });
    }
    const waba = raw.wa_business_account_id.trim();
    const token = raw.wa_access_token.trim();
    if (!waba) return Response.json({ ok: false, error: 'Set the WhatsApp Business Account ID (WABA) to list approved templates.' });
    if (!token) return Response.json({ ok: false, error: 'Set the Meta access token to list approved templates.' });

    const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(waba)}/message_templates?fields=name,status,language,category,components&limit=100`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      return Response.json({ ok: false, error: j?.error?.message || `Meta API HTTP ${r.status}` });
    }

    const templates = (Array.isArray(j?.data) ? j.data : [])
      .filter((t: any) => t?.status === 'APPROVED')
      .map((t: any) => ({
        name: t.name,
        language: t.language,
        status: t.status,
        category: t.category,
      }));
    return Response.json({ ok: true, templates });
  } catch (e: any) {
    console.error('[/api/whatsapp/meta-templates]', e);
    return Response.json({ ok: false, error: e?.message || 'Failed to fetch templates.' });
  }
}
