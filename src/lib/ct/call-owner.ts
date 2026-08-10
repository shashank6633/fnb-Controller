/**
 * Call-to-Table — WHO OWNS AN ANSWERED CALL.
 *
 * THE PROBLEM THIS SOLVES
 * ───────────────────────
 * The screen-pop broadcasts to every signed-in CRM browser, so when a call was
 * answered two GREs would both sit on the pop and both write it up. The second
 * disposition silently overwrote the first. So: an ANSWERED call gets exactly
 * one owner; everyone else drops to a read-only strip naming who has it.
 *
 * HIDING THE POPUP IS NOT A LOCK. The pop is presentation — a browser that
 * hides it can still PUT the disposition. The lock is callWriteBlock() on the
 * server, and it is the only thing standing between two GREs and one call.
 *
 * WHY A NEW COLUMN AND NOT agent_user
 * ───────────────────────────────────
 * ct_calls.agent_user is the TELEPHONY agent id (e.g. 5004_33338614). Mapped
 * ids resolve to a user email via ct_settings agent_map (see ./agents.ts), but
 * an UNMAPPED id resolves to nobody — and that is the common case. Hence
 * FIRST CLAIM WINS: whichever browser acts first owns the call, recorded in
 * ct_calls.owner_email (an app user's email, '' = unowned).
 *
 * THE LOCK RULE — evaluated at WRITE TIME, never by a timer
 * ─────────────────────────────────────────────────────────
 *   unowned                       → anyone may write
 *   caller IS the owner           → may write
 *   caller is Admin/Manager/HOD   → may write (override; a bad claim is never stuck)
 *   disposition already set       → the lock is spent, anyone may write
 *   call has NOT ended            → LOCKED to the owner, no time limit
 *                                   (a 40-minute call must not unlock halfway)
 *   call ended < 15 min ago       → LOCKED to the owner (the write-up window)
 *   otherwise                     → expired, anyone may write
 *
 * A setTimeout in a browser that got closed never fires, so there is NO timer
 * and NO sweeper anywhere: expiry is recomputed from the row on every request.
 *
 * MISSED calls are never ownable. Nobody answered them, chasing them is the
 * whole job of the recovery queue, and locking one would hide it from the
 * people meant to chase it. claimCall() refuses a call that was never answered.
 *
 * SAVING A DISPOSITION DOES NOT ERASE THE OWNER. The rule above spends the lock
 * the moment a disposition exists, so the call opens to everyone with no write
 * at all; owner_email stays behind as the record of who handled it. That is why
 * the UI must read `locked`, never "owner_email is set" — see CallOwnerState.
 *
 * SERVER ONLY. This imports @/lib/auth (which pulls next/headers), so a client
 * component must never import this file — consume the flags the API computed.
 */
import type Database from 'better-sqlite3';
import { isManagement } from '@/lib/auth';
import { fmtISTTime } from '@/lib/format-date';

/** The post-call write-up window, measured from when the call ENDED. */
export const WRITEUP_MINUTES = 15;

/** The hard cap on ANY lock, measured from the claim — the backstop for a call
 *  whose hangup never arrives, which would otherwise stay "live" and locked
 *  forever. See capExpiredSql() for the full reasoning. Deliberately far longer
 *  than any real enquiry call so a genuine long conversation is never cut off. */
export const OWNER_CAP_MINUTES = 60;

/**
 * The ct_calls columns the lock rule reads. Callers that already loaded the row
 * pass it straight in — callWriteBlock() must not re-query what you have.
 * Use callOwnerColumns() to build the SELECT so a column can never be forgotten.
 */
export interface OwnableCall {
  id?: string | null;
  status?: string | null;
  ended_at?: string | null;
  disposition?: string | null;
  owner_email?: string | null;
  owner_claimed_at?: string | null;
}

/** Whoever is asking. SessionUser satisfies this as-is. */
export interface OwnerActor {
  email?: string | null;
  role?: string;
  is_head_chef?: boolean;
}

