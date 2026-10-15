/**
 * P4 — RECEIVING QC · TEMPERATURE · COLD ROOM: the server helpers the four P4
 * routes share.
 *
 * WHY THIS FILE EXISTS WHERE IT DOES. Eight feature lanes are building record
 * modules in parallel and NONE of them may edit `src/lib/fssai.ts` or
 * `src/lib/fssai-server.ts`. The measured reason is on this project's own record:
 * two lanes each wrote their own `sales-slice.ts` with the same export signature,
 * the pair disagreed silently, 0+0 errors alone became 34 together, and `tsc`
 * pointed at the wrong one. So anything P4 needs and the shared modules do not
 * already carry lives HERE, under a phase-named private folder inside P4's own
 * API footprint — `_p4` is an App Router private folder, so nothing in it is
 * routable, and the name says who owns it.
 *
 * ⚠️ NOTHING IN THIS FILE IS A SECOND CONVENTION. Every vocabulary value, every
 * range test, every lifecycle rule comes from `src/lib/fssai.ts`; what is added
 * here is only the P4-shaped glue: resolving WHICH range applies to a reading,
 * freezing it, raising the corrective action a failure owes, and the one
 * attachment writer the record modules need because `fssai_evidence` cannot hold
 * a photograph that has no checklist round (see `writeFssaiAttachment` below).
 *
 * HOUSE RULES OBSERVED THROUGHOUT:
 *   · better-sqlite3 is SYNCHRONOUS — nothing here is async, and nothing here is
 *     ever awaited inside a `db.transaction()`.
 *   · An FK column is written NULL, never '' (foreign_keys = ON makes '' throw).
 *     The only FK in P4's own tables is `fssai_receiving_lines.check_id`, which
 *     always carries a real id, and `fssai_corrective_actions.run_id`, which this
 *     file writes as NULL because a temperature reading has no round.
 *   · `is_fail` / `is_judged` / `min_used` / `max_used` are FROZEN AT WRITE and
 *     never recomputed on read. Tightening a standard next month must not
 *     retrospectively fail a fridge that passed.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import {
  fssaiRangeCheck, fssaiCaDueDate, fssaiToday, isFssaiCaSeverity,
  isFssaiAttachmentEntity, parseFssaiDataUri, FSSAI_PHOTO_MIMES,
  FSSAI_RECEIVING_CHECKPOINTS, fssaiCheckResultIsFail, fssaiCheckResultAnswered,
  FSSAI_TEMP_LOG_KINDS, isISODate, addDaysISO,
  type FssaiActor,
} from '@/lib/fssai';
import { fssaiAuditBestEffort, nextFssaiCaNumber, str } from '@/lib/fssai-server';

/* ================================================================== *
 * 1. THE HUMAN-FACING NUMBER
 * ================================================================== */

/**
 * 'RQC-2026-0001' — the delivery inspection's own number.
 *
 * The house allocator, character for character the one `nextFssaiCaNumber` uses
 * and the one `purchases/route.ts:587` and `returns.ts:155` use before it: MAX of
 * the numeric tail inside this year's prefix. It MUST be called inside the
 * caller's transaction, so two inspections opened in the same second cannot both
 * read the same MAX — and `uq_fssai_rqc_no` (partial, on `check_no <> ''`) is the
 * backstop if they ever do.
 *
 * `outlet_id` is part of that UNIQUE but deliberately NOT part of the MAX: two
 * outlets sharing one series is a cosmetic gap, whereas scoping the MAX per
 * outlet and then colliding on the shared index would be a refused submit.
 */
export function nextFssaiReceivingNo(db: Database.Database, isoDate: string): string {
  const year = /^\d{4}-/.test(String(isoDate || '')) ? String(isoDate).slice(0, 4) : String(new Date().getFullYear());
  const last = db.prepare(
    `SELECT MAX(CAST(substr(check_no, length('RQC-' || ? || '-') + 1) AS INTEGER)) AS n
       FROM fssai_receiving_checks WHERE check_no LIKE 'RQC-' || ? || '-%'`,
  ).get(year, year) as any;
  return `RQC-${year}-${String((Number(last?.n) || 0) + 1).padStart(4, '0')}`;
}

/* ================================================================== *
 * 2. WHICH RANGE APPLIES TO THIS READING — "never hard-coded" (owner §5)
 * ================================================================== */

export interface FssaiResolvedRange {
  /** '' when nothing was found, which is NOT a failure — see `judged`. */
  standard_id: string;
  standard_label: string;
  /** Where the numbers came from, for the screen and for the frozen record. */
  source: 'equipment' | 'standard' | 'none';
  min: number | null;
  max: number | null;
  target: number | null;
  max_minutes: number | null;
  /** Cooling / reheating only: the temperature the schedule line starts from at
   *  minute 0 when a batch has no 0-minute reading of its own
   *  (`fssai_temp_standards.start_value`). null = the rule has no anchor, and a
   *  batch without a 0-minute reading is then failed, never passed. */
  start_value: number | null;
  uom: string;
  decimals: number;
}

/** A REAL number or null. Never 0 for "missing" — 0 °C is a freezing reading. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** An integer or null, same reasoning as `num`. */
function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

export { num as fssaiNum, int as fssaiInt };

/**
 * THE RANGE THIS READING IS JUDGED AGAINST, most specific first.
 *
 * ORDER, AND WHY IT IS THIS ORDER:
 *   1. THE UNIT'S OWN RANGE (`fssai_equipment.min_temp` / `max_temp`). A walk-in
 *      and a dessert chiller are not the same thing, and the owner said so: a
 *      range set on one unit must beat the general rule for its type, so a single
 *      awkward chiller can have its own numbers without changing anything else.
 *   2. A STANDARD, narrowed as far as it will go — an item-specific rule, then an
 *      equipment-kind rule, then the bare kind. `is_active = 1` only: a retired
 *      standard must not silently keep judging.
 *   3. NOTHING. The reading is stored and `judged` is false. This is the honest
 *      answer before the owner has set his standards, and it is the whole reason
 *      `is_judged` is a column: an unjudged reading is NOT a pass, and a screen
 *      that painted it green would be lying about a fridge nobody has a rule for.
 *
 * A unit with only ONE bound set is still a rule (a freezer with a maximum and no
 * minimum is normal), so the test is "either bound present", never "both".
 */
export function resolveFssaiRange(
  db: Database.Database,
  input: {
    logKind: string;
    equipmentId?: string | null;
    equipmentKind?: string | null;
    materialId?: string | null;
    /** 'C' | 'F' | 'pct' | 'ppm' | 'pH' — the unit the reading was taken in. */
    uom?: string | null;
  },
): FssaiResolvedRange {
  const fallbackUom = str(input.uom) || 'C';
  const none: FssaiResolvedRange = {
    standard_id: '', standard_label: '', source: 'none',
    min: null, max: null, target: null, max_minutes: null, start_value: null,
    uom: fallbackUom, decimals: 1,
  };

  const equipmentId = str(input.equipmentId);
  /* ⚠️ A RATE RULE IS NOT REPLACED BY A UNIT'S RANGE. Cooling and reheating are
   * judged against the CLOCK (`max_minutes`), and a unit's own range never carries
   * one — it is the range for the AIR in that unit. Letting the blast chiller's
   * "0 to 5 °C" win for a cooling probe turned every curry still on its way down
   * (30 °C at 60 minutes) into a breach, because with no clock the reading could
   * only be judged on its level. The unit is still recorded as WHERE the food was;
   * the cooling or reheating standard is WHAT it is judged against. */
  const isRateKind = !!FSSAI_TEMP_LOG_KINDS.find((k) => k.key === str(input.logKind))?.window_minutes;
  if (equipmentId && !isRateKind) {
    const eq = db.prepare(
      `SELECT id, name, kind, min_temp, max_temp, temp_uom FROM fssai_equipment WHERE id = ?`,
    ).get(equipmentId) as any;
    if (eq && (num(eq.min_temp) !== null || num(eq.max_temp) !== null)) {
      return {
        standard_id: '',
        standard_label: `${String(eq.name || 'this unit')} — the range set on the unit`,
        source: 'equipment',
        min: num(eq.min_temp),
        max: num(eq.max_temp),
        target: null,
        max_minutes: null,
        start_value: null,
        uom: str(eq.temp_uom) || fallbackUom,
        decimals: 1,
      };
    }
  }

  const logKind = str(input.logKind);
  if (!logKind) return none;
  const equipmentKind = str(input.equipmentKind);
  const materialId = str(input.materialId);

  /* ONE QUERY, ORDERED BY SPECIFICITY, LIMIT 1 — rather than three queries, so
   * the tie-break is in SQL and cannot drift between callers. A row that names
   * this item outranks one that names only the equipment kind, which outranks the
   * bare kind. `sort_order` then `rowid` makes the choice deterministic when two
   * rules are equally specific: without it the "applicable standard" shown on the
   * screen and the one frozen onto the record could differ between two reads. */
  const std = db.prepare(
    `SELECT id, code, label, min_value, max_value, target_value, uom, decimals, max_minutes, start_value,
            (CASE WHEN material_id <> '' AND material_id = ? THEN 0 ELSE 1 END) AS m_rank,
            (CASE WHEN equipment_kind <> '' AND equipment_kind = ? THEN 0 ELSE 1 END) AS k_rank
       FROM fssai_temp_standards
      WHERE is_active = 1
        AND applies_to = ?
        AND (material_id = '' OR material_id = ?)
        AND (equipment_kind = '' OR equipment_kind = ?)
      ORDER BY m_rank ASC, k_rank ASC, sort_order ASC, rowid ASC
      LIMIT 1`,
  ).get(materialId, equipmentKind, logKind, materialId, equipmentKind) as any;

  if (!std) return none;
  return {
    standard_id: String(std.id),
    standard_label: String(std.label || std.code || 'Standard'),
    source: 'standard',
    min: num(std.min_value),
    max: num(std.max_value),
    target: num(std.target_value),
    max_minutes: int(std.max_minutes),
    /* Only a rate kind draws a schedule line; on any other rule the column is
     * meaningless and is never handed on. */
    start_value: isRateKind ? num(std.start_value) : null,
    uom: str(std.uom) || fallbackUom,
    decimals: int(std.decimals) ?? 1,
  };
}

/* ================================================================== *
 * 3. THE VERDICT ON ONE READING — frozen, and never recomputed
 * ================================================================== */

export interface FssaiReadingVerdict {
  is_judged: 0 | 1;
  is_fail: 0 | 1;
  fail_reason: string;
  /** What a screen prints whether or not anything was judged. */
  why: string;
  /** WHICH rule failed, for the corrective action's title — '' on a pass.
   *   level       — outside the range (a level rule, or a rate reading at its end)
   *   behind      — inside the window and behind the schedule line
   *   no_line     — inside the window, short of the target, nothing to measure from
   *   past_window — past the time allowed and still short of the target
   *   late        — at the target, but no reading showed it there within the time
   *   rewarmed    — the batch reached its target and has since gone back past it */
  fail_kind: '' | 'level' | 'behind' | 'no_line' | 'past_window' | 'late' | 'rewarmed';
}

/** The corrective-action title words for a failed rate reading. */
export function fssaiFailKindWords(kind: FssaiReadingVerdict['fail_kind']): string {
  switch (kind) {
    case 'behind': return 'behind schedule';
    case 'no_line': return 'short of target with no starting point';
    case 'past_window': return 'not finished in time';
    case 'late': return 'reached its target late';
    case 'rewarmed': return 'went back past its target';
    default: return 'out of range';
  }
}

