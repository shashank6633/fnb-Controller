'use client';

/**
 * CRM — Live Calls wallboard.
 *
 * Real-time view of RECEIVING calls: what's ringing right now, today's
 * answer/miss counters ticking live, and a rolling feed of call events.
 * Data: SSE /api/crm-calls/events (primary) + /api/crm-calls/live poll
 * fallback + /api/crm-calls/dashboard for today's aggregates. Designed to be
 * left open on a counter screen (wallboard), so it is glanceable from far:
 * big numbers, pulsing ring cards, color-coded feed.
 *
 * WHO HAS THE CALL. An answered call is owned by one app user, who gets the
 * screen-pop and the disposition write-up while the lock is in force; everyone
 * below Admin/Manager/HOD is refused the write (src/lib/ct/call-owner.ts). This
 * board is a supervisor's view of that: the owner is shown wherever the data
 * carries one. It rides entirely on feeds the board already reads — the SSE/poll
 * event's ownerName and owner_name on the live snapshot rows — so there is no
 * per-row lookup and no new request. NOTE the owner is a different thing from
 * `agent_user`/agentName: that is the raw TeleCMI agent, which for an unmapped
 * agent belongs to no app user at all.
 *
 * WHO IT IS RINGING FOR, AND WHO ANSWERED — the headline of every card, not a
 * footnote. A supervisor reads this board to judge how the GREs are working, and
 * the only question that answers is "whose phone is this, and did they take it".
 * The card used to print `queue · agent_user` in 11px muted grey — the RAW
 * TeleCMI id, unresolved, which on this account is an empty string on a ringing
 * row, so the line rendered blank and the board named nobody at all.
 *
 * IT IS A LADDER, AND IT NEVER GUESSES. Every rung comes from the payload or
 * from the database; there is no rung that infers a person:
 *   1. the extension the ring NAMED   → "Ringing for Pushpa B"
 *   2. else the ring GROUP / team     → "Ringing the Front Desk team"
 *   3. else                           → "Ringing · extension not reported"
 * and once somebody picks up, `agent_display` → "Answered by Pushpa B".
 * Rungs 1 and 2 are resolved SERVER-side by ringingForLabel() in
 * src/lib/ct/agents.ts and arrive pre-laddered on both feeds — as
 * ringingAgentName / ringingGroupName on the bus event and as
 * ringing_agent_name / ringing_group_name on the snapshot row — so this board,
 * the screen-pop and the /api/crm-calls/live snapshot cannot word it differently.
 * An unmapped id resolves to the raw id ("5002"), never to blank.
 * See attributionOf() for the one place this file words it.
 *
 * A GROUP IS NOT A PERSON. `queue` still carries the team verbatim on every
 * event whether or not an agent was named, so it must never be rendered as
 * "ringing for" — that would print a group beside a named agent on exactly the
 * calls where the name came through. Only ringing_group_name is the rung.
 *
 * AND FOR AN ADMIN IT SHOWS CALLS THAT ARE ALREADY UP. The panel reads `active`
 * from /api/crm-calls/live — every call still in progress, RINGING and ANSWERED
 * — rather than the ringing-only list. An answered call used to vanish off the
 * board the instant it was picked up, so the one moment a supervisor most wants
 * ("who is on this call right now, and for how long") was the one moment the
 * board went blank. `active` is a superset of `ringing`; we render one of the
 * two, never both, or the same call would appear twice.
 *
 * WHICH OF THE TWO IS NOT THIS FILE'S DECISION, and there is deliberately no
 * role test anywhere in it. The SERVER sends `active` to an admin and omits the
 * key for everyone else, so snapshotOf() lands on the right list on its own:
 * a supervisor gets the whole floor, a GRE gets the ringing-only board this page
 * has always shown. Keeping the gate on the wire rather than in the render is
 * the point — a card hidden by a client-side `if` is not a permission, and the
 * rows (guest name, phone, answerer, talk time) would have been delivered
 * anyway to anyone who could open a network tab.
 *
 * One consequence worth knowing: on a NON-admin board an answered call is no
 * longer pulled the instant it is picked up — it goes green, names the answerer,
 * and leaves at the next 12s re-sync when the ringing-only snapshot stops
 * listing it. That is the labelling half of this change and carries nothing the
 * live feed below did not already print to the same audience.
 *
 * OWNERSHIP MOVING IS ITS OWN FEED LINE. A claim, a management takeover and the
 * release a saved disposition broadcasts all arrive as CtEvent 'ownership' —
 * NOT 'answered', which is what they used to be and why a claim four minutes
 * after the hangup printed "Call answered" underneath "Call ended". They change
 * neither the ringing list nor the counters; only who is writing the call up.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PhoneIncoming, PhoneMissed, PhoneCall, Radio, Users, CalendarCheck, ArrowDownLeft, ArrowUpRight,
  MessageCircle, Send, X, Crown, UserCheck,
} from 'lucide-react';
import { formatPhone } from '@/lib/ct/phone';

interface QuickDoc { label: string; url: string; message?: string }

/* ── "Who should take this call" hints (both OFF by default) ────────────────
 * /api/crm-calls/live/routing returns a sticky-agent line and a VIP badge for
 * the ringing numbers. NOT routing: this app does not control the PBX, so the
 * hints only tell the human at the counter what they'd otherwise look up
 * mid-ring. Whether they are on at all rides along on the /api/crm-calls/live
 * poll the board already makes, so with ct_settings.sticky_agent and
 * vip_routing both off (the default) this file issues NO extra request and
 * renders nothing extra — the board is byte-for-byte what it is today. */
interface RoutingHint {
  sticky: {
    agent_user: string;
    agent_label: string;
    last_answered_at: string;
    answered_calls: number;
    total_answered_calls: number;
    window_days: number;
  } | null;
  vip: { isVip: boolean; visits: number; spend: number; reasons: string[] };
}

// Build a wa.me deep link to a number with pre-filled text — opens the GRE's
// WhatsApp to that caller so a menu / band list / corporate menu goes out in
// one tap. Mirrors normalizeWaNumber: bare 10-digit → +91; keep other codes.
function waLink(phone: string, text: string): string {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return d ? `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}` : '';
}

// Compose the WhatsApp text for one quick-send doc: greeting + (custom message
// OR an auto "Here's our <label>:") + the link when present.
function docText(d: QuickDoc, hi: string): string {
  const msg = (d.message || '').trim();
  const body = msg || `Here's our ${d.label}:`;
  return `${hi}${body}${d.url ? ` ${d.url}` : ''}`.trim();
}

