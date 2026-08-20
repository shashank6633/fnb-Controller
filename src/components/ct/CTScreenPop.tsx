'use client';

/**
 * CT Screen-Pop — the "killer feature" of the Call-to-Table CRM.
 *
 * Mounted by src/app/crm-calls/layout.tsx, so the pop lives on every
 * /crm-calls/* page (and ONLY there — documented decision: GREs work inside
 * the CRM section; app-wide popping would interrupt KDS/cashier screens).
 *
 * Transport: EventSource('/api/crm-calls/events') primary; on error falls
 * back to polling /api/crm-calls/live?after=<seq> every 5s while retrying
 * SSE every 30s (same pattern as the Live Calls wallboard). The SAME route,
 * with &owned=<ids>, is also asked on a slow timer while a card is showing a
 * lock — because a lock lapses on a clock and a clock fires no event. See THE
 * LOCK CLOCK below.
 *
 * Behavior contract (CRM_DECISIONS.md §5.1):
 * - incoming_call → slide-in card top-right (below the floating bell).
 *   Known guest: name, VIP/tags, badge, calls/bookings counts, last visit
 *   (IST). Unknown: "New caller" + phone + name mini-form → Create Guest.
 * - answered for the SAME call does NOT dismiss the card either — it moves to
 *   ON-CALL mode: the header stops saying "Incoming call", the ring counter is
 *   replaced by talk time counted from the answer, and the card NAMES whoever
 *   picked up. See THREE CARD STATES below.
 * - call_ended for the SAME call: OWNER-ONLY DISPOSITION (owner ruling
 *   2026-08-17). When the ended call has a known owner (a mapped agent
 *   answered it), every OTHER browser's card is auto-dismissed on hangup —
 *   the answerer alone keeps the card, switched to disposition mode: 7
 *   one-tap chips → PUT /api/crm-calls/calls/[id]. "Booking Made" opens
 *   QuickBookingModal (pre-filled source_call_id) and dispositions after the
 *   booking saves. The card is kept on EVERY screen when there is no owner to
 *   hand it to: a MISSED call (nobody answered — the whole floor should see
 *   it needs chasing) or an UNMAPPED agent's answer (ownerEmail '', so
 *   first-claim decides who writes it up), and on a browser whose own
 *   identity is unknown (/api/auth/me failed — we cannot prove it is not the
 *   owner's screen, so we must not take the write-up card away).
 * - Multiple simultaneous calls stack, up to MAX_CARDS.
 *
 * ── THREE CARD STATES, AND WHY THE MIDDLE ONE HAD TO EXIST ──────────────────
 * `mode` used to be 'ringing' | 'disposition', with the `answered` event
 * deliberately applying ownership and nothing else. That is why a GRE could be
 * two minutes into a conversation while the pop still read "INCOMING CALL 158s"
 * with the ring counter climbing — the card had no answered state to move to, so
 * it stayed in the only other one it had. It also had nowhere to put the
 * answerer's name, which is the thing the person at the desk actually wants to
 * see, and which Guest 360 has always been able to show from the settled row.
 *
 *   ringing      what it says. Ring seconds. Quick Booking available.
 *   answered     "On call", talk seconds from answeredAt, "Answered by X".
 *                Quick Booking stays — mid-call is exactly when a GRE books.
 *   disposition  the call is over: the 7 outcome chips.
 *
 * The card is never auto-dismissed on ANSWER — a GRE who has just picked up
 * must not have the guest's history yanked out from under them, and everyone
 * else's card flipping to "Answered by X" is how the floor learns the call is
 * handled. On HANGUP the owner-only rule above applies: the answerer keeps the
 * disposition card (the write-up is its whole point); other screens let go.
 * What also goes away is the LIE: a card that has heard nothing for
 * RING_STALE_SECONDS stops counting and says so, instead of implying a phone
 * is still ringing somewhere.
 *
 * ── ONE ANSWERED CALL, ONE OWNER ────────────────────────────────────────────
 * This pop broadcasts to EVERY signed-in CRM browser, so an answered call used
 * to sit in front of two GREs who both wrote it up — the second disposition
 * silently overwrote the first. An answered call now has one owner, and every
 * other browser collapses that card to a slim read-only strip naming them.
 *
 * WHAT THIS FILE IS AND IS NOT. It is presentation. The lock is the server
 * check (callWriteBlock() in src/lib/ct/call-owner.ts) applied by
 * PUT /api/crm-calls/calls/[id]; hiding a popup stops nothing, since the other
 * browser can still send the request. So this file never refuses on its own
 * judgement where the server would allow — every inconclusive answer proceeds
 * and lets the server decide — and when a 403 does come back it shows the
 * server's own sentence rather than a generic failure.
 *
 * THAT RULE HAS EXACTLY ONE DELIBERATE EXCEPTION, and it is named so the rest of
 * the discipline stays true: ADMIN MONITOR MODE (below) hides the write actions
 * on a call that is not the admin's own, even though the server's can_write says
 * an admin MAY write it. It is an owner ruling, not an inference — the admin was
 * offered "read-only plus Quick Booking" and chose the stricter shape — and it
 * removes ACTIONS, never DATA: the guest history stays, and "Take over" (the
 * deliberate, server-checked escalation) stays with it, so an admin who wants
 * the call is one click from having it. Nothing else in this file refuses.
 *
 * WHO OWNS IT. Ownership arrives on the wire (CtEvent.ownerEmail/ownerName,
 * and owner_email/owner_name on the /api/crm-calls/live snapshot); this file
 * never asks per row. A mapped TeleCMI agent is owned the moment the call is
 * answered. An UNMAPPED agent resolves to no app user at all, so the call
 * arrives unowned and stays that way until someone ACTS on it — the first
 * browser to act claims it (POST .../claim), and the losers of that race
 * collapse to the strip. An unowned call therefore keeps today's behaviour for
 * everybody, which is exactly what makes first-claim possible.
 *
 * OWNED IS NOT LOCKED, AND THIS FILE MUST NEVER CONFUSE THE TWO. owner_email is
 * the AUDIT RECORD of the claim and deliberately outlives the lock (call-owner.ts
 * and both server routes say so in writing). Rendering the strip on "has an
 * owner" is why it never lifted: Pushpa answered at 19:00, the call ended 19:05,
 * she closed her browser without dispositioning, the server opened the call to
 * everyone at 19:20 — and every other browser sat on "Pushpa is writing up this
 * call", with no chips, for the rest of the shift. So the strip renders on
 * `locked`, which only the server says.
 *
 * AND THE DEADLINE IS NEVER RE-DERIVED HERE. A lock lapses with the PASSAGE OF
 * TIME, and time fires no event, so a browser told "locked" at 19:05 has to ask
 * again to find out it was opened at 19:20. It asks the way this file already
 * talks to the server: GET /api/crm-calls/live?owned=<ct_calls ids> — ONE request
 * for every card on screen, never one per card — which answers, for THIS viewer,
 * `locked` / `can_write` / `free_at_label`. Copying the 15-minute rule into the
 * browser would be a second copy of it, and the two would drift.
 *
 * WHY can_write AND NOT A LOCAL isManagement(). Admin/Manager/HOD may always
 * write, including somebody else's call. That tier has exactly one definition
 * (isManagement in @/lib/auth, server-only), and the ?owned= answer is that
 * definition already applied to the asking user: management gets locked:true
 * (so the strip still names the owner) WITH can_write:true (so its chips stay
 * live), and gets the management-only takeover — POST .../claim {override:true}
 * — that three server sentences promise.
 *
 * MISSED calls are never owned: nobody answered, chasing them is the recovery
 * queue's whole job, and the claim endpoint refuses them.
 *
 * ── ONE CONVERSATION, SEVERAL RINGING LEGS (hunt group) ─────────────────────
 * The venue rings agents IN SEQUENCE: one inbound call tries PUSHPA for 25s,
 * then Nisha for 25s, then Bharath, who picks up. TeleCMI writes a CDR for EVERY
 * leg, so the FIRST thing the pop hears about a call that is very much alive is
 * "missed". Reported 2026-08-17 with the call log attached: the card flipped to
 * "CALL ENDED — LOG OUTCOME", on every screen, while the phone was still ringing
 * on the next extension.
 *
 * The wire now says which kind of ending it is, and this file acts on it:
 *   leg 'missed_leg'  ONE EXTENSION gave up. The conversation continues. The
 *                     card STAYS in its ringing state, says so ("Ringing —
 *                     trying the next agent", and who did not pick up), and the
 *                     ring timer keeps running because the call is still ringing.
 *   leg 'final'       the conversation itself ended → disposition, exactly as
 *                     before.
 *   leg absent        an older server, and today's behaviour: disposition.
 * Anything else unrecognised also dispositions, deliberately. The two failure
 * directions are not equal: dispositioning early is a card the GRE can still
 * close, while holding a card open on a value we failed to recognise strands it
 * with no write-up — a new bug on top of the old one.
 *
 * A missed leg is also EVIDENCE OF LIFE, which is why RING_STALE_SECONDS is
 * measured from `lastSignalAt` and not from the first ring: a hunt group that
 * walks six extensions would otherwise have the card announce it had lost track
 * while it was demonstrably still ringing. And the safety net that is the whole
 * point of that constant is kept: if a missed leg is the LAST thing that ever
 * arrives (the next leg's events are lost), the window still expires, the card
 * still stops claiming to ring — and it then offers the OUTCOME CHIPS, because a
 * call that rang out really is a missed call somebody has to write up.
 *
 * WHO IT IS RINGING FOR / WHO ANSWERED are two different people on a hunt group
 * and the card names both, each in its own state. Neither is ever blanked for
 * being unmapped: an unmapped id arrives as the raw id by design
 * (resolveAgentLabel, src/lib/ct/agents.ts) and is shown as-is.
 *
 * ── "RINGING FOR" IS A LADDER, AND THE CARD NEVER INVENTS A RUNG ────────────
 * Reported 2026-08-20 with screenshots: the pop said "Ringing — trying the next
 * agent" and never named anybody. It was not a rendering bug — the live ring
 * payload on this account carries no agent field at all, so the server had no
 * name to send (see the ring branch of ingestLive in src/lib/ct/ingest.ts, which
 * now logs the payload's key names every time that happens). The wire therefore
 * answers in two fields, produced by ONE function (ringingForLabel in
 * src/lib/ct/agents.ts) so no surface can ladder it differently:
 *
 *   1 ringingAgentName / ringing_agent_name — A PERSON. The payload named an
 *     extension. Shown in the HEADER: "Ringing — Pushpa B".
 *   2 ringingGroupName / ringing_group_name — A GROUP (TeleCMI's `team`), and
 *     set by the server ONLY when rung 1 is empty. Shown in the BODY, worded as
 *     a group ("Ringing the Front Desk team") because a group is not a person
 *     and must never sit in the slot where a name goes.
 *   3 neither — today's honest wording ("Ringing — trying the next agent" while
 *     a hunt group is walking, otherwise "Incoming call"). NOT a guess: "whoever
 *     is probably next" is supported by nothing on the wire and is forbidden.
 *
 * The two rungs are read IN ORDER at render, never merged, so the card cannot
 * print a group beside a named agent even if a later leg fills rung 1 while an
 * earlier one had filled rung 2. `queue` is deliberately NOT a rung: it carries
 * the group VERBATIM whether or not a person was named, so rendering it as
 * "ringing for" would do exactly that.
 *
 * AND THE CONTRADICTION THIS CARD MUST NEVER PRINT: "Ringing — Pushpa" directly
 * above "Pushpa did not pick up". The missed-leg branch clears rung 1 when the
 * agent it named is the one reported as missing the leg; rung 2 survives that
 * (a group is still ringing after one of its members gave up) and takes over.
 *
 * ── ADMIN MONITOR MODE (owner ruling 2026-08-20) ────────────────────────────
 * An ADMIN sees every live call in the venue, each labelled with who it is
 * ringing for and who answered, so he can judge how the GREs are working. Two
 * rules, and the second is the one with teeth:
 *
 *   HIS OWN CALLS behave exactly as they do for any GRE — full disposition
 *     rights, Quick Booking, everything. "His own" is the SERVER's answer
 *     (is_mine on the /api/crm-calls/live rows, computed from the session and
 *     the agent map), with the email comparison as the fallback, never the
 *     authority.
 *   EVERYONE ELSE'S CALLS ARE WATCH-ONLY — no disposition chips, no Quick
 *     Booking. He was offered "read-only plus Quick Booking" and chose this. The
 *     card says so where the button used to be ("Watching · Pushpa B"), because
 *     a missing control with no explanation reads as a bug and a disabled one
 *     reads as a dare.
 *
 * A NON-ADMIN GRE IS UNAFFECTED, by construction: every branch this mode adds is
 * guarded by `isAdmin &&`, and no existing expression was rewritten — so for
 * role !== 'admin' every path evaluates exactly as it did before. THE TEST FAILS
 * CLOSED: isAdmin comes from the tier the SERVER resolved (/api/auth/me →
 * user.role, an exact === 'admin' compare, never canAccessPage, never
 * isManagement — that set is every Manager and HOD, a far wider audience than
 * the one the owner named). A failed fetch, no session, or any other tier leaves
 * it false, which is today's behaviour.
 *
 * WHAT MONITOR MODE DELIBERATELY DOES NOT CHANGE: the hangup dismissal. An
 * ENDED call is not a live call, the Call Log holds it, and keeping every
 * finished call of the shift on the admin's screen — each one a card whose
 * "log outcome" header he is not allowed to act on — would be clutter that
 * contradicts itself. So on hangup an admin lets go of somebody else's card
 * exactly like everybody else does, and keeps his own.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  PhoneIncoming, PhoneOff, PhoneCall, X, UserPlus, CalendarPlus, ExternalLink, Loader2, Star,
  Lock, UserCheck, Eye,
} from 'lucide-react';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import QuickBookingModal from './QuickBookingModal';

interface GuestSnap {
  id: string;
  name: string;
  tags: string[];
  total_calls?: number;
  total_bookings?: number;
  last_visit_at?: string | null;
  badge?: string;
}

interface PopCard {
  /** Dedupe key: telecmiCallId || callId || phone */
  key: string;
  telecmiCallId?: string;
  callId?: string;
  phone: string;
  guest: GuestSnap | null;
  /** Raw TeleCMI agent id, as first seen on the call. NOT a person's name. */
  agent?: string;
  /**
   * WHO PICKED UP, resolved to a staff display name by the server
   * (agentDisplayName → resolveAgentLabel, src/lib/ct/agents.ts) and carried on
   * CtEvent.agentName. '' until an event names one.
   *
   * An UNMAPPED agent id resolves to the raw id, never to blank — that is
   * resolveAgentLabel's documented contract, and it is the right one here: a
   * GRE seeing "Answered by 201_1111112" learns something ("somebody has it,
   * and the admin has not mapped that extension yet"), where a blank card would
   * teach them nothing and look like the answer never happened.
   *
   * IT IS ALSO LEARNED FROM THE POLL. A live 'answered' webhook that carries no
   * agent id at all leaves this '' — and used to leave it '' for the WHOLE call,
   * because the only other thing that names the answerer is the CDR, which
   * arrives after the hangup and so is useless to the person still holding the
   * phone. The ?owned= snapshot now carries agent_display, so the moment the
   * server learns who has the call (a later live event, the CDR, or an admin
   * mapping the extension) the next poll fills this in. See applyOwned().
   */
  agentName: string;
  /**
   * WHO THE PHONE IS RINGING FOR RIGHT NOW — a staff display name resolved by
   * the server (CtEvent.ringingAgentName), '' when the event named nobody.
   *
   * NOT agentName: on a hunt group the person it is ringing for and the person
   * who eventually answers are different people, and the card is in a different
   * state for each. Cleared when the agent it named is the one reported as
   * missing the leg — "Ringing — Pushpa" directly above "Pushpa did not pick up"
   * is a contradiction the card must not print.
   *
   * An UNMAPPED agent id arrives as the raw id and is shown as the raw id, for
   * the reason spelled out on agentName above.
   */
  ringingFor: string;
  /**
   * RUNG 2 OF "RINGING FOR" — the ring GROUP (TeleCMI's `team`) this call is
   * hunting through, off CtEvent.ringingGroupName / ringing_group_name. '' when
   * the wire named no group.
   *
   * A GROUP IS NOT A PERSON. It is worded as a group in the body and never
   * placed in the header slot where `ringingFor` renders a name, and it is read
   * only AFTER `ringingFor` is found empty — that ordering is what stops the
   * card printing a group beside an agent it has just named.
   *
   * NOT card.queue, which carries the group verbatim on every call including the
   * ones that DID name a person. The server sets this field only when it named
   * nobody, which is precisely what makes it an answer to "who is it ringing
   * for" rather than just a fact about the call.
   *
   * SURVIVES A MISSED LEG on purpose: one member of a hunt group giving up does
   * not stop the group ringing, so when the missed leg clears `ringingFor` this
   * is the honest thing left to say.
   */
  ringingGroup: string;
  /** Staff display name of the last agent whose leg went unanswered, off
   *  CtEvent.missedByName. '' when no leg has been missed, or when the server
   *  could not name one (which is why `hunting` is a separate flag). */
  missedByName: string;
  /**
   * Has a MISSED LEG landed on this card — i.e. one extension gave up and the
   * hunt group moved on? Presentation only ('Ringing — trying the next agent'),
   * and the one thing that earns a rung-out card its outcome chips if the rest
   * of the conversation's events never arrive. Set only while the card is
   * ringing; a late leg CDR can never set it on an answered or finished call.
   */
  hunting: boolean;
  queue?: string;
  startedAt: string;
  /**
   * The last time this call gave ANY evidence of being alive — the first ring,
   * or a missed leg saying the hunt group moved on. RING_STALE_SECONDS is
   * measured from HERE, while the ring counter on the header still counts from
   * startedAt: "how long has this guest been ringing" and "how long since we
   * last heard anything" are different questions, and only the second one is
   * about whether we have lost track.
   */
  lastSignalAt: string;
  mode: 'ringing' | 'answered' | 'disposition';
  /** When the call was picked up (UTC ISO); talk time counts from here. */
  answeredAt?: string;
  endedAt?: string;
  /**
   * App user (email) holding the write-up of this ANSWERED call; '' = unowned.
   * NOT card.agent — that is the raw TeleCMI agent id, which for an unmapped
   * agent belongs to no app user at all.
   */
  ownerEmail: string;
  /** Display name for ownerEmail (falls back to the email); '' when unowned. */
  ownerName: string;
  /**
   * IS THIS CALL MINE — the SERVER's answer for this viewer (is_mine on the
   * /api/crm-calls/live rows), which is the only place the question can honestly
   * be answered: it is computed from the session AND the agent map, and the
   * agent map is admin-only and never reaches a browser.
   *
   * `undefined` = NOT YET ASKED (no snapshot row for this card yet), which reads
   * as "not established as mine" — the same thing the server means by false.
   * FALSE IS NOT "SOMEBODY ELSE'S": an unowned call naming no agent is false for
   * everyone and must stay first-claim for everyone. It is used for exactly one
   * thing, ADMIN MONITOR MODE, where "not established as mine" plus a KNOWN
   * OWNER is what makes a call somebody else's.
   *
   * The email comparison (sameEmail against ownerEmail) remains the fallback for
   * a card no snapshot has covered yet — never the authority.
   */
  isMine?: boolean;
  /**
   * IS A LOCK IN FORCE RIGHT NOW, as the SERVER last told us — never inferred
   * from ownerEmail (see the header). Viewer-independent: true also for the
   * manager who may write straight through it.
   * `undefined` = NOT YET ASKED. Absent is not false: a card whose lock state we
   * have never been told about keeps the pop, and the write is still gated
   * server-side.
   */
  locked?: boolean;
  /**
   * May THIS viewer write this call? The server's own answer for this user, off
   * GET /api/crm-calls/live?owned=. `undefined` = not yet asked. This is the one
   * thing that lets a manager keep their chips on a locked call, and it exists
   * so no browser ever re-implements isManagement().
   */
  canWrite?: boolean;
  /** When the lock lifts, IST-formatted BY THE SERVER (e.g. "7:42 pm"); '' when
   *  there is no deadline to promise. Never computed here — see the header. */
  freeAtLabel: string;
  /**
   * A refusal the SERVER gave us, verbatim — a lost claim race or a 403 on the
   * disposition PUT. Shown as-is on the strip: it names the owner and says when
   * the call frees up, which is more than this browser could work out. '' = none.
   * Retired the moment the server says the call is writable again, or the strip
   * it draws would outlive the lock exactly like the owner-based one did.
   */
  blocked: string;
  /** New-caller mini-form name input */
  newName: string;
  creating?: boolean;
  saving?: boolean;
  /** A claim POST is in flight (the action that triggered it is waiting on it). */
  claiming?: boolean;
  error: string;
}

