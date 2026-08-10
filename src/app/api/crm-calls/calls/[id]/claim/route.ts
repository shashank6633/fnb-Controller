import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { claimCall, overrideCall, type ClaimResult } from '@/lib/ct/call-owner';
import { emitCt, pushRecentCt, type CtEvent } from '@/lib/ct/bus';

/**
 * POST /api/crm-calls/calls/[id]/claim   { override?: boolean }
 *
 * TAKE OWNERSHIP OF AN ANSWERED CALL. The screen-pop broadcasts to every
 * signed-in CRM browser, so an answered call used to sit in front of two GREs
 * who both wrote it up and the second disposition silently overwrote the first.
 * An answered call now belongs to ONE person: they keep the pop, everyone else
 * collapses to a read-only strip naming them.
 *
 * WHEN THIS ROUTE IS THE ONE THAT DECIDES. A MAPPED TeleCMI agent is stamped as
 * the owner by ingest the moment telephony says who picked up (see
 * stampAnsweredOwner in src/lib/ct/ingest.ts) — this route is not involved. An
 * UNMAPPED agent id (5004_33338614 and friends) resolves to no app user at all,
 * so the call arrives UNOWNED and stays that way until a human acts on it. That
 * is the case the owner settled as FIRST CLAIM WINS, and this endpoint is how a
 * browser competes for it.
 *
 * THE RACE IS THE NORMAL CASE, NOT AN EDGE CASE. Two GREs clicking in the same
 * second is what happens every busy evening. Nothing is decided here: the whole
 * decision is claimCall()'s single conditional UPDATE, where the precondition
 * lives in the WHERE clause and the database picks the winner. This route only
 * reports the outcome — and on a loss reports the CURRENT owner, so the loser's
 * browser can draw the strip immediately instead of waiting for a broadcast.
 *
 * HIDING THE POPUP IS NOT A LOCK, AND NEITHER IS THIS ROUTE. Claiming is how a
 * browser ASKS for the write-up; the thing that actually stops a second write is
 * callWriteBlock() on PUT /api/crm-calls/calls/[id]. A browser that never calls
 * this endpoint is not thereby locked out of anything, and one that does is not
 * thereby trusted — the PUT re-checks from the row every time.
 *
 * Responses (the shape the pop codes against):
 *   200 { ok: true,  call_id, owner, ownerName, claimed_at, override }
 *   409 { ok: false, owner, ownerName, reason: 'taken',        error }  ← lost the race
 *   409 { ok: false, owner: '', ownerName: '', reason: 'not_answered', error }
 *   404 { ok: false, ..., reason: 'not_found',      error }
 *   403 { ok: false, ..., reason: 'not_management', error }  ← override by a non-manager
 * `error` is always the lib's own sentence — it names the owner and says when the
 * call frees up, so the client shows it verbatim rather than inventing wording
 * that could contradict what the server will actually allow.
 *
 * override:true is the manager takeover the owner asked for so a bad claim is
 * never stuck. The Admin/Manager/HOD check is NOT repeated here — overrideCall()
 * owns it, so no caller of that function can forget it.
 */
export const dynamic = 'force-dynamic';

/** Refusal reason → HTTP status. 'taken' and 'not_answered' are both 409: the
 *  request was well-formed and the row simply is not in a claimable state. The
 *  client branches on `reason`, never on the status alone. */
