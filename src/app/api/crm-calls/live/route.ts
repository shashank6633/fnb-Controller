import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { latestCtSeq, recentCtSince } from '@/lib/ct/bus';
import {
  agentIdsForEmail, getAgentMap, getUserNamesByEmail, resolveAgentLabel, ringingForLabel,
} from '@/lib/ct/agents';
import { callOwnerColumns, callOwnerState, OWNER_CAP_MINUTES } from '@/lib/ct/call-owner';
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
 *   active   ADMIN ONLY — see "WHO MAY SEE EVERY LIVE CALL" below. Every call
 *            still in progress, ringing AND answered, labelled with who it is
 *            ringing for, who is on it, and whose it is. The key is ABSENT, not
 *            empty, for everyone else.
 *   me       who is asking, as the SERVER sees them (see the `me` block).
 *
 * ── WHO MAY SEE EVERY LIVE CALL ──────────────────────────────────────────────
 * `ringing` is what this route has always returned and it goes to every signed-in
 * caller unchanged: a call that has not been picked up is the floor's problem.
 * `active` is a different thing — it keeps a call on screen for the WHOLE
 * conversation, with the guest, the answerer and the owner on it — and the owner
 * scoped that to an admin ("so the admin can catch how efficiently the GRE's are
 * working"). Widening WHICH CALLS a GRE sees is monitor mode, not labelling.
 *
 * THE GATE IS HERE, ON THE SERVER, AND NOWHERE ELSE. It used to be a client-side
 * `if` in the screen-pop while the route served `active` to everyone, which meant
 * the wallboard (which has no role test at all) handed every in-progress call's
 * guest name, phone, answerer and talk time to any signed-in user — including one
 * with no CRM grant, by plain curl. A hidden control is not a permission.
 *
 * The key is OMITTED rather than sent as [] on purpose: both clients choose their
 * list with `Array.isArray(j.active) ? j.active : j.ringing`, so an absent key
 * falls through to `ringing` — exactly the board a GRE had before this change —
 * whereas an empty array would read as "nothing is live" and blank the board.
 *
 * THE ATTRIBUTION THE SNAPSHOT MUST REPEAT FROM THE STREAM.
 * The bus events name the ringing agent / the answerer / the owner, but a bus is
 * a broadcast in flight: a browser that mounts, reloads, or drops its SSE for a
 * beat gets none of it, and the ring buffer holds 200 events and dies with the
 * process. Every fact the stream carries about WHO IS ON A LIVE CALL is therefore
 * repeated here, resolved the same way by the same helpers:
 *   ringing_agent_name / ringing_group_name
 *                 — ringingForLabel() in @/lib/ct/agents, the SAME ladder and
 *                   the same two rungs the `incoming_call` event carries: a
 *                   named extension, else the ring group, else both ''. The
 *                   group is set only when no person was named. Never a guess,
 *                   and never taken from who missed the previous leg.
 *   agent_display — resolveAgentLabel(), the same name the Call Log, Guest 360
 *                   and the `owned` block below print. On a row that has been
 *                   ANSWERED this is who answered; on a ringing row it is the
 *                   extension being rung, which is already laddered into
 *                   ringing_agent_name — read that one there.
 *   owner_email / owner_name — who holds the write-up.
 *   is_mine       — the server's own answer to "is this call the caller's",
 *                   computed from the SESSION. See the is_mine block.
 *
 * WHAT IT DOES NOT REPEAT — stated so the paragraph above is not read as more
 * than it says. The guest HISTORY the bus events carry (guestSnapshot():
 * total_calls, total_bookings, last_visit_at, badge) is not selected here; these
 * rows carry guest_id, guest_name and guest_tags and nothing else. A card born
 * from this snapshot knows the guest but not their history. That gap is older
 * than this route's `active` list — the `ringing` list has always been this
 * shape — and the render that prints "0 calls · 0 bookings" instead of admitting
 * it does not know is in the screen-pop, not here.
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

/**
 * How far back `active` looks for a call that has been ANSWERED and not yet
 * ended. Deliberately the SAME number as the ownership hard cap rather than a
 * new one: OWNER_CAP_MINUTES exists precisely because a call whose hangup never
 * arrives would otherwise look live forever, and this list has the identical
 * problem and must not disagree about when to stop believing a row.
 *
 * It is NOT applied to ringing rows — those keep the tighter 15-minute bound
 * above, because a 40-minute-old 'ringing' row is a ghost (reconcileLiveEvents
 * sweeps them to 'missed', but only when some other GET happens to run it),
 * whereas a 40-minute-old answered call is just a long conversation.
 */
const ACTIVE_ANSWERED_WINDOW_MS = OWNER_CAP_MINUTES * 60 * 1000;

/** One row of the `active` list, as SELECTed below. */
interface ActiveRow {
  id: string;
  telecmi_call_id: string | null;
  phone_e164: string;
  direction: string;
  status: string;
  agent_user: string;
  queue: string;
  owner_email: string;
  started_at: string;
  answered_at: string;
  guest_id: string | null;
  guest_name: string;
  guest_tags: string;
}

/** The columns labelsOf() reads. Both lists satisfy it; `status` is absent on
 *  the ringing rows, which is exactly what that query already guarantees. */
interface LabelSource {
  agent_user?: string | null;
  queue?: string | null;
  owner_email?: string | null;
  status?: string | null;
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Not signed in' }, { status: 401 });

  const after = Number(new URL(req.url).searchParams.get('after')) || 0;
  const db = getDb();

  // ── ONE LOAD PER REQUEST, AND ONLY IF SOMETHING NEEDS IT ─────────────────
  // getUserNamesByEmail() reads the whole users table and this route is polled
  // every ~5s by every open CRM tab, so it stays lazy: the FIRST caller that
  // actually has a name to resolve loads it, everyone after reuses it, and a
  // poll with nothing to resolve still costs zero. The agent map is one
  // ct_settings row and is now loaded unconditionally because `me.agent_ids`
  // below needs it on every request — an EMPTY agent_ids has to mean "you are
  // mapped to no extension", never "we did not look".
  let namesCache: Record<string, string> | null = null;
  const names = (): Record<string, string> => (namesCache ??= getUserNamesByEmail(db));
  const agentMap = getAgentMap(db);

  // ── IS THE CALLER AN ADMIN? RESOLVED BEFORE ANYTHING IS QUERIED ──────────
  // The base tier the SERVER resolved (an assigned role's base_role wins over
  // the legacy users.role — see @/lib/auth), compared exactly, so every other
  // tier and every unreadable state is false: this FAILS CLOSED. Deliberately
  // NOT isManagement, which includes every Manager and HOD — a much wider
  // audience than the one the owner named. Deliberately NOT canAccessPage,
  // which fails OPEN four ways.
  //
  // It is read HERE, at the top, because it gates the `active` query itself and
  // not merely the key: a non-admin poll must not pay for a list it may not
  // have. `me.is_admin` below reports this same constant.
  const isAdmin = user.role === 'admin';

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

  // ── EVERY CALL STILL IN PROGRESS, RINGING OR ANSWERED ────────────────────
  // `ringing` above is status='ringing' and STAYS that way, byte-for-byte: the
  // screen-pop merges those rows as INCOMING cards and the wallboard prints them
  // under "Ringing now", so an answered call appearing in that list would pop a
  // fresh "Incoming call" for a conversation already in progress.
  //
  // This second list is what lets an ADMIN see a call that is already up — on a
  // board he has just opened, or after a reload mid-conversation. Until it
  // existed the snapshot could only describe calls that had not been answered
  // yet, so a browser that mounted while a call was up learned nothing about it
  // at all — no guest, no agent, no owner — until the next event happened to
  // fire, which on a five-minute call is never.
  //
  // A NON-ADMIN STILL CANNOT RECOVER THEIR OWN ANSWERED CARD AFTER A RELOAD, and
  // that is stated plainly because an earlier version of this comment used that
  // very case to justify serving `active` to everyone — while the screen-pop
  // merged it for admins only, so the gap was never closed for anybody and the
  // whole floor's calls went over the wire for nothing. The gap is exactly as it
  // was before this list existed. Closing it means serving a GRE their OWN
  // in-progress rows and no one else's, which is a separate decision the owner
  // has not been asked for.
  //
  // A SECOND QUERY RATHER THAN A WIDER `WHERE` on the first, deliberately:
  // widening it would put answered rows into the LIMIT 12 that the ringing list
  // is competing for, and a busy minute could then push a genuinely ringing call
  // off a board whose entire job is to show it.
  //
  // NOT RUN AT ALL FOR A NON-ADMIN. It is the gated list (see the header), and
  // it is also by far the more expensive of the two: `status IN (...)` matches
  // every answered call ever recorded and `IFNULL(ended_at,'') = ''` is applied
  // per row, so its cost grows with call HISTORY rather than with the number of
  // live calls. Measured on a throwaway 60k-row database: 3.2 ms against 0.03 ms
  // for the `ringing` query above. better-sqlite3 is synchronous and this route
  // is polled by every open CRM tab, so leaving it to run for the callers that
  // may not even see the result was paying a growing cost for nothing.
  //
  // What remains, for whoever measures this next: an admin's poll still pays it,
  // and it still grows with history rather than with live calls. The whole cost
  // is that idx_ct_calls_status seeks every answered call ever recorded and
  // "not yet ended" is then tested per row. MEASURED, not assumed, at 40k
  // answered rows: a plain (status, ended_at) index barely helps (1.95 ms —
  // IFNULL() on the column is not sargable), while the PARTIAL index
  //   CREATE INDEX IF NOT EXISTS idx_ct_calls_live
  //     ON ct_calls(status, started_at) WHERE IFNULL(ended_at, '') = '';
  // is picked up by the query below exactly as it is written and takes it to
  // 0.015 ms. Not added here: it belongs in initializeSchema() in @/lib/db,
  // which is outside this change.
  const activeCutoff = new Date(Date.now() - ACTIVE_ANSWERED_WINDOW_MS).toISOString();
  const activeRows = !isAdmin ? [] : db.prepare(`
    SELECT c.id, c.telecmi_call_id, c.phone_e164, c.direction, c.status,
           c.agent_user, c.queue,
           IFNULL(c.owner_email, '') AS owner_email,
           COALESCE(NULLIF(c.started_at, ''), c.created_at) AS started_at,
           IFNULL(c.answered_at, '') AS answered_at,
           COALESCE(NULLIF(c.guest_id, ''), gp.id) AS guest_id,
           COALESCE(NULLIF(g.name, ''), NULLIF(gp.name, ''), '') AS guest_name,
           COALESCE(g.tags, gp.tags, '[]') AS guest_tags
    FROM ct_calls c
    LEFT JOIN ct_guests g  ON g.id = c.guest_id
    LEFT JOIN ct_guests gp ON (c.guest_id IS NULL OR c.guest_id = '')
                          AND gp.phone_e164 = c.phone_e164
    WHERE IFNULL(c.ended_at, '') = ''
      AND c.status IN ('ringing', 'answered')
      AND COALESCE(NULLIF(c.started_at, ''), c.created_at)
          >= CASE WHEN c.status = 'ringing' THEN ? ELSE ? END
    -- RINGING FIRST, then newest first. The LIMIT is the reason: this list holds
    -- both kinds, so ordering by time alone lets twelve newer ANSWERED rows push
    -- a call that is still ringing off the end — the exact eviction the second
    -- query above exists to prevent, reappearing inside it. A phone that is
    -- ringing right now is the only thing on this board anyone can still act on,
    -- so it can never lose its slot to a conversation already in progress.
    -- (Both renderers already group ringing first, so nothing on screen moves.)
    ORDER BY CASE WHEN c.status = 'ringing' THEN 0 ELSE 1 END,
             COALESCE(NULLIF(c.started_at, ''), c.created_at) DESC
    LIMIT 12
  `).all(cutoff, activeCutoff) as ActiveRow[];

  // ── WHOSE CALL IS THIS? THE SERVER ANSWERS, NOT THE BROWSER ──────────────
  // The bus is a broadcast and cannot carry a per-viewer answer, so today a
  // client works "is this mine" out for itself by comparing emails. That is fine
  // as presentation and useless as a fact: it depends on the client having
  // fetched its own identity, and it cannot see the agent map at all (that is
  // admin-only, and rightly so). This request is AUTHENTICATED, so it can just
  // say.
  //
  // THE LADDER, and what each rung is worth:
  //   owner_email is set → it decides, full stop. Ownership is the record of who
  //     actually holds the write-up (src/lib/ct/call-owner.ts) and it already had
  //     the agent map applied server-side when it was stamped.
  //   unowned, agent_user names one of MY mapped extensions → mine. This is the
  //     only way a RINGING call can be "mine": a ringing call has no owner by
  //     construction.
  //   unowned, agent_user IS my own login email → mine. Device-dialed callbacks
  //     store the GRE's email in that column (see @/lib/ct/agents header).
  //   anything else → FALSE.
  //
  // FALSE MEANS "NOT ESTABLISHED AS YOURS", NOT "SOMEBODY ELSE'S". An unowned
  // call that names no agent — every missed call, and every ring on this account
  // today — is false for everyone, and it must stay first-claim for everyone.
  // A caller that reads false as "another GRE's" would hide the recovery queue's
  // own calls from the people meant to chase them.
  const myEmail = String(user.email || '').trim();
  const myEmailLower = myEmail.toLowerCase();
  const myAgentIds = agentIdsForEmail(agentMap, myEmail);
  const myIdentities = new Set<string>(myAgentIds.map(s => s.toLowerCase()));
  if (myEmailLower) myIdentities.add(myEmailLower);
  const isMine = (ownerEmail: string, agentUser: string): boolean => {
    const owner = ownerEmail.trim().toLowerCase();
    if (owner) return !!myEmailLower && owner === myEmailLower;
    const a = agentUser.trim().toLowerCase();
    return !!a && myIdentities.has(a);
  };

  /** Falls back to the email so an owner is never rendered as blank — a strip
   *  that names nobody reads as "unowned", which is the opposite of the truth
   *  and would invite a second GRE to start writing. */
  const ownerNameOf = (ownerEmail: string): string =>
    ownerEmail ? (names()[ownerEmail.toLowerCase()] || ownerEmail) : '';

  /**
   * The labels every live surface needs, resolved once per row through the SAME
   * helpers the bus events use, so the pop, the wallboard and this snapshot
   * cannot disagree about what to call the same person or the same group.
   *
   * ringing_agent_name / ringing_group_name are the SAME two rungs the
   * `incoming_call` event carries under those names, from the same function, and
   * with the same rule: the group is set ONLY when no person was named. They are
   * asked ONLY of a row that is still ringing — once a call is answered "who is
   * it ringing for" has no live answer, the phones stopped, and leaving a stale
   * one on the row would have a card announcing a ring that is over.
   */
  const labelsOf = (r: LabelSource) => {
    const agentUser = String(r.agent_user || '').trim();
    const ownerEmail = String(r.owner_email || '').trim();
    // `ringing` rows carry no status column — that query IS `WHERE status =
    // 'ringing'`, so an absent status here means ringing and nothing else. The
    // `active` rows select it, and there it is read for real.
    const stillRinging = String(r.status || 'ringing') === 'ringing';
    const ringFor = stillRinging
      ? ringingForLabel(agentUser, r.queue, agentMap, agentUser ? names() : {})
      : null;
    return {
      agent_user: agentUser,
      // Unmapped ids resolve to the raw id, never to blank — resolveAgentLabel's
      // documented contract, and the right one here: "5002" tells a GRE somebody
      // has it and the extension is unmapped, where a blank teaches them nothing.
      agent_display: agentUser ? resolveAgentLabel(agentUser, agentMap, names()) : '',
      ringing_agent_name: ringFor?.kind === 'agent' ? ringFor.label : '',
      ringing_group_name: ringFor?.kind === 'group' ? ringFor.label : '',
      owner_email: ownerEmail,
      owner_name: ownerNameOf(ownerEmail),
      is_mine: isMine(ownerEmail, agentUser),
    };
  };

  const ringing = rows.map(r => {
    let tags: string[] = [];
    try { const t = JSON.parse(r.guest_tags || '[]'); if (Array.isArray(t)) tags = t; } catch { /* keep [] */ }
    const { guest_tags: _drop, ...rest } = r;
    return {
      ...rest,
      guest_tags: tags,
      // ADDITIVE: agent_display, ringing_agent_name, ringing_group_name and
      // is_mine are new; owner_email and owner_name keep exactly the values and
      // the meanings they always had.
      ...labelsOf(r),
    };
  });

  const active = activeRows.map(r => {
    let tags: string[] = [];
    try { const t = JSON.parse(r.guest_tags || '[]'); if (Array.isArray(t)) tags = t; } catch { /* keep [] */ }
    const { guest_tags: _drop, ...rest } = r;
    return {
      ...rest,
      guest_tags: tags,
      ...labelsOf(r),
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
    //
    // It now goes through the request-wide lazy loader declared at the top of
    // this handler instead of calling getUserNamesByEmail() a second time: the
    // `ringing`/`active` lists above very often loaded it already, and two loads
    // of the same table in one request is pure waste. The TEST is unchanged, so
    // a request where nothing needs a name still loads nothing.
    const anyAgent = oRows.some(r => String(r.agent_user || '').trim());
    const nameMap = anyAgent || oRows.some(r => String(r.owner_email || '').trim())
      ? names()
      : undefined;
    owned = oRows.map(r => {
      const st = callOwnerState(db, r, user, nameMap);
      const agentUser = String(r.agent_user || '').trim();
      return {
        id: String(r.id),
        owner_email: st.ownerEmail,
        owner_name: st.ownerName,
        locked: st.locked,
        can_write: st.canWrite,
        free_at_label: st.freeAtLabel,
        agent_user: agentUser,
        // agentMap is the request-wide one (loaded once, at the top). Same
        // resolution, same fallback to the raw id; a row with no agent still
        // resolves to '' without touching it.
        agent_display: agentUser ? resolveAgentLabel(agentUser, agentMap, nameMap || {}) : '',
      };
    });
  }

  return Response.json({
    seq: latestCtSeq(),
    events: recentCtSince(after),
    ringing,
    // ADDITIVE, ADMIN ONLY, and a SUPERSET of `ringing` — the same call appears
    // in both when it is still ringing. A client renders ONE of the two lists,
    // never both. Rows carry status, so "ringing for" and "answered by" are the
    // same list read at two moments rather than two lists that can disagree.
    //
    // THE KEY IS ABSENT FOR A NON-ADMIN, never []. Both clients pick their list
    // with `Array.isArray(j.active) ? j.active : j.ringing`, so absent falls
    // through to the ringing-only board a GRE has always had, while an empty
    // array would be read as "nothing is live" and wipe it. See the header.
    ...(isAdmin ? { active } : {}),
    // ADDITIVE. Empty array unless ?owned= was passed, so every existing caller
    // is byte-for-byte unaffected.
    owned,
    // ── WHO IS ASKING, AS THE SERVER SEES THEM ────────────────────────────
    // So a client never has to assert its own identity or role to decide what
    // to show. Every field is about the CALLER and nobody else.
    //
    //   is_admin   — the SAME constant that gated `active` above (see the
    //                isAdmin block for why it is an exact compare on the
    //                server-resolved tier and why it is not isManagement). It is
    //                reported so a client can explain itself; it is not what
    //                decides what this response contains. That decision was made
    //                server-side before the query ran, which is the only place
    //                it can be made.
    //   agent_ids  — the caller's OWN agent_map keys, nobody else's, so the
    //                (admin-only) agent map never leaves the server. [] means
    //                "no extension is mapped to you".
    //                NOTHING READS IT TODAY, and the claim that it is "what lets
    //                a browser be told this ringing call is for you" was wrong:
    //                that question is answered per row by `is_mine` above, which
    //                is computed here from the same ids. It is kept because it
    //                is cheap, is about the caller alone, and is the fact a
    //                client would need to explain an is_mine to its user — but
    //                it is not load-bearing, and nothing should be built on the
    //                assumption that it is being consumed.
    //
    // NOT a permission check and not a lock: this route hands out facts. What a
    // viewer may WRITE is still decided by callOwnerState / the PUT on
    // /api/crm-calls/calls/[id], and hiding a control on the strength of
    // is_admin changes what a screen shows, never what the server accepts.
    //
    // It is a SNAPSHOT: an admin who maps a new extension mid-shift changes
    // agent_ids for that user only from their next poll onward.
    me: {
      email: myEmail,
      name: String(user.name || ''),
      is_admin: isAdmin,
      agent_ids: myAgentIds,
    },
    // ADDITIVE: are the Live-board call hints switched on? Two ct_settings
    // reads piggy-backed on a request the board already makes, so a board
    // running with the (default) flags off issues NO extra HTTP call and
    // touches no guest/call/order data. Only when a flag is true does the
    // client go on to ask /api/crm-calls/live/routing for the hints.
    routing: { sticky_agent: isStickyAgentOn(db), vip_routing: isVipRoutingOn(db) },
  });
}
