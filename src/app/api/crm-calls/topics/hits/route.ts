/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { listHits, listRules, alertCount, isTopicTrackingOn } from '@/lib/ct/topics';

/**
 * CRM — Topic Alerts · hits (/api/crm-calls/topics/hits).
 *
 * GET  ?rule_id= &acknowledged=0|1 &from= &to= &limit=
 *      → recent hits GROUPED BY RULE, each carrying the call, the guest and the
 *        excerpt that tripped it. Any signed-in user (this is a working queue —
 *        the GRE who takes the next call is exactly who should see "this guest
 *        mentioned an anniversary").
 * PATCH { id | ids[], acknowledged }
 *      → acknowledge / un-acknowledge. Any signed-in user, same reasoning:
 *        clearing a reviewed alert is queue work, not an admin decision.
 *
 * Acknowledging is the ONLY mutation here and it touches nothing but
 * ct_topic_hits.acknowledged.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const ruleId = (sp.get('rule_id') || '').trim();
  const ackRaw = (sp.get('acknowledged') || '').trim();
  const from = (sp.get('from') || '').trim();
  const to = (sp.get('to') || '').trim();
  if (from && !DATE_RE.test(from)) return Response.json({ error: 'from must be YYYY-MM-DD' }, { status: 400 });
  if (to && !DATE_RE.test(to)) return Response.json({ error: 'to must be YYYY-MM-DD' }, { status: 400 });

  const db = getDb();
  const hits = listHits(db, {
    ruleId: ruleId || undefined,
    acknowledged: ackRaw === '0' ? 0 : ackRaw === '1' ? 1 : null,
    from: from || undefined,
    to: to || undefined,
    limit: Number(sp.get('limit')) || 300,
  });

  // Group by rule for the review page. Rules with no hits in this window are
  // still listed (with an empty array) so the page can show "nothing tripped".
  const rules = listRules(db);
  const groups = rules.map(r => ({
    rule: r,
    hits: hits.filter(h => h.rule_id === r.id),
  })).filter(g => g.hits.length > 0 || !ruleId);

  return Response.json({
    groups: groups.sort((a, b) => b.hits.length - a.hits.length),
    total: hits.length,
    open: hits.filter(h => !h.acknowledged).length,
    alert_count: alertCount(db),
    topic_tracking: isTopicTrackingOn(db) ? '1' : '0',
  });
}

export async function PATCH(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const ids: string[] = [];
  if (typeof body.id === 'string' && body.id.trim()) ids.push(body.id.trim());
  if (Array.isArray(body.ids)) {
    for (const raw of body.ids) {
      const v = String(raw || '').trim();
      if (v) ids.push(v);
    }
  }
  if (!ids.length) return Response.json({ error: 'id or ids[] required' }, { status: 400 });
  if (ids.length > 500) return Response.json({ error: 'At most 500 hits at a time' }, { status: 400 });

  const ack = body.acknowledged === false || body.acknowledged === 0 || body.acknowledged === '0' ? 0 : 1;

  const db = getDb();
  const stmt = db.prepare(`UPDATE ct_topic_hits SET acknowledged = ? WHERE id = ?`);
  let updated = 0;
  db.transaction(() => {
    for (const id of ids) updated += stmt.run(ack, id).changes;
  })();

  return Response.json({ success: true, updated, acknowledged: ack, alert_count: alertCount(db) });
}
