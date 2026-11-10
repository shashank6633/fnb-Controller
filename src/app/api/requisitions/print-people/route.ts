import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { requisitionVisibility } from '@/lib/dept-hierarchy';
import { MAX_PRINT_IDS } from '@/lib/requisition-print';

/**
 * NAMES FOR THE PRINTED REQUISITION SLIP (owner ruling #126).
 *
 * GET /api/requisitions/print-people?ids=<id>,<id>,…
 *   → { names: { "<stored identifier>": "<user name>" }, viewer_name }
 *
 * Every "who" column on a requisition — drafted_by, submitted_by,
 * chef_approved_by, store_processed_by, issue_history[].by, … — stores the
 * user's EMAIL (see the POST insert and the chef-approve / store-issue
 * writers). The screens print it raw; paper must not carry email addresses,
 * so the slip asks for the names here.
 *
 * READ-ONLY, and scoped exactly like the screens: only requisitions the viewer
 * can already open (requisitionVisibility — the same filter GET
 * /api/requisitions?id= applies) are read, and only identifiers stored ON those
 * requisitions are looked up. A caller cannot name an arbitrary email and get a
 * name back. Identifiers no active-or-inactive user matches are simply absent;
 * the slip then prints a blank name line for a hand-written one.
 *
 * KEEP IN STEP with GET /api/requisitions?id= (api/requisitions/route.ts,
 * visibilityFilter): this route applies requisitionVisibility exactly as that
 * one does today (no outlet filter on ?id=). If that read ever gains another
 * predicate, add it here too, or this route names people on a requisition the
 * slip itself can no longer open.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const url = new URL(request.url);
    const ids = [...new Set(
      String(url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean),
    )].slice(0, MAX_PRINT_IDS);
    if (ids.length === 0) return Response.json({ names: {}, viewer_name: me.name || '' });

    const db = getDb();
    const vis = requisitionVisibility(db, me);
    const visSql = vis ? vis.sql : '1=1';
    const visParams = vis ? vis.params : [];

    const reqs = db.prepare(`
      SELECT r.id, r.drafted_by, r.submitted_by, r.chef_approved_by, r.mgmt_approved_by,
             r.rejected_by, r.store_processed_by, r.fulfilled_by, r.cancelled_by,
             r.dept_acknowledged_by
        FROM requisitions r
       WHERE r.id IN (${ids.map(() => '?').join(',')}) AND (${visSql})
    `).all(...ids, ...visParams) as Array<Record<string, string | null>>;

    const who = new Set<string>();
    const add = (v: unknown) => { const s = String(v ?? '').trim(); if (s) who.add(s); };
    for (const r of reqs) {
      for (const [k, v] of Object.entries(r)) if (k !== 'id') add(v);
    }
    const seen = reqs.map(r => String(r.id));
    if (seen.length > 0) {
      const lines = db.prepare(`
        SELECT issued_by, issue_history FROM requisition_items
         WHERE req_id IN (${seen.map(() => '?').join(',')})
      `).all(...seen) as Array<{ issued_by: string | null; issue_history: string | null }>;
      for (const l of lines) {
        add(l.issued_by);
        try {
          const h = JSON.parse(l.issue_history || '[]');
          if (Array.isArray(h)) for (const e of h) add(e?.by);
        } catch { /* an unreadable history names nobody */ }
      }
    }

    const names: Record<string, string> = {};
    const list = [...who];
    for (let i = 0; i < list.length; i += 500) {
      const part = list.slice(i, i + 500);
      const rows = db.prepare(`
        SELECT email, name FROM users
         WHERE LOWER(email) IN (${part.map(() => '?').join(',')})
      `).all(...part.map(s => s.toLowerCase())) as Array<{ email: string; name: string | null }>;
      const byLower = new Map(rows.map(u => [String(u.email).toLowerCase(), String(u.name || '').trim()]));
      for (const s of part) {
        const n = byLower.get(s.toLowerCase());
        if (n) names[s] = n;
      }
    }
    return Response.json({ names, viewer_name: me.name || '' });
  } catch (e: any) {
    console.error('[/api/requisitions/print-people GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