export interface CallOwnerState {
  /** Current owner's email, '' when unowned. Present even after the lock lapses. */
  ownerEmail: string;
  /** Display name for ownerEmail (falls back to the email), '' when unowned. */
  ownerName: string;
  /** Is the asking user the owner? */
  isMine: boolean;
  /**
   * Is a lock actually IN FORCE right now (for someone other than management)?
   * THIS is what the strip renders on — an owner with a spent/expired lock is
   * history, not a lock, and showing "X is on this call" for it is a lie.
   */
  locked: boolean;
  /** May the asking user write to this call? The server enforces exactly this. */
  canWrite: boolean;
  /** null when canWrite; otherwise the one refusal sentence every caller shows. */
  block: string | null;
  /** UTC 'YYYY-MM-DD HH:MM:SS' when the lock lapses; '' while the call is live or unlocked. */
  freeAt: string;
  /** freeAt rendered in IST (e.g. "7:42 pm"), '' when freeAt is ''. */
  freeAtLabel: string;
  /** Is the call still in progress? (No time limit applies while it is.) */
  live: boolean;
}

export type ClaimResult =
  | { ok: true; owner: string; ownerName: string; claimedAt: string }
  | {
      ok: false;
      /** Who holds it now ('' when the failure was not a lost race). */
      owner: string;
      ownerName: string;
      reason: 'taken' | 'not_found' | 'not_answered' | 'no_user' | 'not_management';
      /** Ready-to-show sentence for the loser. */
      message: string;
    };

// ────────────────────────────────────────────────────────────────────────────
// THE RULE, IN SQL, ONCE.
//
// Two places must agree perfectly: the atomic claim (which tests the LIVE
// COLUMNS inside one UPDATE) and the write check (which tests a row already in
// hand). Writing the rule twice is how the UI ends up offering an action the
// server refuses, so both bindings are generated from the SAME strings below —
// `p` is '' to read columns, ':' to read bound parameters of the same names.
//
// Timestamps in this table are a mix of ISO ('...T10:00:00.000Z', written by
// the app) and SQLite's datetime('now') ('... 10:00:00'). julianday() parses
// BOTH identically, which plain string comparison does NOT — 'T' sorts above
// ' ', so a lexical compare would call every datetime('now') row ancient.
// julianday() also returns NULL for blank/garbage, and NULL < x is NULL, i.e.
// falsy — an unparseable timestamp therefore keeps the call LOCKED rather than
// throwing it open. Fail closed is the right direction for a lock.
// ────────────────────────────────────────────────────────────────────────────

/** Is the call still in progress? ended_at is the real signal — an answered call
 *  that hangs up KEEPS status='answered' and merely gains ended_at. The status
 *  test is the second guard, for a terminal row whose ended_at never arrived. */
function liveSql(p: '' | ':'): string {
  return `(IFNULL(${p}ended_at, '') = '' AND IFNULL(${p}status, '') IN ('ringing', 'answered'))`;
}

/** What the 15 minutes are measured from: ended_at, falling back to the claim
 *  time when ended_at is blank (only reachable for a non-live row missing its
 *  ended_at — a live row never expires at all). NULL when neither is usable. */
function lockAnchorSql(p: '' | ':'): string {
  return `COALESCE(NULLIF(IFNULL(${p}ended_at, ''), ''), NULLIF(IFNULL(${p}owner_claimed_at, ''), ''))`;
}

/** Boolean: may :email write this call, IGNORING the management override?
 *  (Management is applied in JS via isManagement so there is one definition of
 *  the tier, the one in @/lib/auth.) */
function lockFreeSql(p: '' | ':'): string {
  return `(
       IFNULL(${p}owner_email, '') = ''
    OR lower(IFNULL(${p}owner_email, '')) = lower(:email)
    OR IFNULL(${p}disposition, '') <> ''
    OR (
         NOT ${liveSql(p)}
         AND julianday(${lockAnchorSql(p)}) < julianday(:now) - (${WRITEUP_MINUTES} / 1440.0)
       )
    OR ${capExpiredSql(p)}
  )`;
}

/** THE HARD CAP — the backstop for a call that never learns it ended.
 *
 *  Everything above releases off ended_at. A live call is deliberately exempt
 *  from the write-up window so a long enquiry cannot unlock while the GRE is
 *  still talking. The hole that leaves: if the hangup never reaches us — a lost
 *  live webhook, or the CDR that reconcileLiveEvents does not cover because it
 *  only sweeps status='ringing' — the row keeps status='answered' with a blank
 *  ended_at, `live` stays true forever, and the call is locked to one person
 *  for good. Nothing on any screen releases it.
 *
 *  That is not hypothetical here: CDRs are currently arriving at ZERO in this
 *  deployment, so betting a lock on a webhook always turning up is a bad bet.
 *
 *  So: no lock outlives OWNER_CAP_MINUTES from the moment it was claimed,
 *  whatever the row's status says. Measured from owner_claimed_at — NOT the
 *  anchor above, which prefers ended_at and is therefore useless in precisely
 *  the case this exists for. 60 minutes is chosen to sit well beyond any real
 *  enquiry call, so a genuine long conversation is never interrupted, while a
 *  lost hangup heals inside the same shift instead of needing a manager.
 *
 *  Like every other branch this is evaluated per request, never by a timer: a
 *  setTimeout in a browser that got closed is exactly how the call got stuck. */
