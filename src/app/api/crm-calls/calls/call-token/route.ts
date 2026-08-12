import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { normalizePhone } from '@/lib/ct/phone';
import { issueCallToken } from '@/lib/ct/call-token';

/**
 * POST /api/crm-calls/calls/call-token  (authed)
 *
 * Mint the wall-clock receipt for an outbound Call Back the GRE is ABOUT to
 * place. The client calls this the moment Call Back is tapped and BEFORE it
 * fires the dial intent, carries the returned id through the round trip, and
 * hands it back to log-callback with the duration.
 *
 * WHY IT EXISTS. The TeleCMI plan has no outbound package, so the talk time
 * always arrives from the client — the Captain APK's deep link carries it in a
 * plain, unsigned query string, and log-callback is a POST any signed-in staff
 * account can make. Nothing in either path is evidence. This endpoint gives the
 * server one fact of its own: WHEN dialling started, on the server clock. The
 * redemption in src/lib/ct/call-token.ts then clamps the claimed duration to
 * the wall time elapsed since — you cannot have talked longer than you have
 * been dialling — and spends the token, so the same token cannot vouch for a
 * second call. It does NOT stop a second call ROW: log-callback records the
 * call whether or not a token survives, by design, so a replay still writes a
 * row and simply carries duration_verified = 0. The token bounds the CLAIM;
 * what bounds the rows is the de-dupe and burst ceiling in log-callback.
 *
 * FAILING HERE MUST NEVER STOP A CALL. Every non-2xx below is survivable: the
 * client is required to dial anyway and log the call unverified. Losing a real
 * guest call to protect a statistic would be a far worse bug than the one this
 * closes. Nothing in this route has a side effect the caller must undo.
 *
 * Body: { phone?, guest_id?, recovery_id? }   — at least one way to resolve the
 *   number, resolved in the SAME order as log-callback (see the note below).
 * → 200 { ok: true, token }
 *   400 unresolvable number · 401 not signed in · 404 unknown recovery
 *   429 more than MINT_BURST_MAX tokens from this agent in the last minute
 *   500 the token could not be bound to an agent + number
 *
 * CSRF: /api/crm-calls is in CSRF_REQUIRED_PREFIXES (src/proxy.ts), and the
 * check is a startsWith over the pathname, so this route inherits it exactly
 * like its siblings — the proxy also re-validates the session for every
 * state-changing /api call before the handler runs.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const db = getDb();

  // ── Resolve the phone EXACTLY as log-callback does ──────────────────────
  // This mirrors src/app/api/crm-calls/calls/log-callback/route.ts (the
  // recovery's own number wins, then body.phone, then the guest's number). The
  // two MUST agree: redemption matches the token's number against the number
  // the call is finally logged against, so a different order here would fail
  // real GREs with 'wrong_phone'. Deliberately duplicated rather than shared,
  // because the resolver lives inside a committed route file — see the note in
  // this change's handoff about lifting it into src/lib/ct/.
  const recoveryId = String(body.recovery_id || '').trim();
  let recovery: any = null;
  if (recoveryId) {
    recovery = db.prepare('SELECT * FROM ct_recoveries WHERE id = ?').get(recoveryId);
    if (!recovery) return Response.json({ error: 'recovery not found' }, { status: 404 });
  }

  const guestId = String(body.guest_id || '').trim() || (recovery?.guest_id ?? '');
  let phone = recovery ? normalizePhone(recovery.phone_e164) : '';
  if (!phone) phone = normalizePhone(body.phone);
  if (!phone && guestId) {
    const g = db.prepare('SELECT phone_e164 FROM ct_guests WHERE id = ?').get(guestId) as any;
    phone = normalizePhone(g?.phone_e164);
  }
  if (!phone) {
    return Response.json(
      { error: 'Could not resolve a phone number to dial (pass phone, guest_id, or recovery_id)' },
      { status: 400 },
    );
  }

  // agent_email is the SIGNED-IN user, never a body field — a token that could
  // be minted for someone else would verify their calls.
  try {
    const { id } = issueCallToken(db, { agentEmail: me.email, phone, recoveryId });
    return Response.json({ ok: true, token: id });
  } catch (e: any) {
    // Two throws, two answers, and BOTH are survivable — mintCallToken treats
    // any non-2xx the same way (return '' and dial). The status code is for
    // whoever reads the logs: 429 is a caller in a loop, 500 is a bug here.
    //
    // Minting is bounded per agent because it is one INSERT per authenticated
    // POST and nothing else — cheap enough to loop, and the 24h prune bounds
    // this table in time but not in size. Refusing costs an unverified call and
    // nothing more, which is the same as being offline.
    if (e?.code === 'rate_limited') {
      return Response.json(
        { error: 'Too many call-back attempts in the last minute. The call can still be placed and logged; it will not be marked verified.' },
        { status: 429 },
      );
    }
    // Otherwise the token would have been bound to nothing (no agent /
    // unnormalizable number). Answer honestly and let the client dial: an
    // unverified call is a small loss, a missed call back is a real one.
    return Response.json(
      { error: e?.message || 'Could not issue a call token' },
      { status: 500 },
    );
  }
}