/**
 * JUDGE ONE READING, AND THE CLOCK WITH IT.
 *
 * Two halves, because FSSAI judges cooling and reheating on a RATE and not a
 * level: the level comes from `fssaiRangeCheck` (shared, unrounded — rounding 5.4
 * would pass a 0–5 rule), and the clock is tested here because only this phase
 * has the elapsed minutes.
 *
 * ⚠️ READ THE CLOCK TEST CAREFULLY (changed 2026-10-15). Past the window, a
 * reading FAILS — still short of the target ('past_window'), or at the target
 * with no earlier reading showing it got there in time ('late'). The old rule
 * passed the second case ("the food is safe, it is the record of the curve that
 * is late"); measured, that filed 4 °C at minute 260 of a 240-minute rule as
 * "In range" with no corrective action, and the overdue job then never raised
 * the batch. By the rule the batch did not reach its target in time, and the
 * record says so. A batch that DID reach its target in time is not failed by a
 * later reading still at the target (`reachedBefore`); one that went back past
 * it is ('rewarmed').
 *
 * `uomForWords` is the symbol the sentence is written with, not a conversion:
 * nothing here converts, because `min_used`/`max_used` are frozen in the unit the
 * reading was taken in and a record that silently restates a number in another
 * unit is unreadable beside the probe that produced it.
 *
 * ── A READING TAKEN WHILE THE FOOD IS STILL ON ITS WAY ───────────────────────
 * This used to be judged on its LEVEL: the range test ran first and on its own,
 * so a curry at 30 °C sixty minutes into a 240-minute cooling window "failed" the
 * 5 °C maximum, demanded an "action taken", and raised a corrective action. Staff
 * learned to log only the end point — and the authority asks for a cooling
 * MONITORING SHEET, which is the readings in between.
 *
 * Inside the window, a reading that has not yet reached its target is now judged
 * against WHERE IT SHOULD BE BY THEN: a straight line from the curve's first
 * reading (`curveStart`) down to the target at the end of the window
 * (`fssaiCurveExpected`). At or past that line it is on schedule and is NOT a
 * breach; behind it, it is. A straight line is the lenient-looking but honest
 * choice — real food cools fastest at the start, so a pot that is above the
 * straight line is genuinely behind. At the end of the window the line IS the
 * target, so the final reading above target is still a breach, and past the
 * window the clock test above still fails anything that has not got there.
 *
 * ── WHERE THE LINE STARTS, AND WHAT HAPPENS WITH NO START (2026-10-14) ──────
 * MEASURED FAIL-OPEN, NOW CLOSED: a reading that started a batch with its
 * minutes typed (65 °C "at 239 of 240 minutes") used to become the start of its
 * own line, so it could never be behind it, and it was filed as a judged PASS
 * with no action and no corrective action. The line now starts at minute 0, and
 * only at minute 0: from the batch's own 0-minute reading, or — when the batch
 * has none — from the rule's `start_value` anchor (`fssaiCurveLineStart` picks,
 * the route freezes the choice on the reading). With NEITHER, there is nothing
 * to measure progress from, and a reading inside the window that has not
 * reached the target is FILED AS A FAILURE on its level — never passed, and not
 * left as "not judged" either, which is how a batch nobody started properly
 * would otherwise slide through every report. The cook's way out is in the
 * reason: take the first reading as the food comes off the heat (0 minutes), or
 * have an administrator set the rule's starting temperature.
 *
 * A rule with no target at all (no target, and no bound on the safe side) can
 * still not judge a reading short of a goal it does not have; that reading stays
 * `is_judged = 0`, which this module never counts as a pass. The standards route
 * refuses to create such a cooling or reheating rule.
 */
export function judgeFssaiReading(input: {
  value: number | null;
  min: number | null;
  max: number | null;
  uomForWords?: string;
  elapsedMinutes?: number | null;
  maxMinutes?: number | null;
  /** The target the curve has to reach before the clock matters. */
  target?: number | null;
  /** 'cold' | 'hot' | 'either' — which side of the target counts as "reached". */
  direction?: 'cold' | 'hot' | 'either';
  /** Where the schedule line starts — see `fssaiCurveLineStart`. Its
   *  `elapsedMinutes` is the minute on the curve's clock (0 for both sources).
   *  `firstValue` is the batch's own 0-minute reading when it has one (only for
   *  the words: the line may start from the rule's stricter figure instead).
   *  null = no line can be drawn, and the reading is failed if short of target. */
  curveStart?: { value: number | null; elapsedMinutes: number | null; source?: FssaiCurveStartSource; firstValue?: number | null } | null;
  /** This reading STARTS its batch at minute 0. It is where the clock begins,
   *  so it is never "behind" a line — even when the line starts from the rule's
   *  stricter starting temperature rather than from this number. */
  batchStart?: boolean;
  /** An EARLIER reading on this batch already reached the target. A reading now
   *  on the wrong side of it is food that has gone back (warmed up again after
   *  cooling, or cooled again after reheating) — a failure, never "on schedule". */
  reachedBefore?: { value: number | null; elapsed: number | null; reading_at?: string } | null;
}): FssaiReadingVerdict {
  const r = fssaiRangeCheck(input.value, input.min, input.max, input.uomForWords || '');
  let judged: 0 | 1 = r.judged ? 1 : 0;
  let fail: 0 | 1 = r.out_of_range ? 1 : 0;
  let reasons: string[] = r.out_of_range ? [r.why] : [];
  let passWhy = r.why;
  let failKind: FssaiReadingVerdict['fail_kind'] = r.out_of_range ? 'level' : '';

  const elapsed = input.elapsedMinutes === null || input.elapsedMinutes === undefined
    ? null : Number(input.elapsedMinutes);
  const limit = input.maxMinutes === null || input.maxMinutes === undefined
    ? null : Number(input.maxMinutes);

  if (Number.isFinite(elapsed as number) && Number.isFinite(limit as number) && (limit as number) > 0) {
    judged = 1;
    const v = input.value === null || input.value === undefined ? null : Number(input.value);
    const target = input.target === null || input.target === undefined ? null : Number(input.target);
    const dir = input.direction || 'either';
    /* "Has it got there yet?" If no target is configured, the range bound on the
     * safe side stands in for one — which is what a cooling rule means in
     * practice: down to the maximum within the window. */
    const goal = target !== null ? target : (dir === 'hot' ? input.min : input.max);
    let reached: boolean | null = null;
    if (v !== null && goal !== null && Number.isFinite(goal)) {
      reached = dir === 'hot' ? v >= Number(goal) : v <= Number(goal);
    }
    const u = input.uomForWords ? ` ${input.uomForWords}` : '';
    const goingWord = dir === 'hot' ? 'heating' : 'cooling';
    const sideWord = dir === 'hot' ? 'at or above' : 'at or below';
    const before = input.reachedBefore || null;
    if (before && reached !== null) {
      /* ── THE BATCH ALREADY GOT THERE (2026-10-15) ─────────────────────────
       * MEASURED FAIL-OPEN, NOW CLOSED: a pot that reached 4 °C and was then
       * probed at 25 °C was filed "on schedule" against the line, and the batch
       * still read "reached in time". Once a batch has reached its target, the
       * schedule line no longer applies: a reading still at the target passes,
       * and one back on the wrong side is food that has warmed up again (or, for
       * reheating, cooled again) — a failure, whatever the clock says. */
      if (reached) {
        passWhy = fail
          ? passWhy
          : `Still ${sideWord} ${goal}${u}: this batch reached its target at ${before.elapsed ?? '?'} minutes${before.reading_at ? ` (${before.reading_at})` : ''}, and this reading at ${elapsed} minutes is still there.`;
      } else {
        fail = 1;
        failKind = 'rewarmed';
        reasons = [
          `This batch reached ${goal}${u} at ${before.elapsed ?? '?'} minutes${before.reading_at ? ` (${before.reading_at})` : ''} and is now back at ${v}${u}, ${elapsed} minutes in. ${dir === 'hot' ? 'Reheated food that has cooled again' : 'Cooled food that has warmed up again'} is not safe to keep as it is — it is filed as a failure, not as "on schedule".`,
        ];
      }
    } else if ((elapsed as number) > (limit as number)) {
      fail = 1;
      if (reached === true) {
        /* ── AT THE TARGET, BUT LATE (2026-10-15) ───────────────────────────
         * MEASURED FAIL-OPEN, NOW CLOSED: 4 °C at minute 260 of a 240-minute
         * cooling rule was filed as a PASS ("In range"), raised nothing, and the
         * overdue job then counted the batch as reached and never escalated it.
         * The rule is "reach the target within the time allowed"; no reading
         * showed this batch there in time, so the record of the cooling fails.
         * The food may be at the target now — the sentence says so — but the
         * batch did not meet the rule, and the cook has to say what was done.
         * PROVISIONAL (the owner has not ruled): the strict side, as a fail;
         * reversible here in one branch. */
        failKind = 'late';
        reasons = [
          ...(r.out_of_range ? [r.why] : []),
          `No reading shows it ${sideWord} ${goal}${u} within the ${limit} minutes the rule allows — the first reading at the target is this one, ${elapsed} minutes in. It is at the target now, but the ${goingWord} took longer than the rule allows.`,
        ];
      } else {
        reasons.push(
          reached === false && goal !== null
            ? `${elapsed} minutes have passed and it is still at ${v}${u} — the rule allows ${limit} minutes to reach ${goal}${u}.`
            : `${elapsed} minutes have passed, and the rule allows ${limit}.`,
        );
        failKind = 'past_window';
      }
    } else if (reached !== true) {
      /* INSIDE THE WINDOW AND NOT THERE YET. The level test above does not decide
       * this reading — the schedule does. Whatever the level test said is
       * replaced, in both directions. */
      const startV = input.curveStart ? num(input.curveStart.value) : null;
      const startE = input.curveStart ? (num(input.curveStart.elapsedMinutes) ?? 0) : null;
      const firstV = input.curveStart ? num(input.curveStart.firstValue) : null;
      const expected = fssaiCurveExpected({
        startValue: startV, startElapsed: startE, goal: goal === null ? null : Number(goal),
        maxMinutes: limit, elapsed,
      });
      if (v === null || goal === null) {
        /* No goal to reach (a rule with no target and no bound on the safe side):
         * nothing can say whether it got there. Recorded, and NOT a pass. */
        judged = 0;
        fail = 0;
        failKind = '';
        reasons = [];
        passWhy = `Taken ${elapsed} minutes in, while still ${goingWord}, against a rule that sets no temperature to reach — so nothing could judge it. It is recorded, not passed.`;
      } else if (input.batchStart && elapsed === 0) {
        /* THE READING THAT STARTS THE BATCH, at minute 0. It is where the clock
         * begins, so it cannot be behind anything — even when the line is drawn
         * from the rule's stricter starting temperature (a pot off the heat at
         * 95 °C is measured from the rule's 60 °C, see fssaiCurveLineStart). */
        judged = 1;
        fail = 0;
        failKind = '';
        reasons = [];
        const capped = startV !== null && startV !== v;
        passWhy = `The first reading of this batch: ${v}${u} at 0 minutes. It has until ${limit} minutes to reach ${goal}${u}, and each reading in between is judged against where it should be by then${capped ? ` — on a straight line from ${startV}${u} at 0 minutes, the rule's starting temperature, which is stricter than this reading` : ''}.`;
      } else if (expected === null) {
        /* FAIL CLOSED. Short of the target, inside the window, and no line to
         * measure it against: neither a 0-minute reading on this batch nor a
         * starting temperature on the rule. Judged on its level, as a failure. */
        judged = 1;
        fail = 1;
        failKind = 'no_line';
        const hasDirection = dir === 'hot' ? 'below' : 'above';
        reasons = [
          `${v}${u} at ${elapsed} minutes is still ${hasDirection} the ${goal}${u} it has to reach, and this batch has no reading from when it started (0 minutes) and the rule sets no starting temperature — so there is no schedule to show it is on track, and a reading short of the target cannot be passed. Take the first reading of a batch as the food comes off the heat (0 minutes), or ask an administrator to set the rule's starting temperature.`,
        ];
      } else {
        /* A float tolerance, NOT rounding: 57.5 must not lose to 57.49999999 that
         * only exists because of the division. The displayed figure is rounded in
         * the SAFE direction so the sentence never contradicts the verdict. */
        const behind = dir === 'hot' ? v < expected - 1e-9 : v > expected + 1e-9;
        const shown = fssaiCurveExpectedShown(expected, dir);
        const anchored = input.curveStart?.source === 'standard_anchor';
        const capped = !anchored && firstV !== null && startV !== null && firstV !== startV;
        const fromWords = anchored
          ? `from the rule's starting temperature of ${startV}${u} at 0 minutes`
          : capped
            ? `from ${startV}${u} at 0 minutes — the rule's starting temperature, stricter than this batch's first reading of ${firstV}${u}`
            : `from ${startV}${u}`;
        const anchorNote = anchored ? ' This batch has no 0-minute reading of its own, so its line starts from the rule.' : '';
        if (behind) {
          fail = 1;
          failKind = 'behind';
          reasons = [
            `Behind schedule: ${elapsed} minutes in it should be ${sideWord} ${shown}${u} to reach ${goal}${u} within ${limit} minutes ${fromWords}, and it is at ${v}${u}.${anchorNote}`,
          ];
        } else {
          fail = 0;
          failKind = '';
          reasons = [];
          const isStart = !anchored && startV === v && startE === elapsed;
          passWhy = isStart
            ? `The first reading of this batch: ${v}${u} at ${elapsed} minutes. It has until ${limit} minutes to reach ${goal}${u}, and each reading in between is judged against where it should be by then.`
            : `Still ${goingWord} and on schedule: ${v}${u} at ${elapsed} minutes, where it needed to be ${sideWord} ${shown}${u} — on a straight line ${fromWords}. It has until ${limit} minutes to reach ${goal}${u}.${anchorNote}`;
        }
      }
    }
  }

  return {
    is_judged: judged,
    is_fail: fail,
    fail_reason: fail ? reasons.join(' ') : '',
    why: reasons.length && fail ? reasons.join(' ') : passWhy,
    fail_kind: fail ? (failKind || 'level') : '',
  };
}

