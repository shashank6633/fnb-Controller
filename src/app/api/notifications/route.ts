import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * In-app notifications. Mostly read for now; future versions will support
 * per-user inbox (mark read, filter by channel, etc.).
 *
 * GET    /api/notifications?limit=50&channel=inapp
 *        → { notifications: [...] }
 * POST   /api/notifications/mark-read   (future)
 *
 * ── RECIPIENT SCOPING (owner's 2026-09 call) ────────────────────────────────
 * This read used to return EVERY row to ANY signed-in user — including the
 * admin-scoped PO deviation alerts (recipient = 'admin'). Rows are now
 * filtered to the caller's own recipient scope, matched against how the
 * writers actually address `notifications.recipient`:
 *
 *   'admin'                      — admin broadcast (PO deviation, GRN amend,
 *                                  QC overdue). Admin tier only.
 *   'store_managers'             — defer-due-check.ts (store-manager alert).
 *   'chef,kitchen_manager,store_manager,admin'
 *                                — kitchen-expiry-check.ts RECIPIENT constant.
 *   comma-joined emails          — grn-qc-notify.ts (one row, many recipients).
 *   a single email               — po-deviation-alert.ts / grn-reversal.ts
 *                                  per-person rows.
 *   '' (column default)          — legacy party-refresh rows; the writer's own
 *                                  comment says they exist "so admins see it in
 *                                  the UI", so unaddressed rows are ADMIN scope
 *                                  (fail closed, not broadcast).
 *
 * A non-admin sees a row when any comma-separated recipient token equals their
 * email (case-insensitive) or a group token they hold: 'chef' → is_head_chef,
 * 'kitchen_manager' → resolved manager tier, 'store_manager'/'store_managers'
 * → is_store_manager. Admins see everything, exactly as before — they are the
 * console this feed was built for ("admins keep admin-scope").
 *
 * The bell does NOT read this route: NotificationBell / CaptainAlertsProvider
 * poll /api/notifications/inbox (live per-tier COUNTs), which is untouched.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    const channel = url.searchParams.get('channel');
    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (channel) { where.push('channel = ?'); params.push(channel); }

    if (me.role !== 'admin') {
      // Tokens this caller may claim. recipient is a comma-joined list with no
      // spaces (writers use .join(',')), so wrap both sides in commas and do an
      // exact token match via instr() — no LIKE wildcards, so an underscore in
      // an email can never over-match, 'admin' can never be matched by
      // 'kitchen_admin', and one email can never prefix-match another.
      const tokens = [String(me.email || '').toLowerCase()]
        .concat(me.role === 'manager' ? ['kitchen_manager'] : [])
        .concat(me.is_head_chef ? ['chef'] : [])
        .concat(me.is_store_manager ? ['store_manager', 'store_managers'] : [])
        .filter(t => t.length > 0);
      if (!tokens.length) return Response.json({ notifications: [] });
      const clause = tokens.map(() =>
        `instr(',' || LOWER(REPLACE(recipient, ' ', '')) || ',', ',' || ? || ',') > 0`);
      where.push(`(${clause.join(' OR ')})`);
      params.push(...tokens);
    }

    const rows = db.prepare(`
      SELECT id, kind, party_unique_id, fp_id, event_name, event_date, channel, title, body, created_at, sent_at
      FROM notifications
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, limit);
    return Response.json({ notifications: rows });
  } catch (e: any) {
    console.error('[/api/notifications]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
