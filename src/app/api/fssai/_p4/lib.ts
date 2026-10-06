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
    min: null, max: null, target: null, max_minutes: null,
    uom: fallbackUom, decimals: 1,
  };

  const equipmentId = str(input.equipmentId);
  if (equipmentId) {
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
    `SELECT id, code, label, min_value, max_value, target_value, uom, decimals, max_minutes,
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
}

/**
 * JUDGE ONE READING, AND THE CLOCK WITH IT.
 *
 * Two halves, because FSSAI judges cooling and reheating on a RATE and not a
 * level: the level comes from `fssaiRangeCheck` (shared, unrounded — rounding 5.4
 * would pass a 0–5 rule), and the clock is tested here because only this phase
 * has the elapsed minutes.
 *
 * ⚠️ READ THE CLOCK TEST CAREFULLY. It fires ONLY when the reading has not yet
 * reached its target AND the window has run out. A dish that came down to 4 °C in
 * 95 minutes against a 90-minute rule is a pass on the level and would be a
 * nonsense failure on the clock — the food is safe, it is the record of the curve
 * that is late. A dish still at 30 °C after 95 minutes is a real failure and this
 * says so in words.
 *
 * `uomForWords` is the symbol the sentence is written with, not a conversion:
 * nothing here converts, because `min_used`/`max_used` are frozen in the unit the
 * reading was taken in and a record that silently restates a number in another
 * unit is unreadable beside the probe that produced it.
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
}): FssaiReadingVerdict {
  const r = fssaiRangeCheck(input.value, input.min, input.max, input.uomForWords || '');
  let judged: 0 | 1 = r.judged ? 1 : 0;
  let fail: 0 | 1 = r.out_of_range ? 1 : 0;
  const reasons: string[] = r.out_of_range ? [r.why] : [];

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
    if ((elapsed as number) > (limit as number) && reached !== true) {
      fail = 1;
      const u = input.uomForWords ? ` ${input.uomForWords}` : '';
      reasons.push(
        reached === false && goal !== null
          ? `${elapsed} minutes have passed and it is still at ${v}${u} — the rule allows ${limit} minutes to reach ${goal}${u}.`
          : `${elapsed} minutes have passed, and the rule allows ${limit}.`,
      );
    }
  }

  return {
    is_judged: judged,
    is_fail: fail,
    fail_reason: reasons.join(' '),
    why: reasons.length ? reasons.join(' ') : r.why,
  };
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