/**
 * WHERE A CURVE SHOULD BE AT `elapsed` MINUTES — the one definition, used by the
 * verdict above, the curve view and the cooling sheet, so the three can never
 * disagree about the same reading.
 *
 * A straight line from the first reading (`startValue` at `startElapsed`) to the
 * `goal` at `maxMinutes`. At or past the end of the window the answer is the goal
 * itself. null when there is nothing to draw the line from.
 */
export function fssaiCurveExpected(p: {
  startValue: number | null;
  startElapsed: number | null;
  goal: number | null;
  maxMinutes: number | null;
  elapsed: number | null;
}): number | null {
  const goal = num(p.goal);
  const limit = num(p.maxMinutes);
  const e = num(p.elapsed);
  if (goal === null || limit === null || limit <= 0 || e === null) return null;
  if (e >= limit) return goal;
  const sv = num(p.startValue);
  const se = num(p.startElapsed) ?? 0;
  if (sv === null || se >= limit) return null;
  const at = Math.max(e, se);
  return sv + (goal - sv) * ((at - se) / (limit - se));
}

/** The schedule figure for a sentence, rounded to 0.1 in the SAFE direction. */
export function fssaiCurveExpectedShown(expected: number, dir: 'cold' | 'hot' | 'either'): string {
  const tenths = dir === 'hot' ? Math.ceil(expected * 10 - 1e-9) : Math.floor(expected * 10 + 1e-9);
  return (tenths / 10).toFixed(1);
}

/* ================================================================== *
 * 3b. ONE BATCH, ONE CURVE — linking the readings of a cooling or reheating
 * ================================================================== */

/**
 * Minutes on one clock for a business date and an HH:MM, so two readings on a
 * curve that crosses midnight still subtract correctly. null when either half is
 * not a real date or time.
 */