// "Send menu" popover — lists the admin-configured quick-send documents that
// have a link OR a message; each opens WhatsApp to the caller pre-filled.
function SendMenu({ phone, guestName, docs }: { phone: string; guestName?: string; docs: QuickDoc[] }) {
  const [open, setOpen] = useState(false);
  const sendable = docs.filter(d => d.url || (d.message || '').trim());
  const hi = guestName && guestName !== 'Unknown caller' ? `Hi ${guestName}! ` : 'Hello! ';
  if (!phone) return null;
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
              className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
              aria-label="Send a document on WhatsApp">
        <MessageCircle className="w-3.5 h-3.5" /> Send
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 z-[61] w-52 bg-white border border-[#E8D5C4] rounded-lg shadow-xl py-1">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#F0E4D6]">
              <span className="text-[10px] font-semibold text-[#8B7355] uppercase tracking-wide">Send on WhatsApp</span>
              <button onClick={() => setOpen(false)} aria-label="Close"><X className="w-3.5 h-3.5 text-[#8B7355]" /></button>
            </div>
            {sendable.length === 0 ? (
              <a href="/crm-calls/settings" className="block px-3 py-2 text-xs text-[#af4408] hover:bg-[#FFF1E3]">
                No documents set up — add links in CRM settings →
              </a>
            ) : sendable.map((d, i) => (
              <button key={i}
                      onClick={() => { window.open(waLink(phone, docText(d, hi)), '_blank'); setOpen(false); }}
                      className="w-full text-left px-3 py-2 text-xs text-[#2D1B0E] hover:bg-[#FFF1E3] flex items-center gap-2">
                <Send className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> {d.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface FeedItem {
  key: string;
  /**
   * The FEED's own row kinds, which are not the bus's event types — 'ownership'
   * in particular must never land on the same row kind as an answer. A claim
   * used to be broadcast as 'answered' and printed "Call answered — Ravi K"
   * minutes AFTER "Call ended"; it now arrives as its own CtEvent type and gets
   * its own row. See handleEvent, where the mapping (and the refusal to guess at
   * an unknown type) lives.
   *
   * EVERY MEMBER HERE IS PRODUCED. 'answered' and 'call_ended' were previously
   * both pushed as 'call_ended' — same grey handset icon for "picked up" and for
   * "over" — while a 'missed' member was declared and never produced at all. A
   * union that lists a row kind nothing emits is a claim about this board that
   * is not true, so the phantom is gone and the answer now uses the member that
   * was already sitting here unused.
   *
   * 'missed_leg' IS NOT 'call_ended'. The venue rings a HUNT GROUP and TeleCMI
   * files every leg as its own CDR, so a missed leg normally means the call has
   * moved to the next extension — the bus says so explicitly with leg:
   * 'missed_leg' (see CtEvent.leg). This board used to print "Call ended" for
   * each of them, so a single call still ringing its way down the group printed
   * "Call ended" two or three times before anyone had picked up. It is now its
   * own row, and it is the row that names who let the call pass.
   */
  type: 'incoming_call' | 'answered' | 'call_ended' | 'missed_leg' | 'recovery_update' | 'ownership';
  phone?: string;
  guestName?: string;
  agentName?: string;
  /** App user holding the write-up of this answered call ('' = nobody). */
  ownerName?: string;
  /** Rung 1/2 of the ringing ladder on an 'incoming_call' row, already resolved
   *  server-side. `ringingForKind` says which, because a group must be worded as
   *  a group and never printed where it reads as a person's name. */
  ringingFor?: string;
  ringingForKind?: 'agent' | 'group';
  /** Who let a leg pass, on a 'missed_leg' row — CtEvent.missedByName. PAST
   *  TENSE and about a phone that has ALREADY STOPPED ringing; it is never the
   *  answer to "who is it ringing for" now. */
  missedBy?: string;
  at: string;
  label: string;
}

/**
 * ONE CALL THAT IS STILL IN PROGRESS — ringing OR answered.
 *
 * Shaped by the `active` rows of /api/crm-calls/live, and topped up between
 * polls by the bus events. Every label field is resolved SERVER-side, by the
 * same helpers the screen-pop's feed uses, so nothing here is re-derived in the
 * browser and no two surfaces can disagree about what to call the same person.
 */
interface LiveCall {
  id?: string;
  telecmi_call_id?: string;
  phone_e164?: string;
  phone?: string;
  guest_name?: string;
  started_at?: string;
  /** When somebody picked up — the clock a talk-time counter runs from. */
  answered_at?: string;
  /**
   * 'ringing' | 'answered'. ABSENT MEANS 'ringing': a card created from an SSE
   * incoming_call has not been in a snapshot yet. Always read it through
   * callStatus(), never `r.status === 'ringing'`.
   */
  status?: string;
  /** Raw TeleCMI agent id — an extension, a login, or (device callbacks) an app
   *  email. NEVER rendered: it is what the old card printed and what read blank. */
  agent_user?: string;
  /** agent_user resolved to a person (raw id when unmapped, '' when there is no
   *  agent at all). On an ANSWERED row this is WHO ANSWERED. */
  agent_display?: string;
  /** The ring group VERBATIM, whether or not an agent was named. Kept for the
   *  raw fact; NOT the "ringing for" rung — that is ringing_group_name. */
  queue?: string;
  /** Rung 1 — a PERSON the ring named. */
  ringing_agent_name?: string;
  /** Rung 2 — the GROUP, set by the server ONLY when rung 1 is empty. */
  ringing_group_name?: string;
  /**
   * Who let the PREVIOUS leg pass, learned from a missed-leg call_ended event.
   * CLIENT-SIDE ONLY — ct_calls has no column for it, so the 12s snapshot can
   * never resupply it and mergeLive() must carry it forward (it does).
   */
  missed_by_name?: string;
  /** Owner of the call, from /api/crm-calls/live — who holds the write-up. */
  owner_email?: string;
  owner_name?: string;
  /**
   * The SERVER's answer to "is this the viewer's call", computed from the
   * session. `false` means NOT ESTABLISHED AS YOURS — never "somebody else's" —
   * so only the true case is ever rendered.
   */
  is_mine?: boolean;
  /**
   * Has the SERVER ever listed this call? CLIENT-SIDE BOOKKEEPING, never
   * rendered and never sent anywhere — it exists only so mergeLive() can tell
   * "the server dropped this call" from "the server had not heard of it yet".
   * See the grace window there.
   */
  seen_by_server?: boolean;
}

/** Absent status means ringing — see LiveCall.status. Never inline this test. */
const callStatus = (r: LiveCall): 'ringing' | 'answered' =>
  (r.status === 'answered' ? 'answered' : 'ringing');

/** The identity a card is keyed by, in the order the board has always tried
 *  them. Only used to line an incoming snapshot up against what is on screen. */
const cardKey = (r: LiveCall): string =>
  String(r.telecmi_call_id || r.id || r.phone_e164 || r.phone || '');

/** "3:07" from seconds. */
const clock = (secs: number): string =>
  `${Math.floor(secs / 60)}:${String(Math.max(0, secs) % 60).padStart(2, '0')}`;

/**
 * WHAT THIS CARD SAYS ABOUT THE AGENT — the one place this file words the
 * ladder, so two cards can never answer the same question differently.
 *
 *   answered → "Answered by <agent_display>"   (raw id when unmapped)
 *   ringing  → "Ringing for <ringing_agent_name>"      rung 1, a PERSON
 *            → "Ringing the <ringing_group_name> team" rung 2, a GROUP
 *            → "Ringing · extension not reported"      rung 3, an honest blank
 *
 * `suffix` exists so the word "team" is never bolded as if it were part of
 * somebody's name, and `fallback` is printed INSTEAD of a name when there is
 * none — it is a statement about what the payload carried, never a guess at who
 * is next in the group. Nothing in any payload supports that guess, and a GRE
 * told their handset is ringing when it is not is worse than a GRE told nothing.
 *
 * missed_by_name is deliberately NOT a rung here. Who let the LAST leg pass is a
 * fact about a phone that has already stopped ringing; it gets its own past-tense
 * line on the card, under this one.
 */
interface Attribution {
  /** Small-caps line above the name. */
  lead: string;
  /** The person or the group. '' when nothing honest can be printed. */
  who: string;
  /** Word appended after `who`, unbolded (only ever "team"). */
  suffix: string;
  /** Printed instead of `who` when it is blank. */
  fallback: string;
  tone: 'ringing' | 'oncall' | 'unknown';
}

/**
 * "team" — unless the group already names itself one. "Sales Team team" is the
 * kind of sentence that makes a GRE distrust the whole card. Same three words
 * and the same test as groupPhrase() in the screen-pop, deliberately: one `team`
 * value must not be worded two ways on two surfaces.
 */
const groupSuffix = (g: string | undefined): string =>
  (/\b(team|group|queue)$/i.test(String(g || '').trim()) ? '' : 'team');

function attributionOf(r: LiveCall): Attribution {
  if (callStatus(r) === 'answered') {
    // WHO ANSWERED, AND NOTHING ELSE DRESSED UP AS IT. owner_name is NOT a
    // second rung here: it is who holds the WRITE-UP, a different fact that
    // becomes true a different way — first-claim, or a management takeover —
    // and neither is evidence that the person picked the phone up.
    //
    // It was reachable today, with no dormant precondition. When the live
    // `answer` payload names no agent (which is the normal case on this
    // account), agent_user stays '' so nothing stamps an owner; the call is
    // then unowned and claimable while it is still up, so the first GRE to open
    // Quick Booking becomes owner_name. The card would print "Answered by Ravi
    // K" about a call Ravi never touched — and the "Write-up: Ravi K" line that
    // would have disclosed where the name came from is suppressed as a
    // duplicate, because it matched. A management takeover made it flatly
    // false: the manager demonstrably did not answer.
    //
    // A blank now falls to the honest fallback below, and the owner keeps his
    // own line on the card, which is the whole of what was actually known.
    const who = String(r.agent_display || '').trim();
    return { lead: 'Answered by', who, suffix: '', fallback: 'Agent not reported', tone: who ? 'oncall' : 'unknown' };
  }
  // NEVER NAME A PHONE WE KNOW HAS STOPPED RINGING. If rung 1 names the very
  // agent a missed leg just told us let the call pass, the two facts contradict
  // each other and the newer one is right — so the card drops to the group.
  //
  // This is not hypothetical bookkeeping. The live ring on this account names
  // nobody today, but if it ever does, ct_calls.agent_user keeps that extension
  // for the whole cascade (a missed-leg CDR does not clear it), so the 12s
  // snapshot would faithfully re-supply "Ringing for Pushpa B" onto a card that
  // is already saying "Pushpa B did not pick up". Deciding it HERE, from the two
  // fields side by side, makes the card self-consistent no matter which feed
  // supplied which half or in what order they arrived.
  const missedBy = String(r.missed_by_name || '').trim();
  const person = String(r.ringing_agent_name || '').trim();
  if (person && person !== missedBy) return { lead: 'Ringing for', who: person, suffix: '', fallback: '', tone: 'ringing' };
  const group = String(r.ringing_group_name || '').trim();
  if (group) return { lead: 'Ringing the', who: group, suffix: groupSuffix(group), fallback: '', tone: 'ringing' };
  return { lead: 'Ringing', who: '', suffix: '', fallback: 'Extension not reported', tone: 'unknown' };
}

/**
 * MERGE THE AUTHORITATIVE SNAPSHOT ONTO WHAT IS ON SCREEN — membership from the
 * server, labels from whichever side actually has one.
 *
 * MEMBERSHIP IS A STRAIGHT REPLACE, exactly as before. The snapshot is the
 * database's own answer to "which calls have not ended", so a call it does not
 * list is over (or a ghost the sweeper is about to relabel) and its card must go.
 *
 * THE LABELS ARE MERGED, NOT REPLACED, and that is the whole point of this
 * function. Two ways a straight replace loses a name the board had already
 * earned — and a name that flickers away every 12 seconds is worse than none:
 *   - The board learns things the snapshot has no column for. "Pushpa did not
 *     pick up" comes off a missed-leg call_ended and lives nowhere in ct_calls,
 *     so the next re-sync would wipe it off the card the moment it appeared.
 *   - A BLANK IS NOT A CORRECTION. resolveAgentLabel() returns '' only when the
 *     row names nobody at all, so an empty ringing_agent_name means "the database
 *     does not know", never "it is not Pushpa after all".
 * Anything the server DOES send wins outright — it is the resolved truth, and it
 * is how an unmapped extension turns into a real name minutes later, with no
 * reload, the moment an admin maps it in CRM Settings.
 *
 * AND A CALL NEVER UN-ANSWERS. A snapshot request issued a beat before the
 * answer landed comes back saying 'ringing'; without this the card would flip
 * back to a red ringing card, timer restarted, in the middle of a conversation.
 *
 * ONE EXCEPTION TO "MEMBERSHIP IS THE SERVER'S": a card the server has NEVER
 * listed. Ingest inserts the ringing row and only then broadcasts, but a
 * snapshot request already in flight can have run its query just BEFORE that
 * insert and come back just after — so its silence about the call is age, not
 * judgement, and obeying it would blink the brand-new card off the board for a
 * whole sync cycle. Such a card is held for UNCONFIRMED_GRACE_MS and no longer;
 * past that, a call the server has never once listed is not a call.
 *
 * The grace applies ONLY while seen_by_server is unset, so it costs nothing in
 * the normal case: a ring the server has confirmed even once — including one the
 * caller hung up on a second later — disappears the instant the server drops it,
 * with no ghost. Unparseable started_at falls through to today's behaviour
 * (dropped) rather than lingering.
 */
const UNCONFIRMED_GRACE_MS = 20_000;

function mergeLive(prev: LiveCall[], incoming: LiveCall[]): LiveCall[] {
  const before = new Map(prev.map(r => [cardKey(r), r]));
  const merged = incoming.map(r => {
    const old = before.get(cardKey(r));
    // A BRAND-NEW CARD IS SUBJECT TO THE SAME agent_display RULE as the merge
    // below — a straight spread would carry a ringing row's value onto the card
    // and the `answered` handler would later inherit it as the answerer. Both
    // arms of this function have to enforce it or the invariant is not one.
    if (!old) {
      return {
        ...r,
        agent_display: callStatus(r) === 'answered' ? String(r.agent_display || '') : '',
        seen_by_server: true,
      };
    }
    const keep = <K extends keyof LiveCall>(k: K): LiveCall[K] =>
      (r[k] === undefined || r[k] === '' ? old[k] : r[k]);
    return {
      ...old,
      ...r,
      seen_by_server: true,
      status: old.status === 'answered' ? 'answered' : (r.status || old.status),
      guest_name: keep('guest_name'),
      answered_at: keep('answered_at'),
      agent_user: keep('agent_user'),
      // agent_display NAMES WHO ANSWERED — so it is taken off a row ONLY when
      // that row itself says somebody has. The server resolves the column for
      // every row it sends, and on a RINGING row that column holds the extension
      // being RUNG, which on a hunt group is a different person from the one who
      // ends up answering. Storing it would let the `answered` handler below
      // inherit it (`e.agentName || r.agent_display`) and the card would print
      // "Answered by" the phone that rang out.
      //
      // Dormant today — live rings on this account name nobody, so the column is
      // '' while ringing — and closed deliberately, because this is the ONLY
      // place a ringing-era name can enter the field: closing it here closes it
      // for the handler, for attributionOf() and for the feed at once. The
      // screen-pop guards the same field the same way, at its own merge.
      agent_display: (callStatus(r) === 'answered' ? String(r.agent_display || '') : '') || old.agent_display || '',
      queue: keep('queue'),
      ringing_agent_name: keep('ringing_agent_name'),
      ringing_group_name: keep('ringing_group_name'),
      owner_email: keep('owner_email'),
      owner_name: keep('owner_name'),
    };
  });
  const listed = new Set(incoming.map(cardKey));
  const now = Date.now();
  const unconfirmed = prev.filter(r => {
    if (listed.has(cardKey(r)) || r.seen_by_server) return false;
    const t = r.started_at ? new Date(r.started_at).getTime() : NaN;
    return !isNaN(t) && now - t < UNCONFIRMED_GRACE_MS;
  });
  // Newest first, same as the server's own order, and still bounded at 12.
  return [...unconfirmed, ...merged].slice(0, 12);
}

/**
 * The live-call list off one /api/crm-calls/live response.
 *
 * `active` is EVERY call still in progress, ringing and answered, each row
 * already carrying the resolved ringing/answered names. `ringing` is the older,
 * ringing-only list and a SUBSET of it, so it is read only when `active` is
 * missing. The two are never read together: the same call is in both, and it
 * would get two cards.
 *
 * `active` IS ABSENT UNLESS THE VIEWER IS AN ADMIN — the server decides that and
 * simply omits the key (see the route header). So this same function is the
 * whole of the board's role behaviour, and it needs no role test of its own:
 *   admin     → `active`  — every live call, ringing and on-call, labelled.
 *   everyone  → `ringing` — the ringing-only board this page has always shown.
 * A key that is absent is therefore NOT a stale server; that case falls here too
 * and lands on exactly the right list either way.
 *
 * This is why the gate is not an `isAdmin` check in this file: a hidden card is
 * not a permission, and a board that filtered client-side would still have been
 * handed every in-progress call's guest name and phone on the wire.
 *
 * null (neither key is an array) means "this response said nothing about live
 * calls" and the caller must leave the board alone. Returning [] instead would
 * wipe every card off a wallboard on a single malformed response.
 */
function snapshotOf(j: unknown): LiveCall[] | null {
  const o = j as { active?: unknown; ringing?: unknown } | null;
  if (Array.isArray(o?.active)) return o.active as LiveCall[];
  if (Array.isArray(o?.ringing)) return o.ringing as LiveCall[];
  return null;
}

/**
 * WHICH CARD DOES THIS EVENT BELONG TO — ids first, phone only as a last resort.
 *
 * Kept verbatim in behaviour from the filter it replaces (and the same shape as
 * matchIdx() in the screen-pop, for the same reason): BOTH id handles are tried
 * in BOTH directions, because ids on this account do not reliably correlate — the
 * ring, the live answer and the CDR can arrive keyed differently, and a cascade
 * that consulted only the first identifier the event happened to carry is
 * precisely what left answered calls sitting in "Ringing now".
 *
 * Phone gets a say only when NEITHER id matched anything, and it is a blunter
 * instrument: it would also hit a second, genuinely-live card for the same
 * number.
 *
 * NULL MEANS "THIS EVENT MATCHES NO CARD ON SCREEN" — no identifier at all, or
 * an identifier that hit nothing. Every caller returns the previous state
 * UNCHANGED on null, which keeps its array identity and so cannot spin the
 * effects that watch it. An event about a call this board never saw is not a
 * reason to rebuild the board.
 */
function eventMatcher(prev: LiveCall[], e: { telecmiCallId?: string; callId?: string; phone?: string }):
  ((r: LiveCall) => boolean) | null {
  const idHit = (r: LiveCall) =>
    (!!e.telecmiCallId && (r.telecmi_call_id === e.telecmiCallId || r.id === e.telecmiCallId)) ||
    (!!e.callId && (r.id === e.callId || r.telecmi_call_id === e.callId));
  if (prev.some(idHit)) return idHit;
  if (!e.phone) return null;
  const phoneHit = (r: LiveCall) => (r.phone_e164 || r.phone) === e.phone;
  return prev.some(phoneHit) ? phoneHit : null;
}

/** "11 Jul" — the day an answered call happened, for the sticky-agent line. */
const istDay = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
};

const istTime = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
};

export default function LiveCallsPage() {
  const [today, setToday] = useState<{ calls: number; answered: number; missed: number; answered_pct: number; pending_recoveries: number; bookings_from_calls: number } | null>(null);
  const [byHour, setByHour] = useState<Array<{ hour: number; total: number; missed: number }>>([]);
  // Every call still in progress — ringing AND answered. Was ringing-only, which
  // is why a call vanished off the board the instant somebody picked it up.
  const [live, setLive] = useState<LiveCall[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [liveMode, setLiveMode] = useState<'sse' | 'poll' | 'connecting'>('connecting');
  const [statsUpdatedAt, setStatsUpdatedAt] = useState<number | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [docs, setDocs] = useState<QuickDoc[]>([]);   // quick-send documents (menu, band list…)
  // Routing hints — null until the first /api/crm-calls/live poll reports the
  // flags; {sticky:false,vip:false} (the default) means the page never fetches
  // hints and renders nothing extra.
  const [hintFlags, setHintFlags] = useState<{ sticky: boolean; vip: boolean } | null>(null);
  const [hints, setHints] = useState<Record<string, RoutingHint>>({});
  const hintReqRef = useRef<Set<string>>(new Set());  // phones already requested (in-flight or done)
  const seqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 1-second tick drives ringing-duration counters
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Load the quick-send documents (menu / band list / corporate menu …) once.
  useEffect(() => {
    fetch('/api/crm-calls/settings')
      .then(r => r.json())
      .then(j => { try { const a = JSON.parse(j?.settings?.quick_send_links || '[]'); if (Array.isArray(a)) setDocs(a.map((x: QuickDoc) => ({ label: String(x?.label || ''), url: String(x?.url || ''), message: String(x?.message || '') }))); } catch { /* ignore */ } })
      .catch(() => {});
  }, []);

  // Fetch hints for any ringing number we haven't asked about yet. Skipped
  // entirely while both flags are off.
  //
  // RINGING CALLS ONLY, still. Both hints answer "who should TAKE this call",
  // which is a question about a phone that is still ringing; asking it of a
  // conversation already in progress would be a request per answered call for an
  // answer nobody can act on. The list this reads widened to include answered
  // calls, so the filter is now explicit rather than implied by the list.
  useEffect(() => {
    if (!hintFlags || (!hintFlags.sticky && !hintFlags.vip)) return;
    const want = live
      .filter(r => callStatus(r) === 'ringing')
      .map(r => r.phone_e164 || r.phone || '')
      .filter(p => p && !hintReqRef.current.has(p));
    if (want.length === 0) return;
    const batch = Array.from(new Set(want)).slice(0, 20);
    for (const p of batch) hintReqRef.current.add(p);
    fetch(`/api/crm-calls/live/routing?phones=${encodeURIComponent(batch.join(','))}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        const got = j?.hints;
        if (!got || typeof got !== 'object') return;
        setHints(prev => {
          const next = { ...prev, ...got };
          // Bound the cache on a wallboard that runs for days.
          const keys = Object.keys(next);
          if (keys.length > 60) {
            for (const k of keys.slice(0, keys.length - 60)) { delete next[k]; hintReqRef.current.delete(k); }
          }
          return next;
        });
      })
      .catch(() => { for (const p of batch) hintReqRef.current.delete(p); });   // allow a retry
  }, [live, hintFlags]);

  const pushFeed = useCallback((item: FeedItem) => {
    setFeed(prev => {
      if (prev.some(p => p.key === item.key)) return prev;
      return [item, ...prev].slice(0, 60);
    });
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const r = await fetch('/api/crm-calls/dashboard?days=1');
      if (!r.ok) { setStatsError(true); return; }
      const j = await r.json();
      if (j?.today) setToday(j.today);
      if (Array.isArray(j?.byHour)) setByHour(j.byHour);
      setStatsError(false);
      setStatsUpdatedAt(Date.now());
    } catch { setStatsError(true); }
  }, []);

  // The Live poll already tells us whether the call hints are switched on
  // (two ct_settings reads on a request the board makes anyway), so a board
  // with both flags off — the default — issues no extra request at all.
  // Identity-stable when nothing changed, so it can't cause re-render churn.
  const applyRoutingFlags = useCallback((routing: { sticky_agent?: boolean; vip_routing?: boolean } | null | undefined) => {
    if (!routing) return;
    const next = { sticky: routing.sticky_agent === true, vip: routing.vip_routing === true };
    setHintFlags(prev => (prev && prev.sticky === next.sticky && prev.vip === next.vip ? prev : next));
  }, []);

  const pollLive = useCallback(async () => {
    try {
      const r = await fetch(`/api/crm-calls/live?after=${seqRef.current}`);
      if (!r.ok) return;
      const j = await r.json();
      applyRoutingFlags(j?.routing);
      if (typeof j?.seq === 'number') seqRef.current = Math.max(seqRef.current, j.seq);
      const snap = snapshotOf(j);
      if (snap) setLive(prev => mergeLive(prev, snap));
      const events: any[] = Array.isArray(j?.events) ? j.events : [];
      for (const e of events) handleEvent(e);
    } catch { /* transient */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-seed ONLY the live-call list from the server's authoritative snapshot
  // without touching the seq cursor or replaying events. Runs on a slow interval
  // even while SSE is healthy so the board self-heals: ended calls drop off,
  // stale rings (reconciled to 'missed' after 5 min) drop off, an extension an
  // admin has just mapped turns into a name, and a transient wipe can never
  // leave the board permanently empty.
  //
  // IT MERGES, IT DOES NOT OVERWRITE. It used to be setRinging(j.ringing) — a
  // wholesale replace every 12 seconds. With names on the cards that is no
  // longer safe: the board holds facts the snapshot has no column for (who let
  // the last leg pass) and the snapshot's blanks are silence, not corrections.
  // See mergeLive().
  const syncRinging = useCallback(async () => {
    try {
      const r = await fetch(`/api/crm-calls/live?after=${seqRef.current}`);
      if (!r.ok) return;
      const j = await r.json();
      applyRoutingFlags(j?.routing);   // also self-heals if an admin flips a flag
      const snap = snapshotOf(j);
      if (snap) setLive(prev => mergeLive(prev, snap));
    } catch { /* transient */ }
  }, [applyRoutingFlags]);

  /**
   * ONE FEED LINE PER EVENT — and only for event types this board actually
   * understands.
   *
   * EVERY BRANCH BELOW IS EXPLICIT, AND AN UNKNOWN TYPE FALLS OFF THE END AND IS
   * IGNORED. That is deliberate: a new CtEvent type quietly inheriting whichever
   * branch it happened to land in is how a claim came to be printed as "Call
   * answered". A row this board cannot label is not news it should invent a
   * label for — it waits for someone to teach it the type.
   */
  const handleEvent = useCallback((e: any) => {
    if (!e || !e.type) return;
    const phone = e.phone || '';
    const name = e.guest?.name || '';
    const at = e.at || new Date().toISOString();
    const key = `${e.type}:${e.telecmiCallId || e.callId || phone}:${at}`;
    if (e.type === 'incoming_call') {
      // THE RINGING LADDER ARRIVES PRE-RESOLVED. ringingAgentName (a person) and
      // ringingGroupName (the team, set only when no person was named) come off
      // ringingForLabel() server-side; the board stores both and words them in
      // attributionOf(). `queue` is kept as the raw fact and is NOT the rung.
      //
      // The old line here read `agent_user: e.agent || ''` and dropped both
      // resolved names on the floor, which is why the card printed an unresolved
      // id — blank, on this account — and named nobody.
      const patch: LiveCall = {
        telecmi_call_id: e.telecmiCallId,
        id: e.callId,
        phone_e164: phone,
        guest_name: name,
        started_at: at,
        agent_user: e.agent || '',
        queue: e.queue || '',
        ringing_agent_name: e.ringingAgentName || '',
        ringing_group_name: e.ringingGroupName || '',
        // A FRESH RING IS NEWER NEWS than any earlier leg's miss, so the "did not
        // pick up" line clears. (It normally cannot fire: ingest suppresses the
        // platform→agent ring, so one call emits one incoming_call. It is here so
        // the rule is "newest fact wins" rather than "whichever arrived first".)
        missed_by_name: '',
      };
      setLive(prev => {
        const id = e.telecmiCallId || e.callId || phone;
        const idx = prev.findIndex(r => (r.telecmi_call_id || r.id || r.phone_e164) === id);
        if (idx === -1) return [{ ...patch, status: 'ringing' }, ...prev].slice(0, 12);
        // Same card, refreshed labels — never a duplicate, and never a downgrade
        // of a call that has already been answered (see mergeLive).
        const next = prev.slice();
        const old = next[idx];
        next[idx] = {
          ...old,
          ...patch,
          // A RE-ANNOUNCED RING MUST NOT SAY LESS THAN THE CARD ALREADY KNOWS.
          // The timer keeps counting from the FIRST ring — restarting it would
          // under-report how long the guest has been waiting, which is the one
          // number a supervisor is watching — and a guest name the snapshot has
          // already resolved is not replaced by an empty one.
          started_at: old.started_at || patch.started_at,
          guest_name: patch.guest_name || old.guest_name,
          status: callStatus(old),
        };
        return next;
      });
      pushFeed({
        key, type: 'incoming_call', phone, guestName: name, at,
        label: 'Incoming call ringing',
        ringingFor: String(e.ringingAgentName || e.ringingGroupName || ''),
        ringingForKind: e.ringingAgentName ? 'agent' : (e.ringingGroupName ? 'group' : undefined),
      });
    } else if (e.type === 'answered') {
      // THE CALL STAYS ON THE BOARD — it turns green, it does not disappear.
      //
      // 'answered' used to share the removal branch with 'call_ended', so the
      // moment a GRE picked up, the card came off and the board showed nothing
      // for the entire conversation. That is the one stretch a supervisor most
      // wants to see: who is on it, and for how long.
      //
      // HOW LONG IT STAYS IS THE SERVER'S ANSWER, NOT THIS BRANCH'S. On an
      // admin's board the snapshot keeps listing the call (`active`) and the
      // card runs for the whole conversation; on a GRE's the snapshot is
      // ringing-only, so mergeLive drops it at the next 12s re-sync. Deciding it
      // here instead would mean a second copy of "who may watch a live call"
      // living in a client, which is exactly what was wrong with the first
      // attempt at this feature.
      setLive(prev => {
        const hit = eventMatcher(prev, e);
        if (!hit) return prev;   // no way to identify a card → touch nothing
        // The event states ownership as a pair, '' meaning UNOWNED (a deliberate
        // statement, not silence — see CtEvent.ownerEmail), so the two move
        // together or a cleared owner would leave a stale name behind.
        const statesOwner = typeof e.ownerEmail === 'string';
        return prev.map(r => (hit(r) ? {
          ...r,
          status: 'answered',
          answered_at: r.answered_at || at,
          agent_user: e.agent || r.agent_user || '',
          // r.agent_display is safe to fall back to ONLY because mergeLive()
          // refuses to store one off a ringing row — see the note there. Without
          // that invariant this line is how the extension that was RUNG ends up
          // under "Answered by", since the answer event does not always name an
          // agent and the ringing row's column holds a different person.
          agent_display: e.agentName || r.agent_display || '',
          owner_email: statesOwner ? e.ownerEmail : r.owner_email,
          owner_name: statesOwner ? String(e.ownerName || '') : r.owner_name,
          // The hunt is over; nobody's phone is still ringing.
          missed_by_name: '',
        } : r));
      });
      pushFeed({
        key, type: 'answered', phone, guestName: name,
        agentName: e.agentName || '', ownerName: e.ownerName || '', at,
        label: 'Call answered',
      });
      refreshStats();
    } else if (e.type === 'call_ended' && e.leg === 'missed_leg') {
      // ONE LEG STOPPED RINGING — THE CALL HAS NOT ENDED.
      //
      // The venue rings a hunt group and TeleCMI files every leg as its own CDR.
      // This board used to treat all of them as the end: it printed "Call ended"
      // and pulled the card, then the 12s re-sync put the card back because the
      // server still said 'ringing'. So a call working its way down the group
      // flashed its card off and on and announced its own end two or three times
      // before anyone had picked up.
      //
      // The card STAYS. What changes is the name on it: the extension we were
      // naming has just rung out, so it is no longer the answer to "who is it
      // ringing for" — but it IS the answer to "who let it pass", which is
      // exactly what a supervisor judging efficiency wants, and it gets its own
      // past-tense line.
      const who = String(e.missedByName || '').trim();
      setLive(prev => {
        const hit = eventMatcher(prev, e);
        if (!hit) return prev;
        return prev.map(r => {
          if (!hit(r)) return r;
          // ONLY A RINGING CARD. Leg CDRs arrive late and out of order, so
          // Pushpa's missed leg can land after Bharath has already answered.
          // Patching an answered card would pin "Pushpa B did not pick up" and a
          // cleared rung 1 onto a live conversation — the same bug pointing the
          // other way. The screen-pop has guarded this since the leg fix landed;
          // this board did not, which is the whole reason the two could drift.
          if (callStatus(r) === 'answered') return r;
          // Drop the named extension ONLY when the CDR told us who missed —
          // replacing a name with a blank would be losing information, not
          // correcting it. Once it is cleared the card falls to whatever rung 2
          // already held, which is the honest next thing to say.
          //
          // RUNG 2 IS NOT TOUCHED HERE, and it is not filled from `e.queue`.
          // A group does not stop ringing because one member gave up, so the
          // value the RING established is still true and needs no help. `queue`
          // is the raw telephony field and the wire contract says in writing it
          // is not the rung (see bus.ts ringingGroupName): off a leg CDR it is
          // whatever QUEUE_KEYS matched — `department` is one of them — and
          // writing it here would let the board announce "Ringing the FrontDesk
          // team" purely on the record of a leg that has already STOPPED
          // ringing, on a call whose ring named no team at all. It would also
          // stick, because mergeLive() reads the server's '' as silence rather
          // than as a correction. The screen-pop leaves the same field alone on
          // the same event; this is what keeps the two surfaces saying one thing.
          // …AND ONLY WHEN IT NAMED THE AGENT THIS CARD IS SHOWING. `who ? '' :`
          // cleared rung 1 whenever the CDR named ANYBODY, which throws away a
          // correct current name: a hunt group rings one extension at a time, so
          // a late leg-1 CDR for Pushpa arriving while the card correctly reads
          // "Ringing for Nisha Sharma" says nothing about Nisha's phone. This is
          // the same comparison attributionOf() already makes at render — made
          // here too so the fact is kept rather than merely hidden, and so it
          // survives missed_by_name later being cleared by the answer.
          const showing = String(r.ringing_agent_name || '').trim();
          return {
            ...r,
            missed_by_name: who || r.missed_by_name || '',
            ringing_agent_name: who && showing === who ? '' : r.ringing_agent_name,
          };
        });
      });
      // The name is carried in `missedBy` rather than baked into the label, so
      // the feed can bold it exactly as it bolds every other agent. Without one,
      // the label has to say the whole thing itself.
      pushFeed({
        key, type: 'missed_leg', phone, guestName: name, missedBy: who, at,
        label: who ? 'Call still ringing' : 'No answer on that extension — call still ringing',
      });
      // NO refreshStats(): nothing was answered and nothing was missed. The call
      // is still open, today's counters are unchanged, and re-fetching them once
      // per leg of every hunt cascade is a request that can only return the same
      // numbers. The final call_ended refreshes them, as does the 60s timer.
    } else if (e.type === 'call_ended') {
      // THE CARD FOR THIS CALL COMES OFF THE BOARD. Two passes, ids then phone,
      // deliberately — the same shape matchIdx() uses in the screen-pop, and for
      // the same reason.
      //
      // It used to be a single cascade that consulted ONLY the first identifier
      // the event happened to carry: an event with a telecmi id that matched no
      // card stopped there, even when its callId matched one perfectly. Ids on
      // this account do not reliably correlate — the ring, the live answer and
      // the CDR can arrive keyed differently — so that was precisely the case
      // that left an answered call sitting in "Ringing now".
      //
      // Phone gets a say only when NEITHER id matched anything. It is a blunter
      // instrument: it would also drop a second, genuinely-live card for the
      // same number. That is bounded to at most one 12s syncRinging cycle (the
      // server snapshot puts back anything still in progress), where a stuck card
      // is bounded by nothing.
      //
      // REACHED ONLY BY A FINAL call_ended — leg 'final', or absent, which the
      // bus documents as meaning final. A 'missed_leg' is handled in the branch
      // above and deliberately does NOT come here.
      setLive(prev => {
        const hit = eventMatcher(prev, e);
        if (!hit) return prev;   // no identifier at all → never nuke the board
        return prev.filter(r => !hit(r));
      });
      // ownerName rides along on the same event — this is the moment a
      // supervisor can see who picked the call up and now owns writing it up.
      pushFeed({
        key,
        type: 'call_ended',
        phone, guestName: name,
        agentName: e.agentName || '', ownerName: e.ownerName || '', at,
        label: 'Call ended',
      });
      refreshStats();
    } else if (e.type === 'ownership') {
      // THE OWNER OR THE LOCK CHANGED ON A CALL THAT ALREADY EXISTS — a claim, a
      // management takeover, or the release the disposition PUT broadcasts.
      //
      // DELIBERATELY DOES NOT TOUCH THE RINGING LIST. This lands at CHIP time,
      // i.e. minutes after the hangup, so re-running the ringing filter for it
      // would be filtering a call that is long over. Nor does it move the
      // counters: nobody was answered or missed, the write-up simply moved.
      //
      // The name goes in the label rather than into ownerName, because the
      // generic "· taken by X" suffix below reads as a claim and would be a lie
      // on the release line.
      const who = String(e.ownerName || '').trim();
      const label = e.locked === false
        ? (who ? `Write-up saved by ${who} — call open to everyone` : 'Write-up saved — call open to everyone')
        : (who ? `Write-up taken by ${who}` : 'Write-up ownership changed');
      pushFeed({ key, type: 'ownership', phone, guestName: name, at, label });
    } else if (e.type === 'recovery_update') {
      pushFeed({ key, type: 'recovery_update', phone, at, label: 'Recovery queue updated' });
      refreshStats();
    }
    // Anything else: a type this board does not know. Ignored on purpose — see
    // the note above. Never add an `else` that labels it.
  }, [pushFeed, refreshStats]);

  // SSE with poll fallback
  useEffect(() => {
    let closed = false;
    const startPolling = () => {
      if (pollTimer.current) return;
      setLiveMode('poll');
      pollTimer.current = setInterval(pollLive, 5000);
    };
    const connect = () => {
      if (closed) return;
      try {
        const es = new EventSource('/api/crm-calls/events');
        esRef.current = es;
        es.onopen = () => {
          setLiveMode('sse');
          if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
        };
        es.onmessage = (m) => { try { handleEvent(JSON.parse(m.data)); } catch { /* heartbeat */ } };
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
    pollLive();          // initial snapshot (ringing list + seq)
    refreshStats();      // initial counters
    const statTimer = setInterval(refreshStats, 60000); // safety refresh
    const ringTimer = setInterval(syncRinging, 12000);  // authoritative ringing re-sync
    return () => {
      closed = true;
      esRef.current?.close();
      if (pollTimer.current) clearInterval(pollTimer.current);
      clearInterval(statTimer);
      clearInterval(ringTimer);
    };
  }, [handleEvent, pollLive, refreshStats, syncRinging]);

  /**
   * How long this card has been doing what it is doing — RING time while it is
   * ringing, TALK time once it has been answered. Two different facts wearing
   * one counter would be the worst of both: "0:42" beside a green ON CALL card
   * has to mean 42 seconds of conversation, not 42 seconds since the phone
   * started ringing (which includes however long it took anyone to pick up).
   * Falls back to started_at when answered_at is missing, and to 0 rather than
   * NaN when neither parses.
   */
  const elapsed = (r: LiveCall) => {
    const from = callStatus(r) === 'answered' ? (r.answered_at || r.started_at) : r.started_at;
    const t = from ? new Date(from).getTime() : NaN;
    if (isNaN(t)) return 0;
    return Math.max(0, Math.floor((nowTick - t) / 1000));
  };

  // Ringing first — an unanswered phone is the only thing on this board anyone
  // can still act on. Within each group the server's newest-first order stands.
  const cards = [...live].sort(
    (a, b) => (callStatus(a) === 'ringing' ? 0 : 1) - (callStatus(b) === 'ringing' ? 0 : 1),
  );
  const ringingCount = live.reduce((n, r) => n + (callStatus(r) === 'ringing' ? 1 : 0), 0);
  const onCallCount = live.length - ringingCount;

  const maxHour = Math.max(1, ...byHour.map(h => h.total));
  const statsStale = statsUpdatedAt != null && nowTick - statsUpdatedAt > 120000;
  const statsBroken = statsError && statsUpdatedAt == null; // never succeeded

  return (
    <div className="p-4 sm:p-6 space-y-5 min-h-screen bg-[#FFF8F0]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">CRM · Call to Table</p>
          <h1 className="text-2xl sm:text-3xl font-bold text-[#2D1B0E] flex items-center gap-3">
            Live Calls
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${liveMode === 'sse' ? 'bg-green-100 text-green-700' : liveMode === 'poll' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
              <span className={`w-2 h-2 rounded-full ${liveMode === 'sse' ? 'bg-green-500 animate-pulse' : liveMode === 'poll' ? 'bg-amber-500 animate-pulse' : 'bg-gray-400'}`} />
              {liveMode === 'sse' ? 'LIVE' : liveMode === 'poll' ? 'LIVE (poll)' : 'connecting…'}
            </span>
          </h1>
        </div>
        <div className="text-right">
          <p className="text-sm text-[#6B5744]">
            {new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          {statsError ? (
            <span role="status" aria-live="polite" className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
              stats unavailable
            </span>
          ) : statsStale ? (
            <span role="status" aria-live="polite" className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
              stats may be stale · {istTime(new Date(statsUpdatedAt!).toISOString())}
            </span>
          ) : statsUpdatedAt != null ? (
            <p className="mt-0.5 text-[11px] text-[#6B5744] tabular-nums">stats updated {istTime(new Date(statsUpdatedAt).toISOString())}</p>
          ) : null}
        </div>
      </div>

      {/* Today counters — big, glanceable */}
      <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: 'Calls today', value: today?.calls ?? '—', cls: 'text-[#2D1B0E]', icon: <PhoneCall className="w-4 h-4" /> },
          { label: 'Answered', value: today?.answered ?? '—', cls: 'text-green-600', icon: <PhoneIncoming className="w-4 h-4" /> },
          { label: 'Missed', value: today?.missed ?? '—', cls: 'text-red-500', icon: <PhoneMissed className="w-4 h-4" /> },
          { label: 'Answer rate', value: today ? `${Math.round(today.answered_pct)}%` : '—', cls: 'text-blue-600', icon: <Radio className="w-4 h-4" /> },
          { label: 'Pending recoveries', value: today?.pending_recoveries ?? '—', cls: (today?.pending_recoveries || 0) > 0 ? 'text-amber-600' : 'text-green-600', icon: <Users className="w-4 h-4" /> },
          { label: 'Bookings from calls', value: today?.bookings_from_calls ?? '—', cls: 'text-[#af4408]', icon: <CalendarCheck className="w-4 h-4" /> },
        ].map((s) => (
          <div key={s.label} className="px-3 py-4 text-center border-r border-b lg:border-b-0 border-[#F0E4D6]">
            <p className="text-[10px] sm:text-[11px] text-[#6B5744] uppercase tracking-wide flex items-center justify-center gap-1">{s.icon}{s.label}</p>
            <p className={`text-3xl sm:text-4xl font-bold mt-1 tabular-nums ${s.cls}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* LIVE NOW — ringing and on-call, each labelled with the agent */}
      <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4">
        <h2 className="text-sm font-semibold text-[#2D1B0E] mb-3 flex items-center gap-2">
          <PhoneIncoming className="w-4 h-4 text-[#af4408]" /> Live now
          {ringingCount > 0 && <span className="text-xs bg-red-100 text-red-700 rounded-full px-2 py-0.5 font-bold animate-pulse">{ringingCount} ringing</span>}
          {onCallCount > 0 && <span className="text-xs bg-emerald-100 text-emerald-700 rounded-full px-2 py-0.5 font-bold">{onCallCount} on call</span>}
        </h2>
        {cards.length === 0 ? (
          <p className="text-sm text-[#6B5744] py-4 text-center">Nothing live right now — a card appears the moment TeleCMI signals a ring, and stays up while the call is being handled.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {cards.map((r, i) => {
              const phone = r.phone_e164 || r.phone || '';
              const onCall = callStatus(r) === 'answered';
              const secs = elapsed(r);
              const att = attributionOf(r);
              // WHO HOLDS THE WRITE-UP, but only when that is a DIFFERENT fact
              // from who answered. A mapped agent owns the call they answered, so
              // an unconditional line reads "Answered by Pushpa B / Write-up:
              // Pushpa B" — two lines about one person. Same dedupe the feed
              // below has always applied.
              const owner = String(r.owner_name || r.owner_email || '').trim();
              const showOwner = !!owner && owner !== att.who;
              // Undefined unless the feature is on AND the hint has arrived.
              // Hints are only requested for ringing calls (see the fetch above),
              // so an on-call card never has one.
              const hint = onCall ? undefined : hints[phone];
              return (
                <div key={r.telecmi_call_id || r.id || `${phone}-${i}`}
                     className={`relative rounded-xl border-2 p-4 ${onCall ? 'border-emerald-300 bg-emerald-50/60' : 'border-red-300 bg-red-50/60'}`}>
                  <div className="flex items-start justify-between">
                    {/* flex-1 so the agent strip below fills the card rather than
                        shrink-wrapping to a name — it is the line meant to be
                        read from across the counter. */}
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-[#2D1B0E] flex items-center gap-1.5 min-w-0">
                        <span className="truncate">{r.guest_name || 'Unknown caller'}</span>
                        {/* ONLY THE TRUE CASE IS EVER RENDERED. is_mine is the
                            server's answer from the session; false means "not
                            established as yours", NOT "somebody else's" — an
                            unowned call naming no agent is false for everyone,
                            and badging those "not yours" would be a lie. */}
                        {r.is_mine === true && (
                          <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-[#af4408] text-white">You</span>
                        )}
                      </p>
                      <p className="text-sm text-[#6B5744] font-mono truncate">{formatPhone(phone) || phone || '—'}</p>

                      {/* ── THE AGENT, AS THE HEADLINE ───────────────────────
                          This is what a supervisor reads the board for, so it is
                          a strip with its own box and a name at 16px — not the
                          11px muted `queue · agent_user` footnote it replaces,
                          which printed the RAW TeleCMI id and rendered blank on
                          every ringing row on this account. Wording comes from
                          attributionOf(), the one place this file words the
                          ladder. `suffix` ("team") is deliberately outside the
                          bold, so a GROUP can never be read as a person's name. */}
                      <div className={`mt-2 rounded-lg border px-2.5 py-1.5 ${att.tone === 'oncall' ? 'border-emerald-200 bg-white' : att.tone === 'ringing' ? 'border-red-200 bg-white' : 'border-[#E8D5C4] bg-[#FFF8F0]'}`}>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-[#8B7355] flex items-center gap-1">
                          {onCall ? <PhoneCall className="w-3 h-3 text-emerald-600 shrink-0" /> : <PhoneIncoming className="w-3 h-3 text-red-500 shrink-0" />}
                          {att.lead}
                        </p>
                        {att.who ? (
                          <p className="text-base font-bold text-[#2D1B0E] leading-tight truncate">
                            {att.who}{att.suffix && <span className="font-semibold text-[#6B5744]"> {att.suffix}</span>}
                          </p>
                        ) : (
                          /* NEVER A GUESS. The payload named nobody, so the card
                             says so; it does not offer "probably whoever is next
                             in the group", which nothing supports. */
                          <p className="text-sm font-semibold text-[#8B7355] leading-tight">{att.fallback}</p>
                        )}
                      </div>

                      {/* WHO LET THE LAST LEG PASS — past tense, and a fact about
                          a phone that has ALREADY STOPPED ringing. It is under
                          the strip and never inside it, because it is not an
                          answer to "who is it ringing for" now. */}
                      {!onCall && r.missed_by_name && (
                        <p className="mt-1.5 text-[11px] text-[#8B7355] flex items-center gap-1">
                          <PhoneMissed className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          <span className="truncate"><b className="text-[#6B5744]">{r.missed_by_name}</b> did not pick up</span>
                        </p>
                      )}

                      {/* WHO HAS THE WRITE-UP. Reads owner_name straight off the
                          snapshot row — no extra request, and nothing rendered
                          when the row names nobody or when it just repeats the
                          answerer. It used to be permanently blank because this
                          list was ringing-only and a ringing call cannot be
                          owned; now that the list carries answered calls too, it
                          is the surface that shows ownership live. */}
                      {showOwner && (
                        <p className="mt-1 text-[11px] text-[#6B5744] flex items-center gap-1">
                          <UserCheck className="w-3.5 h-3.5 text-[#af4408] shrink-0" />
                          <span className="truncate">Write-up: <b className="text-[#2D1B0E]">{owner}</b></span>
                        </p>
                      )}
                      {/* VIP badge — always carries its own evidence, so it is
                          auditable rather than a mysterious star. */}
                      {hint?.vip?.isVip && (
                        <p className="mt-1.5">
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 align-middle">
                            <Crown className="w-3 h-3" /> VIP
                          </span>
                          <span className="ml-1.5 text-[11px] text-amber-800 align-middle">
                            {hint.vip.reasons.join(' · ')}
                          </span>
                        </p>
                      )}
                      {/* Sticky agent — continuity hint, NOT a re-route. */}
                      {hint?.sticky && (
                        <p className="mt-1 text-[11px] text-[#6B5744] flex items-start gap-1"
                           title={`${hint.sticky.answered_calls} of this guest's ${hint.sticky.total_answered_calls} answered calls in the last ${hint.sticky.window_days} days were handled by ${hint.sticky.agent_label}. Hint only — the call is not re-routed.`}>
                          <UserCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-px" />
                          <span className="min-w-0">
                            {hint.sticky.total_answered_calls > 1 ? 'Regular' : 'Called before'} — last handled by{' '}
                            <b className="text-[#2D1B0E]">{hint.sticky.agent_label}</b>
                            {hint.sticky.last_answered_at && <> · {istDay(hint.sticky.last_answered_at)}</>}
                            {hint.sticky.answered_calls > 1 && <> · {hint.sticky.answered_calls} of {hint.sticky.total_answered_calls} calls</>}
                          </span>
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0 ml-3 flex flex-col items-end gap-1.5">
                      {onCall
                        ? <PhoneCall className="w-6 h-6 text-emerald-600" />
                        : <PhoneIncoming className="w-6 h-6 text-red-500 animate-pulse" />}
                      {/* Ring seconds while ringing, talk time once answered —
                          two different facts, so they are never shown in the same
                          format. See elapsed(). */}
                      <p className={`text-xs font-semibold tabular-nums ${onCall ? 'text-emerald-700' : 'text-red-600'}`}>
                        {onCall ? clock(secs) : `${secs}s`}
                      </p>
                      <SendMenu phone={phone} guestName={r.guest_name} docs={docs} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Live feed */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4">
          <h2 className="text-sm font-semibold text-[#2D1B0E] mb-3 flex items-center gap-2">
            <Radio className="w-4 h-4 text-[#af4408]" /> Live feed
          </h2>
          {feed.length === 0 ? (
            <p className="text-sm text-[#8B7355] py-4 text-center">
              Waiting for call activity — new calls will appear here live.
              {process.env.NODE_ENV !== 'production' && (
                <> (test with <code className="font-mono bg-[#FFF1E3] px-1 rounded">npm run simulate:call</code>)</>
              )}
            </p>
          ) : (
            <ul className="divide-y divide-[#F0E4D6] max-h-[420px] overflow-y-auto">
              {feed.map(f => (
                <li key={f.key} className="py-2 flex items-start gap-3 text-sm">
                  {/* One icon per row kind. 'answered' is green and its own
                      glyph — it used to share the grey handset with 'call_ended',
                      so at a glance "picked up" and "over" were the same row.
                      'missed_leg' is a rung-out extension on a call that is still
                      going, so it gets the missed handset and NOT the grey
                      "ended" one. The final arm is 'recovery_update', the only
                      kind left. */}
                  {f.type === 'incoming_call'
                    ? <ArrowDownLeft className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
                    : f.type === 'answered'
                      ? <PhoneIncoming className="w-4 h-4 text-green-700 shrink-0 mt-0.5" />
                      : f.type === 'missed_leg'
                        ? <PhoneMissed className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                        : f.type === 'call_ended'
                          ? <PhoneCall className="w-4 h-4 text-[#8B7355] shrink-0 mt-0.5" />
                          : f.type === 'ownership'
                            ? <UserCheck className="w-4 h-4 text-[#af4408] shrink-0 mt-0.5" />
                            : <ArrowUpRight className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />}
                  {/* WRAPS RATHER THAN TRUNCATES. The agent is the point of these
                      rows for a supervisor, and it sits at the END of the line —
                      `truncate` cut off precisely the part that had to be read. */}
                  <span className="flex-1 min-w-0 text-[#3D2614]">
                    <b>{f.guestName || formatPhone(f.phone || '') || 'System'}</b> — {f.label}
                    {/* WHO IT IS RINGING FOR, on the ring row. Same ladder as the
                        cards, worded from the SERVER's kind: a group is printed as
                        a group ("the Front Desk team") and never as a person. */}
                    {f.ringingFor && (
                      <span className="text-[#6B5744]">
                        {f.ringingForKind === 'group' ? ' · ringing the ' : ' · ringing for '}
                        <b className="text-[#2D1B0E]">{f.ringingFor}</b>
                        {/* Same suppression as the cards — a group already
                            called "Sales Team" is not a "Sales Team team". */}
                        {f.ringingForKind === 'group' && groupSuffix(f.ringingFor) ? ' team' : ''}
                      </span>
                    )}
                    {/* WHO LET IT PASS, on a missed-leg row. PAST TENSE and
                        never "ringing for": that extension has already stopped
                        ringing, and the call has moved on. */}
                    {f.missedBy && <span className="text-[#6B5744]"> · <b className="text-[#2D1B0E]">{f.missedBy}</b> did not pick up</span>}
                    {f.agentName && <span className="text-[#6B5744]"> · answered by <b className="text-[#2D1B0E]">{f.agentName}</b></span>}
                    {/* Suppressed when it just repeats the agent: a MAPPED
                        TeleCMI agent resolves to the same person, and "answered
                        by Pushpa · taken by Pushpa" reads like two people. */}
                    {f.ownerName && f.ownerName !== f.agentName && (
                      <span className="text-[#6B5744]"> · taken by <b className="text-[#2D1B0E]">{f.ownerName}</b></span>
                    )}
                  </span>
                  {f.phone && <SendMenu phone={f.phone} guestName={f.guestName} docs={docs} />}
                  <span className="text-[11px] text-[#8B7355] tabular-nums shrink-0">{istTime(f.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Today by hour */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4">
          <h2 className="text-sm font-semibold text-[#2D1B0E] mb-3">Today by hour <span className="text-[11px] font-normal text-[#8B7355]">(red = missed)</span></h2>
          {byHour.every(h => h.total === 0) ? (
            <p className="text-sm text-[#8B7355] py-4 text-center">
              {statsBroken ? "Couldn't load call stats — retrying automatically…" : 'No calls yet today.'}
            </p>
          ) : (
            <div className="flex items-end gap-1 h-40">
              {byHour.map(h => (
                <div key={h.hour} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={`${h.hour}:00 — ${h.total} calls, ${h.missed} missed`}>
                  <div className="w-full flex flex-col justify-end" style={{ height: '128px' }}>
                    <div className="w-full bg-red-400 rounded-t-sm" style={{ height: `${(h.missed / maxHour) * 128}px` }} />
                    <div className="w-full bg-[#E8955C]" style={{ height: `${(Math.max(0, h.total - h.missed) / maxHour) * 128}px` }} />
                  </div>
                  <span className="text-[9px] text-[#8B7355]">{h.hour}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