function capExpiredSql(p: '' | ':'): string {
  return `(
       IFNULL(${p}owner_claimed_at, '') <> ''
   AND julianday(IFNULL(${p}owner_claimed_at, '')) < julianday(:now) - (${OWNER_CAP_MINUTES} / 1440.0)
  )`;
}

/** Only an ANSWERED call can be owned. answered_at is the primary signal;
 *  status='answered' covers a row whose answered_at never landed.
 *
 *  THE STATUS EXCLUSION IS NOT REDUNDANT — WITHOUT IT A MISSED CALL IS CLAIMABLE.
 *  answered_at alone is not proof anybody spoke. The CDR upsert in ingest.ts
 *  keeps an earlier live-notify answered_at (COALESCE) while flipping status to
 *  'missed', so a ring that was picked up by the system and then abandoned lands
 *  as answered_at <> '' AND status = 'missed'. That row is in the RECOVERY QUEUE
 *  and must stay everyone's to chase — the owner's rule is that missed calls are
 *  never owned. Keyed on answered_at alone, the first GRE to touch a chip on it
 *  claimed it and locked the recovery away from the people meant to work it.
 *  Found by review against exactly that row, not in theory. */
function answeredSql(p: '' | ':'): string {
  return `(
       (IFNULL(${p}answered_at, '') <> '' OR IFNULL(${p}status, '') = 'answered')
   AND IFNULL(${p}status, '') NOT IN ('missed', 'abandoned', 'voicemail')
  )`;
}

/** THE atomic claim. One statement: the precondition lives in the WHERE, so the
 *  database decides the winner. There is deliberately no SELECT before it. */
const CLAIM_SQL = `
  UPDATE ct_calls
     SET owner_email = :email, owner_claimed_at = :now
   WHERE id = :id
     AND ${answeredSql('')}
     AND ${lockFreeSql('')}
`;

/** Management takeover. The precondition is the ACTOR (checked in JS), not the
 *  row state, so this one is unconditional apart from "must be an answered call". */
const OVERRIDE_SQL = `
  UPDATE ct_calls
     SET owner_email = :email, owner_claimed_at = :now
   WHERE id = :id
     AND ${answeredSql('')}
`;

/** Why the claim failed, read back from the row itself so the same SQL that
 *  gated the UPDATE explains the refusal — no second opinion in JS. */
const CLAIM_DIAG_SQL = `
  SELECT IFNULL(owner_email, '') AS owner_email,
         CASE WHEN ${answeredSql('')} THEN 1 ELSE 0 END AS answered
    FROM ct_calls
   WHERE id = :id
`;

/** Evaluates the rule against a row already in hand (parameter binding). */
const CHECK_SQL = `
  SELECT CASE WHEN ${lockFreeSql(':')} THEN 1 ELSE 0 END AS free,
         CASE WHEN ${liveSql(':')} THEN 1 ELSE 0 END AS live,
         -- THE EARLIER OF THE TWO DEADLINES, because two now exist. The write-up
         -- window (anchor + 15 min) does not apply while the call is live, but
         -- the hard cap (claim + 60 min) always does — so a live call is no
         -- longer deadline-less and must stop reporting that it is.
         --
         -- THE COALESCE PAIR IS NOT DECORATION. SQLite's MULTI-ARGUMENT min()
         -- returns NULL if ANY argument is NULL — it does NOT skip them; that is
         -- the AGGREGATE min(), a different function with the same name. Written
         -- as a bare MIN(a, b) this returned NULL for every live call, because
         -- the write-up arm is deliberately NULL there — so a locked live call
         -- reported no deadline at all, which is the exact thing the cap exists
         -- to stop it doing. Caught by the regression, not by reading.
         --
         -- MIN(COALESCE(a,b), COALESCE(b,a)) gives: both present -> the earlier;
         -- one present -> that one; neither -> NULL, and no promise is made.
         MIN(
           COALESCE(
             CASE WHEN ${liveSql(':')} THEN NULL
                  ELSE datetime(${lockAnchorSql(':')}, '+${WRITEUP_MINUTES} minutes') END,
             CASE WHEN IFNULL(:owner_claimed_at, '') = '' THEN NULL
                  ELSE datetime(:owner_claimed_at, '+${OWNER_CAP_MINUTES} minutes') END
           ),
           COALESCE(
             CASE WHEN IFNULL(:owner_claimed_at, '') = '' THEN NULL
                  ELSE datetime(:owner_claimed_at, '+${OWNER_CAP_MINUTES} minutes') END,
             CASE WHEN ${liveSql(':')} THEN NULL
                  ELSE datetime(${lockAnchorSql(':')}, '+${WRITEUP_MINUTES} minutes') END
           )
         ) AS free_at
`;