export function fssaiClockMinute(isoDate: unknown, hhmm: unknown): number | null {
  const d = str(isoDate);
  const t = str(hhmm);
  if (!isISODate(d) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return null;
  const [y, m, dd] = d.split('-').map(Number);
  const [hh, mi] = t.split(':').map(Number);
  return Math.round(Date.UTC(y, m - 1, dd, hh, mi) / 60000);
}

export interface FssaiCurveMember {
  id: string;
  key: string;
  business_date: string;
  reading_at: string;
  minute: number | null;
  value: number | null;
  elapsed: number | null;
  uom: string;
  goal: number | null;
  /** The time limit frozen on this reading (`max_minutes_used`). */
  max_minutes: number | null;
  is_fail: number;
  is_judged: number;
  status: string;
  /** The schedule line's start FROZEN on this reading (curve_start_*). null /
   *  '' on readings filed before 2026-10-14 and on readings with no line. */
  start_used: number | null;
  start_minute: number | null;
  start_source: FssaiCurveStartSource | '';
  /** The rule FROZEN on this reading — a batch is judged to the end on the
   *  numbers frozen on its first reading (2026-10-15: an admin lengthening the
   *  time limit half-way through a batch used to move the deadline under it). */
  standard_id: string;
  min_used: number | null;
  max_used: number | null;
  target_used: number | null;
  /** WHAT was read — a batch picked by id must be the same food (2026-10-15:
   *  one dish was judged on another dish's clock through a mis-pick). */
  equipment_id: string;
  equipment_label: string;
  material_id: string;
  item_label: string;
  area_label: string;
  outlet_id: string;
}

/** Where a schedule line was drawn from. fssai_temperature_logs.curve_start_source. */
export type FssaiCurveStartSource = 'first_reading' | 'standard_anchor';

/** Which side "reached" is on for a rate kind. */
export function fssaiTempDirection(logKind: string): 'cold' | 'hot' | 'either' {
  return FSSAI_TEMP_LOG_KINDS.find((k) => k.key === str(logKind))?.direction || 'either';
}

function memberGoal(row: any, dir: 'cold' | 'hot' | 'either'): number | null {
  const t = num(row?.target_used);
  if (t !== null) return t;
  return dir === 'hot' ? num(row?.min_used) : num(row?.max_used);
}

function shapeMember(row: any, dir: 'cold' | 'hot' | 'either'): FssaiCurveMember {
  return {
    id: String(row.id),
    key: String(row.batch_id || '') || String(row.id),
    business_date: String(row.business_date || ''),
    reading_at: String(row.reading_at || ''),
    minute: fssaiClockMinute(row.business_date, row.reading_at),
    value: num(row.value_num),
    elapsed: int(row.elapsed_minutes),
    uom: String(row.uom || 'C'),
    goal: memberGoal(row, dir),
    max_minutes: int(row.max_minutes_used),
    is_fail: Number(row.is_fail) ? 1 : 0,
    is_judged: Number(row.is_judged) ? 1 : 0,
    status: String(row.status || ''),
    start_used: num(row.curve_start_used),
    start_minute: int(row.curve_start_minute),
    start_source: row.curve_start_source === 'first_reading' || row.curve_start_source === 'standard_anchor'
      ? row.curve_start_source : '',
    standard_id: String(row.standard_id || ''),
    min_used: num(row.min_used),
    max_used: num(row.max_used),
    target_used: num(row.target_used),
    equipment_id: String(row.equipment_id || ''),
    equipment_label: String(row.equipment_label || ''),
    material_id: String(row.material_id || ''),
    item_label: String(row.item_label || ''),
    area_label: String(row.area_label || ''),
    outlet_id: String(row.outlet_id || ''),
  };
}

/* Clock order, then filing order — two readings in the same minute keep the
 * order they were entered in. A row with no usable time sorts last. */
function byClock(a: { m: FssaiCurveMember; rowid: number }, b: { m: FssaiCurveMember; rowid: number }): number {
  const am = a.m.minute ?? Number.MAX_SAFE_INTEGER;
  const bm = b.m.minute ?? Number.MAX_SAFE_INTEGER;
  if (am !== bm) return am - bm;
  return a.rowid - b.rowid;
}

/**
 * EVERY READING ON ONE CURVE, in the order they were taken.
 *
 * The curve's key lives in `batch_id`: the production batch when the kitchen
 * named one, otherwise the id of the curve's FIRST reading (written there by the
 * route when the curve starts). So membership is "batch_id is the key, or the row
 * IS the key" — the second half is what keeps the first reading on its own curve.
 * `includeVoid` is for the sheet, which shows struck-out readings; the verdict
 * path never measures from a voided one.
 */
export function fssaiCurveMembers(
  db: Database.Database,
  logKind: string,
  key: string,
  includeVoid = false,
): FssaiCurveMember[] {
  const k = str(key);
  if (!k) return [];
  const dir = fssaiTempDirection(logKind);
  const rows = db.prepare(
    `SELECT rowid AS rowid, id, batch_id, business_date, reading_at, value_num, elapsed_minutes, uom,
            target_used, min_used, max_used, max_minutes_used, is_fail, is_judged, status,
            curve_start_used, curve_start_minute, curve_start_source, standard_id,
            equipment_id, equipment_label, material_id, item_label, area_label, outlet_id
       FROM fssai_temperature_logs
      WHERE log_kind = ? AND (batch_id = ? OR id = ?)
        ${includeVoid ? '' : `AND status <> 'void'`}`,
  ).all(str(logKind), k, k) as any[];
  return rows
    .map((r) => ({ m: shapeMember(r, dir), rowid: Number(r.rowid) || 0 }))
    .sort(byClock)
    .map((x) => x.m);
}

/** Has any live reading on this curve reached its goal? */
export function fssaiCurveReached(members: FssaiCurveMember[], logKind: string): FssaiCurveMember | null {
  const dir = fssaiTempDirection(logKind);
  for (const m of members) {
    if (m.status === 'void' || m.value === null || m.goal === null) continue;
    if (dir === 'hot' ? m.value >= m.goal : m.value <= m.goal) return m;
  }
  return null;
}

export type FssaiCurveResolution =
  | {
      ok: true;
      /** '' = this reading starts the curve and its own id becomes the key. */
      key: string;
      mode: 'new' | 'joined';
      /** The first live reading, when joining. null when this reading is the start. */
      start: FssaiCurveMember | null;
      /** Minutes on the curve's clock at this reading — COUNTED, not typed. */
      elapsed: number;
      /** What the person typed, kept only to say so when it differed. */
      typed: number | null;
      how: string;
      /** The earliest live reading on the batch that already reached its target
       *  before this one — null when none has. The verdict then judges "still
       *  there" or "gone back past it", never the schedule line. */
      reached: FssaiCurveMember | null;
    }
  | { ok: false; status: number; error: string; code: string };

/**
 * How far minutes TYPED on a reading may run ahead of an open batch's counted
 * clock and still be that batch. A pot the cook says has been cooling 200
 * minutes is not the pot that came off the heat 10 minutes ago (2026-10-15: the
 * default "match" option threw the 200 away and judged the reading on the
 * newer pot's 10-minute clock — the lenient figure won).
 */
export const FSSAI_CURVE_TYPED_TOLERANCE_MINUTES = 10;

type FssaiCurveSubject = { equipmentId: string; materialId: string; itemLabel: string; areaLabel: string; outletId: string };

/**
 * IS THIS READING ABOUT THE SAME THING AS THE BATCH IT NAMES? '' when it is;
 * otherwise 'outlet' | 'food' | 'place'.
 *
 * A batch is ONE FOOD: when its first reading names an item or a material, a
 * reading put on it must name the same one (or none — the route then takes the
 * batch's). The PLACE may change, because a pot is moved from the stove to the
 * blast chiller half-way down. A batch that names no food is a PLACE or a UNIT,
 * and then the place must match. 2026-10-15: a curve picked by id was never
 * checked, and "Chicken curry" at Banquet was judged on "Dal"'s clock.
 */
export function fssaiCurveSubjectMismatch(first: FssaiCurveMember, s: FssaiCurveSubject): '' | 'outlet' | 'food' | 'place' {
  const norm = (v: unknown) => str(v).toLowerCase();
  if (first.outlet_id && str(s.outletId) && first.outlet_id !== str(s.outletId)) return 'outlet';
  const batchItem = norm(first.item_label);
  const batchMat = str(first.material_id);
  const item = norm(s.itemLabel);
  const mat = str(s.materialId);
  if (batchItem || batchMat) {
    if (!item && !mat) return '';
    let compared = false;
    if (batchMat && mat) { if (batchMat !== mat) return 'food'; compared = true; }
    if (batchItem && item) { if (batchItem !== item) return 'food'; compared = true; }
    return compared ? '' : 'food';
  }
  if (str(first.equipment_id) !== str(s.equipmentId)) return 'place';
  if (norm(first.area_label) !== norm(s.areaLabel)) return 'place';
  return '';
}

/**
 * WHICH CURVE IS THIS READING ON, AND HOW MANY MINUTES INTO IT — counted by the
 * server from the curve's first reading, never typed per reading.
 *
 * In order:
 *   1. `curveId` — any reading already on the curve. The kitchen said which batch.
 *      It must be the same food (fssaiCurveSubjectMismatch).
 *   2. `batchId` — a batch already on file (same food check), or a kitchen
 *      production batch (production_batches id or barcode) that has no reading
 *      yet. Anything else is refused: an unknown id used to start a fresh batch
 *      that passed at minute 0.
 *   3. `newCurve`, or minutes typed as 0 — "this has just started".
 *   4. Otherwise the batches of the same thing (same unit, item, place, outlet)
 *      from this date and the day before, sorted into:
 *        OPEN    — not at its target, within twice its window, nothing filed after
 *                  this reading's time. One → joined. Several → the one whose clock
 *                  matches the minutes typed; with no minutes typed, REFUSED
 *                  (`ambiguous_batch`) — the server does not guess which pot.
 *                  A batch whose clock is shorter than the minutes typed (beyond
 *                  FSSAI_CURVE_TYPED_TOLERANCE_MINUTES) is not this pot.
 *        STALE   — not at its target and past twice its window, with no newer
 *                  batch of the same thing since. REFUSED (`stale_batch_open`):
 *                  the cook picks it (judged late on its own clock) or says
 *                  "a new batch". 2026-10-15: such a reading silently started a
 *                  new batch at minute 0 and passed.
 *        REACHED — already at its target, within twice its window. A reading
 *                  still at the target joins it; one back past the target that is
 *                  not a fresh start (at or beyond the rule's starting
 *                  temperature) is REFUSED (`after_target`) — same pot warming up
 *                  again (pick it: filed as a failure) or a new pot (say so).
 *   5. Nothing of the same thing: this reading starts a curve.
 *
 * THE CLOCK. A curve's first reading sits at minute 0 — or at the minutes typed on
 * it, which can only move the start EARLIER (a cook saying "it has been cooling
 * 30 minutes already"), so the deadline can only get stricter. Every later
 * reading is that plus the time between the two readings. A minutes figure typed
 * on a later reading is not used for the clock; the response says when it
 * differed.
 *
 * REFUSED: a reading timed before its curve's first reading, or in the middle of
 * readings already filed — the verdicts already frozen on that curve were judged
 * from its start, and slipping an earlier reading in would change what they were
 * measured against.
 */
export function resolveFssaiCurve(
  db: Database.Database,
  p: {
    logKind: string;
    curveId?: string | null;
    batchId?: string | null;
    newCurve?: boolean;
    typedElapsed: number | null;
    businessDate: string;
    readingAt: string;
    uom: string;
    maxMinutes: number | null;
    subject: FssaiCurveSubject;
    /** The number about to be filed (null in the form's preview before it is
     *  typed) — decides whether a reading after a batch reached its target is
     *  still there, gone back, or a fresh start. */
    value?: number | null;
    /** The rule's starting temperature (FssaiResolvedRange.start_value). */
    anchor?: number | null;
  },
): FssaiCurveResolution {
  const logKind = str(p.logKind);
  const dir = fssaiTempDirection(logKind);
  const going = dir === 'hot' ? 'heating' : 'cooling';
  const typed = p.typedElapsed === null || p.typedElapsed === undefined ? null : Number(p.typedElapsed);
  const now = fssaiClockMinute(p.businessDate, p.readingAt);
  if (now === null) {
    return { ok: false, status: 400, code: 'bad_time', error: 'The time of the reading is needed to place it on its cooling or reheating curve.' };
  }
  const value = num(p.value);
  const anchor = num(p.anchor);
  const s = p.subject;
  const norm = (v: unknown) => str(v).toLowerCase();
  const batchWords = (m: FssaiCurveMember) => [m.item_label, m.equipment_label || m.area_label].filter(Boolean).join(' · ') || 'an unnamed batch';
  const readingWords = [str(s.itemLabel), str(s.areaLabel)].filter(Boolean).join(' · ') || 'this reading';
  const deg = (u: string) => (u === 'C' || u === 'F' ? ` °${u}` : ` ${u}`);

  const start = (note = '', key?: string): FssaiCurveResolution => ({
    ok: true, key: key ?? str(p.batchId), mode: 'new', start: null, reached: null,
    elapsed: typed !== null && typed > 0 ? Math.trunc(typed) : 0, typed,
    how: (typed !== null && typed > 0
      ? `This starts a new batch, ${Math.trunc(typed)} minutes after it began — the time you gave. Later readings on it are counted from here.`
      : 'This starts a new batch. Later readings on it are timed from this one.')
      + (note ? ` ${note}` : ''),
  });

  /* A BATCH THAT CROSSES MIDNIGHT. The clock is the reading's DATE plus its
   * time, so a reading taken at 00:30 has to carry the new day's date. One
   * entered under the old date lands 23 hours BEFORE a batch that began at
   * 23:30 — and silently starting a fresh batch from it would file a pass at
   * "minute 0" for a pot that has been cooling for an hour. It is refused with
   * the date it most likely needs. */
  const midnightHint = (first: FssaiCurveMember): string => {
    if (first.minute === null) return '';
    const gap = (first.minute as number) - (now as number);
    if (gap <= 0 || gap >= 24 * 60 || first.business_date !== p.businessDate) return '';
    const next = addDaysISO(p.businessDate, 1);
    return next ? ` If it was taken after midnight, date it ${next} — a batch that runs past midnight keeps counting on the next day's date.` : '';
  };

  const counted = (first: FssaiCurveMember): number => (first.elapsed ?? 0) + ((now as number) - (first.minute as number));

  const join = (members: FssaiCurveMember[], key: string, said: string, explicit: boolean): FssaiCurveResolution => {
    const first = members[0];
    if (first.minute === null) {
      return { ok: false, status: 409, code: 'curve_unreadable', error: 'The first reading on that batch has no usable time, so minutes cannot be counted from it. Start a new batch.' };
    }
    if (now < first.minute) {
      return {
        ok: false, status: 409, code: 'before_curve_start',
        error: `This reading is timed ${p.readingAt} on ${p.businessDate}, before the batch's first reading at ${first.reading_at} on ${first.business_date}. Readings go onto a batch in the order they were taken.${midnightHint(first)}`,
      };
    }
    const later = members.find((m) => m.minute !== null && (m.minute as number) > now);
    if (later) {
      return {
        ok: false, status: 409, code: 'out_of_order',
        error: `A reading at ${later.reading_at} on ${later.business_date} is already filed on this batch, after the time given for this one (${p.readingAt}). The readings after it were judged from the batch's start, so an earlier one cannot be slipped in. If this is a different pot, start a new batch.`,
      };
    }
    if (first.uom !== p.uom) {
      return { ok: false, status: 400, code: 'uom_mismatch', error: `This batch was started in °${first.uom}. Enter the reading in °${first.uom}.`, };
    }
    if (explicit) {
      const mm = fssaiCurveSubjectMismatch(first, s);
      if (mm) {
        return {
          ok: false, status: 409, code: 'curve_subject_mismatch',
          error: mm === 'outlet'
            ? 'That batch belongs to another outlet. Pick a batch from this outlet, or start a new batch.'
            : mm === 'food'
              ? `That batch is ${batchWords(first)}, and this reading is for ${readingWords}. A reading can only go onto the batch of the same food — one dish cannot be judged on another dish's clock. Pick the batch of ${readingWords}, or start a new batch.`
              : `That batch is ${batchWords(first)}, and this reading is for ${readingWords}. Pick the batch of the same place or unit, or start a new batch.`,
        };
      }
    }
    const elapsed = counted(first);
    const reached = fssaiCurveReached(members, logKind);
    const moved = explicit && (norm(first.area_label) !== norm(s.areaLabel) || str(first.equipment_id) !== str(s.equipmentId))
      && (first.item_label || first.material_id);
    return {
      ok: true, key, mode: 'joined', start: first, elapsed, typed, reached,
      how: `${said} — the batch started at ${first.reading_at}${first.business_date !== p.businessDate ? ` on ${first.business_date}` : ''} at ${first.value ?? '?'} °${first.uom}. ${elapsed} minutes in, counted from that reading.`
        + (typed !== null && typed !== elapsed ? ` You entered ${typed} minutes; the counted ${elapsed} is what is recorded.` : '')
        + (moved ? ` It was at ${first.equipment_label || first.area_label || 'another place'} then; it is recorded here at ${readingWords}.` : '')
        + (reached ? ` It already reached its target at ${reached.elapsed ?? '?'} minutes (${reached.reading_at}), so this reading is judged on whether it is still there.` : ''),
    };
  };

  /* 1. Named by a reading on the curve. */
  const curveId = str(p.curveId);
  if (curveId) {
    const row = db.prepare(`SELECT id, batch_id, log_kind FROM fssai_temperature_logs WHERE id = ?`).get(curveId) as any;
    if (!row) return { ok: false, status: 400, code: 'curve_unknown', error: 'That batch is not in the file.' };
    if (String(row.log_kind) !== logKind) {
      return { ok: false, status: 400, code: 'curve_kind', error: `That batch is a ${String(row.log_kind)} curve, not ${logKind}.` };
    }
    const key = String(row.batch_id || '') || String(row.id);
    const members = fssaiCurveMembers(db, logKind, key);
    if (!members.length) {
      return { ok: false, status: 409, code: 'curve_voided', error: 'Every reading on that batch has been voided. Start a new batch.' };
    }
    return join(members, key, 'Added to the batch you picked', true);
  }

  /* 2. A batch named by its id: one already on file, or a kitchen production
   *    batch that has no reading yet. Nothing else — an id nobody can trace
   *    would start a batch that passes at minute 0 (2026-10-15). */
  const batchId = str(p.batchId);
  if (batchId) {
    const members = fssaiCurveMembers(db, logKind, batchId);
    if (members.length) return join(members, batchId, 'Added to this batch', true);
    let prod: any = null;
    try {
      prod = db.prepare(`SELECT id, material_id, item_name FROM production_batches WHERE id = ? OR barcode = ? LIMIT 1`).get(batchId, batchId);
    } catch { prod = null; }
    if (!prod) {
      return {
        ok: false, status: 400, code: 'batch_unknown',
        error: `"${batchId}" is not a batch on file — neither a ${logKind} batch nor a kitchen production batch. Pick the batch from the list, or start a new batch.`,
      };
    }
    /* Keyed on the production batch's own id, so a reading given its barcode and
     * one given its id land on the same curve — and the SECOND reading given the
     * other spelling joins that curve rather than starting it again at minute 0. */
    const prodKey = String(prod.id);
    if (prodKey !== batchId) {
      const already = fssaiCurveMembers(db, logKind, prodKey);
      if (already.length) return join(already, prodKey, 'Added to this production batch', true);
    }
    if (str(prod.material_id) && str(s.materialId) && str(prod.material_id) !== str(s.materialId)) {
      return {
        ok: false, status: 409, code: 'curve_subject_mismatch',
        error: `Production batch "${batchId}" is ${str(prod.item_name) || 'another item'}, not the item this reading names. Pick the right batch, or start a new one.`,
      };
    }
    return start(`It is kitchen production batch ${str(prod.item_name) ? `"${str(prod.item_name)}"` : batchId}.`, prodKey);
  }

  /* 3. Said to be a new one. */
  if (p.newCurve || typed === 0) return start();

  /* 4. The batches of the same thing. */
  const pLimit = num(p.maxMinutes);
  const defaultHorizon = pLimit !== null && pLimit > 0 ? pLimit * 2 : 24 * 60;
  const lookbackDays = Math.max(1, Math.ceil(defaultHorizon / (24 * 60)));
  const rows = db.prepare(
    `SELECT id, batch_id, item_label, area_label
       FROM fssai_temperature_logs
      WHERE log_kind = ? AND status <> 'void'
        AND equipment_id = ? AND material_id = ? AND outlet_id = ?
        AND business_date >= ? AND business_date <= ?`,
  ).all(
    logKind, str(s.equipmentId), str(s.materialId), str(s.outletId),
    addDaysISO(p.businessDate, -lookbackDays) || p.businessDate, p.businessDate,
  ) as any[];
  const keys = new Set<string>();
  for (const r of rows) {
    if (norm(r.item_label) !== norm(s.itemLabel) || norm(r.area_label) !== norm(s.areaLabel)) continue;
    keys.add(String(r.batch_id || '') || String(r.id));
  }
  type Cand = { key: string; members: FssaiCurveMember[]; first: FssaiCurveMember; counted: number; limit: number | null; reached: FssaiCurveMember | null };
  const all: Cand[] = [];
  const open: Cand[] = [];
  const stale: Cand[] = [];
  const reachedRecent: Cand[] = [];
  const blocked: Cand[] = [];
  let startsLater: FssaiCurveMember | null = null;
  for (const key of keys) {
    const members = fssaiCurveMembers(db, logKind, key);
    if (!members.length) continue;
    const first = members[0];
    if (first.minute === null) continue;
    if (first.minute > now) {
      /* An open batch of the same thing that began AFTER this reading's time,
       * on the same date and within a day: almost always a post-midnight
       * reading entered under the old date (see midnightHint). */
      if (!fssaiCurveReached(members, logKind) && midnightHint(first)) startsLater = first;
      continue;
    }
    const limit = first.max_minutes ?? pLimit;
    const horizon = limit !== null && limit > 0 ? limit * 2 : 24 * 60;
    const c: Cand = {
      key, members, first, counted: counted(first), limit,
      reached: fssaiCurveReached(members.filter((m) => m.minute !== null && (m.minute as number) <= now), logKind),
    };
    all.push(c);
    const isBlocked = members.some((m) => m.minute !== null && (m.minute as number) > now);
    if (isBlocked) { if (!c.reached && c.counted <= horizon) blocked.push(c); continue; }
    if (c.reached) { if (c.counted <= horizon) reachedRecent.push(c); continue; }
    if (c.counted <= horizon) open.push(c); else stale.push(c);
  }
  const fits = (c: Cand) => typed === null || typed <= c.counted + FSSAI_CURVE_TYPED_TOLERANCE_MINUTES;
  const startedWords = (c: Cand) => `${c.first.reading_at}${c.first.business_date !== p.businessDate ? ` on ${c.first.business_date}` : ''} at ${c.first.value ?? '?'}${deg(c.first.uom)}`;

  /* OPEN */
  const openFit = open.filter(fits);
  if (openFit.length === 1) return join(openFit[0].members, openFit[0].key, 'Added to the open batch of the same thing', false);
  if (openFit.length > 1) {
    if (typed !== null) {
      /* The batch whose clock is closest to the minutes typed; a tie goes to the
       * OLDER batch, whose longer clock is the stricter one. */
      const best = [...openFit].sort((a, b) => (Math.abs(a.counted - typed) - Math.abs(b.counted - typed)) || (b.counted - a.counted))[0];
      return join(best.members, best.key, `Added to the open batch of the same thing whose clock is closest to the ${typed} minutes you gave`, false);
    }
    const list = [...openFit].sort((a, b) => (a.first.minute as number) - (b.first.minute as number)).map(startedWords).join('; ');
    return {
      ok: false, status: 409, code: 'ambiguous_batch',
      error: `${openFit.length} batches of ${batchWords(openFit[0].first)} are still ${going} (started ${list}). Pick the batch this reading belongs to, or enter how many minutes this pot has been ${going}.`,
    };
  }
  if (blocked.length) {
    const f = blocked[0].first;
    const later = blocked[0].members[blocked[0].members.length - 1];
    return {
      ok: false, status: 409, code: 'out_of_order',
      error: `The open batch of this started at ${f.reading_at} and already has a reading at ${later.reading_at}, after the time given for this one (${p.readingAt}). Readings go onto a batch in the order they were taken. If this is a different pot, enter 0 minutes to start a new batch.`,
    };
  }

  /* STALE — the newest one that no later batch of the same thing has replaced. */
  const staleFit = stale
    .filter(fits)
    .filter((c) => !all.some((o) => o.key !== c.key && (o.first.minute as number) > (c.first.minute as number)))
    .sort((a, b) => (b.first.minute as number) - (a.first.minute as number));
  if (staleFit.length) {
    const st = staleFit[0];
    const goal = st.first.goal;
    return {
      ok: false, status: 409, code: 'stale_batch_open',
      error: `A batch of ${batchWords(st.first)} started at ${startedWords(st)}, ${st.counted} minutes ago, and no reading on it has reached ${goal ?? 'its target'}${goal !== null ? deg(st.first.uom) : ''} — its ${st.limit ?? '?'} minutes ran out long ago. If this reading is from that pot, pick that batch: it is judged on its own clock, as late. If it is a different pot, choose "A new batch".`,
    };
  }

  /* REACHED — the newest batch of the same thing that already got there. */
  const reachedFit = reachedRecent.filter(fits).sort((a, b) => (b.first.minute as number) - (a.first.minute as number));
  let note = '';
  if (reachedFit.length) {
    const R = reachedFit[0];
    const reachedM = R.reached as FssaiCurveMember;
    const goal = reachedM.goal;
    if (value !== null && goal !== null) {
      const atTarget = dir === 'hot' ? value >= goal : value <= goal;
      if (atTarget) return join(R.members, R.key, 'Added to the batch of the same thing, which has already reached its target', false);
      /* Back past the target. A FRESH pot starts at or beyond the rule's
       * starting temperature (or the last batch's own start when the rule has
       * none); anything between that and the target is either the same pot
       * going back, or a new pot whose first reading was taken late. The server
       * does not guess either way. */
      const ref = anchor ?? R.first.value;
      const fresh = ref !== null && (dir === 'hot' ? value <= ref : value >= ref);
      if (!fresh) {
        return {
          ok: false, status: 409, code: 'after_target',
          error: `The batch of ${batchWords(R.first)} that started at ${startedWords(R)} reached ${goal}${deg(reachedM.uom)} at ${reachedM.reading_at}. This reading of ${value}${deg(p.uom)} is back ${dir === 'hot' ? 'below' : 'above'} that. If it is the same pot ${dir === 'hot' ? 'cooling down again' : 'warming up again'}, pick that batch — it is filed as a failure. If it is a new pot, choose "A new batch" (and give its minutes if it has already been ${going} a while).`,
        };
      }
    } else if (goal !== null) {
      note = `A batch of this reached its target at ${reachedM.reading_at}: a reading ${dir === 'hot' ? 'at or above' : 'at or below'} ${goal}${deg(reachedM.uom)} joins it, and one back past it is asked about before it is filed.`;
    }
  }
  if (startsLater) {
    return {
      ok: false, status: 409, code: 'before_curve_start',
      error: `An open batch of the same thing started at ${startsLater.reading_at} on ${startsLater.business_date}, after the time given for this reading (${p.readingAt} on ${p.businessDate}).${midnightHint(startsLater)} If this really is a different pot, start a new batch.`,
    };
  }
  if (typed !== null && open.length) {
    const newest = [...open].sort((a, b) => a.counted - b.counted)[0];
    note = `${note ? `${note} ` : ''}No open batch of this has been ${going} that long (the newest is ${newest.counted} minutes in), so it is not added to one.`;
  }
  return start(note);
}

/* ================================================================== *
 * 3c. WHERE THE SCHEDULE LINE STARTS — and the frozen copy of it
 * ================================================================== */

export interface FssaiCurveStart {
  value: number;
  /** The minute on the batch clock the start sits at. Always 0: a line starts
   *  where the batch started, never part-way. */
  minute: number;
  source: FssaiCurveStartSource;
}

/**
 * THE ONE RULE FOR WHERE A BATCH'S SCHEDULE LINE STARTS, used by the write path
 * (and frozen onto the reading as curve_start_*), the form's preview and the
 * curve view, so the three cannot disagree.
 *
 *   1. The batch's own 0-minute reading — its first live reading, when that was
 *      taken at minute 0 ('first_reading'). When this reading STARTS the batch at
 *      minute 0, it is that reading.
 *   2. Otherwise the batch has no 0-minute reading, and the line is drawn from
 *      the rule's starting temperature at minute 0 ('standard_anchor'). A batch
 *      that already froze an anchor on its first reading keeps THAT anchor, so an
 *      administrator changing the rule half-way through a batch does not move the
 *      line under the readings still to come.
 *   3. Neither: null. The verdict then fails a reading short of the target
 *      (judgeFssaiReading) — never passes it.
 *
 * WHY NOT THE FIRST READING WHEN IT WAS TAKEN PART-WAY. That is the measured
 * fail-open: a line drawn from a reading cannot put that reading behind it, so
 * "65 °C at 239 of 240 minutes" was its own start and passed. Minutes typed on a
 * batch's first reading say the food had ALREADY been cooling that long; the
 * line has to begin where it began, and only the rule knows a safe figure for
 * that.
 *
 * THE STRICTER OF THE TWO AT MINUTE 0 (2026-10-15). A batch with its own
 * 0-minute reading starts its line from that reading OR the rule's starting
 * temperature, whichever is stricter — the lower for cooling, the higher for
 * reheating. Measured: a pot off the heat at 95 °C drew its line from 95, so
 * 48 °C at 120 minutes passed (needed ≤ 50), while the same 48 °C on a batch
 * measured from the rule's 60 °C failed (needed ≤ 32.5). A hotter start must
 * not buy leeway the rule does not give. The source stays 'first_reading' (the
 * batch HAS its 0-minute reading); `curve_start_used` then holds the rule's
 * figure, and the verdict's sentence says so. The reading that starts the batch
 * is never itself "behind" (judgeFssaiReading `batchStart`).
 *
 * ONE LINE PER BATCH. The line is decided on the batch's FIRST reading and
 * frozen there; every later reading copies it (`first.start_*`), so an
 * administrator editing the rule's starting temperature half-way through a batch
 * cannot move it. Readings filed before the line was frozen keep the old rule
 * (their first reading's own value), which is what their verdicts used.
 */
export function fssaiCurveLineStart(p: {
  /** The batch's first LIVE reading; null when this reading starts the batch. */
  first: FssaiCurveMember | null;
  /** This reading: its value and the minutes counted for it. */
  self: { value: number | null; elapsed: number | null };
  /** The rule's `start_value` (FssaiResolvedRange.start_value). */
  anchor: number | null;
  /** The rule's direction: which side of the first reading and the anchor is
   *  the stricter start. Omitted = no comparison (the first reading as it is). */
  direction?: 'cold' | 'hot' | 'either';
}): FssaiCurveStart | null {
  const a = num(p.anchor);
  const stricter = (v: number): number => {
    if (a === null) return v;
    if (p.direction === 'cold') return Math.min(v, a);
    if (p.direction === 'hot') return Math.max(v, a);
    return v;
  };
  if (!p.first) {
    const e = num(p.self.elapsed) ?? 0;
    const v = num(p.self.value);
    if (e === 0 && v !== null) return { value: stricter(v), minute: 0, source: 'first_reading' };
  } else {
    /* The batch's line, as frozen on its first reading. */
    if (p.first.start_source && p.first.start_used !== null) {
      return { value: p.first.start_used, minute: p.first.start_minute ?? 0, source: p.first.start_source };
    }
    /* Filed before the line was frozen: what its verdicts were measured from. */
    const fe = p.first.elapsed ?? 0;
    if (fe === 0 && p.first.value !== null) return { value: p.first.value, minute: 0, source: 'first_reading' };
  }
  return a === null ? null : { value: a, minute: 0, source: 'standard_anchor' };
}

/**
 * "NEEDED BY THEN" FOR ONE FILED READING — read from that reading's own frozen
 * columns: its curve_start_* (where the line started), target / bound used, the
 * time limit used and its minutes. A pure function of the row, so a sheet
 * printed next year draws the same line the verdict used today.
 *
 * Readings filed before the start was frozen (curve_start_source '') fall back
 * to `legacyStart` — the batch's first live reading, which is what those
 * verdicts were measured from. null when there is no line (or the row is not a
 * cooling or reheating reading).
 */
export function fssaiReadingScheduleValue(
  row: any,
  legacyStart?: { value: number | null; elapsed: number | null } | null,
): number | null {
  const logKind = str(row?.log_kind);
  if (!FSSAI_TEMP_LOG_KINDS.find((k) => k.key === logKind)?.window_minutes) return null;
  const dir = fssaiTempDirection(logKind);
  const goal = num(row?.target_used) ?? (dir === 'hot' ? num(row?.min_used) : num(row?.max_used));
  const frozenSource = str(row?.curve_start_source);
  /* The reading that STARTS its batch at minute 0 is where the clock begins:
   * nothing is "needed" of it. (Its line may start from the rule's stricter
   * figure — 60 °C beside a 95 °C start — and printing that beside an
   * "On schedule" start would read as a contradiction.) */
  if (frozenSource === 'first_reading' && int(row?.elapsed_minutes) === 0) return null;
  const startValue = frozenSource ? num(row?.curve_start_used) : (legacyStart ? num(legacyStart.value) : null);
  const startElapsed = frozenSource ? (int(row?.curve_start_minute) ?? 0) : (legacyStart ? (num(legacyStart.elapsed) ?? 0) : null);
  return fssaiCurveExpected({
    startValue, startElapsed, goal,
    maxMinutes: int(row?.max_minutes_used), elapsed: int(row?.elapsed_minutes),
  });
}

/* ================================================================== *
 * 3d. THE VERDICT IN WORDS, FOR ANY SCREEN OR PRINTOUT
 * ================================================================== */

/**
 * The verdict word for one temperature reading, from its FROZEN columns only
 * (is_fail, is_judged, value_num, target/min/max_used, log_kind). Nothing is
 * re-judged.
 *
 *   'Not judged'  — is_judged = 0. Not a pass.
 *   'FAIL'        — is_fail = 1.
 *   'On schedule' — a cooling or reheating reading that passed while still short
 *                   of its target: 30 °C an hour into cooling is not "in range"
 *                   of a 5 °C rule, it is where the schedule allowed it to be.
 *   'In range'    — everything else that passed.
 *
 * ⚠️ FOR THE AUDIT FILE (and Inspection Mode): its PDF printed "70.0 C | at most
 * 5 C | In range" for a pot still on its way down. Call this instead of a local
 * is_fail test so the PDF, the Reports screen and the temperature page say the
 * same word for the same row.
 */
export function fssaiTempVerdictWord(r: any): 'Not judged' | 'FAIL' | 'On schedule' | 'In range' {
  const judged = r?.is_judged === null || r?.is_judged === undefined ? 1 : Number(r.is_judged);
  if (!judged) return 'Not judged';
  if (Number(r?.is_fail) === 1) return 'FAIL';
  const logKind = str(r?.log_kind);
  if (!FSSAI_TEMP_LOG_KINDS.find((k) => k.key === logKind)?.window_minutes) return 'In range';
  const v = num(r?.value_num);
  const dir = fssaiTempDirection(logKind);
  const goal = num(r?.target_used) ?? (dir === 'hot' ? num(r?.min_used) : num(r?.max_used));
  if (v === null || goal === null) return 'In range';
  return (dir === 'hot' ? v < goal : v > goal) ? 'On schedule' : 'In range';
}

/**
 * "60 of 240" — the minutes counted on a cooling or reheating batch's clock, and
 * the time allowed. A reading AT minute 0 prints "0 of 240" (the audit-file PDF
 * printed a blank for it, because 0 is falsy). '' only when nothing was counted.
 */
export function fssaiTempMinutesWords(r: any): string {
  const e = int(r?.elapsed_minutes);
  if (e === null) return '';
  const m = int(r?.max_minutes_used);
  return m !== null ? `${e} of ${m}` : String(e);
}

/* ================================================================== *
 * 3d-bis. A NUMBER NOBODY COULD HAVE READ — refused before it is judged
 * ================================================================== */

/**
 * THE WIDEST RANGE, IN °C, A READING OF EACH KIND CAN PHYSICALLY BE.
 *
 * NOT A SAFETY RULE — nothing here passes or fails food. It is a typing guard:
 * measured 2026-10-15, a cooling reading typed as −45 (a minus sign for 45)
 * counted as "reached 5 °C", closed its batch as reached in time and stopped the
 * overdue escalation; a reheating reading of 750 °C passed. A number outside
 * these bounds is refused with the bounds in words, so the cook re-enters it;
 * nothing is filed. Deliberately wide (a blast freezer's air, a fryer's oil, a
 * calibration in boiling water all fit) so a real reading is never lost.
 * ASSUMPTION, REVERSIBLE: one table.
 */
export const FSSAI_TEMP_PLAUSIBLE_C: Readonly<Record<string, { min: number; max: number }>> = {
  equipment: { min: -60, max: 150 },
  food: { min: -50, max: 200 },
  delivery: { min: -50, max: 100 },
  hot_holding: { min: -30, max: 150 },
  cooking: { min: -40, max: 250 },
  /* Cooked food on its way down: a core below −20 °C is not cooling, and the
   * minus-sign typo the guard exists for lands here. */
  cooling: { min: -20, max: 130 },
  reheating: { min: -30, max: 150 },
  thawing: { min: -50, max: 60 },
  probe_calibration: { min: -30, max: 130 },
};
const FSSAI_TEMP_PLAUSIBLE_DEFAULT_C = { min: -60, max: 300 };

/** null when the value could be a real reading of this kind; otherwise the
 *  bounds, in the reading's own unit, for the refusal. */
export function fssaiTempImplausible(
  logKind: string,
  value: number | null,
  uom: string,
): { min: number; max: number; uom: string } | null {
  const v = num(value);
  if (v === null) return null;
  const b = FSSAI_TEMP_PLAUSIBLE_C[str(logKind)] || FSSAI_TEMP_PLAUSIBLE_DEFAULT_C;
  const u = str(uom).toUpperCase() === 'F' ? 'F' : 'C';
  const min = u === 'F' ? Math.round(b.min * 9 / 5 + 32) : b.min;
  const max = u === 'F' ? Math.round(b.max * 9 / 5 + 32) : b.max;
  return v < min || v > max ? { min, max, uom: u } : null;
}

/* ================================================================== *
 * 3e. ONE BATCH, SUMMED UP — and the batches still open
 * ================================================================== */

/** The current IST time on the same clock as a reading (fssaiClockMinute). */
export function fssaiNowMinuteIST(now: Date = new Date()): number | null {
  const hhmm = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  return fssaiClockMinute(fssaiToday(now), hhmm);
}

export type FssaiCurveOutcome = 'breach' | 'reached_in_time' | 'reached_late' | 'overdue' | 'in_progress';

export const FSSAI_CURVE_OUTCOME_WORDS: Record<FssaiCurveOutcome, string> = {
  reached_in_time: 'Reached the target within the time allowed',
  reached_late: 'Reached the target, but after the time allowed',
  breach: 'A reading on this batch was a breach',
  overdue: 'Past the time allowed with no reading at the target',
  in_progress: 'Still in progress',
};

export interface FssaiCurveSummary {
  id: string;
  log_kind: string;
  log_kind_label: string;
  direction: 'cold' | 'hot' | 'either';
  goal: number | null;
  max_minutes: number | null;
  start: { id: string; business_date: string; reading_at: string; value_num: number | null; elapsed_minutes: number | null } | null;
  /** Where the batch's schedule line starts (0-minute reading, or the rule's
   *  anchor as frozen on the batch), or null when it has neither. */
  line_start: { value: number; minute: number; source: FssaiCurveStartSource } | null;
  last: { id: string; business_date: string; reading_at: string; value_num: number | null; elapsed_minutes: number | null } | null;
  reached: { id: string; reading_at: string; value_num: number | null; elapsed_minutes: number | null } | null;
  /** Minutes on the batch's clock now; null once it reached the target. */
  elapsed_now: number | null;
  /** Where the batch should be now on its line (null when there is no line). */
  needed_now: number | null;
  has_breach: boolean;
  outcome: FssaiCurveOutcome;
  outcome_label: string;
}

/**
 * ONE BATCH'S CURVE, as the sheet and the screen read it. Every verdict is the
 * FROZEN one; `schedule(member)` is "needed by then" for a reading, read from
 * that reading's frozen line (fssaiReadingScheduleValue) — shown beside it and
 * never used to change its verdict.
 *
 * `anchor` is the CURRENT rule's start_value, used only to say where the line
 * stands now for a batch with no 0-minute reading that never froze an anchor
 * (readings from before 2026-10-14).
 */
export function fssaiCurveSummary(
  db: Database.Database,
  logKind: string,
  key: string,
  nowMinute: number | null,
): { summary: FssaiCurveSummary; members: FssaiCurveMember[]; schedule: (m: FssaiCurveMember) => number | null } {
  const all = fssaiCurveMembers(db, logKind, key, true);
  const live = all.filter((m) => m.status !== 'void');
  const dir = fssaiTempDirection(logKind);
  const start = live[0] || null;
  const limit = start ? start.max_minutes : null;
  const goal = start ? start.goal : null;
  const reached = fssaiCurveReached(live, logKind);
  const last = live[live.length - 1] || null;
  const elapsedNow = start && start.minute !== null && nowMinute !== null
    ? (start.elapsed ?? 0) + (nowMinute - start.minute) : null;
  const breach = live.some((m) => m.is_fail === 1);
  /* A breach anywhere on the batch outranks how it ended: a pot that fell behind
   * and then caught up still had a breach, and the sheet must say so first. */
  const outcome: FssaiCurveOutcome = breach ? 'breach'
    : reached
      ? (limit !== null && reached.elapsed !== null && reached.elapsed > limit ? 'reached_late' : 'reached_in_time')
      : (limit !== null && elapsedNow !== null && elapsedNow > limit ? 'overdue' : 'in_progress');
  /* The batch's line: from its newest live reading's frozen start when it has
   * one, else the same rule the write path uses on the first reading. */
  const frozen = [...live].reverse().find((m) => m.start_source && m.start_used !== null) || null;
  const lineStart = frozen
    ? { value: frozen.start_used as number, minute: frozen.start_minute ?? 0, source: frozen.start_source as FssaiCurveStartSource }
    : (start && (start.elapsed ?? 0) === 0 && start.value !== null
      ? { value: start.value, minute: 0, source: 'first_reading' as const }
      : null);
  const lineFor = (elapsed: number | null): number | null => {
    if (lineStart) {
      return fssaiCurveExpected({ startValue: lineStart.value, startElapsed: lineStart.minute, goal, maxMinutes: limit, elapsed });
    }
    return start ? fssaiCurveExpected({ startValue: start.value, startElapsed: start.elapsed, goal, maxMinutes: limit, elapsed }) : null;
  };
  const neededNow = reached || elapsedNow === null ? null : lineFor(elapsedNow);
  const summary: FssaiCurveSummary = {
    id: key,
    log_kind: logKind,
    log_kind_label: FSSAI_TEMP_LOG_KINDS.find((k) => k.key === logKind)?.label || logKind,
    direction: dir,
    goal,
    max_minutes: limit,
    start: start ? { id: start.id, business_date: start.business_date, reading_at: start.reading_at, value_num: start.value, elapsed_minutes: start.elapsed } : null,
    line_start: lineStart,
    last: last ? { id: last.id, business_date: last.business_date, reading_at: last.reading_at, value_num: last.value, elapsed_minutes: last.elapsed } : null,
    reached: reached ? { id: reached.id, reading_at: reached.reading_at, value_num: reached.value, elapsed_minutes: reached.elapsed } : null,
    elapsed_now: reached ? null : elapsedNow,
    needed_now: neededNow === null ? null : Number(fssaiCurveExpectedShown(neededNow, dir)),
    has_breach: breach,
    outcome,
    outcome_label: FSSAI_CURVE_OUTCOME_WORDS[outcome],
  };
  const schedule = (m: FssaiCurveMember): number | null => {
    if (m.status === 'void') return null;
    if (m.start_source === 'first_reading' && m.elapsed === 0) return null;
    const e = m.start_source
      ? fssaiCurveExpected({ startValue: m.start_used, startElapsed: m.start_minute ?? 0, goal: m.goal, maxMinutes: m.max_minutes, elapsed: m.elapsed })
      : (start ? fssaiCurveExpected({ startValue: start.value, startElapsed: start.elapsed, goal, maxMinutes: limit, elapsed: m.elapsed }) : null);
    return e === null ? null : Number(fssaiCurveExpectedShown(e, dir));
  };
  return { summary, members: all, schedule };
}

/**
 * EVERY COOLING / REHEATING BATCH STILL OPEN — started today or yesterday (IST,
 * `today`), not voided, and with no reading at its target yet. Each comes with
 * its FssaiCurveSummary, so `outcome === 'overdue'` is a batch past its time
 * with nothing at the target: an abandoned pot.
 *
 * ⚠️ FOR THE SCHEDULED JOBS (job_keys 'cooling_overdue' and, since 2026-10-15,
 * 'reheating_overdue'; subject_key = the curve key `summary.id`): this is the
 * one definition of "open" and "overdue",
 * the same one GET /api/fssai/temperature?curves=open and the temperature page's
 * batch picker use. `where` narrows the rows (the route passes its department
 * visibility clause; a job passes nothing). Read-only.
 */
/** One open batch, as fssaiOpenCurves returns it. The subject fields let a
 *  screen offer only the batches of the dish being entered, and fill the form
 *  from the batch it picks (2026-10-15: the picker offered every dish). */
export type FssaiOpenCurve = FssaiCurveSummary & {
  label: string; item_label: string; place_label: string;
  equipment_id: string; equipment_label: string; area_label: string; material_id: string;
  department_id: string; open_ca: number;
};

export function fssaiOpenCurves(
  db: Database.Database,
  opts: {
    today?: string;
    nowMinute?: number | null;
    logKind?: string;
    /** Extra SQL on fssai_temperature_logs aliased `t`. */
    where?: { sql: string; args: any[] } | null;
    /** Include batches that already reached the target (default false). */
    includeReached?: boolean;
  } = {},
): Array<FssaiOpenCurve> {
  const today = isISODate(str(opts.today)) ? str(opts.today) : fssaiToday();
  const nowMinute = opts.nowMinute === undefined ? fssaiNowMinuteIST() : opts.nowMinute;
  const rateKinds = FSSAI_TEMP_LOG_KINDS.filter((k) => k.window_minutes).map((k) => k.key as string);
  const kinds = opts.logKind ? rateKinds.filter((k) => k === str(opts.logKind)) : rateKinds;
  if (!kinds.length) return [];
  const where = [
    `t.log_kind IN (${kinds.map(() => '?').join(',')})`,
    `t.status <> 'void'`,
    `t.business_date >= ?`,
    `t.business_date <= ?`,
  ];
  const args: any[] = [...kinds, addDaysISO(today, -1) || today, today];
  if (opts.where && opts.where.sql) { where.push(opts.where.sql); args.push(...opts.where.args); }
  const rows = db.prepare(
    `SELECT t.id, t.batch_id, t.log_kind, t.equipment_id, t.equipment_label, t.area_label, t.item_label, t.material_id, t.department_id
       FROM fssai_temperature_logs t WHERE ${where.join(' AND ')}
      ORDER BY t.business_date ASC, t.reading_at ASC, t.rowid ASC`,
  ).all(...args) as any[];
  const seen = new Map<string, any>();
  for (const r of rows) {
    const k = `${String(r.log_kind)}|${String(r.batch_id || '') || String(r.id)}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  const out: Array<FssaiOpenCurve> = [];
  for (const [k, r] of seen) {
    const key = k.slice(k.indexOf('|') + 1);
    const s = fssaiCurveSummary(db, String(r.log_kind), key, nowMinute);
    if (!s.summary.start) continue;
    if (s.summary.reached && !opts.includeReached) continue;
    const liveIds = s.members.filter((m) => m.status !== 'void').map((m) => m.id);
    const openCa = liveIds.length
      ? Number((db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_corrective_actions
          WHERE source_kind = 'temperature' AND response_id IN (${liveIds.map(() => '?').join(',')})
            AND status IN ('open','in_progress','done')`,
      ).get(...liveIds) as any)?.n) || 0
      : 0;
    const item = String(r.item_label || '');
    const place = String(r.equipment_label || r.area_label || '');
    out.push({
      ...s.summary,
      label: [item, place].filter(Boolean).join(' · ') || 'Unnamed',
      item_label: item,
      place_label: place,
      equipment_id: String(r.equipment_id || ''),
      equipment_label: String(r.equipment_label || ''),
      area_label: String(r.area_label || ''),
      material_id: String(r.material_id || ''),
      department_id: String(r.department_id || ''),
      open_ca: openCa,
    });
  }
  out.sort((a, b) => `${a.start!.business_date} ${a.start!.reading_at}`.localeCompare(`${b.start!.business_date} ${b.start!.reading_at}`));
  return out;
}