/** Loose bus-event shape (SSE + poll deliver the same CtEvent JSON). */
interface AnyEvent {
  type?: string;
  callId?: string;
  telecmiCallId?: string;
  phone?: string;
  guest?: GuestSnap | null;
  agent?: string;
  /** Staff display name for `agent` — CtEvent.agentName in src/lib/ct/bus.ts.
   *  Carried by `answered` and by an ANSWERED call's `call_ended`. */
  agentName?: string;
  /**
   * WHICH ENDING IS THIS — CtEvent.leg, on `call_ended` only.
   *   'missed_leg'  one extension of a hunt group stopped ringing; the
   *                 conversation carries on to the next agent.
   *   'final'       the conversation ended.
   * Absent on an older server, which is today's behaviour: treat as final.
   * Typed loosely (string) for the same reason as everything else on AnyEvent —
   * this is untrusted JSON off the wire, not a compile-time guarantee.
   */
  leg?: string;
  /** Staff display name of the agent who let a 'missed_leg' ring out —
   *  CtEvent.missedByName. Unmapped ids arrive as the raw id, never blank. */
  missedByName?: string;
  /**
   * RUNG 1 — the staff display name of the agent the call is ringing for NOW,
   * CtEvent.ringingAgentName, on `incoming_call`. Unmapped ids arrive as the raw
   * id, never blank.
   *
   * IT IS ALSO READ ON A 'missed_leg', AND THE SERVER HAS NEVER SENT IT THERE.
   * That read is kept because it costs nothing and is right the day the server
   * can answer — but the comment that used to promise "the server already knows
   * who it moved on to" was describing a value that does not exist: the NEXT
   * extension mid-cascade appears in no TeleCMI payload and in no emitted field,
   * so filling it would be the guess this whole ladder exists to forbid. Until
   * then a missed leg falls to rung 2 (the group, which survives the leg) and
   * then to "trying the next agent".
   */
  ringingAgentName?: string;
  /**
   * RUNG 2 — CtEvent.ringingGroupName on `incoming_call`: the ring group /
   * `team` the call is hunting through, set by the server ONLY when it named no
   * person. See PopCard.ringingGroup for why this is not `queue`.
   */
  ringingGroupName?: string;
  /** Owner of the answered call — see CtEvent.ownerEmail in src/lib/ct/bus.ts. */
  ownerEmail?: string;
  ownerName?: string;
  /** Is a lock in force — CtEvent.locked. Viewer-independent, so it never
   *  answers "may I write"; only the ?owned= poll can do that. */
  locked?: boolean;
  /** CtEvent.freeAtLabel — already IST-formatted by the server. */
  freeAtLabel?: string;
  queue?: string;
  at?: string;
}

const MAX_CARDS = 5;

/** How often to re-ask the server whether a lock we are showing is still in
 *  force. Only runs while a card actually has one — see THE LOCK CLOCK below. */
const OWNERSHIP_REFRESH_MS = 15000;

/**
 * How long a card may claim to be RINGING with no further news before it stops
 * counting and says it has lost track.
 *
 * 300s deliberately, because that is reconcileLiveEvents()'s own rule
 * (src/lib/ct/ingest.ts): five minutes after a ring with nothing following, the
 * SERVER stops believing the call is ringing and marks the row missed. A pop
 * that kept ticking past that point would be contradicting the database it is a
 * view of. Not a dismissal — the GRE keeps the card, the guest history and the
 * actions; only the false "still ringing" goes.
 *
 * Applies to 'ringing' ONLY. A real conversation can run half an hour, and there
 * is nothing stale about an 'answered' card whose talk timer is still climbing.
 *
 * MEASURED FROM THE LAST SIGNAL, NOT THE FIRST RING (see PopCard.lastSignalAt).
 * On a hunt group the news arrives leg by leg, and each missed leg is proof the
 * call is alive; counting from the first ring would let a long hunt trip this
 * window and print "No update from telephony" about a phone that is audibly
 * ringing. The window itself is unchanged, and so is the thing it protects: a
 * call that really does go quiet still stops counting five minutes later.
 */
const RING_STALE_SECONDS = 300;

const DISPOSITIONS: Array<{ value: string; label: string }> = [
  { value: 'booking_made', label: 'Booking Made' },
  { value: 'enquiry', label: 'Enquiry' },
  { value: 'event_enquiry', label: 'Event' },
  { value: 'complaint', label: 'Complaint' },
  { value: 'wrong_number', label: 'Wrong No.' },
  { value: 'follow_up_needed', label: 'Follow-up' },
  { value: 'no_action', label: 'No Action' },
];

const istDay = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
};

const eventKey = (e: AnyEvent): string => String(e.telecmiCallId || e.callId || e.phone || '');

/** Case-insensitive email identity. '' never matches '': an unowned call has
 *  no owner to be, and a browser that does not yet know its own email is not
 *  anybody either. */
const sameEmail = (a: unknown, b: unknown): boolean => {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  return !!x && x === y;
};

/** Do two display labels name the same person? Used only to stop the card
 *  saying "Ringing — Pushpa" and "Pushpa did not pick up" at the same time. Two
 *  blanks are not a match, exactly as in sameEmail. */
const sameLabel = (a: unknown, b: unknown): boolean => {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  return !!x && x === y;
};

/**
 * Word a RING GROUP as a group — "Front Desk" → "Front Desk team" — so rung 2 of
 * the ringing ladder can never be mistaken for a person's name (see the header).
 *
 * The suffix is dropped when the group already names itself one, because
 * "Sales Team team" is the kind of sentence that makes a GRE distrust the whole
 * card. Nothing else is done to the label: it is the telephony system's own
 * `team` value and is otherwise printed exactly as it arrived.
 */
