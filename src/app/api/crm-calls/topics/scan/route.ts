/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { scanCalls, SCAN_CALL_LIMIT } from '@/lib/ct/topics';

/**
 * CRM — Topic Alerts · on-demand scan (/api/crm-calls/topics/scan).
 *
 * POST { from, to, rule_ids?, dry_run?, include_inactive? }
 *
 *   dry_run: true  → PREVIEW. Reads calls, computes what would be recorded and
 *                    writes NOTHING. Allowed whatever the master flag says, and
 *                    may include inactive rules — that is how a venue tries a
 *                    rule out before switching it on.
 *   dry_run: false → records hits, but ONLY when ct_settings topic_tracking='1'
 *                    and only for ACTIVE rules. With the flag off the response
 *                    comes back persisted:false + blocked_reason and the DB is
 *                    untouched.
 *
 * Re-running the same range is a no-op: inserts are INSERT OR IGNORE against
 * UNIQUE(rule_id, call_id, matched_term).
 *
 * Every response carries a `coverage` block (how many of the scanned calls have
 * any text at all) so "0 hits" is never mistaken for "0 issues" when the real
 * answer is "nothing to read".
 *
 * Management only — a scan writes rows other people then work from.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  let body: any = {};
  if (req.headers.get('content-type')?.includes('application/json')) {
    try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const from = String(body.from || '').trim();
  const to = String(body.to || '').trim();
  if (from && !DATE_RE.test(from)) return Response.json({ error: 'from must be YYYY-MM-DD' }, { status: 400 });
  if (to && !DATE_RE.test(to)) return Response.json({ error: 'to must be YYYY-MM-DD' }, { status: 400 });
  if (from && to && from > to) return Response.json({ error: 'from must be on or before to' }, { status: 400 });

  let ruleIds: string[] | undefined;
  if (body.rule_ids !== undefined) {
    if (!Array.isArray(body.rule_ids)) return Response.json({ error: 'rule_ids must be an array' }, { status: 400 });
    ruleIds = body.rule_ids.map((r: any) => String(r || '').trim()).filter(Boolean).slice(0, 200);
  }

  const limit = body.limit === undefined ? undefined
    : Math.min(SCAN_CALL_LIMIT, Math.max(1, Number(body.limit) || SCAN_CALL_LIMIT));

  const db = getDb();
  const result = scanCalls(db, {
    from: from || undefined,
    to: to || undefined,
    ruleIds,
    dryRun: body.dry_run === true || body.dry_run === '1' || body.dry_run === 1,
    includeInactive: body.include_inactive === true || body.include_inactive === '1' || body.include_inactive === 1,
    limit,
  });

  return Response.json({ success: true, ...result });
}