/* ================================================================== *
 * 4. THE CORRECTIVE ACTION A FAILED RECORD OWES (owner §4)
 * ================================================================== */

export interface FssaiRecordCaInput {
  sourceKind: 'temperature' | 'manual';
  /** The table and row the failure is on, for the description and the audit row. */
  entityTable: string;
  entityId: string;
  title: string;
  description: string;
  severity?: string;
  equipmentId?: string | null;
  departmentId?: string | null;
  businessDate?: string | null;
  actor: FssaiActor & { name?: string | null };
  outletId?: string | null;
}

/**
 * RAISE ONE CORRECTIVE ACTION AGAINST A RECORD THAT FAILED.
 *
 * Owner §4, in his own words about this phase: "Out-of-range automatically raises
 * a corrective action." `raiseFssaiCorrectiveActions` in `fssai-server.ts` does
 * this for a CHECKLIST ANSWER — it reads `fssai_responses`, it is keyed on
 * (run_id, response_id) and every path through it needs a run. A temperature
 * reading has no run, so this is the record-shaped twin, and it reuses everything
 * that can be reused: the same table, the same number allocator, the same due-date
 * maths, the same audit writer, the same "owner starts empty" rule.
 *
 * THREE PROPERTIES CARRIED OVER DELIBERATELY FROM THE CHECKLIST VERSION:
 *
 * 1. `run_id` IS WRITTEN NULL, NEVER ''. The column is `TEXT` with a FOREIGN KEY
 *    to `fssai_runs` and `foreign_keys = ON`, so '' throws — and a throw here
 *    would roll back a reading a member of staff really took.
 *
 * 2. IDEMPOTENT ON THE RECORD. The record's own id is written into `response_id`
 *    (the only spare key on that table that is indexed by use rather than by FK)
 *    and checked first, so a double-submit cannot put two jobs in front of the
 *    engineer for one warm fridge.
 *
 * 3. BEST-EFFORT, AND THE TRADE IS STATED. A failure to raise cannot roll back
 *    the record: §7 Q4 says never lose a check a member of staff really did. The
 *    consequence is visible rather than hidden — the action is missing, the
 *    FAILURE IS STILL ON THE RECORD in red, and `fail_reason` still says why.
 *    Nothing about the record's own truth depends on this succeeding.
 *
 * Returns the raised action's `{ id, ca_number }`, or null if nothing was raised.
 */
