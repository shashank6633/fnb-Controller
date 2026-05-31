import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Global party-requisition rules.
 *   - require_fp_approval_for_req (default '1') — FP-status gate before raise.
 *   - allow_past_day_party_req    (default '0') — 3-day grace for emergency raises.
 *   - require_mgmt_approval       (default '0') — when '0', chef-approved party
 *     requisitions land directly in the store inbox (no Mgmt gate). When '1',
 *     the legacy Chef → Mgmt → Store flow applies. Internal kitchen reqs are
 *     never gated by Mgmt (they only need Chef regardless of this setting).
 *
 * GET  /api/admin/party-rules → any signed-in user (UI gates the button)
 * POST /api/admin/party-rules → admin only
 *      body: { require_fp_approval_for_req?, allow_past_day_party_req?,
 *              require_mgmt_approval? }
 *      Only the keys you send are updated; others stay as-is.
 */
export const dynamic = 'force-dynamic';

function readFlag(db: any, key: string, defaultValue: boolean): boolean {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  if (!row) return defaultValue;
  return row.value === '1';
}

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    return Response.json({
      require_fp_approval_for_req: readFlag(db, 'require_fp_approval_for_req', true),
      allow_past_day_party_req:    readFlag(db, 'allow_past_day_party_req',    false),
      require_mgmt_approval:       readFlag(db, 'require_mgmt_approval',       false),
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }
    const db = getDb();
    const b = await request.json();
    const upsert = db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    if (typeof b?.require_fp_approval_for_req === 'boolean') {
      upsert.run('require_fp_approval_for_req', b.require_fp_approval_for_req ? '1' : '0');
    }
    if (typeof b?.allow_past_day_party_req === 'boolean') {
      upsert.run('allow_past_day_party_req', b.allow_past_day_party_req ? '1' : '0');
    }
    if (typeof b?.require_mgmt_approval === 'boolean') {
      upsert.run('require_mgmt_approval', b.require_mgmt_approval ? '1' : '0');
    }
    return Response.json({
      ok: true,
      require_fp_approval_for_req: readFlag(db, 'require_fp_approval_for_req', true),
      allow_past_day_party_req:    readFlag(db, 'allow_past_day_party_req',    false),
      require_mgmt_approval:       readFlag(db, 'require_mgmt_approval',       false),
    });
  } catch (e: any) {
    console.error('[/api/admin/party-rules]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
