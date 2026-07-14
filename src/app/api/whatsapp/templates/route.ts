import { requireRole } from '@/lib/auth';
import { getDb, generateId } from '@/lib/db';

/**
 * WhatsApp message templates — CRUD (admin only).
 *
 *   GET    /api/whatsapp/templates            → { templates: [...] }
 *   POST   /api/whatsapp/templates            → create { name, category?, language?, body, is_active? }
 *   PUT    /api/whatsapp/templates            → update { id, ...fields }  (partial)
 *   DELETE /api/whatsapp/templates?id=...     → delete
 *
 * Bodies support {{placeholder}} vars, rendered by renderTemplate() at send
 * time. Nothing here talks to WhatsApp — templates are pure data, ready for
 * the provider whenever it's configured.
 *
 * Provider-template columns (all optional, backward-compatible):
 *   send_as_template       0|1 — 1 routes notifyEvent through the provider's
 *                          approved-template API instead of free-form text.
 *   provider_template_name exact approved template name at Meta/Interakt.
 *   provider_language      e.g. 'en_US' (Meta) / 'en' (Interakt); empty falls
 *                          back to the `language` column.
 *   param_order            JSON array string of var names in {{1}},{{2}}… order;
 *                          empty falls back to WA_EVENT_PARAM_ORDER in the lib.
 */
export const dynamic = 'force-dynamic';

const CATEGORIES = ['notification', 'marketing', 'approval', 'general'];

/**
 * Coerce an incoming param_order into a stored JSON-array string (or '').
 * Accepts an array of strings, a JSON-array string, or a comma-separated list
 * of variable names (the form the editor's label/placeholder/hint show).
 * Returns { value } on success or { error } for anything else.
 */
function coerceParamOrder(input: unknown): { value: string } | { error: string } {
  if (input === undefined || input === null || input === '') return { value: '' };
  let arr: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { value: '' };
    let parsed: unknown;
    let jsonOk = false;
    try { parsed = JSON.parse(trimmed); jsonOk = true; } catch { /* not JSON — fall through to comma-separated */ }
    arr = jsonOk && Array.isArray(parsed)
      ? parsed
      : trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(arr) || !arr.every(v => typeof v === 'string')) {
    return { error: 'param_order must be a JSON array or comma-separated list of variable names.' };
  }
  return { value: JSON.stringify(arr) };
}

export async function GET() {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const db = getDb();
    const templates = db.prepare(`
      SELECT id, name, category, language, body, is_active,
             provider_template_name, provider_language, param_order, send_as_template,
             created_at, updated_at
      FROM whatsapp_templates ORDER BY category, name
    `).all();
    return Response.json({ templates });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const b = await request.json().catch(() => ({}));
    const name = String(b?.name || '').trim();
    const body = String(b?.body || '').trim();
    if (!name) return Response.json({ error: 'Template name is required.' }, { status: 400 });
    if (!body) return Response.json({ error: 'Template body is required.' }, { status: 400 });
    const category = CATEGORIES.includes(b?.category) ? b.category : 'general';
    const language = String(b?.language || 'en').trim() || 'en';
    const providerTemplateName = String(b?.provider_template_name || '').trim();
    const providerLanguage = String(b?.provider_language || '').trim();
    const sendAsTemplate = b?.send_as_template ? 1 : 0;
    if (sendAsTemplate && !providerTemplateName) {
      return Response.json({ error: 'Provider template name is required when "Send as approved template" is on.' }, { status: 400 });
    }
    const paramOrder = coerceParamOrder(b?.param_order);
    if ('error' in paramOrder) return Response.json({ error: paramOrder.error }, { status: 400 });
    const db = getDb();
    const id = generateId();
    try {
      db.prepare(`
        INSERT INTO whatsapp_templates
          (id, name, category, language, body, is_active,
           provider_template_name, provider_language, param_order, send_as_template)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, category, language, body, b?.is_active === false ? 0 : 1,
             providerTemplateName, providerLanguage, paramOrder.value, sendAsTemplate);
    } catch (e: any) {
      if (String(e?.message || '').includes('UNIQUE')) {
        return Response.json({ error: `A template named "${name}" already exists.` }, { status: 409 });
      }
      throw e;
    }
    const template = db.prepare('SELECT * FROM whatsapp_templates WHERE id = ?').get(id);
    return Response.json({ ok: true, template });
  } catch (e: any) {
    console.error('[/api/whatsapp/templates POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const b = await request.json().catch(() => ({}));
    const id = String(b?.id || '');
    const db = getDb();
    const existing = db.prepare('SELECT * FROM whatsapp_templates WHERE id = ?').get(id) as any;
    if (!existing) return Response.json({ error: 'Template not found.' }, { status: 404 });

    const name = b?.name !== undefined ? String(b.name).trim() : existing.name;
    const body = b?.body !== undefined ? String(b.body).trim() : existing.body;
    if (!name) return Response.json({ error: 'Template name is required.' }, { status: 400 });
    if (!body) return Response.json({ error: 'Template body is required.' }, { status: 400 });
    const category = b?.category !== undefined
      ? (CATEGORIES.includes(b.category) ? b.category : 'general')
      : existing.category;
    const language = b?.language !== undefined ? (String(b.language).trim() || 'en') : existing.language;
    const isActive = b?.is_active !== undefined ? (b.is_active ? 1 : 0) : existing.is_active;
    const providerTemplateName = b?.provider_template_name !== undefined
      ? String(b.provider_template_name).trim() : (existing.provider_template_name ?? '');
    const providerLanguage = b?.provider_language !== undefined
      ? String(b.provider_language).trim() : (existing.provider_language ?? '');
    const sendAsTemplate = b?.send_as_template !== undefined
      ? (b.send_as_template ? 1 : 0) : (existing.send_as_template ?? 0);
    if (sendAsTemplate && !providerTemplateName) {
      return Response.json({ error: 'Provider template name is required when "Send as approved template" is on.' }, { status: 400 });
    }
    let paramOrderValue = existing.param_order ?? '';
    if (b?.param_order !== undefined) {
      const coerced = coerceParamOrder(b.param_order);
      if ('error' in coerced) return Response.json({ error: coerced.error }, { status: 400 });
      paramOrderValue = coerced.value;
    }

    try {
      db.prepare(`
        UPDATE whatsapp_templates
        SET name = ?, category = ?, language = ?, body = ?, is_active = ?,
            provider_template_name = ?, provider_language = ?, param_order = ?, send_as_template = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(name, category, language, body, isActive,
             providerTemplateName, providerLanguage, paramOrderValue, sendAsTemplate, id);
    } catch (e: any) {
      if (String(e?.message || '').includes('UNIQUE')) {
        return Response.json({ error: `A template named "${name}" already exists.` }, { status: 409 });
      }
      throw e;
    }
    const template = db.prepare('SELECT * FROM whatsapp_templates WHERE id = ?').get(id);
    return Response.json({ ok: true, template });
  } catch (e: any) {
    console.error('[/api/whatsapp/templates PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const id = new URL(request.url).searchParams.get('id') || '';
    const db = getDb();
    const r = db.prepare('DELETE FROM whatsapp_templates WHERE id = ?').run(id);
    if (r.changes === 0) return Response.json({ error: 'Template not found.' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('[/api/whatsapp/templates DELETE]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
