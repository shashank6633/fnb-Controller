/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { resolveRecipients, MAX_REPORT_RECIPIENTS } from '@/lib/wa-report-recipients';

/**
 * POST /api/crm-calls/reports/resolve — who would actually receive this?
 *
 * ── WHY A PREVIEW ENDPOINT EXISTS AT ALL ─────────────────────────────────
 * "Management" and "HOD — Akan Bar" are the right way to address a report:
 * they follow the job when the person changes. They are also the wrong thing
 * to show an admin at the moment they click Save, because a group is not a
 * promise that anyone will receive anything. Two failure modes this makes
 * visible BEFORE the setting is written:
 *
 *   · a group that resolves to NOBODY — a department with no senior staff
 *     assigned. Ticking it looks like coverage and delivers silence.
 *   · a person with NO WHATSAPP NUMBER on file. They are listed as
 *     unreachable, by name, instead of quietly not being in the send list.
 *
 * The saved setting is still the GROUP, not this snapshot — resolution happens
 * again at send time, every time, so the preview is a preview and never a
 * frozen copy that rots.
 *
 * Read-only: resolves and returns. Writes nothing, sends nothing.
 * Management-readable, matching the config page it serves.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!isManagement(me)) {
    return Response.json({ error: 'Scheduled reports are limited to admins, managers and heads of department.' }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as any;
  const audience = Array.isArray(body?.audience) ? body.audience : [];
  const manual = Array.isArray(body?.manual) ? body.manual : String(body?.manual ?? '');

  const r = resolveRecipients(getDb(), { audience, manual });
  return Response.json({
    recipients: r.recipients,
    unreachable: r.unreachable,
    empty_tokens: r.emptyTokens,
    capped: r.capped,
    count: r.recipients.length,
    max: MAX_REPORT_RECIPIENTS,
  });
}