const groupPhrase = (g: string): string => {
  const s = String(g || '').trim();
  if (!s) return '';
  return /\b(team|group|queue)$/i.test(s) ? s : `${s} team`;
};

/**
 * The later of two ISO timestamps, preferring whichever is parseable.
 *
 * The staleness clock only ever moves FORWARD. A leg CDR can be delivered late
 * and carries the moment that leg ended, not the moment we heard about it, so an
 * older `at` must never shorten the window a newer event already opened.
 */
const laterIso = (a: string, b: string): string => {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (isNaN(ta)) return b;
  if (isNaN(tb)) return a;
  return tb > ta ? b : a;
};

/**
 * Ownership carried by a bus event, or null when the event says nothing.
 *
 * ABSENT AND EMPTY ARE DIFFERENT THINGS ON THIS WIRE, and getting them the same
 * way round breaks the feature in one direction or the other:
 *   field missing  → NO INFORMATION. Leave the owner alone. An older emitter,
 *                    or any event type that simply does not speak about
 *                    ownership, must not wipe what `answered` told us.
 *   ownerEmail: '' → UNOWNED, stated deliberately (see the ownerEmail comments
 *                    in src/lib/ct/ingest.ts). This is the hand-back: the live
 *                    'answer' notify is optimistic, and a CDR that reclassifies
 *                    the call as missed CLEARS the owner, because a missed call
 *                    belongs to the recovery queue and everyone in it. A browser
 *                    that ignored this would sit on a read-only strip for a call
 *                    it is supposed to be chasing.
 * Both ingest paths read the owner back off the row before emitting, so a ''
 * on the wire is the row's real state and not an echo of a failed write.
 *
 * Either way, a STATED ownership also retires the card's `blocked` message.
 * That string is a refusal the server gave us about a state this event has just
 * superseded, and keeping it outlives its truth in both directions: a call
 * handed back to the recovery queue would stay hidden behind "X is writing it
 * up" from the very people meant to chase it, and a call handed TO us would
 * still be showing somebody else's refusal. Nothing is lost — the strip is
 * re-derived from ownership.
 */
function ownerPatch(e: AnyEvent): Partial<Pick<PopCard, 'ownerEmail' | 'ownerName' | 'blocked'>> | null {
  if (typeof e.ownerEmail !== 'string') return null;   // absent → say nothing
  const email = e.ownerEmail.trim();
  if (!email) return { ownerEmail: '', ownerName: '', blocked: '' }; // stated unowned
  return { ownerEmail: email, ownerName: String(e.ownerName || '').trim() || email, blocked: '' };
}

/**
 * Everything an event states about ownership AND about the lock, as one patch.
 *
 * The two are separate fields on the wire because they are separate facts: the
 * claim route sends an owner WITH locked:true, the disposition PUT sends the
 * SAME owner with locked:false (the owner is the audit record; the release is
 * the news), and ingest's `answered`/`call_ended` state an owner and say nothing
 * about the lock at all. Each is therefore applied only when the event actually
 * carries it — an absent field is no information, never `false`.
 *
 * A stated locked:false settles `canWrite` too, and is the only place an event
 * can: "no lock is in force" is viewer-independent good news, so it is true for
 * everyone reading it. locked:true is NOT the mirror image — management writes
 * straight through a lock — so it deliberately leaves canWrite alone for the
 * ?owned= poll to answer.
 */
function lockPatch(e: AnyEvent): Partial<PopCard> {
  const owner = ownerPatch(e);
  const patch: Partial<PopCard> = { ...(owner || {}) };
  // AN EVENT THAT STATES UNOWNED STATES NO LOCK. owner_email '' is the very
  // first clause of the server's rule (lockFreeSql in call-owner.ts): with no
  // owner, everyone may write. Deriving it here is not a second copy of the
  // deadline logic — there is no deadline in it, only the identity "nobody holds
  // it ⇒ nobody is locked out".
  // It matters for exactly one flow: the live 'answer' notify is optimistic, and
  // a CDR that reclassifies the call as MISSED clears the owner. Without this
  // the strip would survive that hand-back and hide a recovery-queue call from
  // the very people whose job is to chase it.
  if (owner && owner.ownerEmail === '') {
    patch.locked = false;
    patch.canWrite = true;
    patch.freeAtLabel = '';
  }
  if (typeof e.locked === 'boolean') {
    patch.locked = e.locked;
    if (!e.locked) {
      patch.canWrite = true;
      patch.blocked = '';        // the refusal is spent; keeping it re-draws a dead strip
      patch.freeAtLabel = '';    // nothing left to free up
    } else {
      // A NEW LOCK INVALIDATES ANY canWrite WE ALREADY HELD — it must go back to
      // "not yet asked" (undefined), not stay at whatever we last believed.
      //
      // canWrite is per-VIEWER and only the ?owned= poll can answer it; this
      // broadcast cannot. Leaving a stale `true` standing was the one place the
      // client was LESS restrictive than the server, and it showed:
      //   · unmapped agent answers -> event carries ownerEmail '' -> the clause
      //     above sets canWrite true and the card counts as settled-open, so
      //     polling stops
      //   · Ravi claims it -> ownership event, locked true, canWrite left true
      //   · every bystander renders live chips AND the management-only
      //     "Take over" button on a call locked to Ravi
      // The same path fired when a manager took over a call you had claimed.
      // Dropping to undefined makes lockView fall through to the `locked`
      // branch — the strip — until the poll says otherwise. Wrong for a manager
      // for one round-trip is the right direction to be wrong in.
      //
      // Safe for the OWNER's own browser: lockView short-circuits on
      // sameEmail(card.ownerEmail, myEmail) before it ever consults canWrite,
      // so the person who holds the call keeps their pop either way. Only the
      // people who need the strip are affected.
      patch.canWrite = undefined;
    }
  }
  if (typeof e.freeAtLabel === 'string' && e.locked !== false) {
    patch.freeAtLabel = e.freeAtLabel;
  }
  return patch;
}

/**
 * Which card does a call-level event belong to? Shared by `answered`,
 * `ownership` and `call_ended` so they can never drift apart.
 *
 * IDS FIRST, ALWAYS — telecmi id, then ct_calls id. Only if NEITHER matches any
 * card does the phone get a say, and then only for a card the call is not
 * finished on ('ringing' or 'answered').
 *
 * THE PHONE FALLBACK USED TO REQUIRE THE EVENT TO CARRY NO IDS AT ALL, and that
 * was too strict in the one case that matters most. Ids on this account do not
 * reliably correlate: the live events and the CDR can arrive keyed differently,
 * so a card born from the ring holds one id and the CDR's `call_ended` arrives
 * with another — both present, neither matching. Under the old rule that event
 * bound to nothing, and the pop sat on "INCOMING CALL" for a call that had ended
 * minutes ago. It is a two-pass search rather than one predicate precisely so a
 * mismatching id can never let the phone outrank a card that DID match by id.
 *
 * Matching on phone cannot cross-wire two different guests — it is the same
 * number — and the mode bound keeps it off a card already being written up.
 */
function matchIdx(list: PopCard[], e: AnyEvent): number {
  const byId = list.findIndex(c =>
    (!!e.telecmiCallId && c.telecmiCallId === e.telecmiCallId) ||
    (!!e.callId && c.callId === e.callId),
  );
  if (byId !== -1) return byId;
  if (!e.phone) return -1;
  return list.findIndex(c => c.phone === e.phone && c.mode !== 'disposition');
}

/**
 * Is somebody else's lock in force on this card, and may I write anyway?
 *
 *   null                → no lock to show. Plain pop, exactly as today.
 *   { canWrite: false } → READ-ONLY STRIP. Not mine, and the server will refuse.
 *   { canWrite: true }  → the pop stays fully live, with a line naming who holds
 *                         it and the management takeover. This is the manager
 *                         case, and it comes from the server's own can_write —
 *                         isManagement() is never re-implemented here.
 *
 * WHAT IT NEVER READS: `ownerEmail` as a lock. An owner outlives the lock by
 * design, and treating the two as one is what kept the strip up forever.
 *
 * ORDER OF AUTHORITY, most authoritative first:
 *   can_write, per-viewer, from the ?owned= poll — the same answer the write
 *     itself will give, so it settles the question in both directions.
 *   locked, viewer-independent, off an event — enough to draw the strip the
 *     instant a claim lands, which is the whole point of the broadcast. A
 *     manager who lands here loses their chips only until the next poll, which
 *     the lock change itself kicks off.
 *   blocked, a refusal the server already gave us — believed until something
 *     newer contradicts it, and cleared the moment anything does.
 *
 * WHY AN UNKNOWN `myEmail` STILL KEEPS THE POP where we have no server verdict.
 * Until /api/auth/me answers (or if it never does) this browser cannot tell the
 * owner apart from everybody else. Showing "someone else has this call" to the
 * person actually on it is the worse of the two mistakes; the opposite error
 * just shows a pop whose disposition the server will refuse anyway, with its
 * refusal surfaced. So inference fails OPEN — but a server verdict is not an
 * inference, and `locked`/`can_write`/`blocked` are honoured whether or not we
 * know who we are.
 */
interface LockView { title: string; freeAtLabel: string; canWrite: boolean }

function lockView(card: PopCard, myEmail: string): LockView | null {
  if (sameEmail(card.ownerEmail, myEmail)) return null;   // it's mine — keep the pop
  const who = card.ownerName || card.ownerEmail;
  // 'answered' reads like 'ringing' here, not like 'disposition': the call is
  // still up, so the honest sentence is that they are ON it, not writing it up.
  const title = who
    ? (card.mode === 'disposition' ? `${who} is writing up this call` : `${who} is on this call`)
    : 'Another user is writing up this call';

  // The server said I may write. If a lock is still in force it belongs to
  // somebody else and they must be named — but only once we know it is not us.
  if (card.canWrite === true) {
    return card.locked && myEmail ? { title, freeAtLabel: card.freeAtLabel, canWrite: true } : null;
  }
  if (card.locked === true) return { title, freeAtLabel: card.freeAtLabel, canWrite: false };
  // A refusal the server actually gave us: it names the owner and already says
  // when the call frees up, so it is shown verbatim rather than re-worded.
  if (card.blocked) return { title: card.blocked, freeAtLabel: '', canWrite: false };
  return null;
}

/**
 * Which cards do we need the server's ownership verdict for?
 *
 * Only ones with a ct_calls.id — /api/crm-calls/live?owned= keys on the primary
 * key, and a card holding only a TeleCMI id has nothing to ask with (it keeps
 * the full pop and the PUT's 403 remains the backstop). And only ones with
 * something lock-shaped about them: an owner, a lock we were told about, or a
 * refusal we are still showing. An ordinary unowned ringing call adds nothing to
 * the query string, so the common case is byte-for-byte the request this
 * component made before.
 *
 * Capped at 20 to match the route's own cap; MAX_CARDS makes that unreachable,
 * but the two limits should not be able to disagree silently.
 *
 * ONE CARD ASKS FOR A SECOND REASON: a call that is UP RIGHT NOW and still does
 * not name who answered it. The same snapshot carries agent_display, so a card
 * left anonymous by an agent-less 'answered' webhook has somewhere to learn the
 * name from while the conversation is still happening — which is the only time
 * it is worth anything. It is deliberately NOT enough to be lock-shaped: the
 * reported case is an UNMAPPED (or absent) agent, which resolves to no app user,
 * so the card arrives unowned and every lock test below skips it. Bounded by
 * construction — the card stops asking the moment a name arrives, and 'answered'
 * mode ends at the hangup, so it can never poll for the rest of a shift.
 */
function ownedIdsOf(list: PopCard[]): string[] {
  const ids: string[] = [];
  for (const c of list) {
    if (!c.callId) continue;
    const needsAnswerer = c.mode === 'answered' && !c.agentName;
    if (!needsAnswerer) {
      if (!c.ownerEmail && c.locked !== true && !c.blocked) continue;
      // SETTLED OPEN: the server has told us this viewer may write and no lock is
      // in force. There is nothing further to learn by asking again — a lock can
      // only come BACK by somebody claiming, and a claim is an event. Stopping
      // here is what keeps a dispositioned card (which keeps its owner forever, as
      // the audit record) from polling for the rest of the shift.
      if (c.canWrite === true && c.locked === false) continue;
    }
    if (!ids.includes(c.callId)) ids.push(c.callId);
    if (ids.length >= 20) break;
  }
  return ids;
}

/**
 * Append a card, enforcing the MAX_CARDS stack. When full, drop an already-ended
 * (disposition-mode) card first — a LIVE call, whether still ringing or already
 * answered, always wins the slot.
 * We permanently suppress (add to `dismissed`) ONLY an ended card; if we're
 * forced to evict a live one (every slot is ringing or on a call), we drop it
 * WITHOUT suppressing so it can re-pop from the poll once a slot frees — a live
 * caller must never be hidden forever.
 */
function pushCard(list: PopCard[], card: PopCard, dismissed: Set<string>): PopCard[] {
  const next = [...list, card];
  if (next.length <= MAX_CARDS) return next;
  let idx = next.findIndex(c => c.mode === 'disposition');
  if (idx === -1 || idx === next.length - 1) idx = 0;
  if (next[idx].mode === 'disposition') dismissed.add(next[idx].key);
  next.splice(idx, 1);
  return next;
}

