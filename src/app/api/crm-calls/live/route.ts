import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { latestCtSeq, recentCtSince } from '@/lib/ct/bus';
import { getAgentMap, getUserNamesByEmail, resolveAgentLabel } from '@/lib/ct/agents';
import { callOwnerColumns, callOwnerState } from '@/lib/ct/call-owner';
import { isStickyAgentOn, isVipRoutingOn } from '@/lib/ct/routing';

/**
 * GET /api/crm-calls/live?after=<seq> — polling fallback for the screen-pop.
 *
 * When the SSE stream (/api/crm-calls/events) drops, CTScreenPop polls this
 * every ~5s. Returns:
 *   seq      latest ring-buffer sequence — client passes it back as ?after=
 *   events   bus events with seq > after (same CtEvent shape as the stream)
 *   ringing  currently-ringing calls (newest 10, guest joined) so a client
 *            that reconnects mid-ring still pops the card. Bounded to the
 *            last 15 min: reconcileLiveEvents() marks stale ringing rows
 *            missed on the next sweep, but the sweep runs on other GETs —
 *            never resurface hours-old "ringing" ghosts here.
 *            Each row also carries owner_email + owner_name (see below).
 *
 * OWNERSHIP ON THE SNAPSHOT. An answered call belongs to one person
 * (src/lib/ct/call-owner.ts) and every browser needs to know who, so the rows
 * here carry it rather than making the pop ask per call. In practice it is
 * almost always '' — this list is scoped to status='ringing' and a ringing call
 * is not yet ownable — but it is NOT dead: a row whose answered_at landed while
 * its status update did not is both claimable and still listed here, and the
 * client gets one uniform shape either way.
 *
 * owner_email is the RECORD of the claim, not the lock. The lock lapses on
 * disposition or 15 min after the call ends while owner_email deliberately stays
 * put as the audit trail, so "owner_email is set" must never be read as "locked".
 * The only authority on whether a write is allowed is the server check on
 * PUT /api/crm-calls/calls/[id].
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const RINGING_WINDOW_MS = 15 * 60 * 1000;

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Not signed in' }, { status: 401 });

  const after = Number(new URL(req.url).searchParams.get('after')) || 0;
  const db = getDb();

  const cutoff = new Date(Date.now() - RINGING_WINDOW_MS).toISOString();
  const rows = db.prepare(`
    SELECT c.id, c.telecmi_call_id, c.phone_e164, c.direction, c.agent_user, c.queue,
           IFNULL(c.owner_email, '') AS owner_email,
           COALESCE(NULLIF(c.started_at, ''), c.created_at) AS started_at,
           COALESCE(NULLIF(c.guest_id, ''), gp.id) AS guest_id,
           COALESCE(NULLIF(g.name, ''), NULLIF(gp.name, ''), '') AS guest_name,
           COALESCE(g.tags, gp.tags, '[]') AS guest_tags
    FROM ct_calls c
    LEFT JOIN ct_guests g  ON g.id = c.guest_id
    LEFT JOIN ct_guests gp ON (c.guest_id IS NULL OR c.guest_id = '')
                          AND gp.phone_e164 = c.phone_e164
    WHERE c.status = 'ringing'
      AND COALESCE(NULLIF(c.started_at, ''), c.created_at) >= ?
    ORDER BY COALESCE(NULLIF(c.started_at, ''), c.created_at) DESC
    LIMIT 12
  `).all(cutoff) as any[];

  // email → display name, loaded ONCE for the whole page of rows and only when a
  // row actually has an owner. This poll runs every ~5s in every open CRM tab,
  // and the normal answer is "no owners here at all" (ringing calls are not yet
  // ownable), so the usual cost of ownership on this route is exactly zero extra
  // queries — and never one per row.
  const ownerNames = rows.some(r => String(r.owner_email || '').trim())
    ? getUserNamesByEmail(db)
    : null;

  const ringing = rows.map(r => {
    let tags: string[] = [];
    try { const t = JSON.parse(r.guest_tags || '[]'); if (Array.isArray(t)) tags = t; } catch { /* keep [] */ }
    const { guest_tags: _drop, ...rest } = r;
    const ownerEmail = String(r.owner_email || '').trim();
    return {
      ...rest,
      guest_tags: tags,
      owner_email: ownerEmail,
      // Falls back to the email so an owner is never rendered as blank — a
      // strip that names nobody reads as "unowned", which is the opposite of
      // the truth and would invite a second GRE to start writing.
      owner_name: ownerEmail ? (ownerNames?.[ownerEmail.toLowerCase()] || ownerEmail) : '',
    };
  });

  // ── AUTHORITATIVE OWNERSHIP FOR CARDS ALREADY ON SCREEN ──────────────────
  // ?owned=id1,id2 — the pop passes the calls it is currently showing and gets
  // back the SERVER's verdict for THIS viewer on each.
  //
  // WHY THIS EXISTS RATHER THAN THE CLIENT WORKING IT OUT. A lock lapses with
  // the passage of time (the write-up window, then the hard cap), and time
  // passing fires no event — so a browser told "locked" at 19:05 would still be
  // showing the strip at 19:21, long after the server opened the call to
  // everyone. The alternatives were both worse: re-deriving the deadline in the
  // browser puts a second copy of the rule where it can drift from the real one,
  // and a dedicated per-card endpoint would add a request per card. This rides
  // on a poll the board already makes every ~5s.
  //
  // canWrite is honest here in a way it can never be on the SSE broadcast: this
  // is an authenticated request, so we know who is asking. Management sees
  // locked=true (so the strip still names the owner) together with canWrite=true
  // (so their chips stay live) — which is exactly the owner's rule, and it comes
  // from isManagement inside callOwnerState rather than any second definition.
  //
  // WHO ANSWERED RIDES ALONG (agent_user + agent_display). ADDITIVE — every key
  // above keeps its name and its meaning; these two are new.
  //
  // WHY THEY ARE HERE AND NOT ONLY ON THE BUS. The pop learns the answerer from
  // the live 'answered' event, which carries whatever agentDisplayName() could
  // make of the agent id the LIVE webhook happened to send. When that payload
  // names no agent at all the card stays anonymous — "ON CALL 0:33" with nobody
  // on it — for the whole call, because the only other chance to learn the name
  // is the CDR, which lands after the call is over and is therefore too late to
  // be of any use to the person holding the phone.
  //
  // The pop already asks this route about these very cards every few seconds, so
  // this is the SELF-HEAL path: the moment the server learns who has the call —
  // a later live event that does carry the id, the CDR, or an admin mapping the
  // extension in CRM Settings — the next poll carries the name and the card
  // fills it in. No new request, no request per card.
  //
  // agent_display is resolved EXACTLY as /api/crm-calls/calls resolves it
  // (resolveAgentLabel with the agent_map + user names), so the pop, the Call
  // Log and Guest 360 can never disagree about what to call the same person. An
  // unmapped id resolves to the raw id rather than to blank — that is
  // resolveAgentLabel's documented contract and the right one here: "Answered by
  // 5002" tells a GRE somebody has it and the extension is unmapped, where a
  // blank teaches them nothing.
  const ownedIds = String(new URL(req.url).searchParams.get('owned') || '')
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  let owned: Array<{ id: string; owner_email: string; owner_name: string;
                     locked: boolean; can_write: boolean; free_at_label: string;
                     agent_user: string; agent_display: string }> = [];
  if (ownedIds.length) {
    const ph = ownedIds.map(() => '?').join(',');
    const oRows = db.prepare(
      `SELECT c.id, c.agent_user, ${callOwnerColumns('c')} FROM ct_calls c WHERE c.id IN (${ph})`,
    ).all(...ownedIds) as any[];
    // One name map for the whole batch, never one query per row. Now also
    // needed by an agent id (a mapped agent resolves THROUGH an email to a
    // user's name), so the "is it worth loading" test covers both — and a batch
    // with neither an owner nor an agent still costs zero extra queries.
    const anyAgent = oRows.some(r => String(r.agent_user || '').trim());
    const names = anyAgent || oRows.some(r => String(r.owner_email || '').trim())
      ? getUserNamesByEmail(db)
      : undefined;
    // The agent_map is one ct_settings read, and only an agent id can use it.
    const agentMap = anyAgent ? getAgentMap(db) : null;
    owned = oRows.map(r => {
      const st = callOwnerState(db, r, user, names);
      const agentUser = String(r.agent_user || '').trim();
      return {
        id: String(r.id),
        owner_email: st.ownerEmail,
        owner_name: st.ownerName,
        locked: st.locked,
        can_write: st.canWrite,
        free_at_label: st.freeAtLabel,
        agent_user: agentUser,
        agent_display: agentUser && agentMap
          ? resolveAgentLabel(agentUser, agentMap, names || {})
          : '',
      };
    });
  }

  return Response.json({
    seq: latestCtSeq(),
    events: recentCtSince(after),
    ringing,
    // ADDITIVE. Empty array unless ?owned= was passed, so every existing caller
    // is byte-for-byte unaffected.
    owned,
    // ADDITIVE: are the Live-board call hints switched on? Two ct_settings
    // reads piggy-backed on a request the board already makes, so a board
    // running with the (default) flags off issues NO extra HTTP call and
    // touches no guest/call/order data. Only when a flag is true does the
    // client go on to ask /api/crm-calls/live/routing for the hints.
    routing: { sticky_agent: isStickyAgentOn(db), vip_routing: isVipRoutingOn(db) },
  });
}