export function raiseFssaiRecordCa(
  db: Database.Database,
  p: FssaiRecordCaInput,
): { id: string; ca_number: string; due_date: string; severity: string } | null {
  try {
    const already = db.prepare(
      `SELECT id, ca_number FROM fssai_corrective_actions
        WHERE response_id = ? AND source_kind = ? LIMIT 1`,
    ).get(p.entityId, p.sourceKind) as any;
    if (already) return null;

    const severity = isFssaiCaSeverity(p.severity) ? String(p.severity) : 'high';
    const businessDate = str(p.businessDate) || fssaiToday();
    const id = generateId();
    const caNumber = nextFssaiCaNumber(db, businessDate);
    const dueDate = fssaiCaDueDate(severity, businessDate);

    db.prepare(
      `INSERT INTO fssai_corrective_actions
         (id, ca_number, source_kind, run_id, response_id, equipment_id, department_id,
          title, description, severity, status, owner_email, due_date, created_by, outlet_id)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'open', '', ?, ?, ?)`,
    ).run(
      id, caNumber, p.sourceKind, p.entityId,
      str(p.equipmentId), str(p.departmentId),
      p.title.slice(0, 300),
      p.description,
      severity,
      dueDate,
      str(p.actor.email),
      str(p.outletId),
    );

    fssaiAuditBestEffort(db, {
      entity_table: 'fssai_corrective_actions', entity_id: id, action: 'create',
      after: {
        ca_number: caNumber, source_kind: p.sourceKind, source_table: p.entityTable,
        source_id: p.entityId, severity, status: 'open', title: p.title.slice(0, 300),
      },
      reason: 'Raised automatically: this reading was outside the range that was applied to it.',
      actor: { email: p.actor.email, name: p.actor.name }, outlet_id: str(p.outletId),
    });

    return { id, ca_number: caNumber, due_date: dueDate, severity };
  } catch (e) {
    // See property 3 above: the record is already true without this.
    console.error('raiseFssaiRecordCa failed (the record stands):', e);
    return null;
  }
}