export default function CTScreenPop() {
  const [cards, setCards] = useState<PopCard[]>([]);
  const [booking, setBooking] = useState<{
    cardKey: string;
    guestId?: string;
    guestName?: string;
    sourceCallId?: string;
    dispositionAfter: boolean;
  } | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  /**
   * Who am I? Only used to answer "is this call MINE?" — never "may I write
   * it", which is the server's `can_write` and nothing this browser derives.
   * '' until /api/auth/me answers — see lockView() for what that changes and
   * what it deliberately does not.
   */
  const [myEmail, setMyEmail] = useState('');
  /**
   * AM I AN ADMIN — the one gate on monitor mode, and it FAILS CLOSED.
   *
   * `user.role` is the base tier the SERVER already resolved (an assigned role's
   * base_role wins over the legacy users.role, see src/lib/auth.ts), compared
   * exactly against 'admin'. Every other tier, a failed fetch, an expired
   * session and any unreadable answer all leave this false — which is today's
   * behaviour for everybody.
   *
   * NOT isManagement (admin + manager + every HOD — a far wider audience than
   * the owner named) and NOT canAccessPage, which fails OPEN four ways and is
   * therefore never an "is this user an admin" test.
   *
   * IT COMES FROM THE SAME FETCH AS myEmail, DELIBERATELY. /api/crm-calls/live
   * also reports `me.is_admin`, and OR-ing that in would decouple the two: a
   * browser could know it is an admin while still not knowing its own email, and
   * every owned card would then look like somebody else's — putting an admin
   * into watch-only on calls that are his. One source, both facts, settled
   * together.
   */
  const [isAdmin, setIsAdmin] = useState(false);

  const cardsRef = useRef<PopCard[]>([]);
  /** Mirror of myEmail for handlers created with empty deps (handleEvent) —
   *  same pattern as cardsRef. '' means identity unknown, which the owner-only
   *  hangup rule treats as "keep the card" (never yank a write-up we cannot
   *  prove belongs to someone else). */
  const myEmailRef = useRef('');
  /** Mirror of isAdmin for callbacks created with stable deps (pollLive), so
   *  choosing which snapshot list to merge never re-creates the callback — and
   *  therefore never tears down and rebuilds the SSE connection, which depends
   *  on pollLive's identity. false until proven otherwise, as above. */
  const isAdminRef = useRef(false);
  const seqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Keys the user dismissed / completed — never re-pop them from the poll. */
  const dismissedRef = useRef<Set<string>>(new Set());

  useEffect(() => { cardsRef.current = cards; }, [cards]);
  useEffect(() => { myEmailRef.current = myEmail; }, [myEmail]);
  useEffect(() => { isAdminRef.current = isAdmin; }, [isAdmin]);

  // Identify this browser once. A failure is survivable: myEmail stays '' and
  // every card keeps its full pop, with the server still refusing writes that
  // are not this user's to make.
  //
  // The SAME answer carries the tier, so monitor mode costs no second request:
  // /api/auth/me returns the whole SessionUser and role is already on it. The
  // compare is exact and everything else — including a role we do not recognise
  // — is not an admin.
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => {
        setMyEmail(String(d?.user?.email || ''));
        setIsAdmin(String(d?.user?.role || '') === 'admin');
      })
      .catch(() => { /* stays '' / false — presentation falls back to today's behaviour */ });
  }, []);

  // 1s tick drives BOTH counters — ring seconds and, once the call is up, talk
  // time. It runs only while a card actually has a live counter on it, so a
  // stack of finished cards costs nothing.
  //
  // A ringing card that has gone stale is excluded, which is what stops the
  // interval on a tab left open on a call nobody ever finished: the display is
  // frozen at that point anyway, so there is nothing left to re-render. The
  // dependency is a boolean derived from nowTick, so it settles in one pass
  // (goes false, interval clears, nothing further updates nowTick).
  // Measured from lastSignalAt, NOT startedAt — a missed leg re-dates it, and
  // the counter has to come back with it: a hunt group that walks three
  // extensions is a call whose timer must keep running. Re-arming after a freeze
  // is safe because a fresher lastSignalAt against the (stopped) nowTick reads
  // as 0 seconds, so the boolean flips back to true on the very next render.
  const hasLiveCounter = cards.some(c =>
    c.mode === 'answered' ||
    (c.mode === 'ringing'
      && Math.floor((nowTick - new Date(c.lastSignalAt || c.startedAt).getTime()) / 1000) <= RING_STALE_SECONDS),
  );
  useEffect(() => {
    if (!hasLiveCounter) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasLiveCounter]);

  const updateCard = useCallback((key: string, patch: Partial<PopCard>) => {
    setCards(prev => prev.map(c => (c.key === key ? { ...c, ...patch } : c)));
  }, []);

  const removeCard = useCallback((key: string) => {
    dismissedRef.current.add(key);
    setCards(prev => prev.filter(c => c.key !== key));
  }, []);

  // ── Event handling (shared by SSE + poll) ─────────────────────────────────
  const handleEvent = useCallback((e: AnyEvent) => {
    if (!e || typeof e !== 'object' || !e.type) return;

    if (e.type === 'incoming_call') {
      const key = eventKey(e);
      if (!key || dismissedRef.current.has(key)) return;
      const ringingFor = String(e.ringingAgentName || '').trim();
      // RUNG 2, carried alongside rung 1 and never merged with it. The server
      // sets exactly one of the two per event, so on a single ring they cannot
      // both be filled; across SEVERAL rings of one hunt group they can, which is
      // why the render reads them in order rather than trusting them to stay
      // exclusive here.
      const ringingGroup = String(e.ringingGroupName || '').trim();
      setCards(prev => {
        const existing = prev.find(c => c.key === key);
        if (existing) {
          // Ring repeat / richer payload — merge ids and guest, never duplicate.
          // A hunt group re-rings the SAME conversation at the next extension, so
          // a ring that names an agent we were not already ringing for is real
          // news: it re-dates the staleness clock (the call is demonstrably still
          // ringing) and re-labels the header. A re-delivery of the ring we
          // already have names the same agent, changes nothing, and deliberately
          // does NOT reset the clock — otherwise a repeating event could hold a
          // dead card open for ever.
          return prev.map(c => {
            if (c.key !== key) return c;
            const moved = !!ringingFor && !sameLabel(c.ringingFor, ringingFor);
            return {
              ...c,
              callId: c.callId || e.callId,
              guest: c.guest || e.guest || null,
              ...(ringingFor ? { ringingFor } : {}),
              // Same "only when the event states one" rule as rung 1: a ring
              // that names no group must not wipe the group an earlier ring of
              // the same conversation established.
              ...(ringingGroup ? { ringingGroup } : {}),
              ...(moved && c.mode === 'ringing'
                ? { lastSignalAt: laterIso(c.lastSignalAt, e.at || new Date().toISOString()) }
                : {}),
            };
          });
        }
        return pushCard(prev, {
          key,
          telecmiCallId: e.telecmiCallId,
          callId: e.callId,
          phone: String(e.phone || ''),
          guest: e.guest || null,
          agent: e.agent || '',
          agentName: e.agentName || '',   // a ring names no answerer yet
          // …but a ring DOES name who it is ringing for, which is the question
          // the GRE staring at the card actually has. Rung 1 when the payload
          // named a person, rung 2 (the group) when it named only the team —
          // on this account today that is the rung that fires.
          ringingFor,
          ringingGroup,
          missedByName: '',
          hunting: false,
          queue: e.queue || '',
          startedAt: e.at || new Date().toISOString(),
          lastSignalAt: e.at || new Date().toISOString(),
          mode: 'ringing',
          ownerEmail: '',   // a ringing call is unanswered, so unownable
          ownerName: '',
          freeAtLabel: '',
          blocked: '',
          newName: '',
          error: '',
        }, dismissedRef.current);
      });
      return;
    }

    if (e.type === 'answered' || e.type === 'ownership') {
      // The card KEEPS ITS SLOT and is never dismissed by either of these — a
      // GRE who has just picked up must not have the guest's history pulled out
      // from under them. What differs is that 'answered' now also moves the card
      // out of the ringing state, which it did not used to do.
      //
      // 'answered' is TELEPHONY: somebody picked up. It states an owner ('' for
      // the unmapped-agent case, which leaves the card open to everyone and is
      // what makes first-claim possible), it names the answerer, and it says
      // NOTHING about the lock — the ?owned= poll settles that, kicked off by
      // this very change.
      // 'ownership' is the owner or the lock CHANGING on a call that already
      // exists: a claim (locked:true), a management takeover, or the release the
      // disposition PUT broadcasts (locked:false) — which is the event that
      // lifts everyone else's strip the instant the write-up is saved. It is NOT
      // telephony, so it must not touch the mode or the timer: it lands at CHIP
      // time, i.e. after the call is over, and promoting a card to "On call" on
      // the strength of it would put a dead call back on the phone.
      const patch: Partial<PopCard> = lockPatch(e);
      // Guarded merge: 'ownership' shares this branch and carries no agent, so
      // an unconditional copy would blank a name 'answered' had established.
      if (e.agentName) patch.agentName = e.agentName;
      const answeredAt = e.at || new Date().toISOString();
      if (Object.keys(patch).length === 0 && e.type !== 'answered') return; // stated nothing
      setCards(prev => {
        const idx = matchIdx(prev, e);
        if (idx === -1) return prev;   // this browser never saw the call ring
        const c = prev[idx];
        const next = [...prev];
        next[idx] = {
          ...c,
          ...patch,
          // ON CALL — but never backwards. A re-delivered 'answered', or one for
          // another leg of a call that has already hung up, must not drag a card
          // out of disposition and put a finished call back on the phone.
          ...(e.type === 'answered' && c.mode !== 'disposition'
            ? { mode: 'answered' as const, answeredAt: c.answeredAt || answeredAt }
            : {}),
        };
        return next;
      });
      return;
    }

    if (e.type === 'call_ended') {
      // ── ONE LEG GAVE UP, THE CALL DID NOT ─────────────────────────────────
      // A hunt group rings agent after agent and TeleCMI writes a CDR per leg,
      // so a 'missed' ending is routinely the FIRST news about a call that is
      // still ringing somewhere else in the building. This branch is the whole
      // fix for the 2026-08-17 report: it must run BEFORE anything below, since
      // the owner-only rule would otherwise DISMISS the card outright on other
      // screens — which is precisely what happened, on a live call.
      //
      // Everything unrecognised falls through to the disposition path below —
      // see the header for why that direction is the safe one.
      if (String(e.leg || '').trim() === 'missed_leg') {
        const at = e.at || new Date().toISOString();
        const nextRinger = String(e.ringingAgentName || '').trim();
        const missedBy = String(e.missedByName || '').trim();
        setCards(prev => {
          const idx = matchIdx(prev, e);
          if (idx === -1) return prev;    // this browser never saw the call ring
          const c = prev[idx];
          // ONLY A RINGING CARD. Leg CDRs arrive minutes late and out of order,
          // so Pushpa's missed leg can land AFTER Bharath has already answered
          // (or after the conversation ended and the card went to chips).
          // Putting a live or finished call back on "trying the next agent"
          // would be this same bug pointing the other way, so a missed leg for
          // anything that is no longer ringing is simply not news.
          if (c.mode !== 'ringing') return prev;
          const next = [...prev];
          next[idx] = {
            ...c,
            callId: c.callId || e.callId,
            guest: e.guest || c.guest,   // the CDR carries a fresher snapshot
            hunting: true,
            ...(missedBy ? { missedByName: missedBy } : {}),
            // Who it rings for now: the server's next agent when it named one,
            // otherwise nobody — the agent we were showing is the one that just
            // rang out, and keeping his name up would contradict the very line
            // underneath it. A blank drops to rung 2 (the GROUP, deliberately
            // left untouched below: one member giving up does not stop the group
            // ringing) and then to "trying the next agent".
            //
            // `nextRinger` is a read the server has never satisfied — the next
            // extension mid-cascade is in no payload — and it stays a read
            // rather than becoming a guess. See AnyEvent.ringingAgentName.
            ringingFor: nextRinger || (sameLabel(c.ringingFor, missedBy) ? '' : c.ringingFor),
            // ringingGroup IS NOT TOUCHED HERE. It is still true, and it is the
            // most specific thing left to say once the name above is cleared.
            // EVIDENCE OF LIFE — the staleness clock restarts. Without this a
            // six-extension hunt would cross RING_STALE_SECONDS and the card
            // would announce it had lost track of a call it can hear ringing.
            lastSignalAt: laterIso(c.lastSignalAt, at),
            // OWNERSHIP IS DELIBERATELY UNTOUCHED. A leg that nobody answered
            // says nothing about who will own the conversation, and applying an
            // ownerEmail of '' off a late-delivered leg could hand a settled
            // call back to the queue. `answered`/`final` state the owner.
          };
          return next;
        });
        return;
      }

      // OWNER-ONLY DISPOSITION (owner ruling 2026-08-17, header §call_ended):
      // when the ended call has a KNOWN owner, every browser that is not the
      // owner's drops the card on hangup — Agent B saw "Answered by A" while
      // the call ran; once it ends, the write-up belongs to A alone and a
      // dead card on B's screen is clutter. Three deliberate keep-cases:
      //   · owner unknown/'' (missed call, or an unmapped agent answered) —
      //     the card stays EVERYWHERE, because either the whole floor should
      //     see the miss, or first-claim decides who writes it up;
      //   · myEmail '' (identity fetch failed) — we cannot prove this is not
      //     the owner's screen, so we must not take the write-up card away;
      //   · the owner's own screen — the whole point of disposition mode.
      // The key lands in dismissedRef so the ?owned= poll cannot resurrect it.
      setCards(prev => {
        const idx = matchIdx(prev, e);
        if (idx === -1) return prev;
        const c = prev[idx];
        const owner = String((e as { ownerEmail?: unknown }).ownerEmail ?? '').trim() || String(c.ownerEmail || '').trim();
        const me = myEmailRef.current;
        if (owner && me && !sameEmail(owner, me)) {
          dismissedRef.current.add(c.key);
          return prev.filter(x => x.key !== c.key);
        }
        const next = [...prev];
        next[idx] = {
          ...c,
          mode: 'disposition',
          callId: e.callId || c.callId,
          guest: e.guest || c.guest, // CDR event carries a fresher snapshot
          endedAt: e.at || c.endedAt || new Date().toISOString(),
          // An ANSWERED call's CDR names the agent (ingest.ts only sets
          // agentName when status === 'answered'), so this is the second — and
          // on a browser that missed the live 'answer', the ONLY — chance to
          // learn who took it. Guarded for the same reason as above: a missed
          // call's call_ended carries no agentName and must not erase one.
          // On a hunt group this is the FINAL leg — the one that was actually
          // picked up — so it names the answerer and not any of the extensions
          // that rang out first; those never reach here (they return above).
          ...(e.agentName ? { agentName: e.agentName } : {}),
          // The write-up window is the whole point of the lock, so an owner
          // named on the hangup/CDR matters most here. lockPatch ignores an
          // absent field rather than clearing what `answered` already told us.
          ...lockPatch(e),
        };
        return next;
      });
    }
    // recovery_update is not a pop concern.
  }, []);

  /**
   * Merge LIVE calls off the poll snapshot into the stack.
   *
   * IT TAKES BOTH LISTS THE ROUTE OFFERS, and reads `status` to tell them apart:
   *   `ringing` — status='ringing' by construction, which is why an ABSENT
   *               status here means ringing and nothing else (that query IS the
   *               WHERE clause; the route says so in writing).
   *   `active`  — every call still in progress, ringing AND answered. THE
   *               SERVER sends this one to an admin and to nobody else, and
   *               omits the key entirely otherwise (see the route header), so a
   *               non-admin browser is never handed the rows at all. The test in
   *               pollLive is what a client does with a list it has; it is not
   *               what decides whether it gets one.
   * The two never both arrive: `active` is a superset, so merging both would
   * be the same call twice — the route's own instruction is to render one.
   *
   * THE SNAPSHOT NOW CARRIES RESOLVED LABELS, and that is what fixes the second
   * half of the 2026-08-20 report. It used to hand over only the RAW agent id,
   * so this function deliberately dropped every name on the floor — a pop that
   * reloaded mid-ring lost who it was ringing for permanently, and a card that
   * mounted mid-call never learned who was on it. ringing_agent_name,
   * ringing_group_name and agent_display are resolved server-side through the
   * same helpers the bus events use, so filling them in here cannot disagree
   * with what an event would have said.
   *
   * EVERY PATCH ONTO AN EXISTING CARD FILLS A BLANK ONLY, under the file's
   * standing rule: events know things a row does not (which leg is ringing now,
   * that a leg was missed), and a snapshot must never undo them. And nothing
   * here touches `mode` — learning who is on a call says nothing about whether
   * it is still up, and promoting a card on the strength of a row is how a
   * finished call would get put back on the phone.
   */
  const mergeLiveRows = useCallback((rows: any[]) => {
    if (!Array.isArray(rows) || rows.length === 0) return;
    setCards(prev => {
      let next = prev;
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const key = String(r.telecmi_call_id || r.id || r.phone_e164 || '');
        if (!key || dismissedRef.current.has(key)) continue;

        // Ownership off the snapshot — the self-heal path when SSE dropped and
        // this browser never saw the `answered` event. Same rule as the bus: a
        // row that does not NAME an owner tells us nothing and must not clear
        // one we already know (an older API simply has no such column).
        const rowOwner = String(r.owner_email || '').trim();
        const ownerFields = rowOwner
          ? { ownerEmail: rowOwner, ownerName: String(r.owner_name || '').trim() || rowOwner }
          : null;

        // STILL RINGING? Absent status = the `ringing` list = ringing. This is
        // the one thing that decides whether agent_display names the extension
        // being RUNG or the person who ANSWERED, and getting it wrong would put
        // "Answered by Pushpa" on a call Pushpa has not picked up.
        const rowRinging = String(r.status || 'ringing') === 'ringing';
        const agentDisplay = String(r.agent_display || '').trim();
        // Rungs 1 and 2, already resolved and already mutually exclusive on the
        // wire. Asked only of a ringing row: once a call is answered "who is it
        // ringing for" has no live answer, and the route does not send one.
        const rowRingingFor = rowRinging ? String(r.ringing_agent_name || '').trim() : '';
        const rowRingingGroup = rowRinging ? String(r.ringing_group_name || '').trim() : '';
        // The server's own "is this mine", used by monitor mode alone.
        const rowIsMine: boolean | undefined = typeof r.is_mine === 'boolean' ? r.is_mine : undefined;

        const hit = next.findIndex(c => c.key === key || (!!r.id && c.callId === r.id));
        if (hit !== -1) {
          const c = next[hit];
          const patch: Partial<PopCard> = {
            ...(ownerFields || {}),
            // Only when it actually CHANGES. Every poll carries is_mine, so
            // copying it unconditionally would hand back a new card object (and
            // a new array) every five seconds for a stack that has not moved.
            ...(rowIsMine !== undefined && rowIsMine !== c.isMine ? { isMine: rowIsMine } : {}),
            // FILL A BLANK ONLY, all three — and rung 1 has one more test to
            // pass before it may be refilled.
            //
            // THE CONTRADICTION THIS SECOND CLAUSE EXISTS FOR. The missed-leg
            // branch above CLEARS ringingFor in exactly one case: when it named
            // the agent the CDR has just told us let the call pass. A blank is
            // precisely what "fill a blank" treats as free to write, and
            // ct_calls.agent_user is NOT cleared by a missed-leg CDR — so the
            // very next 5s poll would hand the same name straight back, and the
            // card would print "Ringing — Pushpa B" in the header directly above
            // "Pushpa B did not pick up" in the body. That is the one sentence
            // this file's header says it must never print, and it would be
            // permanent, because every poll re-asserts it.
            //
            // Dormant while live rings on this account name nobody — and left
            // dormant would be worse than useless, since the whole point of the
            // ingest log is to make naming the ringing extension possible. The
            // Live wallboard closes the same hole at its own merge, from the
            // same two fields side by side.
            ...(rowRingingFor && !c.ringingFor && !sameLabel(rowRingingFor, c.missedByName)
              ? { ringingFor: rowRingingFor }
              : {}),
            ...(rowRingingGroup && !c.ringingGroup ? { ringingGroup: rowRingingGroup } : {}),
            // …and the answerer only off a row that says somebody answered.
            ...(!rowRinging && agentDisplay && !c.agentName ? { agentName: agentDisplay } : {}),
          };
          if (Object.keys(patch).length) {
            next = next === prev ? [...next] : next;   // never mutate state in place
            next[hit] = { ...c, ...patch };
          }
          continue;
        }
        const guest: GuestSnap | null = r.guest_id
          ? {
              id: String(r.guest_id),
              name: String(r.guest_name || ''),
              tags: Array.isArray(r.guest_tags) ? r.guest_tags.map((t: unknown) => String(t)) : [],
            }
          : null;
        const startedAt = String(r.started_at || new Date().toISOString());
        next = pushCard(next, {
          key,
          telecmiCallId: r.telecmi_call_id ? String(r.telecmi_call_id) : undefined,
          callId: r.id ? String(r.id) : undefined,
          phone: String(r.phone_e164 || ''),
          guest,
          agent: String(r.agent_user || ''),
          // WHO ANSWERED — and ONLY off a row that has been answered. On a
          // ringing row agent_display resolves the extension the PBX is ringing,
          // not the person holding the call, so copying it here would render
          // "Answered by Pushpa B" on a phone still ringing on her desk.
          agentName: rowRinging ? '' : agentDisplay,
          // WHO IT IS RINGING FOR, both rungs, resolved by the server. This is
          // what a card born from the snapshot used to have to leave blank.
          ringingFor: rowRingingFor,
          ringingGroup: rowRingingGroup,
          missedByName: '',
          hunting: false,
          queue: String(r.queue || ''),
          startedAt,
          lastSignalAt: startedAt,
          mode: rowRinging ? 'ringing' : 'answered',
          // Talk time counts from the answer. answered_at should always be set
          // on an answered row; falling back to started_at when it is not
          // over-counts by the ring (~25s), which is a smaller lie than a talk
          // timer frozen at 0:00 on a conversation that is demonstrably running.
          ...(rowRinging ? {} : { answeredAt: String(r.answered_at || '') || startedAt }),
          ownerEmail: ownerFields?.ownerEmail || '',
          ownerName: ownerFields?.ownerName || '',
          ...(rowIsMine !== undefined ? { isMine: rowIsMine } : {}),
          // The snapshot carries the owner but NOT the lock, so a card born here
          // starts with the lock unknown and keeps the full pop until the
          // ?owned= answer arrives — which it asks for on the very next tick,
          // because having an owner is one of the things that makes a card ask.
          freeAtLabel: '',
          blocked: '',
          newName: '',
          error: '',
        }, dismissedRef.current);
      }
      return next;
    });
  }, []);

  /**
   * The SERVER's verdict for THIS viewer on the cards we asked about
   * (?owned=). Authoritative in a way nothing else here is: it is a direct read
   * of the row by an authenticated request, so an owner_email of '' really does
   * mean unowned (unlike the ringing snapshot, which is a partial view), and
   * can_write is the same answer the disposition PUT will give.
   *
   * IT ALSO CARRIES WHO ANSWERED (agent_display, resolved server-side by the
   * same resolveAgentLabel() the Call Log uses). That is a strictly ADDITIVE
   * read here and it is applied under the file's existing guarded-merge rule:
   * it may only FILL A BLANK. It never overwrites a name an event already
   * established — the events know things a row does not, and a snapshot must not
   * be able to undo them — never blanks one, and never touches `mode`: learning
   * who is on a call says nothing about whether the call is still up, and
   * promoting a card on the strength of it would put a finished call back on the
   * phone (the same mistake the 'ownership' event is explicitly forbidden from
   * making).
   */
  const applyOwned = useCallback((rows: any[]) => {
    if (!Array.isArray(rows) || rows.length === 0) return;
    setCards(prev => {
      let next = prev;
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const id = String(r.id || '');
        if (!id) continue;
        const hit = next.findIndex(c => c.callId === id);
        if (hit === -1) continue;
        // A CLAIM IS IN FLIGHT ON THIS CARD — leave it alone. This answer was
        // read from the row before our POST landed, so applying it would flash
        // the pre-claim state (and, for a beat, somebody else's strip) over a
        // call we are in the middle of taking. The claim's own response, and the
        // next poll, both settle it correctly.
        if (next[hit].claiming) continue;
        const owner = String(r.owner_email || '').trim();
        // FILL A BLANK ONLY. An unmapped id resolves to the raw id, never to
        // blank, so a non-empty agent_display is always something worth showing;
        // an empty one is "the server does not know either" and must leave a
        // name we already have alone.
        const agentDisplay = String(r.agent_display || '').trim();
        next = next === prev ? [...next] : next;   // never mutate state in place
        next[hit] = {
          ...next[hit],
          ...(agentDisplay && !next[hit].agentName ? { agentName: agentDisplay } : {}),
          ownerEmail: owner,
          ownerName: owner ? (String(r.owner_name || '').trim() || owner) : '',
          ...(typeof r.locked === 'boolean' ? { locked: r.locked } : {}),
          ...(typeof r.can_write === 'boolean' ? { canWrite: r.can_write } : {}),
          freeAtLabel: String(r.free_at_label || ''),
          // A refusal is only true until the server says otherwise, and it just
          // did. Leaving it would redraw the strip over a call this viewer may
          // now write — the same "outlived its truth" bug in a second costume.
          ...(r.can_write === true ? { blocked: '' } : {}),
        };
      }
      return next;
    });
  }, []);

  const pollLive = useCallback(async (processEvents: boolean) => {
    try {
      // ?owned= rides along on the request this component already makes. ONE
      // batched question about every card on screen whose lock we need checked —
      // never a request per card, and none at all when there is nothing to ask.
      const ids = ownedIdsOf(cardsRef.current);
      const owned = ids.length ? `&owned=${encodeURIComponent(ids.join(','))}` : '';
      const r = await fetch(`/api/crm-calls/live?after=${seqRef.current}${owned}`);
      if (!r.ok) return;
      let j: any = null;
      try { j = await r.json(); } catch { return; }
      if (typeof j?.seq === 'number') seqRef.current = Math.max(seqRef.current, j.seq);
      // WHICH LIST — and this single line is the whole of "an admin sees every
      // live call". `active` is `ringing` plus the calls that have already been
      // ANSWERED and not yet ended, i.e. exactly the ones a browser can learn
      // about no other way: a card is normally born from the `incoming_call`
      // event, so a tab opened (or reloaded) while a conversation is running
      // knows nothing about it at all — no guest, no agent, no owner — until the
      // next event, which on a five-minute call is never.
      //
      // ADMIN ONLY, on purpose. Labelling calls is for everybody (that is the
      // other half of this change), but WHICH CALLS a GRE's pop shows is monitor
      // mode, and a non-admin must keep exactly the stack they have today.
      //
      // THE ENFORCEMENT IS THE SERVER'S. It does not send `active` to a
      // non-admin at all, so this line is belt-and-braces rather than the gate —
      // which is the right way round: a client-side `if` beside a wire that
      // carried the rows anyway was a hidden control, not a permission. The
      // `Array.isArray` arm also covers a server older than `active`, and both
      // fall through to `ringing`.
      //
      // Read off the ref so this callback keeps a stable identity — it is a
      // dependency of the SSE effect, and re-creating it would reconnect the
      // stream.
      const live = isAdminRef.current && Array.isArray(j?.active) ? j.active : j?.ringing;
      mergeLiveRows(Array.isArray(live) ? live : []);
      if (processEvents && Array.isArray(j?.events)) {
        for (const e of j.events) handleEvent(e);
      }
      // LAST: the authoritative per-viewer verdict wins over anything the events
      // above patched in, because it was read from the row by this same request.
      applyOwned(Array.isArray(j?.owned) ? j.owned : []);
    } catch { /* transient network error — next tick retries */ }
  }, [applyOwned, handleEvent, mergeLiveRows]);

  /**
   * THE LOCK CLOCK. Everything else here is event-driven, and a lapsing lock is
   * the one thing that fires no event: 15 minutes after the call ends (or 60
   * after the claim) the server opens the call, and nothing tells anybody. The
   * SSE stream cannot help — it is healthy, and healthy is exactly when the 5s
   * fallback poll is switched OFF, so without this the strip would still be up
   * at 19:21 on a browser nobody has touched.
   *
   * Costs nothing when there is nothing to watch: ownedIdsOf() is empty unless a
   * card on screen actually has an owner / a lock / a refusal, and the fallback
   * poll (which already carries ?owned= every 5s) suppresses this one entirely.
   */
  // Re-armed (and re-asked) whenever this string changes, which is exactly when
  // the ownership picture moved — a claim, an answer, a takeover, a refusal.
  // That immediacy is what gets a manager's can_write back within a tick instead
  // of making them wait out the interval with their chips greyed.
  // The last segment is "this card is up and still nameless" — the second reason
  // a card asks (see ownedIdsOf). Included so the ask happens on the tick the
  // call is answered rather than up to OWNERSHIP_REFRESH_MS later: a name that
  // lands after the conversation is over is the very problem being fixed.
  const ownedSignature = cards
    .filter(c => !!c.callId)
    .map(c => `${c.callId}:${c.ownerEmail.toLowerCase()}:${c.locked === true ? 1 : 0}:${c.blocked ? 1 : 0}:${c.mode === 'answered' && !c.agentName ? 1 : 0}`)
    .join('|');
  const watching = ownedIdsOf(cards).length > 0;
  useEffect(() => {
    if (!watching) return;
    const tick = () => { if (!pollTimer.current) void pollLive(true); };
    tick();
    const t = setInterval(tick, OWNERSHIP_REFRESH_MS);
    return () => clearInterval(t);
  }, [watching, ownedSignature, pollLive]);

  // ── SSE with poll fallback (mirrors the Live Calls wallboard) ─────────────
  useEffect(() => {
    let closed = false;
    const startPolling = () => {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(() => { void pollLive(true); }, 5000);
    };
    const connect = () => {
      if (closed) return;
      try {
        const es = new EventSource('/api/crm-calls/events');
        esRef.current = es;
        es.onopen = () => {
          if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
        };
        es.onmessage = (m) => {
          try { handleEvent(JSON.parse(m.data)); } catch { /* heartbeat */ }
        };
        es.onerror = () => {
          es.close();
          esRef.current = null;
          startPolling();
          if (!closed) setTimeout(connect, 30000); // keep retrying SSE
        };
      } catch {
        startPolling();
      }
    };
    connect();
    // Initial seed: latest seq + mid-ring calls, but SKIP the historical
    // event backlog (after=0 would replay old, long-finished calls).
    void pollLive(false);
    return () => {
      closed = true;
      esRef.current?.close();
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [handleEvent, pollLive]);

  // ── Actions ────────────────────────────────────────────────────────────────

  /** ct_calls.id for a card — from the event, else the live ringing list. */
  const resolveCallId = useCallback(async (card: PopCard): Promise<string | null> => {
    if (card.callId) return card.callId;
    try {
      const r = await fetch(`/api/crm-calls/live?after=${seqRef.current}`);
      if (r.ok) {
        let j: any = null;
        try { j = await r.json(); } catch { return null; }
        const rows: any[] = Array.isArray(j?.ringing) ? j.ringing : [];
        const m = rows.find(x =>
          (card.telecmiCallId && x?.telecmi_call_id === card.telecmiCallId) ||
          (!card.telecmiCallId && card.phone && x?.phone_e164 === card.phone),
        );
        if (m?.id) return String(m.id);
      }
    } catch { /* fall through */ }
    return null;
  }, []);

  /**
   * FIRST CLAIM WINS — take the call before acting on it.
   *
   * `proceed: false` means somebody else got there first. The card has already
   * been collapsed to the strip naming them, and that IS the losing experience:
   * two GREs reaching for the same call at the same instant is the normal case,
   * not an error, so it never becomes a toast or a red box.
   *
   * FAILS OPEN ON PURPOSE. Only a refusal that NAMES a different owner stops
   * anything. No call id yet, a network blip, a 404 because the endpoint is not
   * deployed, or the claim being refused because the call was never answered
   * (every missed call, which stays everyone's to chase) — all proceed. The
   * client is not the lock: PUT /api/crm-calls/calls/[id] re-checks ownership
   * server-side and its 403 is surfaced verbatim. Refusing here on a guess
   * would block work the server would have allowed, which is the one failure
   * the user can neither see through nor get past.
   *
   * Returns the resolved ct_calls.id so the caller uses it directly rather than
   * re-reading card state that React has not re-rendered yet.
   */
  const claimBeforeAct = useCallback(async (
    card: PopCard,
  ): Promise<{ proceed: boolean; callId?: string }> => {
    // WHAT WE CLAIM WITH. The claim route accepts EITHER ct_calls.id or the
    // TeleCMI id, and that matters more than it looks: resolveCallId() finds the
    // internal id by searching /api/crm-calls/live, whose snapshot is RINGING
    // rows only — and a claimable call has by definition stopped ringing. So for
    // the very case first-claim exists for, resolveCallId() usually comes back
    // empty and the TeleCMI id is the only handle we have.
    const claimRef = card.callId || card.telecmiCallId || (await resolveCallId(card)) || '';
    if (!claimRef) return { proceed: true };
    updateCard(card.key, { claiming: true, error: '' });
    try {
      const res = await api(`/api/crm-calls/calls/${encodeURIComponent(claimRef)}/claim`, { method: 'POST' });
      let j: any = {};
      try { j = await res.json(); } catch { /* keep {} */ }
      const owner = String(j?.owner || j?.owner_email || '').trim();
      const ownerName = String(j?.ownerName || j?.owner_name || '').trim();

      if (res.ok && j?.ok !== false) {
        // Won it (or already had it — re-claiming your own call succeeds). Record
        // ourselves as owner so a later echo of our own claim, on the bus or in a
        // snapshot, can never be mistaken for somebody else holding the call.
        //
        // call_id is the route's resolved ct_calls.id. Keep ONLY that: claimRef
        // may be a TeleCMI id, and the disposition PUT matches on the primary key
        // alone, so storing the wrong one turns the write-up into a 404.
        const realId = String(j?.call_id || '').trim() || card.callId || '';
        updateCard(card.key, {
          claiming: false,
          ownerEmail: owner || myEmail,
          ownerName: ownerName || owner || myEmail,
          // We hold it, so a lock is in force and it is ours: chips stay live
          // because canWrite is us, not because nothing is locked.
          locked: true,
          canWrite: true,
          // We hold it now, so any earlier refusal is spent. Not reachable while
          // the strip has no actions on it, but keeping the invariant here means
          // "owned by me" and "blocked" can never both be true on one card.
          blocked: '',
          ...(realId ? { callId: realId } : {}),
        });
        return { proceed: true, callId: realId || undefined };
      }

      if (owner && !sameEmail(owner, myEmail)) {
        // MANAGEMENT IS NOT BLOCKED BY A LOST CLAIM. claimCall() refuses anyone
        // who is not the owner — the management override lives in overrideCall(),
        // not in the claim — so a manager clicking a chip on somebody else's call
        // loses this race even though the PUT that follows would be ACCEPTED.
        // can_write is the server's own answer for this viewer, so when it says
        // yes we go on and let the write happen; the takeover button is for
        // deliberately taking the call, not a toll gate on doing the work.
        if (card.canWrite === true) {
          updateCard(card.key, {
            claiming: false,
            ownerEmail: owner,
            ownerName: ownerName || owner,
            locked: true,
            blocked: '',
          });
          return { proceed: true, callId: card.callId || undefined };
        }
        updateCard(card.key, {
          claiming: false,
          ownerEmail: owner,
          ownerName: ownerName || owner,
          // A live lock held by somebody else. `locked` is what draws the strip;
          // canWrite stays where it is so the next ?owned= answer can still turn
          // out to be "yes" for a manager whose poll has not landed yet.
          locked: true,
          // The server's sentence, which also carries when the call frees up.
          // Kept so the strip is right even before /api/auth/me has answered.
          blocked: String(j?.message || j?.error || '')
            || `${ownerName || owner} answered this call first and is handling it.`,
        });
        return { proceed: false };
      }

      // Inconclusive (not answered yet, no such call, endpoint missing, 401…):
      // proceed and let the server decide. No callId is reported — claimRef may
      // be a TeleCMI id, and only the internal id is safe to write back.
      updateCard(card.key, { claiming: false });
      return { proceed: true, callId: card.callId || undefined };
    } catch {
      updateCard(card.key, { claiming: false });
      return { proceed: true, callId: card.callId || undefined };
    }
  }, [myEmail, resolveCallId, updateCard]);

  /**
   * MANAGEMENT TAKEOVER — POST .../claim { override: true }.
   *
   * Three sentences on the server promise this ("A manager can take it over.",
   * from refusal() in call-owner.ts, on every refusal a GRE ever reads) and until
   * now nothing in any .tsx sent override:true, so the promise was unkeepable
   * from the product. overrideCall() owns the Admin/Manager/HOD check, so this
   * button is offered ONLY where the server already said can_write on a call that
   * is locked to somebody else — which is exactly the management case — and a
   * non-manager who somehow reached it gets a 403 with the lib's own sentence.
   *
   * Ordinary chips do NOT come through here: a manager who just wants to write
   * the call up is let through by claimBeforeAct above. This is for deliberately
   * moving the call onto themselves, which is what unsticks a bad claim.
   */
  const takeOver = useCallback(async (card: PopCard) => {
    const claimRef = card.callId || card.telecmiCallId || '';
    if (!claimRef) {
      updateCard(card.key, { error: 'Call record not found yet — try again in a moment.' });
      return;
    }
    updateCard(card.key, { claiming: true, error: '' });
    try {
      const res = await api(`/api/crm-calls/calls/${encodeURIComponent(claimRef)}/claim`, {
        method: 'POST',
        body: { override: true },
      });
      let j: any = {};
      try { j = await res.json(); } catch { /* keep {} */ }
      if (res.ok && j?.ok !== false) {
        const owner = String(j?.owner || '').trim() || myEmail;
        const realId = String(j?.call_id || '').trim() || card.callId || '';
        updateCard(card.key, {
          claiming: false,
          ownerEmail: owner,
          ownerName: String(j?.ownerName || '').trim() || owner,
          locked: true,
          canWrite: true,
          freeAtLabel: '',
          blocked: '',
          ...(realId ? { callId: realId } : {}),
        });
        return;
      }
      // The lib's own sentence, verbatim — it says why, and this is a deliberate
      // action, so unlike a lost race it deserves to be reported.
      updateCard(card.key, {
        claiming: false,
        error: String(j?.error || '') || `Could not take this call (HTTP ${res.status})`,
      });
    } catch (e: any) {
      updateCard(card.key, { claiming: false, error: e?.message || 'Network error — call not taken over' });
    }
  }, [myEmail, updateCard]);

  /**
   * Create the guest for an unknown caller.
   *
   * DELIBERATELY DOES NOT CLAIM THE CALL. This writes guest master data, not
   * the call write-up: the server does not gate it, it is needed just as much
   * by whoever is chasing a missed call, and claiming here would let someone
   * who only typed a name lock out the person actually talking to the caller.
   */
  const createGuest = useCallback(async (card: PopCard) => {
    if (!card.phone) {
      updateCard(card.key, { error: 'No phone number on this call — cannot create a guest' });
      return;
    }
    updateCard(card.key, { creating: true, error: '' });
    try {
      const res = await api('/api/crm-calls/guests', {
        method: 'POST',
        body: { name: card.newName.trim(), phone: card.phone, source: 'call' },
      });
      let j: any = {};
      try { j = await res.json(); } catch { /* keep {} */ }
      if (res.status === 409 && j?.existing_guest_id) {
        updateCard(card.key, {
          creating: false,
          guest: { id: String(j.existing_guest_id), name: card.newName.trim(), tags: [] },
        });
      } else if (!res.ok) {
        updateCard(card.key, { creating: false, error: j?.error || `Could not create guest (HTTP ${res.status})` });
      } else {
        const g = j?.guest || {};
        updateCard(card.key, {
          creating: false,
          guest: {
            id: String(g.id || ''),
            name: String(g.name || card.newName.trim()),
            tags: Array.isArray(g.tags) ? g.tags.map((t: unknown) => String(t)) : [],
          },
        });
      }
    } catch (e: any) {
      updateCard(card.key, { creating: false, error: e?.message || 'Network error — guest not created' });
    }
  }, [updateCard]);

  const submitDisposition = useCallback(async (card: PopCard, value: string) => {
    updateCard(card.key, { saving: true, error: '' });
    const callId = await resolveCallId(card);
    if (!callId) {
      updateCard(card.key, { saving: false, error: 'Call record not found yet — try again in a moment.' });
      return;
    }
    if (!card.callId) updateCard(card.key, { callId });
    try {
      const res = await api(`/api/crm-calls/calls/${callId}`, {
        method: 'PUT',
        body: { disposition: value },
      });
      let j: any = {};
      try { j = await res.json(); } catch { /* keep {} */ }
      if (!res.ok) {
        // 403 is THE ownership refusal, and the server's own sentence names the
        // owner and says when the call frees up — far more use than "Failed to
        // save". Collapse to the strip carrying it: this browser is not writing
        // this call, so leaving the chips up would just invite a second refusal.
        if (res.status === 403) {
          const owner = String(j?.owner || j?.owner_email || '').trim();
          const ownerName = String(j?.ownerName || j?.owner_name || '').trim();
          updateCard(card.key, {
            saving: false,
            blocked: String(j?.error || j?.block || j?.message || '')
              || 'Another user is writing up this call.',
            // The refusal settles can_write for this viewer, right now — and the
            // 403 states `locked` too. free_at rides along as raw UTC and is
            // deliberately NOT read: formatting it here would be a second copy of
            // a deadline the server already renders in IST. The sentence above
            // carries the time anyway.
            canWrite: false,
            ...(typeof j?.locked === 'boolean' ? { locked: j.locked } : {}),
            ...(owner ? { ownerEmail: owner, ownerName: ownerName || owner } : {}),
          });
          return;
        }
        updateCard(card.key, { saving: false, error: j?.error || `Failed to save (HTTP ${res.status})` });
        return;
      }
      removeCard(card.key); // dispositioned → done
    } catch (e: any) {
      updateCard(card.key, { saving: false, error: e?.message || 'Network error — outcome not saved' });
    }
  }, [removeCard, resolveCallId, updateCard]);

  /** "Booking Made" chip: open Quick Booking first, disposition after save. */
  const openBookingForDisposition = useCallback(async (card: PopCard) => {
    updateCard(card.key, { error: '' });
    const callId = card.callId || (await resolveCallId(card)) || undefined;
    if (callId && !card.callId) updateCard(card.key, { callId });
    setBooking({
      cardKey: card.key,
      guestId: card.guest?.id,
      guestName: card.guest?.name,
      sourceCallId: callId,
      dispositionAfter: true,
    });
  }, [resolveCallId, updateCard]);

  /**
   * A disposition chip — the gated write. Take the call first: whoever writes
   * it up owns it, which is exactly the double-write this feature exists to
   * stop. Losing the race collapses this card to the strip and the PUT never
   * leaves, so the winner's write-up is the only one.
   *
   * `handleBookingSaved` also reaches submitDisposition, but only down the
   * booking_made path that already claimed here, so the claim sits at the
   * moments work is actually COMMITTED — a chip, or a booking saved — and never
   * inside the writer.
   */
  const onChip = useCallback((card: PopCard, value: string) => {
    void (async () => {
      const gate = await claimBeforeAct(card);
      if (!gate.proceed) return;
      const c = gate.callId ? { ...card, callId: gate.callId } : card;
      if (value === 'booking_made') await openBookingForDisposition(c);
      else await submitDisposition(c, value);
    })();
  }, [claimBeforeAct, openBookingForDisposition, submitDisposition]);

  /**
   * [+ Quick Booking] while ringing / talking. OPENING THE MODAL CLAIMS NOTHING.
   *
   * It used to, and that is the same hazard createGuest() refuses to take three
   * functions up: a bystander who mis-clicks would own the call for the rest of
   * it plus the whole write-up window, the GRE actually on the phone would be
   * told "<Bystander> is on this call", and cancelling the modal released
   * nothing because nothing here ever released. Merely LOOKING at a booking form
   * is not handling a call.
   *
   * The claim moves to the save (see handleBookingSaved) — the point at which a
   * booking carrying source_call_id exists, which really is a write-up of this
   * call by another name. Cancel now costs nobody anything, because cancel never
   * claimed.
   *
   * The callId is still resolved here so the booking can carry source_call_id.
   */
  const onQuickBooking = useCallback((card: PopCard) => {
    void (async () => {
      updateCard(card.key, { error: '' });
      const callId = card.callId || (await resolveCallId(card)) || undefined;
      if (callId && !card.callId) updateCard(card.key, { callId });
      setBooking({
        cardKey: card.key,
        guestId: card.guest?.id,
        guestName: card.guest?.name,
        sourceCallId: callId,
        dispositionAfter: false,
      });
    })();
  }, [resolveCallId, updateCard]);

  const handleBookingSaved = useCallback((b: NonNullable<typeof booking>) => {
    const card = cardsRef.current.find(c => c.key === b.cardKey);
    if (!card) return;
    // booking_made came through onChip, which already claimed; go straight to
    // the disposition (which is itself the gated write and 403s if we lost it).
    if (b.dispositionAfter) { void submitDisposition(card, 'booking_made'); return; }
    // THE QUICK-BOOKING CLAIM, ON SAVE. A booking now exists against this call,
    // so the write-up is ours to hold. A lost race just collapses the card to
    // the strip — the booking is guest/booking data and stands either way, and a
    // ringing call is refused as not-answered and changes nothing.
    void claimBeforeAct(card);
  }, [claimBeforeAct, submitDisposition]);

  const secondsSince = (iso?: string) => {
    const t = new Date(String(iso || '')).getTime();
    if (isNaN(t)) return 0;
    return Math.max(0, Math.floor((nowTick - t) / 1000));
  };

  /** "2:31" — talk time reads as a duration, not as a raw second count. */
  const clock = (secs: number) =>
    `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  if (cards.length === 0 && !booking) return null;

  return (
    <>
      {/* Below the floating bell; container is click-through, cards are not. */}
      <div className="fixed top-24 right-4 md:right-6 z-50 w-[min(92vw,22.5rem)] space-y-3 pointer-events-none">
        <style>{'@keyframes ctPopSlideIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}'}</style>
        {cards.map(card => {
          /* A LOCK IS IN FORCE ON THIS CALL AND IT IS NOT MINE.
             Read off the SERVER's locked/can_write, never off "it has an
             owner" — an owner outlives the lock, which is exactly how this
             strip used to stay up all evening on a call the server had already
             opened to everyone. lockView() is where that rule lives. */
          const lock = lockView(card, myEmail);
          /* ADMIN MONITOR MODE — is this somebody ELSE'S call that I am only
             watching? (See the header for the ruling and its one exception to
             this file's "never refuse where the server would allow".)

             Three properties make this the right predicate rather than a
             near-miss:
               · THE SERVER ANSWERS FIRST. is_mine is computed from the session
                 AND the agent map — the map is admin-only and never reaches a
                 browser, so a mapped admin's own call is recognised without
                 anything being exposed. sameEmail is the fallback for a card no
                 snapshot has covered yet, and it returns false for two blanks,
                 so an unknown identity is never "mine".
               · A KNOWN OWNER IS REQUIRED. An UNOWNED card — every missed call,
                 and every call an unmapped agent answered — stays first-claim
                 for the admin exactly as it does for everyone: the server would
                 accept the write, chasing it is the recovery queue's whole job,
                 and hiding it would take a call away from someone who can work
                 it. So watch-only is only ever "this belongs to a named person
                 who is not me".
               · isAdmin FAILS CLOSED, so for every GRE this is false and every
                 branch below it is dead code. */
          const isMine = card.isMine === true || sameEmail(card.ownerEmail, myEmail);
          const watchOnly = isAdmin && !!card.ownerEmail && !isMine;
          /* Who I am watching. The answerer when telephony named one, else the
             owner — and never blank, because watchOnly requires an owner and the
             server falls owner_name back to the email rather than to nothing. */
          const watchingWho = card.agentName || card.ownerName || card.ownerEmail;
          /* …and I MAY NOT write it → the pop closes down to a slim read-only
             strip naming them. No chips, no Quick Booking, no disposition —
             one answered call, one write-up. Only the dismiss stays, because a
             strip nobody can clear is just clutter on a screen that lives open
             all shift. No "take over" here either: this branch is precisely
             the non-management one, and offering an action the server will
             refuse is worse than not offering it. */
          if (lock && !lock.canWrite) {
            return (
              <div key={card.key} role="status"
                   style={{ animation: 'ctPopSlideIn .3s ease-out' }}
                   className="pointer-events-auto w-full bg-white border border-[#E8D5C4] rounded-xl shadow-lg overflow-hidden">
                <div className="flex items-start gap-2 px-3 py-2.5">
                  <span className="mt-px shrink-0 w-6 h-6 rounded-full bg-[#FFF1E3] border border-[#E8D5C4] inline-flex items-center justify-center">
                    <Lock className="w-3.5 h-3.5 text-[#8B7355]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-[#2D1B0E] leading-snug">{lock.title}</p>
                    <p className="text-[11px] text-[#8B7355] truncate mt-0.5">
                      {[card.guest?.name, formatPhone(card.phone) || card.phone].filter(Boolean).join(' · ') || '—'}
                      {/* The server's own IST label — this browser never works
                          out a deadline of its own. */}
                      {lock.freeAtLabel ? ` · opens to everyone at ${lock.freeAtLabel}` : ''}
                    </p>
                  </div>
                  <button onClick={() => removeCard(card.key)} aria-label="Dismiss"
                          className="p-0.5 rounded hover:bg-[#FFF1E3] shrink-0">
                    <X className="w-4 h-4 text-[#8B7355]" />
                  </button>
                </div>
              </div>
            );
          }

          const tags = card.guest?.tags || [];
          const isVip = tags.some(t => String(t).toLowerCase() === 'vip');
          const otherTags = tags.filter(t => String(t).toLowerCase() !== 'vip').slice(0, 3);
          /* THE HEADER MUST NEVER SAY SOMETHING THE CARD DOES NOT KNOW.
             Three states, plus the one honest admission: a card still claiming
             to ring RING_STALE_SECONDS after its LAST NEWS (the first ring, or
             the last leg that rang out — see PopCard.lastSignalAt) has heard
             nothing since, and by then the server itself has stopped believing
             it (see the constant). It says so and freezes its counter rather
             than implying a phone is still ringing somewhere in the building. */
          const ringStale = card.mode === 'ringing'
            && secondsSince(card.lastSignalAt || card.startedAt) > RING_STALE_SECONDS;
          const onCall = card.mode === 'answered';
          /* THE HUNT GROUP IS STILL WALKING EXTENSIONS. One leg rang out and the
             call moved on, which is news the card must show rather than act on:
             it is still a RINGING card in every other respect. Gated on
             !ringStale because once the window has expired we no longer know
             that, and the honest admission below outranks it. */
          const hunting = card.mode === 'ringing' && card.hunting && !ringStale;
          /* RUNG 2 OF "RINGING FOR" — the GROUP, read ONLY once rung 1 (the
             person, which the header prints) has come up empty. That ordering is
             the whole guarantee that the card cannot say "Ringing — Pushpa B" in
             the header and "Ringing the Front Desk team" underneath it: two
             answers to one question, one of them stale.

             Gated on a card that is RINGING and not stale, for the same reason
             `hunting` is: once the window has expired we no longer know the
             phones are ringing, and claiming a group is being rung would be the
             very lie the stale header exists to stop telling. It is also the
             rung that survives a missed leg — one member giving up does not stop
             the group ringing — which is what the card falls back to when the
             name it was showing is cleared for contradicting "X did not pick
             up". */
          const ringGroup = card.mode === 'ringing' && !ringStale && !card.ringingFor
            ? groupPhrase(card.ringingGroup)
            : '';
          /* …AND THE ONE CASE WHERE IT NEVER CAME BACK. A missed leg was the last
             thing we ever heard: nothing says the call is still up, and a call
             that rang out is a real missed call somebody has to write up. The
             card drops to the stale presentation AND offers the outcome chips,
             so it is never left with a dismiss as the only way out. */
          const strandedMiss = ringStale && card.hunting;
          const showChips = card.mode === 'disposition' || strandedMiss;
          const headerBg = ringStale ? 'bg-[#6B5744]' : onCall ? 'bg-[#15803d]' : card.mode === 'ringing' ? 'bg-[#af4408]' : 'bg-[#2D1B0E]';
          const headerText = ringStale
            ? 'No update from telephony'
            : onCall ? 'On call'
            // WHO IT IS RINGING FOR, in the header, while it rings. An unmapped
            // extension resolves to the raw id and is printed as the raw id —
            // "Ringing — 201_1111112" tells the GRE something; a blank does not.
            : card.mode === 'ringing' ? (card.ringingFor ? `Ringing — ${card.ringingFor}` : 'Incoming call')
            : 'Call ended — log outcome';
          return (
            <div key={card.key}
                 style={{ animation: 'ctPopSlideIn .3s ease-out' }}
                 className="pointer-events-auto w-full bg-white border border-[#E8D5C4] rounded-xl shadow-2xl overflow-hidden">
              {/* Header strip */}
              <div className={`flex items-center gap-2 px-3 py-2 text-white ${headerBg}`}>
                {card.mode === 'ringing'
                  ? <PhoneIncoming className={`w-4 h-4 shrink-0 ${ringStale ? '' : 'animate-pulse'}`} />
                  : onCall
                    ? <PhoneCall className="w-4 h-4 shrink-0" />
                    : <PhoneOff className="w-4 h-4 shrink-0" />}
                <span className="text-xs font-semibold uppercase tracking-wide flex-1 truncate">
                  {headerText}
                </span>
                {/* Ring seconds while ringing; TALK TIME once answered, counted
                    from the answer and formatted as a duration so it reads the
                    same way the Call Log's "02:31" does. */}
                {card.mode === 'ringing' && !ringStale && (
                  <span className="text-[11px] tabular-nums opacity-90 shrink-0">{secondsSince(card.startedAt)}s</span>
                )}
                {onCall && (
                  <span className="text-[11px] tabular-nums opacity-90 shrink-0">{clock(secondsSince(card.answeredAt))}</span>
                )}
                <button onClick={() => removeCard(card.key)} aria-label="Dismiss"
                        className="p-0.5 rounded hover:bg-white/20 shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-3 space-y-2.5">
                {/* WHO IT IS RINGING, SAID OUT LOUD. Directly under the header,
                    because these are the sentences that stop a GRE believing
                    the call is over or that it is not their problem: the ring
                    GROUP when the header could not name a person (rung 2), and
                    the hunt itself — one extension gave up, the phone is still
                    ringing on the next one. The missed name is kept when the
                    window has expired too — "X did not pick up" stays true
                    whatever happened afterwards — but the claim that anything
                    is still ringing is dropped with it, which is why `ringGroup`
                    and `hunting` are both gated on !ringStale and the icon falls
                    back to the hung-up phone. */}
                {(hunting || !!ringGroup || (strandedMiss && !!card.missedByName)) && (
                  <div className="flex items-start gap-2 px-2.5 py-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg">
                    {(hunting || ringGroup)
                      ? <PhoneIncoming className="w-3.5 h-3.5 text-[#af4408] shrink-0 mt-0.5 animate-pulse" />
                      : <PhoneOff className="w-3.5 h-3.5 text-[#8B7355] shrink-0 mt-0.5" />}
                    <div className="min-w-0 flex-1">
                      {/* WHO IT IS RINGING FOR, when the header could not say.
                          One sentence, never two: the group and the hunt are
                          the same fact seen from two sides ("it is ringing the
                          Front Desk team" / "one of them just gave up"), and
                          printing them as separate lines reads like two
                          different calls. When the wire named no group at all
                          this is exactly today's wording, unchanged. */}
                      {(hunting || ringGroup) && (
                        <p className="text-[11px] font-semibold text-[#af4408] leading-snug">
                          {ringGroup
                            ? <>Ringing the <b className="text-[#2D1B0E]">{ringGroup}</b>{hunting ? ' — trying the next agent' : ''}</>
                            : 'Ringing — trying the next agent'}
                        </p>
                      )}
                      {!!card.missedByName && (
                        <p className="text-[11px] text-[#8B7355] leading-snug truncate">
                          <b className="text-[#2D1B0E] font-semibold">{card.missedByName}</b> did not pick up
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Identity */}
                {card.guest ? (
                  <div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="font-bold text-[#2D1B0E] truncate max-w-full">{card.guest.name || 'Guest'}</p>
                      {isVip && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-300">
                          <Star className="w-3 h-3 fill-amber-500 text-amber-500" /> VIP
                        </span>
                      )}
                      {card.guest.badge && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#FFF1E3] text-[#af4408] border border-[#E8D5C4]">
                          {card.guest.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-[#6B5744] font-mono">{formatPhone(card.phone) || card.phone || '—'}</p>
                    {otherTags.length > 0 && (
                      <div className="flex gap-1 flex-wrap mt-1">
                        {otherTags.map(t => (
                          <span key={String(t)} className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#FFF8F0] text-[#8B7355] border border-[#E8D5C4]">
                            {String(t)}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-[11px] text-[#8B7355] mt-1">
                      {card.guest.total_calls ?? 0} calls · {card.guest.total_bookings ?? 0} bookings
                      {card.guest.last_visit_at ? ` · last visit ${istDay(card.guest.last_visit_at)}` : ''}
                    </p>
                    {(card.queue || card.agent) && (
                      <p className="text-[10px] text-[#8B7355] truncate">{[card.queue, card.agent].filter(Boolean).join(' · ')}</p>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="font-bold text-[#2D1B0E]">New caller</p>
                    <p className="text-sm text-[#6B5744] font-mono">{formatPhone(card.phone) || card.phone || 'Unknown number'}</p>
                    <div className="flex gap-2 mt-2">
                      <input type="text" value={card.newName}
                             onChange={e => updateCard(card.key, { newName: e.target.value })}
                             placeholder="Guest name"
                             className="flex-1 min-w-0 px-2.5 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E]" />
                      <button onClick={() => createGuest(card)} disabled={card.creating || !card.phone}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-xs font-semibold shrink-0">
                        {card.creating
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <UserPlus className="w-3.5 h-3.5" />}
                        Create Guest
                      </button>
                    </div>
                  </div>
                )}

                {/* WHO PICKED UP. Rendered for BOTH identity branches, which is
                    the point — the raw agent id used to appear only inside the
                    known-guest block, so on the "New caller" card (the exact
                    case in the owner's screenshot) the pop said nothing at all
                    about who had answered.
                    This is the answerer, NOT the owner: the two differ whenever
                    the TeleCMI agent is unmapped, and the owner already has its
                    own line inside the lock box below. An unmapped id shows as
                    the raw id — resolveAgentLabel never hides one. */}
                {card.agentName && card.mode !== 'ringing' && (
                  <p className="text-[11px] text-[#6B5744] flex items-center gap-1">
                    <UserCheck className="w-3.5 h-3.5 text-[#af4408] shrink-0" />
                    <span className="truncate">
                      Answered by <b className="text-[#2D1B0E]">{card.agentName}</b>
                    </span>
                  </p>
                )}

                {/* MANAGEMENT ON SOMEBODY ELSE'S LOCKED CALL. The server said
                    can_write, so for a MANAGER or an HOD the card stays fully
                    live — chips, Quick Booking, everything — and this line is
                    the part they actually need: WHO is on it, until WHEN, and
                    the takeover three server sentences have been promising.
                    AN ADMIN IS THE ONE EXCEPTION, by the owner's ruling: monitor
                    mode has already removed his chips and Quick Booking on a
                    call that is not his, and this box is what makes that
                    survivable — the takeover below is his one-click route from
                    watching to holding, and it is checked on the server, so
                    nothing here is a promise the API will not keep. Reachable only
                    when the SERVER said can_write on a call locked to someone
                    else — which is the definition of management here, computed
                    by isManagement inside callOwnerState and never re-derived
                    in the browser. Everyone else is caught by the read-only
                    strip above, because a lock arriving on an event resets
                    canWrite to "not yet asked" rather than leaving a stale
                    answer standing (see lockPatch) — without that reset this
                    button did briefly render for bystanders. */}
                {lock && lock.canWrite && (
                  <div className="flex items-start gap-2 px-2.5 py-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg">
                    <Lock className="w-3.5 h-3.5 text-[#8B7355] shrink-0 mt-0.5" />
                    <p className="text-[11px] text-[#6B5744] leading-snug min-w-0 flex-1">
                      {lock.title}
                      {lock.freeAtLabel ? ` · opens to everyone at ${lock.freeAtLabel}` : ''}
                    </p>
                    <button onClick={() => takeOver(card)} disabled={card.claiming}
                            className="text-[11px] text-[#af4408] font-semibold hover:underline disabled:opacity-50 shrink-0">
                      Take over
                    </button>
                  </div>
                )}

                {card.error && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">{card.error}</p>
                )}

                {/* ACTIONS. Quick Booking stays available for the whole live
                    call, ringing AND answered — mid-conversation is exactly when
                    a GRE takes a booking, and gating it on 'ringing' alone would
                    have removed it the instant the guest was picked up. The
                    outcome chips belong to the call being OVER — which is the
                    disposition state, plus the one ringing card we have positive
                    evidence rang out and then went silent (strandedMiss). That
                    card is a missed call in everything but the event that never
                    arrived, and leaving it with no chips would mean the only way
                    off the screen was to throw the write-up away. Quick Booking
                    is not lost with it: the "Booking Made" chip opens the same
                    modal. */}
                {/* ADMIN MONITOR MODE, and the one place it actually bites.
                    Somebody else's call: NO disposition chips and NO Quick
                    Booking — the owner was offered "read-only plus Quick
                    Booking" and chose this shape. It is checked FIRST so there
                    is exactly one gate rather than one on each branch, which is
                    how a control eventually gets added to the wrong side.

                    A LABEL, NOT A DEAD BUTTON. It sits precisely where the
                    button was, because a control that silently vanishes reads as
                    a bug and a greyed-out one reads as a dare. The Profile link
                    stays — watching is the point, and reading a guest's history
                    is not writing anything. The takeover, when the server has
                    said this call is locked to them, is in the box above: that
                    is the honest way for an admin to go from watching to
                    handling, and it is server-checked.

                    For a non-admin `watchOnly` is false and this whole branch is
                    unreachable, so the two below are byte-for-byte today's. */}
                {watchOnly ? (
                  <div className="flex items-center gap-2 pt-0.5">
                    <span className="flex-1 min-w-0 inline-flex items-center gap-1.5 px-3 py-2 bg-[#FFF8F0] border border-[#E8D5C4] text-[#6B5744] rounded-lg text-xs font-semibold">
                      <Eye className="w-3.5 h-3.5 shrink-0 text-[#8B7355]" />
                      <span className="truncate">Watching · {watchingWho}</span>
                    </span>
                    {card.guest?.id && (
                      <Link href={`/crm-calls/guests/${card.guest.id}`}
                            className="inline-flex items-center gap-1 px-3 py-2 bg-[#FFF1E3] hover:bg-[#E8D5C4] text-[#6B5744] rounded-lg text-xs font-semibold shrink-0">
                        <ExternalLink className="w-3.5 h-3.5" /> Profile
                      </Link>
                    )}
                  </div>
                ) : !showChips ? (
                  <div className="flex items-center gap-2 pt-0.5">
                    <button onClick={() => onQuickBooking(card)} disabled={card.claiming}
                            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-xs font-semibold">
                      <CalendarPlus className="w-3.5 h-3.5" /> Quick Booking
                    </button>
                    {card.guest?.id && (
                      <Link href={`/crm-calls/guests/${card.guest.id}`}
                            className="inline-flex items-center gap-1 px-3 py-2 bg-[#FFF1E3] hover:bg-[#E8D5C4] text-[#6B5744] rounded-lg text-xs font-semibold shrink-0">
                        <ExternalLink className="w-3.5 h-3.5" /> Profile
                      </Link>
                    )}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-2 gap-1.5">
                      {DISPOSITIONS.map((d, i) => (
                        <button key={d.value} disabled={card.saving || card.claiming}
                                onClick={() => onChip(card, d.value)}
                                className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50 ${
                                  i === 0
                                    ? 'bg-[#af4408] text-white border-[#af4408] hover:bg-[#8a3506]'
                                    : 'bg-white text-[#6B5744] border-[#D4B896] hover:bg-[#FFF1E3]'
                                } ${i === DISPOSITIONS.length - 1 ? 'col-span-2' : ''}`}>
                          {d.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center justify-between">
                      {card.saving || card.claiming ? (
                        <span className="text-[11px] text-[#8B7355] inline-flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          {card.claiming ? 'Taking this call…' : 'Saving…'}
                        </span>
                      ) : <span />}
                      {card.guest?.id && (
                        <Link href={`/crm-calls/guests/${card.guest.id}`}
                              className="text-[11px] text-[#af4408] font-medium hover:underline inline-flex items-center gap-1">
                          <ExternalLink className="w-3 h-3" /> Open Profile
                        </Link>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {booking && (
        <QuickBookingModal
          open
          onClose={() => setBooking(null)}
          onSaved={() => handleBookingSaved(booking)}
          guestId={booking.guestId}
          guestName={booking.guestName}
          sourceCallId={booking.sourceCallId}
        />
      )}
    </>
  );
}
