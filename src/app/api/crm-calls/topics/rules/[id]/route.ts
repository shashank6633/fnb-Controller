/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { normalizeKeywords, normalizeSeverity, MAX_RULE_NAME_LEN } from '@/lib/ct/topics';

/**
 * CRM — Topic Alerts · one rule (/api/crm-calls/topics/rules/[id]).
 *
 * PUT    → partial update { name, keywords, severity, is_active, notify }.
 *          Only the keys present in the body change, so the Active toggle can
 *          be flipped without resending the keyword list.
 * DELETE → remove the rule AND its hits (a hit with no rule can't be grouped,
 *          reviewed or explained — leaving orphans would be worse than losing
 *          them). The response reports how many hits went with it.
 *
 * Both are management-only. CSRF is enforced by proxy.ts (/api/crm-calls prefix).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const asBool = (v: any): 0 | 1 => (v === true || v === 1 || v === '1' ? 1 : 0);

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM ct_topic_rules WHERE id = ?`).get(id) as any;
  if (!existing) return Response.json({ error: 'Rule not found' }, { status: 404 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Invalid body' }, { status: 400 });

  const sets: string[] = [];
  const vals: any[] = [];

  if (body.name !== undefined) {
    const name = String(body.name || '').trim().slice(0, MAX_RULE_NAME_LEN);
    if (!name) return Response.json({ error: 'name cannot be empty' }, { status: 400 });
    const dupe = db.prepare(`SELECT id FROM ct_topic_rules WHERE lower(name) = lower(?) AND id <> ?`).get(name, id) as any;
    if (dupe) return Response.json({ error: `A rule named "${name}" already exists` }, { status: 409 });
    sets.push('name = ?'); vals.push(name);
  }
  if (body.keywords !== undefined) {
    const keywords = normalizeKeywords(body.keywords);
    if (!keywords.length) return Response.json({ error: 'At least one keyword is required' }, { status: 400 });
    sets.push('keywords = ?'); vals.push(JSON.stringify(keywords));
  }
  if (body.severity !== undefined) { sets.push('severity = ?'); vals.push(normalizeSeverity(body.severity)); }
  if (body.is_active !== undefined) { sets.push('is_active = ?'); vals.push(asBool(body.is_active)); }
  if (body.notify !== undefined) { sets.push('notify = ?'); vals.push(asBool(body.notify)); }

  if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

  vals.push(id);
  db.prepare(`UPDATE ct_topic_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  const row = db.prepare(`SELECT * FROM ct_topic_rules WHERE id = ?`).get(id);
  return Response.json({ success: true, rule: row });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM ct_topic_rules WHERE id = ?`).get(id) as any;
  if (!existing) return Response.json({ error: 'Rule not found' }, { status: 404 });

  let hitsDeleted = 0;
  db.transaction(() => {
    hitsDeleted = db.prepare(`DELETE FROM ct_topic_hits WHERE rule_id = ?`).run(id).changes;
    db.prepare(`DELETE FROM ct_topic_rules WHERE id = ?`).run(id);
  })();

  return Response.json({ success: true, hits_deleted: hitsDeleted });
}