/* ================================================================== *
 * 4b. DOES THIS RECEIVED LINE FAIL?
 * ================================================================== */

/**
 * THE ONE PREDICATE, used by the draft's live preview AND by the submit freeze,
 * so the badge on the screen and the frozen `is_fail` on the record can never
 * disagree about the same pack.
 *
 * A line fails when ANY named checkpoint is explicitly `not_ok`, OR anything was
 * sent back, OR the line was rejected outright, OR the probed temperature was
 * outside the range that was applied to it.
 *
 * ⚠️ IT DOES NOT FAIL FOR BEING UNANSWERED. `''` means NOT ASSESSED — that is the
 * whole reason these columns are TEXT and not the GRN's integers (29 GRNs on the
 * live snapshot have all six integer boxes summing to 0, which cannot tell
 * "checked and wrong" from "nobody ticked it"). Turning an unanswered check into a
 * failure would make an unfinished inspection look like a bad delivery. What `''`
 * does instead is block the SUBMIT, which is the honest place for it — see
 * `fssaiReceivingLineGaps`.
 *
 * It reads ONLY the frozen columns on the row it is given: `temp_min_used` /
 * `temp_max_used`, never a live standard. Re-resolving the range here would mean a
 * tightened rule retrospectively failing a delivery that passed.
 *
 * Lives in this shared file rather than in the route because it is the one piece
 * of P4 a probe must be able to call directly.
 */
