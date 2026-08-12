/**
 * CRM — how far a displayed talk time can be trusted, decided in ONE place.
 *
 * Most call durations in this system are measured by the PBX: TeleCMI times the
 * call and sends it in the CDR, and nobody in the building can influence that
 * number. Those are not in question and this module never marks them.
 *
 * The exception is the Call Back flow. The TeleCMI plan has no outbound package,
 * so a GRE dials from their own handset and the app records what the DEVICE
 * reports. On Android the Captain APK reads a duration out of the phone's call
 * log; on iPhone and desktop nothing can read a call log, so the number is the
 * GRE's own estimate. Both used to render as an identical monospace figure,
 * which is the dishonesty this module exists to remove.
 *
 * WHY THE MARK READS duration_verified AND NOTHING ELSE
 * ─────────────────────────────────────────────────────
 * There are two columns, and only ONE of them is a fact this server owns:
 *
 *   ct_calls.duration_source   what the CLIENT said the number is
 *                              ('call_log' | 'approx' | 'timer' | 'manual'),
 *                              or '' when no callback wrote this row. It arrives
 *                              in a request body. Every value of it — including
 *                              'call_log' — is typeable by anyone who can POST.
 *   ct_calls.duration_verified 1 when the SERVER established the number: a
 *                              single-use call token, minted before the dial on
 *                              the server clock, was redeemed, and the claimed
 *                              talk time fitted inside the wall time that had
 *                              elapsed since. See src/lib/ct/call-token.ts.
 *
 * An earlier version of this module promoted a row to "measured" — a green check
 * whose tooltip said the number had been read from the phone's own call log — on
 * duration_source === 'call_log' plus that bound. The bound is real, but the
 * word that made it a MEASUREMENT came out of the request body: an iPhone GRE
 * who mints a token, waits, and posts source='call_log' earns the same green
 * check, and nothing was read from anything. The only mark that read as proof
 * was therefore separated from an ordinary estimate by client input alone.
 *
 * So the mark now asserts exactly what the server can defend and not one word
 * more: THE RECORDED TIME IS BOUNDED BY A WALL CLOCK THIS SERVER KEPT. Whether a
 * call log was really read is unknowable here, so it is reported as the claim it
 * is, inside the tooltip, and never as proof. "Measured" is gone from the
 * vocabulary — there is no state this server can call measured.
 *
 * WHAT VERIFIED STILL DOES NOT MEAN. It is an upper bound, not a reading. A GRE
 * who taps Call Back, talks for 30s and types 4 minutes gets 4 minutes accepted
 * if four minutes of wall clock went by. The bound kills instant forgery — the
 * typed URL, the curl, the scripted burst — not patience. Say that plainly
 * rather than letting anyone read the check as "this number is exact".
 *
 * THE THIRD STATE IS THE IMPORTANT ONE. Every row that existed before this
 * mechanism shipped carries duration_source = '' (the ALTER back-filled it), and
 * so does every PBX CDR. Those are UNMARKED — no glyph, no tilde, no tooltip,
 * byte-identical to how they render today. That is deliberate and it is the
 * whole reason the discriminator is duration_source rather than a date cutoff:
 * a real callback logged by a real GRE last month is not suspicious, it simply
 * predates the mechanism, and decorating it would be a false accusation against
 * staff who did nothing wrong.
 *
 * Pure module — no React, no database, no imports. Safe from a 'use client'
 * page (hard rule 5).
 */

/** What the client claimed the number is. Mirrors DURATION_SOURCES in
 *  src/lib/ct/call-token.ts, plus '' for "no callback wrote this row".
 *  Re-declared rather than imported because that module reaches @/lib/db and
 *  these callers are client components. */
export type DurationSourceValue = '' | 'call_log' | 'approx' | 'timer' | 'manual';

export type DurationTrustKind =
  /** Not a self-logged duration: a PBX CDR, or a row from before the mechanism.
   *  Renders exactly as it always has. */
  | 'unmarked'
  /** The SERVER bounded this number against its own clock. The only state that
   *  renders as proof, and it proves a bound — never a reading. */
  | 'verified'
  /** Self-logged and not server-bounded. A claim, whatever the client called it. */
  | 'reported';

