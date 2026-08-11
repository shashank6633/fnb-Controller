import { getDb, logAuditEvent } from '@/lib/db';
import { requireRole, getCurrentUser } from '@/lib/auth';
import { rotateWebhookToken, webhookToken } from '@/lib/ct/settings';

/**
 * POST /api/crm-calls/settings/rotate-webhook — mint a new webhook token.
 *
 * WHY THIS IS ITS OWN ROUTE. The ordinary settings PUT deliberately REFUSES to
 * write webhook_token (WRITE_BLOCKED_KEYS in ../route.ts) so that no caller can
 * choose one. Rotation must therefore be a separate, explicit action that
 * generates the value server-side and never reads one from the body — folding it
 * into the settings PUT would mean relaxing that block, which is the one thing
 * that must not happen.
 *
 * THIS BREAKS CALL INGESTION UNTIL TeleCMI IS RECONFIGURED. The old URLs stop
 * being accepted the instant this returns; calls arriving in the gap are lost,
 * not queued. Hence the explicit confirm below — a rotate reached by a stray
 * click during service would silently drop the evening's calls.
 *
 * ADMIN ONLY, and /api/crm-calls is a CSRF-required prefix (src/proxy.ts), so
 * this inherits the same double-submit check as every other state change here.
 *
 * The response carries the NEW URLs, relative, exactly as GET does — the client
 * prepends its own origin so the same code works on localhost and production.
 * The token is returned ONCE, because it is the only way the admin can paste it
 * into TeleCMI; it is never written to the audit trail.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  // Explicit intent required. Not a nicety: the cost of an accidental rotate is
  // silent, and it lands on whoever is on the phone at the time.
  let body: any = null;
  try { body = await req.json(); } catch { /* no body → not confirmed */ }
  if (body?.confirm !== true) {
    return Response.json(
      {
        error: 'Rotating the webhook token stops TeleCMI from reaching this app until '
          + 'both URLs are updated there. Calls in that gap are lost, not queued. '
          + 'Re-send with { "confirm": true } once you are ready to paste the new URLs.',
      },
      { status: 400 },
    );
  }

  const db = getDb();
  const me = await getCurrentUser();
  const before = webhookToken(db);

  const res = rotateWebhookToken(db);
  if (!res.ok) return Response.json({ error: res.error }, { status: 409 });

  // Security-relevant, so it is recorded — but the token itself never goes in.
  // A fingerprint (first 6 of the OLD one) is enough to tell two rotations apart
  // in the log without putting a live credential in a table admins can read.
  try {
    logAuditEvent(db, {
      event_type: 'crm.webhook_token.rotate',
      entity_type: 'ct_settings',
      entity_id: 'webhook_token',
      actor_email: me?.email || 'admin',
      after: { rotated: true, previous_fingerprint: before.slice(0, 6) },
      note: 'CRM webhook token rotated — both TeleCMI URLs must be updated.',
    });
  } catch { /* audit must never break the action */ }

  return Response.json({
    ok: true,
    // Relative on purpose — the client prepends its origin, so this is correct
    // on localhost, testing and production without storing a hostname.
    webhook_cdr_url: `/api/telecmi/webhook/cdr/${res.token}`,
    webhook_live_url: `/api/telecmi/webhook/live/${res.token}`,
    note: 'Old URLs are already refused. Update BOTH in TeleCMI now — the CDR one '
      + 'and the live one are configured separately.',
  });
}
