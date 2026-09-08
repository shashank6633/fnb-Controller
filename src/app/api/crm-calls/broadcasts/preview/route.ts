/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { parseAudience, previewAudience } from '@/lib/wa-broadcast';

/**
 * POST /api/crm-calls/broadcasts/preview — resolve an audience definition to
 * counts + a sample + a cost estimate WITHOUT writing anything.
 *
 * Returns eligible_now plus every exclusion with its reason (no phone /
 * duplicate / opted out / cooldown). ADVISORY ONLY: consent, cooldown and the
 * daily cap are re-checked server-side when each message is actually claimed
 * for sending — a STOP that arrives after this preview still wins.
 *
 * Management-only.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const audience = parseAudience(body?.audience);
  if (!audience) {
    return Response.json({
      error: "audience must be one of: {kind:'all_guests'} | {kind:'winback', days} | {kind:'min_visits', visits} | {kind:'birthday_month', month} | {kind:'tier', tier} | {kind:'phones', phones:[…]}",
    }, { status: 400 });
  }

  return Response.json({ audience, preview: previewAudience(getDb(), audience) });
}
