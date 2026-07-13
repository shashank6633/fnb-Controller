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
 */
export const dynamic = 'force-dynamic';

const CATEGORIES = ['notification', 'marketing', 'approval', 'general'];

export async function GET() {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const db = getDb();
    const templates = db.prepare(`
      SELECT id, name, category, language, body, is_active, created_at, updated_at
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
    const db = getDb();
    const id = generateId();
    try {
      db.prepare(`
        INSERT INTO whatsapp_templates (id, name, category, language, body, is_active)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, name, category, language, body, b?.is_active === false ? 0 : 1);
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

    try {
      db.prepare(`
        UPDATE whatsapp_templates
        SET name = ?, category = ?, language = ?, body = ?, is_active = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(name, category, language, body, isActive, id);
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