const CLAIM_HTTP_STATUS: Record<string, number> = {
  taken: 409,
  not_answered: 409,
  not_found: 404,
  not_management: 403,
  no_user: 401,
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'Not signed in' }, { status: 401 });
  const { id } = await params;

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* body is optional */ }
  const override = body?.override === true;

  const db = getDb();

  // Accept either the internal id or the telecmi_call_id, exactly as
  // ../analyze/route.ts does. The pop often holds ONLY the TeleCMI id: its
  // fallback lookup goes through /api/crm-calls/live, which returns RINGING rows
  // only — and by definition a claimable call has already stopped ringing.
  // Without this the unmapped-agent case (the only case first-claim exists for)
  // would frequently have no id to claim with.
  //
  // This read does NOT reintroduce the read-then-write race: it resolves an
  // alias to a primary key and nothing more. Ownership is still decided by the
  // one conditional UPDATE below, which both racers reach with the same id.
  const row = db.prepare(`
    SELECT id, telecmi_call_id, phone_e164, IFNULL(owner_email, '') AS owner_email
    FROM ct_calls WHERE id = ? OR telecmi_call_id = ? LIMIT 1
  `).get(id, id) as
    { id: string; telecmi_call_id: string | null; phone_e164: string | null; owner_email: string } | undefined;
  if (!row) {
    return Response.json(
      { ok: false, owner: '', ownerName: '', reason: 'not_found', error: 'That call no longer exists.' },
      { status: 404 },
    );
  }
  const ownerBefore = row.owner_email;

  const result: ClaimResult = override
    ? overrideCall(db, row.id, user)
    : claimCall(db, row.id, user.email);

  if (!result.ok) {
    return Response.json(
      { ok: false, owner: result.owner, ownerName: result.ownerName, reason: result.reason, error: result.message },
      { status: CLAIM_HTTP_STATUS[result.reason] ?? 409 },
    );
  }

  // ── Tell every other browser, so their pop collapses to the strip ─────────
  // 'answered' is the CtEvent type ingest already uses to announce ownership of
  // an answered call (ingestLive's answer branch), so the wire stays one shape
  // and the pop needs one handler. The bus is a broadcast — there is no
  // per-user targeting and none is wanted: each browser compares ownerEmail
  // with its own user and decides for itself.
  //
  // SKIPPED WHEN THE OWNER DID NOT CHANGE, i.e. the same person re-claiming
  // their own call (claimCall deliberately lets an owner re-claim so a browser
  // that reconnects mid-call keeps its pop). Every browser was already told the
  // first time, and one that missed that broadcast still picks it up from the
  // ring buffer on its next /api/crm-calls/live poll. This is the only skipped
  // case: a LOST race never reaches here at all, and a won race on a call that
  // was unowned a moment ago always has ownerBefore = '' ≠ the winner. Worth the
  // branch because the Live wallboard renders one feed line per event, and a
  // re-claim is not news.
  if (result.owner.toLowerCase() !== ownerBefore.trim().toLowerCase()) {
    const evt: CtEvent = {
      // 'ownership', NOT 'answered'. A claim happens at CHIP time — after the
      // call has already ended — so broadcasting it as 'answered' printed
      // "Call answered — Ravi K" on the wallboard BELOW "Call ended", minutes
      // late, and re-ran the board's ringing filter for a finished call. The
      // owner changed; the call was not answered again.
      type: 'ownership',
      callId: row.id,
      telecmiCallId: row.telecmi_call_id || undefined,
      phone: row.phone_e164 || undefined,
      // Never '' on this path — a successful claim always has an owner. (ingest
      // is the side that sends '' to announce a call being handed back.)
      ownerEmail: result.owner,
      ownerName: result.ownerName,
      // A successful claim IS a lock, by definition — the claimer now holds it.
      // Sent explicitly so no browser has to infer a lock from the presence of
      // an owner, which is the inference that kept the strip up forever after
      // the lock had already lapsed. freeAtLabel is left to the live poll: the
      // deadline moves with the call, and a value frozen at claim time would go
      // stale the moment the call actually ends.
      locked: true,
      // agentName is deliberately left unset: it means the TELEPHONY agent, and
      // the claimer is precisely the person telephony could not identify.
      at: result.claimedAt,
    };
    emitCt(evt);
    pushRecentCt(evt); // the poll fallback reads the same event out of the buffer
  }

  return Response.json({
    ok: true,
    call_id: row.id,
    owner: result.owner,
    ownerName: result.ownerName,
    claimed_at: result.claimedAt,
    override,
  });
}
