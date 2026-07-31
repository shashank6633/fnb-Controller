/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import {
  listRules, normalizeKeywords, normalizeSeverity, isTopicTrackingOn, alertCount,
  MAX_RULE_NAME_LEN, TOPIC_SEVERITIES,
} from '@/lib/ct/topics';

/**
 * CRM — Topic Alerts · rules (/api/crm-calls/topics/rules).
 *
 * GET  → every rule + its hit counts, the master `topic_tracking` flag and the
 *        in-app alert count. Any signed-in user (the review page is read-only
 *        for non-management).
 * POST → create a rule (management only). New rules are created INACTIVE unless
 *        the caller explicitly passes is_active — a rule must be switched on by
 *        a deliberate action, never by a default.
 *
 * Nothing here can message a guest; `notify` is an in-app flag only.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const db = getDb();
  const rules = listRules(db);
  const counts = db.prepare(`
    SELECT rule_id,
           COUNT(*) AS hits,
           SUM(CASE WHEN acknowledged = 0 THEN 1 ELSE 0 END) AS open_hits
    FROM ct_topic_hits GROUP BY rule_id
  `).all() as any[];
  const byRule = new Map<string, { hits: number; open_hits: number }>();
  for (const c of counts) byRule.set(c.rule_id, { hits: c.hits ?? 0, open_hits: c.open_hits ?? 0 });

  return Response.json({
    rules: rules.map(r => ({ ...r, ...(byRule.get(r.id) || { hits: 0, open_hits: 0 }) })),
    topic_tracking: isTopicTrackingOn(db) ? '1' : '0',
    alert_count: alertCount(db),
    can_manage: isManagement(me),
    is_admin: me.role === 'admin',
    severities: TOPIC_SEVERITIES,
  });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Invalid body' }, { status: 400 });

  const name = String(body.name || '').trim().slice(0, MAX_RULE_NAME_LEN);
  if (!name) return Response.json({ error: 'name required' }, { status: 400 });

  const keywords = normalizeKeywords(body.keywords);
  if (!keywords.length) {
    return Response.json({ error: 'At least one keyword is required' }, { status: 400 });
  }

  const db = getDb();
  const dupe = db.prepare(`SELECT id FROM ct_topic_rules WHERE lower(name) = lower(?)`).get(name) as any;
  if (dupe) return Response.json({ error: `A rule named "${name}" already exists` }, { status: 409 });

  const id = generateId();
  db.prepare(`
    INSERT INTO ct_topic_rules (id, name, keywords, severity, is_active, notify, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, JSON.stringify(keywords), normalizeSeverity(body.severity),
    body.is_active === true || body.is_active === 1 || body.is_active === '1' ? 1 : 0,
    body.notify === true || body.notify === 1 || body.notify === '1' ? 1 : 0,
    me.email || me.name || '', new Date().toISOString(),
  );

  const row = db.prepare(`SELECT * FROM ct_topic_rules WHERE id = ?`).get(id);
  return Response.json({ success: true, rule: row });
}