export function fssaiReceivingLineFails(row: any): { fail: boolean; why: string[] } {
  const why: string[] = [];
  for (const cp of FSSAI_RECEIVING_CHECKPOINTS) {
    if (fssaiCheckResultIsFail(row?.[cp.column])) why.push(`${cp.label}: not in order`);
  }
  const rejected = num(row?.qty_rejected);
  if (rejected !== null && rejected > 0) {
    why.push(`${rejected} ${str(row?.uom)} sent back`.trim());
  }
  if (str(row?.decision) === 'rejected') why.push('rejected outright');
  const temp = num(row?.temp_c);
  const min = num(row?.temp_min_used);
  const max = num(row?.temp_max_used);
  if (temp !== null) {
    if (min !== null && temp < min) why.push(`arrived at ${temp} °C, below ${min} °C`);
    else if (max !== null && temp > max) why.push(`arrived at ${temp} °C, above ${max} °C`);
  }
  return { fail: why.length > 0, why };
}

/** Which checkpoints on a line were never assessed, in the words the form uses. */
export function fssaiReceivingLineGaps(row: any): string[] {
  return FSSAI_RECEIVING_CHECKPOINTS
    .filter((cp) => !fssaiCheckResultAnswered(row?.[cp.column]))
    .map((cp) => cp.label);
}

/* ================================================================== *
 * 5. A PHOTOGRAPH ON A RECORD THAT HAS NO CHECKLIST ROUND
 * ================================================================== */

/**
 * WRITE ONE ATTACHMENT, with the entity-table allowlist enforced BEFORE any SQL.
 *
 * WHY NOT `fssai_evidence`, which already exists and already holds photographs.
 * Its `run_id` is `TEXT NOT NULL` with a FOREIGN KEY to `fssai_runs`, so a
 * photograph of a rejected delivery cannot go there at all — and widening it
 * would be worse than useless: `computeFssaiSheetDigest` hashes a run's evidence
 * into the SHA-256 that the signature covers, so run-less rows would sit inside a
 * signed set. That is the one option that quietly weakens a signature.
 *
 * `entity_table` is validated with `isFssaiAttachmentEntity` and the caller's
 * string NEVER reaches SQL as an identifier — it is stored as data, in a column,
 * and the allowlist is what stops an attachment pointing at a table that does not
 * exist (an orphan nothing will ever show).
 *
 * The photograph itself goes through `parseFssaiDataUri`, which is where the
 * 400 KB ceiling, the three allowed mimes and the "not an image at all" refusal
 * live. `code` on the refusal lets the ROUTE choose 413 vs 400 without matching
 * on the wording of a sentence.
 */
export function writeFssaiAttachment(
  db: Database.Database,
  p: {
    entityTable: string;
    entityId: string;
    kind: string;
    dataUri: string;
    filename?: string;
    caption?: string;
    actorEmail?: string | null;
    outletId?: string | null;
  },
): { ok: true; id: string; bytes: number } | { ok: false; error: string; status: number } {
  if (!isFssaiAttachmentEntity(p.entityTable)) {
    return { ok: false, error: 'A photograph cannot be attached to that kind of record.', status: 400 };
  }
  if (!str(p.entityId)) {
    return { ok: false, error: 'Which record is this photograph of? No record was named.', status: 400 };
  }
  const parsed = parseFssaiDataUri(p.dataUri);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, status: parsed.code === 'too_big' ? 413 : 400 };
  }
  const id = generateId();
  /* digest_sha256 is left '' here on purpose. The column exists so a later phase
   * can de-duplicate or prove a photograph has not been swapped; computing one
   * now would imply an attestation nothing in this module yet checks, and an
   * unverified hash on a compliance record is worse than no hash. */
  db.prepare(
    `INSERT INTO fssai_attachments
       (id, entity_table, entity_id, kind, data_uri, filename, mime, size_bytes, caption,
        digest_sha256, created_by, outlet_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
  ).run(
    id, p.entityTable, str(p.entityId),
    FSSAI_PHOTO_MIMES.includes(parsed.mime) ? str(p.kind) || 'photo' : 'photo',
    str(p.dataUri), str(p.filename).slice(0, 200), parsed.mime, parsed.bytes,
    str(p.caption).slice(0, 500), str(p.actorEmail), str(p.outletId),
  );
  return { ok: true, id, bytes: parsed.bytes };
}

/**
 * HOW MANY PHOTOGRAPHS EACH OF THESE ROWS HAS, in one query.
 *
 * A count, never the images: a list of thirty deliveries each carrying four
 * 250 KB data URIs is a 30 MB JSON response, which is how an honest screen
 * becomes an unusable one. The image itself is fetched when somebody taps it.
 *
 * Returns an empty Map for an empty id list rather than building `IN ()`, which
 * is a syntax error in SQLite.
 */
export function fssaiAttachmentCounts(
  db: Database.Database,
  entityTable: string,
  ids: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (!isFssaiAttachmentEntity(entityTable) || !ids.length) return out;
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return out;
  const rows = db.prepare(
    `SELECT entity_id, COUNT(*) AS n FROM fssai_attachments
      WHERE entity_table = ? AND entity_id IN (${unique.map(() => '?').join(',')})
      GROUP BY entity_id`,
  ).all(entityTable, ...unique) as any[];
  for (const r of rows) out.set(String(r.entity_id), Number(r.n) || 0);
  return out;
}

/* ================================================================== *
 * 6. SMALL SHARED SHAPES
 * ================================================================== */

/**
 * WHICH RECORDS MAY THIS PERSON SEE — the clause, matching the corrective-action
 * route's shape exactly so a staff member is never shown "12 open" over a list
 * of 2.
 *
 * `FSSAI_NO_MATCH` rather than '' is load-bearing and is already proved
 * elsewhere in this module: a user with no department must see the records that
 * are HIS, not every record whose department column happens to be blank.
 *
 * ⚠️ A RESTAURANT-WIDE RECORD IS READABLE BY ANYONE SIGNED IN. A reading taken
 * on a unit with no department belongs to the restaurant, not to nobody — the
 * same ruling the checklist runs route reached after a colleague was told a
 * restaurant-wide record "belongs to another department".
 */
export function fssaiRecordVisibility(
  me: any,
  cols: { department: string; recordedBy: string },
  isMgmt: boolean,
  noMatch: string,
): { sql: string; args: any[] } {
  if (isMgmt) return { sql: '', args: [] };
  return {
    sql: `(${cols.department} = ''
           OR ${cols.department} = ?
           OR lower(IFNULL(${cols.recordedBy},'')) = lower(?))`,
    args: [me?.department_id || noMatch, me?.email || noMatch],
  };
}

/** HH:MM as typed, or '' — never a silent 00:00, which reads as midnight. */
export function fssaiClock(v: unknown): string {
  const s = str(v);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : '';
}

/**
 * Today in IST, and the earliest date a record may be backdated to.
 *
 * §7 Q9 PROVISIONAL DEFAULT (the owner has not ruled): a check may be backdated
 * by ONE day with a mandatory reason, and the row is flagged. P4 keeps the window
 * and the reason; what it does NOT have is a `is_backdated` column on these
 * tables, so the flag goes into the audit row instead of being invented as a
 * column — see each route's `backdate_reason` handling.
 */
export const FSSAI_BACKDATE_DAYS = 1;
