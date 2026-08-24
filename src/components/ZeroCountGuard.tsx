'use client';

/**
 * THE UPLOAD PATTERN GUARD, ON SCREEN (owner requirement 7).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *      BLANK = NOT COUNTED.        0 = COUNTED AND FOUND EMPTY.
 *
 * A weekly sheet arrived with 793 of 1,033 rows carrying a typed 0 where the
 * cells were meant to be blank, and 1,472 counts landed in the approval queue.
 * No value check can catch that — a 0 is a perfectly legitimate count and the
 * owner's own rule says so. Only the PATTERN can: when an implausible share of
 * the lines somebody filled in read 0, the server refuses the whole submit
 * BEFORE writing a single row and names the count (zeroPatternGuard in
 * src/lib/variance-approval.ts — ≥25 counted lines AND ≥15 zeros AND ≥60%).
 *
 * This dialog is what that refusal looks like. Three jobs, in this order:
 *   1. SAY NOTHING WAS SAVED. The counter's next move depends entirely on
 *      whether their numbers are in the system; leaving that ambiguous is worse
 *      than the original bug.
 *   2. SHOW WHAT WAS FOUND — how many zeros, out of how many filled-in lines,
 *      as a share. The server's own sentence is rendered VERBATIM beneath it so
 *      this component can never drift from the rule the API actually applied.
 *   3. OFFER A DELIBERATE WAY THROUGH. A genuine all-zero stocktake is real
 *      (a bar that was emptied, a section being closed down), so confirming is
 *      possible — but it is the heavier button, it names the number it is about
 *      to write, and it is never the default.
 *
 * The caller re-sends the IDENTICAL body plus `confirm_zeros: true`. It must
 * not re-derive the payload from the screen in between — the number in this
 * dialog would then describe a different submit than the one it authorises.
 */

import { AlertTriangle, Loader2, X } from 'lucide-react';

/** The `zero_guard` block the counting APIs answer 409 with. */
export interface ZeroGuardInfo {
  /** Lines that carried a real count. Blanks are NOT counted and not included. */
  counted: number;
  /** How many of those were exactly 0. */
  zeros: number;
  /** zeros / counted, 0..1. */
  share: number;
  /** The server's own sentence. Rendered verbatim — never re-worded here. */
  message: string;
}

/**
 * Pull the guard out of a refusal body, or null when this was some OTHER
 * failure (a bad date, a permission refusal, a 500). Two shapes are explicitly
 * NOT a refusal and must return null, or a successful save would raise the
 * dialog over counts that are already stored:
 *   · `confirmed: true`  — the echo the routes put on a CONFIRMED save
 *   · `suspicious: false` — the preview shape, which always carries the block
 */
export function readZeroGuard(json: unknown): ZeroGuardInfo | null {
  if (!json || typeof json !== 'object') return null;
  const g = (json as Record<string, unknown>).zero_guard;
  if (!g || typeof g !== 'object') return null;
  const o = g as Record<string, unknown>;
  if (o.confirmed === true) return null;
  if (o.suspicious === false) return null;
  const counted = Number(o.counted) || 0;
  const zeros = Number(o.zeros) || 0;
  return {
    counted,
    zeros,
    share: Number(o.share) || (counted > 0 ? zeros / counted : 0),
    message: String(o.message || ''),
  };
}

export default function ZeroCountGuard({
  guard,
  what,
  busy = false,
  onCancel,
  onConfirm,
}: {
  guard: ZeroGuardInfo;
  /** What is being saved, in the counter's words — "this file", "this sheet". */
  what: string;
  busy?: boolean;
  onCancel: () => void;
  /** Re-send the SAME payload with confirm_zeros: true. Nothing re-derived. */
  onConfirm: () => void;
}) {
  const pct = Math.round((Number(guard.share) || 0) * 100);
  const n = (v: number) => (Number(v) || 0).toLocaleString('en-IN');

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4"
         onClick={() => { if (!busy) onCancel(); }}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-start justify-between gap-3">
          <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            Mostly zeros — nothing was saved
          </h2>
          <button onClick={onCancel} disabled={busy}
                  className="text-[#8B7355] hover:text-[#2D1B0E] disabled:opacity-50">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-3.5">
          {/* WHAT WAS FOUND, as a figure rather than a paragraph — this is the
              one number that tells the counter whether their file is wrong. */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3.5 text-center">
            <div className="text-3xl font-bold text-amber-900">
              {n(guard.zeros)} <span className="text-lg font-semibold text-amber-800">of {n(guard.counted)}</span>
            </div>
            <div className="text-[12px] text-amber-800 mt-0.5">
              lines you filled in read <b>0</b> — {pct}% of {what}
            </div>
          </div>

          {/* THE RULE, in the two lines the whole fix exists for. */}
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <div className="border border-[#E8D5C4] rounded-lg p-2.5 bg-[#FFF8F0]">
              <div className="font-semibold text-[#2D1B0E]">A blank cell</div>
              <div className="text-[#6B5744] mt-0.5">means <b>not counted</b>. Nothing is recorded and nothing is compared.</div>
            </div>
            <div className="border border-[#E8D5C4] rounded-lg p-2.5 bg-[#FFF8F0]">
              <div className="font-semibold text-[#2D1B0E]">A typed 0</div>
              <div className="text-[#6B5744] mt-0.5">means <b>counted, found empty</b>. It is a real count and is treated like any other number.</div>
            </div>
          </div>

          {/* The server's own sentence, verbatim. Do not paraphrase it here —
              the thresholds live in the lib and this must not drift from them. */}
          {guard.message && (
            <p className="text-[12px] leading-relaxed text-[#6B5744] bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3">
              {guard.message}
            </p>
          )}

          <p className="text-[12px] text-[#6B5744]">
            <b>Nothing has been written.</b> Fix the blanks and try again, or confirm below if the shelves really were empty.
          </p>
        </div>

        <div className="px-5 py-4 border-t border-[#E8D5C4] flex flex-wrap justify-end gap-2">
          {/* The safe way out is the default and the wider target. */}
          <button onClick={onCancel} disabled={busy}
                  className="px-4 py-2 text-sm font-medium text-[#2D1B0E] bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg hover:bg-[#E8D5C4] disabled:opacity-50">
            Go back and fix the blanks
          </button>
          {/* The deliberate one. It NAMES the number it will write, so it can
              never be clicked as a generic "OK, continue". */}
          <button onClick={onConfirm} disabled={busy}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertTriangle className="w-4 h-4" />}
            Yes — record {n(guard.zeros)} shelves as empty
          </button>
        </div>
      </div>
    </div>
  );
}