export interface DurationTrustView {
  kind: DurationTrustKind;
  /**
   * Prefix for the formatted duration: '~' on EVERY self-logged number, '' only
   * on 'unmarked'. The tilde is the ordinary typographic mark for
   * "approximately", so it qualifies the figure without adding a chip, a colour
   * or a second element.
   *
   * IT STAYS ON A VERIFIED ROW, and that is not an oversight. The two marks say
   * two orthogonal things: the tilde says THIS FIGURE IS NOT ESTABLISHED, the
   * check says THE SERVER BOUNDED IT. No self-logged duration is ever
   * established — the strongest thing available is an upper bound — so dropping
   * the tilde on verification would quietly promote a bounded typed estimate to
   * looking like a PBX-timed call.
   *
   * It also matters because not every surface draws the check. The Guest 360
   * timeline renders prefix + note and no icon at all by design, so the tilde is
   * the ONLY mark it has; tying the tilde to non-verification would blank that
   * page's qualifier on exactly the rows a token was minted for.
   */
  prefix: string;
  /** Tooltip. Always '' for 'unmarked' — nothing is being claimed about those
   *  rows, so saying anything would invent a distinction that is not there. */
  note: string;
}

const UNMARKED: DurationTrustView = { kind: 'unmarked', prefix: '', note: '' };

/** What the client SAID this number was, phrased as the claim it is. Used in
 *  both marked states, because the claim is worth showing and is worth showing
 *  as a claim either way. */
function claimClause(src: string): string {
  switch (src) {
    case 'call_log':
      return 'The phone reported it as an exact reading from its own call log — a claim this server cannot check.';
    case 'approx':
      return 'The Captain app estimated it, because it could not read the phone’s call log for this call.';
    case 'timer':
      return 'It was estimated from the time spent at the dialler — iPhone and desktop cannot read a phone’s call log.';
    case 'manual':
      return 'It was typed in by hand as a remembered estimate.';
    default:
      // Only reachable from a writer this build does not know about. Falling to
      // the weakest claim is the safe direction.
      return 'The client did not say where the number came from, so treat it as self-reported.';
  }
}

/**
 * Classify one call's duration.
 *
 * @param source       ct_calls.duration_source ('' when absent — an older cached
 *                     API response is treated as unmarked, never as verified).
 * @param verified     ct_calls.duration_verified (1 = server-bounded). THE ONLY
 *                     INPUT THAT CAN PRODUCE A PROOF MARK.
 * @param durationSec  the number about to be rendered. It never changes the
 *                     kind — a self-logged row is marked whatever it says,
 *                     including zero, because a zero-second "connected" call is
 *                     the cheapest row anyone can fabricate and it must not
 *                     render byte-identical to a PBX call. It only tunes the
 *                     wording.
 */
export function durationTrust(
  source: string | null | undefined,
  verified: number | boolean | null | undefined,
  durationSec: number | null | undefined,
): DurationTrustView {
  const src = String(source || '').trim();
  if (!src) return UNMARKED;

  const secs = Number(durationSec) || 0;
  const zero = secs <= 0;
  const bounded = verified === 1 || verified === true;

  if (bounded) {
    return {
      kind: 'verified',
      // Still a tilde — see the prefix contract above. Bounded is not exact.
      prefix: '~',
      note: zero
        ? 'Checked by the server: this call back was started from the app, and it was '
          + 'logged with no talk time. ' + claimClause(src)
        : 'Checked by the server: this call back was started from the app, and the time '
          + 'recorded cannot be longer than the wall time since Call Back was tapped. That '
          + 'is a limit the server proved, not a reading it took. ' + claimClause(src),
    };
  }

  return {
    kind: 'reported',
    prefix: '~',
    note: zero
      ? 'Self-logged callback recorded with no talk time, and not checked against when '
        + 'the call was started. ' + claimClause(src)
      : 'Self-logged, and the server could not check it against when the call was started. '
        + claimClause(src),
  };
}
