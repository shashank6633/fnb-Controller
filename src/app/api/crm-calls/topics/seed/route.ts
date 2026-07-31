import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { seedExampleRules, listRules, SEED_RULES } from '@/lib/ct/topics';

/**
 * CRM — Topic Alerts · load the example rules (/api/crm-calls/topics/seed).
 *
 * POST → inserts the 4 starter rules (birthday/anniversary, complaint, large
 *        group enquiry, dietary request) that don't already exist, ALWAYS
 *        INACTIVE. Idempotent: an existing rule with the same name is skipped,
 *        never overwritten, so a venue that has edited a starter keeps its
 *        edits.
 *
 * This is an explicit button, not a boot migration: seeding rules is an admin
 * decision, and a boot-time write would re-add rules the venue deliberately
 * deleted on every deploy (see scripts/check-boot-migrations.js for why that
 * matters here).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const db = getDb();
  const { created, skipped } = seedExampleRules(db, me.email || me.name || 'system');

  return Response.json({
    success: true,
    created,
    skipped,
    available: SEED_RULES.map(r => r.name),
    rules: listRules(db),
  });
}
