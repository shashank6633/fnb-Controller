'use client';

/**
 * "DID I COUNT THIS, OR DID I NOT?" — the counter's own answer, on screen.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *      BLANK = NOT COUNTED.        0 = COUNTED AND FOUND EMPTY.
 *
 * That rule is now enforced end-to-end on every write path, but enforcement
 * alone would have let the defect back in through the front door: an empty box
 * and a box holding 0 looked identical at a glance in a 900-row sheet, and a
 * fill-down or a stray keystroke could turn one into the other with nothing on
 * screen saying which had happened. This strip sits under every count box and
 * states, in words, which of the two the row currently says — plus the two
 * one-click ways to change that answer deliberately:
 *
 *   · "none left"  writes a literal 0 — I looked, the shelf is empty.
 *   · "clear"      empties the box   — I did not count this one.
 *
 * A negative or unparseable entry gets its own state rather than being folded
 * into "counted": the server refuses those per line, and a counter who is told
 * "counted" and then finds the row missing has been lied to.
 */

import { Minus } from 'lucide-react';

export type CountKind = 'blank' | 'zero' | 'count' | 'bad';

/** What one entry box currently says. Whitespace is a blank, never a zero. */
export function countKind(raw: string | number | null | undefined): CountKind {
  if (raw === null || raw === undefined) return 'blank';
  const s = String(raw).trim();
  if (s === '') return 'blank';
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return 'bad';
  return n === 0 ? 'zero' : 'count';
}

export default function CountState({
  raw,
  onZero,
  onClear,
  className = '',
}: {
  raw: string | number | null | undefined;
  /** Record a deliberate zero — "I counted, there is none". */
  onZero: () => void;
  /** Back to not-counted. */
  onClear: () => void;
  className?: string;
}) {
  const kind = countKind(raw);
  const link = 'text-[9px] underline decoration-dotted text-[#8B7355] hover:text-[#af4408]';

  return (
    <div className={`mt-0.5 flex items-center justify-between gap-1 leading-none ${className}`}>
      {kind === 'blank' && <span className="text-[9px] text-[#B8A590]">not counted</span>}
      {kind === 'zero' && (
        <span className="inline-flex items-center gap-0.5 text-[9px] font-medium px-1 py-0.5 rounded bg-amber-100 text-amber-800">
          <Minus className="w-2.5 h-2.5" /> counted · none
        </span>
      )}
      {kind === 'count' && (
        <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-emerald-100 text-emerald-700">counted</span>
      )}
      {kind === 'bad' && (
        <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-red-100 text-red-700">not a count</span>
      )}

      {kind === 'blank'
        ? <button type="button" onClick={onZero} className={link} title="I counted this and there is none left — records a real 0">none left</button>
        : <button type="button" onClick={onClear} className={link} title="Empty the box — this row was not counted">clear</button>}
    </div>
  );
}