/** Prepared once per database handle (dev HMR hands out new handles; a WeakMap
 *  lets the old ones be collected). callOwnerState runs this twice per row. */
const checkStmtCache = new WeakMap<Database.Database, Database.Statement>();
function checkStmt(db: Database.Database): Database.Statement {
  let s = checkStmtCache.get(db);
  if (!s) { s = db.prepare(CHECK_SQL); checkStmtCache.set(db, s); }
  return s;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Case-insensitive email identity — the one comparison, used everywhere.
 *  '' never matches '': an unowned call has no owner to be. */
function sameEmail(a: unknown, b: unknown): boolean {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  return !!x && x === y;
}

/**
 * The ct_calls columns callWriteBlock/callOwnerState need, as a SELECT list.
 * Paste this into your query instead of typing the names — a forgotten column
 * is the one way to accidentally disable the lock, and it fails loudly (see
 * MISSING_FIELDS_BLOCK) rather than silently letting two people write.
 *
 *   const rows = db.prepare(
 *     'SELECT c.id, ' + callOwnerColumns('c') + ' FROM ct_calls c WHERE ...'
 *   ).all();
 */
export function callOwnerColumns(alias = ''): string {
  const p = alias ? `${alias}.` : '';
  return `${p}status, ${p}ended_at, ${p}disposition, ${p}owner_email, ${p}owner_claimed_at`;
}

/** Resolve an owner email to a person's name. Pass `names` (the map from
 *  getUserNamesByEmail() in ./agents) when checking a LIST, so N rows do not
 *  become N queries; omit it for a single row. */
export function ownerDisplayName(
  db: Database.Database,
  email: string,
  names?: Record<string, string>,
): string {
  const e = String(email || '').trim();
  if (!e) return '';
  if (names) return names[e.toLowerCase()] || e;
  try {
    const r = db.prepare(`SELECT name FROM users WHERE lower(email) = lower(?) LIMIT 1`)
      .get(e) as { name?: string } | undefined;
    return String(r?.name || '').trim() || e;
  } catch { return e; } // never let a display lookup break a write check
}

/** Shown when the caller handed us a row that is missing ownership columns —
 *  a bug, not a state. Fails CLOSED: silently treating it as unowned would
 *  disable the lock for everyone and nobody would notice until two GREs
 *  overwrote each other again. */
const MISSING_FIELDS_BLOCK =
  'Call ownership could not be checked on the server, so this call is read-only for now. Reload the page; if it persists, report it to an admin.';

// ────────────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────────────

/**
 * Everything the server and the UI need to know about one call's ownership.
 * callWriteBlock() is this function's `block`; nothing may re-derive any part
 * of it, or the strip and the API will disagree about who can do what.
 */
export function callOwnerState(
  db: Database.Database,
  call: OwnableCall | null | undefined,
  user: OwnerActor | null | undefined,
  names?: Record<string, string>,
): CallOwnerState {
  const me = String(user?.email || '').trim();
  const mgmt = isManagement(user ? { role: user.role, is_head_chef: user.is_head_chef } : null);
  const base: CallOwnerState = {
    ownerEmail: '', ownerName: '', isMine: false, locked: false,
    canWrite: true, block: null, freeAt: '', freeAtLabel: '', live: false,
  };

  // A row we cannot judge is a row we must not open up.
  const missing = !call || (['status', 'ended_at', 'disposition', 'owner_email', 'owner_claimed_at'] as const)
    .some(k => call[k] === undefined);
  if (missing) {
    console.error('[call-owner] row is missing ownership columns — use callOwnerColumns()', {
      callId: call?.id ?? null,
    });
    return { ...base, canWrite: false, block: MISSING_FIELDS_BLOCK };
  }

  const row = {
    owner_email: String(call.owner_email ?? ''),
    owner_claimed_at: String(call.owner_claimed_at ?? ''),
    ended_at: String(call.ended_at ?? ''),
    disposition: String(call.disposition ?? ''),
    status: String(call.status ?? ''),
  };
  const now = new Date().toISOString();
  const stmt = checkStmt(db);

  // Two runs of the SAME rule: once as the caller (may I write?) and once as a
  // stranger (is a lock in force at all?). The second is what the strip shows,
  // and it is why a manager sees "Ravi is on this call" while still being able
  // to write. Both come from the SQL above — neither is re-derived in JS.
  const asMe = stmt.get({ ...row, email: me, now }) as { free: number; live: number; free_at: string | null };
  const asAnyone = stmt.get({ ...row, email: '', now }) as { free: number };

  const ownerEmail = row.owner_email;
  const isMine = sameEmail(ownerEmail, me);
  const locked = !asAnyone.free;
  const canWrite = !!asMe.free || mgmt;
  const live = !!asMe.live;
  // A live call DOES have a deadline now — the hard cap. It used to have none,
  // which is why this suppressed freeAt while live; publishing it then would
  // have promised a release the rule would not honour. The cap changes that, and
  // free_at above already returns the earlier of the two, so a live call can
  // honestly say when it frees up. Still blank when nothing is locked.
  const freeAt = locked ? String(asMe.free_at || '') : '';
  const ownerName = ownerDisplayName(db, ownerEmail, names);

  return {
    ownerEmail,
    ownerName,
    isMine,
    locked,
    canWrite,
    block: canWrite ? null : refusal(ownerName || ownerEmail, live, freeAt),
    freeAt,
    freeAtLabel: freeAt ? fmtISTTime(freeAt, { fallback: '' }) : '',
    live,
  };
}

/** The one refusal sentence, so every caller says the same thing: name the
 *  owner, say when it frees up, and point at the way out. */
function refusal(who: string, live: boolean, freeAt: string): string {
  const name = who || 'Another user';
  if (live) {
    // The cap means even a live call has an outside limit now, so do not promise
    // an open-ended "until the call ends" any more — that sentence was written
    // when a live call genuinely had no deadline, and it is the stuck-call case
    // (no hangup ever arrives) where it would have been most wrong.
    const cap = freeAt ? fmtISTTime(freeAt, { fallback: '' }) : '';
    return cap
      ? `${name} answered this call and is handling it — the write-up stays theirs until the call ends, and in any case opens to everyone by ${cap}. A manager can take it over.`
      : `${name} answered this call and is handling it — the write-up stays theirs until the call ends. A manager can take it over.`;
  }
  const when = freeAt ? fmtISTTime(freeAt, { fallback: '' }) : '';
  return when
    ? `${name} answered this call and is writing it up. It opens to everyone at ${when} unless they save a disposition first. A manager can take it over.`
    : `${name} answered this call and is writing it up. It opens to everyone once they save a disposition. A manager can take it over.`;
}

/**
 * May this user write to this call? null = yes. A string = the refusal,
 * ready to return to the client verbatim.
 *
 * Takes the ROW (not an id) so a caller that already loaded the call does not
 * query it twice — SELECT callOwnerColumns() with it.
 */
export function callWriteBlock(
  db: Database.Database,
  call: OwnableCall | null | undefined,
  user: OwnerActor | null | undefined,
  names?: Record<string, string>,
): string | null {
  return callOwnerState(db, call, user, names).block;
}

/**
 * FIRST CLAIM WINS. One conditional UPDATE — the precondition is the WHERE, so
 * two browsers clicking at the same instant are resolved by the database, not
 * by us. The loser is told who won.
 *
 * Re-claiming a call you already own succeeds (clause 2 of the rule), so a
 * browser that reconnects mid-call keeps its pop instead of being locked out
 * of its own call.
 */
export function claimCall(
  db: Database.Database,
  callId: string,
  email: string,
  names?: Record<string, string>,
): ClaimResult {
  const me = String(email || '').trim();
  const id = String(callId || '').trim();
  if (!me) {
    return { ok: false, owner: '', ownerName: '', reason: 'no_user', message: 'Sign in again to take this call.' };
  }
  if (!id) {
    return { ok: false, owner: '', ownerName: '', reason: 'not_found', message: 'That call no longer exists.' };
  }

  const now = new Date().toISOString();
  const res = db.prepare(CLAIM_SQL).run({ id, email: me, now });
  if (res.changes === 1) {
    return { ok: true, owner: me, ownerName: ownerDisplayName(db, me, names), claimedAt: now };
  }

  // changes === 0 means the WHERE did not match. Read the row back to say WHY —
  // this read cannot race the outcome: whatever it finds, we did not get the row.
  const diag = db.prepare(CLAIM_DIAG_SQL).get({ id }) as
    { owner_email: string; answered: number } | undefined;
  if (!diag) {
    return { ok: false, owner: '', ownerName: '', reason: 'not_found', message: 'That call no longer exists.' };
  }
  if (!diag.answered) {
    return {
      ok: false, owner: '', ownerName: '', reason: 'not_answered',
      message: 'Only an answered call can be taken. A missed call stays open to everyone in the recovery queue.',
    };
  }
  const owner = String(diag.owner_email || '');
  const ownerName = ownerDisplayName(db, owner, names);
  return {
    ok: false, owner, ownerName, reason: 'taken',
    message: `${ownerName || owner || 'Another user'} answered this call first and is handling it. A manager can take it over.`,
  };
}

/**
 * Management takeover — Admin / Manager / HOD only, so a bad claim is never
 * stuck. The tier check is here rather than in the route so no caller can
 * forget it; a non-manager gets a refusal, not a silent no-op.
 */
export function overrideCall(
  db: Database.Database,
  callId: string,
  user: OwnerActor | null | undefined,
  names?: Record<string, string>,
): ClaimResult {
  const me = String(user?.email || '').trim();
  const id = String(callId || '').trim();
  if (!me) {
    return { ok: false, owner: '', ownerName: '', reason: 'no_user', message: 'Sign in again to take this call.' };
  }
  if (!isManagement(user ? { role: user.role, is_head_chef: user.is_head_chef } : null)) {
    const cur = db.prepare(CLAIM_DIAG_SQL).get({ id }) as { owner_email: string } | undefined;
    const owner = String(cur?.owner_email || '');
    return {
      ok: false, owner, ownerName: ownerDisplayName(db, owner, names), reason: 'not_management',
      message: 'Only a manager or admin can take a call off someone else.',
    };
  }

  const now = new Date().toISOString();
  const res = db.prepare(OVERRIDE_SQL).run({ id, email: me, now });
  if (res.changes === 1) {
    return { ok: true, owner: me, ownerName: ownerDisplayName(db, me, names), claimedAt: now };
  }
  const diag = db.prepare(CLAIM_DIAG_SQL).get({ id }) as
    { owner_email: string; answered: number } | undefined;
  if (!diag) {
    return { ok: false, owner: '', ownerName: '', reason: 'not_found', message: 'That call no longer exists.' };
  }
  return {
    ok: false, owner: '', ownerName: '', reason: 'not_answered',
    message: 'Only an answered call can be taken. A missed call stays open to everyone in the recovery queue.',
  };
}

/**
 * Hand the call back — the owner giving it up, or management clearing a bad
 * claim. Returns true when ownership was actually cleared.
 *
 * NOT called on disposition: the rule already spends the lock the moment a
 * disposition exists, and keeping owner_email there is what lets the call log
 * show who handled it. Clearing it would throw that away for nothing.
 */
export function releaseCall(
  db: Database.Database,
  callId: string,
  user: OwnerActor | null | undefined,
): boolean {
  const me = String(user?.email || '').trim();
  const id = String(callId || '').trim();
  if (!me || !id) return false;
  const mgmt = isManagement(user ? { role: user.role, is_head_chef: user.is_head_chef } : null);
  // The branch is on the ACTOR, never on row state, so there is nothing to race:
  // an owner may only release their own call, management may release any.
  const guard = mgmt
    ? `IFNULL(owner_email, '') <> ''`
    : `lower(IFNULL(owner_email, '')) = lower(:email)`;
  const res = db.prepare(`
    UPDATE ct_calls
       SET owner_email = '', owner_claimed_at = ''
     WHERE id = :id AND ${guard}
  `).run(mgmt ? { id } : { id, email: me });
  return res.changes === 1;
}
