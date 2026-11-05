/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  FSSAI_TEMP_LOG_KINDS, FSSAI_TEMP_SOURCES, FSSAI_TEMP_UOMS, FSSAI_SHIFTS,
  FSSAI_EQUIPMENT_KINDS, FSSAI_RECORD_STATUSES,
  isFssaiTempLogKind, isFssaiShift, fssaiTempLogKindLabel, fssaiRecordStatusMeta,
  fssaiDisplayReading, fssaiVoidRefusal, canVerifyFssai, fssaiToday, isISODate,
  addDaysISO, daysBetweenISO,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAuditBestEffort, fssaiAppAudit,
  str, FSSAI_NO_MATCH,
} from '@/lib/fssai-server';
import {
  resolveFssaiRange, judgeFssaiReading, raiseFssaiRecordCa, writeFssaiAttachment,
  fssaiAttachmentCounts, fssaiRecordVisibility, fssaiClock, fssaiNum, fssaiInt,
  FSSAI_BACKDATE_DAYS,
  resolveFssaiCurve, fssaiCurveExpectedShown, fssaiTempDirection,
  fssaiCurveLineStart, fssaiCurveExpected, fssaiReadingScheduleValue, fssaiTempVerdictWord,
  fssaiTempMinutesWords, fssaiCurveSummary, fssaiOpenCurves, fssaiNowMinuteIST,
  fssaiClockMinute, fssaiCurveMembers, fssaiFailKindWords, fssaiTempImplausible, fssaiCurveKeyOf,
  type FssaiCurveResolution, type FssaiCurveStart,
} from '../_p4/lib';

/**
 * How far AHEAD of the server's IST clock a reading's time may be and still be
 * filed — for a tablet whose clock runs a few minutes fast. Beyond it the time is
 * in the future and refused (2026-10-15: a cooling target reading timed three
 * hours ahead closed its batch as "reached in time", stopped the overdue job,
 * and every real reading after it was refused as out of order).
 */
const FSSAI_FUTURE_TIME_TOLERANCE_MINUTES = 5;

/**
 * Minutes typed for a cooling or reheating reading: '' / null / absent = not
 * given; otherwise a whole number, 0 or more. Anything else is refused rather
 * than silently read as "not given" — '239abc' used to become blank and start a
 * batch at minute 0 that passed, and −0.5 truncated to 0 did the same.
 */
function typedMinutes(raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw === 'string' && raw.trim() === '') return { ok: true, value: null };
  if (typeof raw !== 'number' && typeof raw !== 'string') return { ok: false };
  const n = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n + 0 };
}

/**
 * TEMPERATURE LOGS (/api/fssai/temperature) — owner §4 and §5.
 *
 * The running record of every temperature taken in the building: a cold room on
 * its round, a probe into a curry, a hot cabinet, a delivery at the door, a
 * cooling curve against the clock, a thermometer checked against ice.
 *
 * ── ONE TABLE AND A `log_kind`, NOT NINE TABLES ─────────────────────────────
 * Every one of those is the same record — a number, a time, a range, a person, a
 * verdict — and §24's "dynamic and configurable rather than a separate table for
 * every checklist" applies with more force to readings than to checklists.
 *
 * ── THE THREE RULES THIS ROUTE IS BUILT AROUND ──────────────────────────────
 *
 * 1. NO NUMBER IS HARD-CODED (owner §5). The range comes from the UNIT first
 *    (`fssai_equipment.min_temp`/`max_temp`), then from a STANDARD row, and from
 *    nowhere else. `resolveFssaiRange` is the single resolver and the GET exposes
 *    it (`?preview=1`) so the screen shows a staff member what their reading will
 *    be judged against BEFORE they type it.
 *
 * 2. THE VERDICT IS FROZEN AT WRITE AND NEVER RECOMPUTED ON READ.
 *    `min_used` / `max_used` / `target_used` / `max_minutes_used` / `is_judged` /
 *    `is_fail` / `fail_reason` / `standard_id` are written once. Tightening a
 *    range next month cannot retrospectively fail a fridge that passed, and the
 *    record can still say which rule judged it. Nothing in the GET recomputes a
 *    verdict — grep it: `judgeFssaiReading` appears only in POST.
 *
 * 3. AN UNJUDGED READING IS NOT A PASS. If no range applies, the reading is
 *    stored with `is_judged = 0` and the screen says so. A register that painted
 *    every unranged unit green would be the most dangerous thing this module
 *    could print, because all of them are unranged until the owner sets his
 *    numbers.
 *
 * ── WHAT A FAILURE DOES (owner §4) ──────────────────────────────────────────
 * "Out-of-range automatically raises a corrective action." It does — inside the
 * same transaction as the reading, idempotent on the reading's own id, and
 * best-effort so a follow-up row that will not insert can never cost a chef the
 * reading he just took. The failure stays on the record either way.
 *
 * ── WHAT THIS ROUTE CANNOT DO ───────────────────────────────────────────────
 * It cannot change a reading. There is no edit action and no UPDATE of
 * `value_num`, `is_fail`, `is_judged`, `min_used` or `max_used` anywhere below —
 * grep for them, the only UPDATEs name `status` and the void/verify columns. A
 * reading entered in error is VOIDED with a written reason by management (§19),
 * which is the one way the file can show what changed and why.
 *
 *   GET  ?id=<id>                                one reading, with its photographs
 *   GET  ?preview=1&log_kind=&equipment_id=…     the range that WOULD apply
 *   GET  ?due=1                                  units with no reading today
 *   GET  [?from=&to=&log_kind=&equipment_id=&department_id=&status=&fails=1&q=]
 *   POST { action: 'record' | 'void' | 'verify' | 'attach' , … }
 */
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 300;

const LOG_SELECT = `
  SELECT t.id, t.business_date, t.reading_at, t.shift, t.log_kind, t.source_kind,
         t.run_id, t.response_id, t.receiving_line_id, t.equipment_id, t.equipment_label,
         t.equipment_kind, t.area_label, t.department_id, t.material_id, t.item_label,
         t.batch_id, t.standard_id, t.value_num, t.uom, t.decimals,
         t.min_used, t.max_used, t.target_used, t.elapsed_minutes, t.max_minutes_used,
         t.is_fail, t.is_judged, t.fail_reason, t.action_taken, t.ca_id, t.note,
         t.status, t.recorded_by, t.recorded_name, t.verified_by, t.verified_at,
         t.voided_at, t.voided_by, t.void_reason, t.outlet_id, t.created_at, t.updated_at,
         t.curve_start_used, t.curve_start_minute, t.curve_start_source,
         IFNULL(d.name,'')  AS department_name,
         IFNULL(e.name,'')  AS equipment_name_now,
         IFNULL(m.name,'')  AS material_name,
         IFNULL(s.label,'') AS standard_label,
         IFNULL(c.ca_number,'') AS ca_number,
         IFNULL(c.status,'')    AS ca_status
    FROM fssai_temperature_logs t
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN fssai_equipment e ON e.id = t.equipment_id
    LEFT JOIN raw_materials m ON m.id = t.material_id
    LEFT JOIN fssai_temp_standards s ON s.id = t.standard_id
    LEFT JOIN fssai_corrective_actions c ON c.id = t.ca_id`;

function shapeLog(row: any, photoCount = 0) {
  const value = fssaiNum(row.value_num);
  return {
    id: String(row.id),
    business_date: String(row.business_date || ''),
    reading_at: String(row.reading_at || ''),
    shift: String(row.shift || ''),
    log_kind: String(row.log_kind || ''),
    log_kind_label: fssaiTempLogKindLabel(row.log_kind),
    source_kind: String(row.source_kind || 'manual'),
    source_label: FSSAI_TEMP_SOURCES.find((s) => s.key === String(row.source_kind))?.label || String(row.source_kind || ''),
    run_id: String(row.run_id || ''),
    response_id: String(row.response_id || ''),
    receiving_line_id: String(row.receiving_line_id || ''),
    equipment_id: String(row.equipment_id || ''),
    /* THE LABEL FROZEN ON THE READING LEADS, never the live name. A unit renamed
     * or retired must not re-label the readings taken on it — the same rule the
     * checklist record learned the hard way with `template_name_at_record`. */
    equipment_label: String(row.equipment_label || ''),
    equipment_name_now: String(row.equipment_name_now || ''),
    equipment_renamed_since:
      !!String(row.equipment_label || '')
      && !!String(row.equipment_name_now || '')
      && String(row.equipment_label) !== String(row.equipment_name_now),
    equipment_kind: String(row.equipment_kind || ''),
    equipment_kind_label: FSSAI_EQUIPMENT_KINDS.find((k) => k.key === String(row.equipment_kind))?.label || '',
    area_label: String(row.area_label || ''),
    department_id: String(row.department_id || ''),
    department_name: String(row.department_name || ''),
    material_id: String(row.material_id || ''),
    material_name: String(row.material_name || ''),
    item_label: String(row.item_label || ''),
    batch_id: String(row.batch_id || ''),
    standard_id: String(row.standard_id || ''),
    standard_label: String(row.standard_label || ''),
    /* null means NOT RECORDED. A reading of 0 °C and a reading nobody took are
     * different facts and must never render the same way. */
    value_num: value,
    display_value: fssaiDisplayReading(value, row.decimals),
    uom: String(row.uom || 'C'),
    decimals: fssaiInt(row.decimals) ?? 1,
    min_used: fssaiNum(row.min_used),
    max_used: fssaiNum(row.max_used),
    target_used: fssaiNum(row.target_used),
    elapsed_minutes: fssaiInt(row.elapsed_minutes),
    max_minutes_used: fssaiInt(row.max_minutes_used),
    is_fail: Number(row.is_fail) ? 1 : 0,
    is_judged: Number(row.is_judged) ? 1 : 0,
    fail_reason: String(row.fail_reason || ''),
    action_taken: String(row.action_taken || ''),
    ca_id: String(row.ca_id || ''),
    ca_number: String(row.ca_number || ''),
    ca_status: String(row.ca_status || ''),
    note: String(row.note || ''),
    status: String(row.status || 'submitted'),
    status_label: fssaiRecordStatusMeta(row.status).label,
    recorded_by: String(row.recorded_by || ''),
    recorded_name: String(row.recorded_name || ''),
    verified_by: String(row.verified_by || ''),
    verified_at: String(row.verified_at || ''),
    voided_at: String(row.voided_at || ''),
    voided_by: String(row.voided_by || ''),
    void_reason: String(row.void_reason || ''),
    created_at: String(row.created_at || ''),
    /* Cooling and reheating only: the batch whose curve this reading is on
     * (GET ?curve=<this> returns the whole curve). '' for every other kind. */
    curve_id: isRateKind(row.log_kind) ? (String(row.batch_id || '') || String(row.id)) : '',
    /* Where this reading's schedule line started, FROZEN with its verdict
     * (cooling / reheating only): the batch's 0-minute reading, or the rule's
     * starting temperature when the batch had none. null / '' otherwise. */
    curve_start_used: fssaiNum(row.curve_start_used),
    curve_start_minute: fssaiInt(row.curve_start_minute),
    curve_start_source: String(row.curve_start_source || ''),
    /* "Needed by then", from the frozen line — never a live rule. */
    schedule_value: (() => {
      const e = fssaiReadingScheduleValue(row);
      return e === null ? null : Number(fssaiCurveExpectedShown(e, fssaiTempDirection(String(row.log_kind || ''))));
    })(),
    /* The one word every screen and printout uses for this verdict: 'On
     * schedule' for a cooling reading still on its way down, never "In range". */
    verdict_word: fssaiTempVerdictWord(row),
    minutes_words: fssaiTempMinutesWords(row),
    photo_count: photoCount,
    /* The range in words, computed from the FROZEN columns and not from any live
     * rule, so a list and a record can never disagree. */
    range_label: rangeWords(fssaiNum(row.min_used), fssaiNum(row.max_used), String(row.uom || 'C')),
  };
}

/** Cooling and reheating — the kinds whose FSSAI rule is a RATE against a clock. */
function isRateKind(logKind: unknown): boolean {
  return !!FSSAI_TEMP_LOG_KINDS.find((k) => k.key === String(logKind || ''))?.window_minutes;
}

/** "0 to 5 °C" / "at or below −18 °C" / "no range was set". */
function rangeWords(min: number | null, max: number | null, uom: string): string {
  const u = uom === 'C' || uom === 'F' ? `°${uom}` : uom;
  if (min !== null && max !== null) return `${min} to ${max} ${u}`;
  if (max !== null) return `at or below ${max} ${u}`;
  if (min !== null) return `at or above ${min} ${u}`;
  return 'no range was set';
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;
  const mgmt = isManagement(me);

  try {
    const db = getDb();
    const url = new URL(request.url);

    /* ══ THE RANGE THAT *WOULD* APPLY — before a number is typed ═════════════
     * This is what stops "not judged" looking like a bug. The staff member sees
     * the rule, and where it came from, on the form.
     * ════════════════════════════════════════════════════════════════════════ */
    if (url.searchParams.get('preview') === '1') {
      const logKind = str(url.searchParams.get('log_kind')) || 'equipment';
      if (!isFssaiTempLogKind(logKind)) {
        return Response.json({ error: `"${logKind}" is not a kind of temperature reading.` }, { status: 400 });
      }
      const equipmentId = str(url.searchParams.get('equipment_id'));
      let equipmentKind = str(url.searchParams.get('equipment_kind'));
      let equipmentLabel = '';
      if (equipmentId) {
        const eq = db.prepare(`SELECT name, kind FROM fssai_equipment WHERE id = ?`).get(equipmentId) as any;
        if (eq) { equipmentKind = equipmentKind || String(eq.kind || ''); equipmentLabel = String(eq.name || ''); }
      }
      const range = resolveFssaiRange(db, {
        logKind,
        equipmentId,
        equipmentKind,
        materialId: str(url.searchParams.get('material_id')),
        uom: str(url.searchParams.get('uom')),
      });
      const kindMeta = FSSAI_TEMP_LOG_KINDS.find((k) => k.key === logKind);
      const dir = kindMeta?.direction || 'either';
      const goal = range.target !== null ? range.target : (dir === 'hot' ? range.min : range.max);
      const u = range.uom === 'C' || range.uom === 'F' ? ` °${range.uom}` : ` ${range.uom}`;
      const going = dir === 'hot' ? 'heating' : 'cooling';
      const startWords = range.start_value !== null
        ? `A batch with no 0-minute reading is measured from the rule's starting temperature, ${range.start_value}${u} at 0 minutes.`
        : `This rule sets no starting temperature, so a batch whose first reading is taken part-way (minutes entered) has nothing to be measured from — a reading short of ${goal}${u} on such a batch is filed as a failure. Take the first reading as the food comes off the heat.`;

      /* WHERE THIS READING WOULD GO, before it is filed — the same resolver and
       * the same line rule the write path uses, read-only. Only when the screen
       * asks with a time (`reading_at`), so the plain range preview is unchanged. */
      let curvePreview: any = null;
      const pvAt = fssaiClock(url.searchParams.get('reading_at'));
      if (kindMeta?.window_minutes && pvAt && range.source !== 'none') {
        const pvDate = isISODate(str(url.searchParams.get('business_date'))) ? str(url.searchParams.get('business_date')) : fssaiToday();
        const tm = typedMinutes(url.searchParams.get('elapsed_minutes'));
        const pvValue = fssaiNum(url.searchParams.get('value_num'));
        const c = !tm.ok
          ? { ok: false as const, status: 400, code: 'bad_minutes', error: 'Minutes must be a whole number, 0 or more.' }
          : resolveFssaiCurve(db, {
            logKind,
            curveId: str(url.searchParams.get('curve_id')),
            batchId: str(url.searchParams.get('batch_id')),
            newCurve: url.searchParams.get('new_curve') === '1',
            typedElapsed: tm.value,
            businessDate: pvDate,
            readingAt: pvAt,
            uom: range.uom === 'F' ? 'F' : 'C',
            maxMinutes: range.max_minutes,
            subject: {
              equipmentId, materialId: str(url.searchParams.get('material_id')),
              itemLabel: str(url.searchParams.get('item_label')).slice(0, 200),
              areaLabel: str(url.searchParams.get('area_label')).slice(0, 200),
              outletId: (await getCurrentOutletId()) || '',
            },
            value: pvValue,
            anchor: range.start_value,
            goal,
            moved: url.searchParams.get('moved') === '1',
          });
        if (!c.ok) {
          /* The batch the refusal is about rides along, so the form can offer
           * "it is that pot" beside "A new batch". */
          curvePreview = { ok: false, error: c.error, code: c.code, curve_id: c.curve_id || '', curve_label: c.curve_label || '' };
        } else {
          /* A JOINED batch is judged on the rule frozen on its first reading —
           * the same numbers the write path will use. */
          const frozen = c.rule && c.rule.max_minutes !== null ? c.rule : null;
          const limitUsed = frozen ? frozen.max_minutes : range.max_minutes;
          const goalUsed = frozen ? frozen.goal : goal;
          /* A new batch at 0 minutes starts its own line from the number about to
           * be typed — nothing is "needed" of it yet. */
          const startsLine = !c.start && c.elapsed === 0;
          const line = startsLine
            ? null
            : fssaiCurveLineStart({ first: c.start, ruled: c.rule, self: { value: null, elapsed: c.elapsed }, anchor: range.start_value, direction: dir });
          const needed = c.reached
            ? goalUsed
            : line
              ? fssaiCurveExpected({ startValue: line.value, startElapsed: line.minute, goal: goalUsed, maxMinutes: limitUsed, elapsed: c.elapsed })
              : null;
          curvePreview = {
            ok: true,
            mode: c.mode,
            curve_id: c.key || '',
            elapsed_minutes: c.elapsed,
            starts_line: startsLine,
            line_start: line,
            /* null with starts_line false = no line at all: a reading short of
             * the target will be filed as a failure (see the note). */
            needed: needed === null ? null : Number(fssaiCurveExpectedShown(needed, dir)),
            goal: goalUsed,
            max_minutes: limitUsed,
            past_window: limitUsed !== null && c.elapsed > limitUsed,
            /* The batch already reached its target: this reading has to still be
             * there, or it is filed as a failure. */
            after_target: !!c.reached,
            rule_frozen_from_batch: !!frozen,
            how: c.how,
          };
        }
      }

      return Response.json({
        range,
        equipment_label: equipmentLabel,
        range_label: rangeWords(range.min, range.max, range.uom),
        direction: dir,
        wants_clock: !!kindMeta?.window_minutes,
        curve_preview: curvePreview,
        /* The honest sentence, written here so every screen says the same thing. */
        note: range.source === 'none'
          ? 'No safe range has been set for this, so the reading will be recorded and marked as not judged. It will not be counted as a pass.'
          : range.source === 'equipment'
            ? 'This unit has its own range, which beats the general rule for its kind.'
            : (kindMeta?.window_minutes && range.max_minutes && goal !== null
              /* Said BEFORE the number is typed, so a cook does not read the red
               * "out of range" on 30 °C as a breach half-way down. */
              ? `Judged against "${range.standard_label}". While it is still ${going}, a reading is judged against where it should be by then — on a straight line from where the batch started at 0 minutes to ${goal}${u} at ${range.max_minutes} minutes — not against ${goal}${u} itself. At ${range.max_minutes} minutes it has to be at ${goal}${u}. Minutes are counted from the batch's first reading. ${startWords}`
              : `Judged against "${range.standard_label}".`),
      });
    }

    /* ══ ONE BATCH'S COOLING OR REHEATING CURVE ═══════════════════════════
     * ?curve=<any reading on it, or the batch id>[&log_kind=cooling]
     * The readings in the order they were taken, the minutes counted for each,
     * the frozen verdict, and the figure the schedule asked for at that point.
     * ════════════════════════════════════════════════════════════════════════ */
    const curveRef = str(url.searchParams.get('curve'));
    if (curveRef) {
      const ref = db.prepare(`SELECT id, batch_id, log_kind FROM fssai_temperature_logs WHERE id = ?`).get(curveRef) as any;
      const logKind = ref ? String(ref.log_kind) : (str(url.searchParams.get('log_kind')) || 'cooling');
      const key = ref ? (String(ref.batch_id || '') || String(ref.id)) : curveRef;
      if (!isRateKind(logKind)) {
        return Response.json({ error: 'Only cooling and reheating readings are kept as a curve.' }, { status: 400 });
      }
      const s = fssaiCurveSummary(db, logKind, key, fssaiNowMinuteIST());
      if (!s.members.length) return Response.json({ error: 'That batch is not in the file.' }, { status: 404 });
      const ids = s.members.map((m) => m.id);
      const rows = db.prepare(`${LOG_SELECT} WHERE t.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[];
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      const visible = (r: any) => {
        if (mgmt) return true;
        const dept = String(r.department_id || '');
        const mine = String(me.email || '').toLowerCase() === String(r.recorded_by || '').toLowerCase();
        return !dept || dept === me.department_id || mine;
      };
      const readings = s.members
        .map((m) => ({ m, row: byId.get(m.id) }))
        .filter((x) => x.row && visible(x.row))
        .map((x) => ({ ...shapeLog(x.row), schedule_value: s.schedule(x.m) }));
      if (!readings.length) {
        return Response.json({ error: 'That batch belongs to another department.' }, { status: 403 });
      }
      return Response.json({
        curve: s.summary,
        readings,
        note: 'Each verdict is the one frozen on the reading when it was taken. "Schedule" is where the batch needed to be at that point, on a straight line from where it started at 0 minutes — its own 0-minute reading, or the rule\'s starting temperature when it had none — to the target at the time limit.',
      });
    }

    /* ══ THE BATCHES STILL COOLING OR HEATING ══════════════════════════════
     * ?curves=open[&log_kind=cooling|reheating] — every batch from today or
     * yesterday that has not reached its target: the list a cook picks from to
     * add the next reading, and the one a manager reads for a pot left unfinished.
     * ════════════════════════════════════════════════════════════════════════ */
    if (url.searchParams.get('curves') === 'open') {
      const kindParam = str(url.searchParams.get('log_kind'));
      if (kindParam && !isRateKind(kindParam)) {
        return Response.json({ error: 'Only cooling and reheating readings are kept as a curve.' }, { status: 400 });
      }
      /* ONE DEFINITION of "open" and "overdue" — fssaiOpenCurves in _p4/lib,
       * shared with the scheduled jobs. This route only adds who may see what. */
      const vis = fssaiRecordVisibility(me, { department: 't.department_id', recordedBy: 't.recorded_by' }, mgmt, FSSAI_NO_MATCH);
      /* `include_reached=1` also lists the batches that already reached their
       * target (today or yesterday) — the form's picker needs them: a pot that
       * warmed up again is filed on ITS batch, as a failure, and the refusal that
       * says "pick that batch" is useless if the list does not hold it
       * (closing round 2026-10-15). The panel and the overdue count read the
       * unreached ones only. */
      const withReached = url.searchParams.get('include_reached') === '1';
      const open = fssaiOpenCurves(db, {
        today: fssaiToday(),
        nowMinute: fssaiNowMinuteIST(),
        logKind: kindParam || undefined,
        where: vis.sql ? vis : null,
        includeReached: withReached,
      });
      return Response.json({
        curves: open,
        overdue: open.filter((c) => c.outcome === 'overdue' && !c.reached).length,
      });
    }

    /* ══ ONE READING ════════════════════════════════════════════════════════ */
    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(`${LOG_SELECT} WHERE t.id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That reading is no longer in the file.' }, { status: 404 });
      if (!mgmt) {
        const dept = String(row.department_id || '');
        const mine = String(me.email || '').toLowerCase() === String(row.recorded_by || '').toLowerCase();
        // A restaurant-wide reading (no department) is readable by anyone signed
        // in — the ruling the checklist runs route reached after a colleague was
        // wrongly told a restaurant-wide record belonged to another department.
        if (dept && dept !== me.department_id && !mine) {
          return Response.json({ error: 'That reading belongs to another department.' }, { status: 403 });
        }
      }
      const photos = db.prepare(
        `SELECT id, kind, mime, size_bytes, caption, filename, created_by, created_at,
                (data_uri <> '') AS has_image, status, voided_at, voided_by, void_reason
           FROM fssai_attachments
          WHERE entity_table = 'fssai_temperature_logs' AND entity_id = ?
          ORDER BY created_at ASC`,
      ).all(id) as any[];
      return Response.json({
        reading: shapeLog(row, photos.length),
        /* The list is metadata only. The image itself is fetched one at a time —
         * four 250 KB data URIs in a list response is how an honest screen becomes
         * an unusable one. */
        photos: photos.map((p) => ({
          id: String(p.id), kind: String(p.kind || 'photo'), mime: String(p.mime || ''),
          size_bytes: Number(p.size_bytes) || 0, caption: String(p.caption || ''),
          filename: String(p.filename || ''), created_by: String(p.created_by || ''),
          created_at: String(p.created_at || ''), has_image: Number(p.has_image) ? 1 : 0,
          /* A mistaken photograph is VOIDED, never removed: it stays listed, with
           * who voided it and why. */
          status: String(p.status || 'active'),
          voided_at: String(p.voided_at || ''), voided_by: String(p.voided_by || ''),
          void_reason: String(p.void_reason || ''),
        })),
        void_refusal: fssaiVoidRefusal(me, { status: row.status, voided_at: row.voided_at }, 'placeholder reason'),
        can_verify: canVerifyFssai(me, row.recorded_by) && String(row.status) === 'submitted',
        cannot_change: 'A reading cannot be edited. If it was entered wrongly a manager voids it with a reason and a fresh one is taken — the file then shows both.',
      });
    }

    /* ══ ONE PHOTOGRAPH ═════════════════════════════════════════════════════ */
    const photoId = str(url.searchParams.get('photo_id'));
    if (photoId) {
      const p = db.prepare(
        `SELECT a.id, a.data_uri, a.mime, a.caption, a.size_bytes, a.image_dropped_at,
                t.department_id, t.recorded_by
           FROM fssai_attachments a
           JOIN fssai_temperature_logs t ON t.id = a.entity_id
          WHERE a.id = ? AND a.entity_table = 'fssai_temperature_logs'`,
      ).get(photoId) as any;
      if (!p) return Response.json({ error: 'That photograph is no longer in the file.' }, { status: 404 });
      if (!mgmt) {
        const dept = String(p.department_id || '');
        const mine = String(me.email || '').toLowerCase() === String(p.recorded_by || '').toLowerCase();
        if (dept && dept !== me.department_id && !mine) {
          return Response.json({ error: 'That photograph belongs to another department.' }, { status: 403 });
        }
      }
      return Response.json({
        id: String(p.id),
        data_uri: String(p.data_uri || ''),
        mime: String(p.mime || ''),
        caption: String(p.caption || ''),
        size_bytes: Number(p.size_bytes) || 0,
        /* The row outlives the image: after the retention window the photograph is
         * gone and the record still says it existed and when it went. */
        image_dropped_at: String(p.image_dropped_at || ''),
      });
    }

    /* ══ WHICH UNITS HAVE NOT BEEN READ TODAY ═══════════════════════════════
     * The only question the cold-room board is really asked. A unit nobody read
     * is the gap an inspector finds, and a board that only showed the readings
     * taken would hide exactly that.
     * ════════════════════════════════════════════════════════════════════════ */
    if (url.searchParams.get('due') === '1') {
      const day = isISODate(str(url.searchParams.get('date'))) ? str(url.searchParams.get('date')) : fssaiToday();
      const units = db.prepare(
        `SELECT e.id, e.name, e.kind, e.location_label, e.department_id, e.check_frequency,
                e.min_temp, e.max_temp, e.temp_uom,
                (SELECT COUNT(*) FROM fssai_temperature_logs t
                  WHERE t.equipment_id = e.id AND t.business_date = ? AND t.status <> 'void') AS readings_today,
                (SELECT COUNT(*) FROM fssai_temperature_logs t
                  WHERE t.equipment_id = e.id AND t.business_date = ? AND t.status <> 'void' AND t.is_fail = 1) AS fails_today
           FROM fssai_equipment e
          WHERE e.is_active = 1
          ORDER BY e.sort_order ASC, e.name ASC`,
      ).all(day, day) as any[];
      return Response.json({
        date: day,
        units: units.map((u) => ({
          id: String(u.id), name: String(u.name || ''), kind: String(u.kind || ''),
          kind_label: FSSAI_EQUIPMENT_KINDS.find((k) => k.key === String(u.kind))?.label || '',
          location_label: String(u.location_label || ''),
          department_id: String(u.department_id || ''),
          check_frequency: String(u.check_frequency || 'daily'),
          min_temp: fssaiNum(u.min_temp), max_temp: fssaiNum(u.max_temp),
          temp_uom: String(u.temp_uom || 'C'),
          has_range: fssaiNum(u.min_temp) !== null || fssaiNum(u.max_temp) !== null,
          readings_today: Number(u.readings_today) || 0,
          fails_today: Number(u.fails_today) || 0,
        })),
        not_read: units.filter((u) => !Number(u.readings_today)).map((u) => String(u.id)),
      });
    }

    /* ══ THE LIST ═══════════════════════════════════════════════════════════ */
    const where: string[] = [];
    const args: any[] = [];

    const from = str(url.searchParams.get('from'));
    const to = str(url.searchParams.get('to'));
    if (from) {
      if (!isISODate(from)) return Response.json({ error: 'That "from" date is not a real date.' }, { status: 400 });
      where.push('t.business_date >= ?'); args.push(from);
    }
    if (to) {
      if (!isISODate(to)) return Response.json({ error: 'That "to" date is not a real date.' }, { status: 400 });
      where.push('t.business_date <= ?'); args.push(to);
    }

    const logKind = str(url.searchParams.get('log_kind'));
    if (logKind) {
      if (!isFssaiTempLogKind(logKind)) {
        return Response.json({ error: `"${logKind}" is not a kind of temperature reading.` }, { status: 400 });
      }
      where.push('t.log_kind = ?'); args.push(logKind);
    }

    const equipmentId = str(url.searchParams.get('equipment_id'));
    if (equipmentId) { where.push('t.equipment_id = ?'); args.push(equipmentId); }

    const deptId = str(url.searchParams.get('department_id'));
    if (deptId) { where.push('t.department_id = ?'); args.push(deptId === '__none__' ? '' : deptId); }

    const status = str(url.searchParams.get('status')) || 'live';
    if (status === 'live') {
      // The default: everything that still counts. A voided reading is history and
      // has to be asked for, or a register silently averages struck-out numbers.
      where.push(`t.status <> 'void'`);
    } else if (status !== 'all') {
      if (!FSSAI_RECORD_STATUSES.some((s) => s.key === status)) {
        return Response.json({ error: `"${status}" is not a state a reading can be in.` }, { status: 400 });
      }
      where.push('t.status = ?'); args.push(status);
    }

    if (url.searchParams.get('fails') === '1') where.push('t.is_fail = 1');
    if (url.searchParams.get('unjudged') === '1') where.push('t.is_judged = 0');

    const vis = fssaiRecordVisibility(me, { department: 't.department_id', recordedBy: 't.recorded_by' }, mgmt, FSSAI_NO_MATCH);
    if (vis.sql) { where.push(vis.sql); args.push(...vis.args); }

    const rows = db.prepare(
      `${LOG_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.business_date DESC, t.reading_at DESC, t.created_at DESC, t.rowid DESC
       LIMIT ${LIST_LIMIT}`,
    ).all(...args) as any[];

    const counts = db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN is_fail = 1 THEN 1 ELSE 0 END) AS fails,
              SUM(CASE WHEN is_judged = 0 THEN 1 ELSE 0 END) AS unjudged,
              SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN status = 'void' THEN 1 ELSE 0 END) AS voided
         FROM fssai_temperature_logs
        WHERE business_date >= ? AND business_date <= ?`,
    ).get(from || '0000-01-01', to || '9999-12-31') as any;

    const photoCounts = fssaiAttachmentCounts(db, 'fssai_temperature_logs', rows.map((r) => String(r.id)));
    const q = str(url.searchParams.get('q')).toLowerCase();
    const shaped = rows
      .map((r) => shapeLog(r, photoCounts.get(String(r.id)) || 0))
      .filter((r) => !q
        || r.equipment_label.toLowerCase().includes(q)
        || r.area_label.toLowerCase().includes(q)
        || r.item_label.toLowerCase().includes(q)
        || r.material_name.toLowerCase().includes(q)
        || r.recorded_by.toLowerCase().includes(q)
        || r.log_kind_label.toLowerCase().includes(q)
        || r.note.toLowerCase().includes(q));

    return Response.json({
      readings: shaped,
      counts: {
        total: Number(counts?.total) || 0,
        fails: Number(counts?.fails) || 0,
        unjudged: Number(counts?.unjudged) || 0,
        verified: Number(counts?.verified) || 0,
        voided: Number(counts?.voided) || 0,
      },
      vocab: {
        kinds: FSSAI_TEMP_LOG_KINDS,
        sources: FSSAI_TEMP_SOURCES,
        uoms: FSSAI_TEMP_UOMS,
        shifts: FSSAI_SHIFTS,
        statuses: FSSAI_RECORD_STATUSES,
      },
      is_management: mgmt,
      me: me.email || '',
      today: fssaiToday(),
      earliest_backdate: addDaysISO(fssaiToday(), -FSSAI_BACKDATE_DAYS),
      truncated: rows.length >= LIST_LIMIT,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/temperature failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the temperature log' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const action = str(body?.action) || 'record';

    /* ══════════════════════════════════════════════════════════════════════
     * RECORD — the write path this whole phase exists for.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'record') {
      const logKind = str(body?.log_kind) || 'equipment';
      if (!isFssaiTempLogKind(logKind)) {
        return Response.json({ error: `"${logKind}" is not a kind of temperature reading.` }, { status: 400 });
      }
      const kindMeta = FSSAI_TEMP_LOG_KINDS.find((k) => k.key === logKind)!;

      const value = fssaiNum(body?.value_num);
      if (value === null) {
        /* REFUSED, not stored as NULL. A reading with no number is not a record of
         * anything, and a row that looked like a check but held no value would be
         * the worst kind of entry in a compliance file: evidence of diligence with
         * no content. (NULL is reserved for a column nobody was asked to fill.) */
        return Response.json(
          { error: 'Enter the temperature you read. A reading with no number says a check happened and proves nothing.', code: 'value_required' },
          { status: 400 },
        );
      }

      const uom = (str(body?.uom) || 'C').toUpperCase() === 'F' ? 'F' : 'C';
      if (!FSSAI_TEMP_UOMS.some((u) => u.key === uom)) {
        return Response.json({ error: 'A temperature must be in °C or °F.' }, { status: 400 });
      }

      /* A NUMBER NOBODY COULD HAVE READ is refused before anything is judged —
       * a typing guard, not a safety rule (fssaiTempImplausible). Measured: a
       * cooling −45 (for 45) closed its batch as reached; a reheat 750 passed. */
      const implausible = fssaiTempImplausible(logKind, value, uom);
      if (implausible) {
        return Response.json(
          {
            error: `${value} °${uom} cannot be a ${fssaiTempLogKindLabel(logKind).toLowerCase()} reading — it has to be between ${implausible.min} and ${implausible.max} °${implausible.uom}. Check the minus sign and the decimal point, and enter it again.`,
            code: 'implausible_value', min: implausible.min, max: implausible.max,
          },
          { status: 400 },
        );
      }

      /* Minutes typed for a cooling or reheating reading must be a whole number,
       * 0 or more — never silently read as "not given". On any other kind the
       * figure is ignored, as before. */
      const tm = kindMeta.window_minutes ? typedMinutes(body?.elapsed_minutes) : { ok: true as const, value: null };
      if (!tm.ok) {
        return Response.json(
          { error: 'Minutes since the batch started must be a whole number, 0 or more — or leave it blank.', code: 'bad_minutes' },
          { status: 400 },
        );
      }

      const shift = str(body?.shift);
      if (!isFssaiShift(shift)) {
        return Response.json({ error: `"${shift}" is not one of the shifts.` }, { status: 400 });
      }

      /* ── WHAT WAS READ ───────────────────────────────────────────────────
       * A reading needs a subject. "17 °C" with nothing attached cannot be
       * audited, cannot be judged and cannot be put in front of anyone. */
      let equipmentId = str(body?.equipment_id);
      let areaLabel = str(body?.area_label).slice(0, 200);
      let itemLabel = str(body?.item_label).slice(0, 200);
      let materialId = str(body?.material_id);
      let equipmentLabel = '';
      let equipmentKind = '';
      let departmentId = str(body?.department_id);

      /* A BATCH PICKED FROM THE LIST carries its own subject. A reading added to
       * it that names no food takes the batch's food, and one that names no place
       * takes where the batch was last read — so "add the next reading" from the
       * batch panel works without retyping, and the resolver's same-food check
       * (fssaiCurveSubjectMismatch) has something to compare. A reading that DOES
       * name a food keeps it, and is refused there if it is a different one. */
      if (kindMeta.window_minutes && str(body?.curve_id)) {
        /* By a reading's id or by the batch's own key (fssaiCurveKeyOf). */
        const pick = fssaiCurveKeyOf(db, logKind, str(body.curve_id));
        if (pick && pick.kind === logKind) {
          const batchMembers = fssaiCurveMembers(db, logKind, pick.key);
          const bFirst = batchMembers[0];
          const bLast = batchMembers[batchMembers.length - 1];
          if (bFirst && bLast) {
            const namesFood = !!(itemLabel || materialId);
            const namesPlace = !!(equipmentId || areaLabel);
            if (!namesFood) { itemLabel = bFirst.item_label; materialId = bFirst.material_id; }
            if (!namesPlace) { equipmentId = bLast.equipment_id; areaLabel = bLast.area_label; }
            if (!departmentId) {
              const d = db.prepare(`SELECT department_id FROM fssai_temperature_logs WHERE id = ?`).get(bLast.id) as any;
              departmentId = str(d?.department_id);
            }
          }
        }
      }

      if (equipmentId) {
        const eq = db.prepare(
          `SELECT id, name, kind, department_id, is_active FROM fssai_equipment WHERE id = ?`,
        ).get(equipmentId) as any;
        if (!eq) {
          return Response.json({ error: 'That unit is not on the equipment register.' }, { status: 400 });
        }
        if (!Number(eq.is_active)) {
          /* A RETIRED UNIT IS REFUSED FOR A NEW READING but keeps its history.
           * Allowing it would quietly reopen a unit an admin took out of use, and
           * the retire had to carry a reason precisely because somebody would
           * notice the gap. */
          return Response.json(
            { error: `"${String(eq.name)}" has been retired from the register, so a new reading cannot be filed against it. An administrator can put it back into use.`, code: 'unit_retired' },
            { status: 409 },
          );
        }
        equipmentLabel = String(eq.name || '');
        equipmentKind = String(eq.kind || '');
        // The unit's department unless the caller named one: a reading inherits
        // where the thing lives, which is what makes the visibility clause work.
        departmentId = departmentId || String(eq.department_id || '');
      }

      if (!equipmentId && !areaLabel && !itemLabel && !materialId) {
        return Response.json(
          {
            error: 'Say what was read — pick a unit, or name the food or the place. A temperature with nothing attached to it cannot be checked by anybody later.',
            code: 'subject_required',
          },
          { status: 400 },
        );
      }

      if (materialId) {
        const mat = db.prepare(`SELECT id, name FROM raw_materials WHERE id = ?`).get(materialId) as any;
        if (!mat) return Response.json({ error: 'That item is not in the item list.' }, { status: 400 });
      }
      if (departmentId) {
        const dept = db.prepare(`SELECT id FROM departments WHERE id = ?`).get(departmentId) as any;
        if (!dept) return Response.json({ error: 'That department does not exist.' }, { status: 400 });
      }

      /* ── WHEN ────────────────────────────────────────────────────────────
       * §7 Q9 PROVISIONAL DEFAULT (the owner has NOT ruled): a record may be
       * backdated by one day with a mandatory reason. P4 keeps the window and the
       * reason. These tables have no `is_backdated` column and this lane may not
       * add one, so the flag goes into the AUDIT ROW — which is where §19 wants
       * "reason for change" anyway. Recorded in FSSAI-BUILD-STATE.md §7.
       */
      const today = fssaiToday();
      const businessDate = isISODate(str(body?.business_date)) ? str(body.business_date) : today;
      const daysBack = daysBetweenISO(businessDate, today);
      if (!Number.isFinite(daysBack) || daysBack < 0) {
        return Response.json(
          { error: 'A reading cannot be dated in the future.', code: 'future_date' },
          { status: 400 },
        );
      }
      const backdateReason = str(body?.backdate_reason).slice(0, 1000);
      if (daysBack > FSSAI_BACKDATE_DAYS) {
        return Response.json(
          {
            error: `A reading can be dated today or yesterday. ${businessDate} is ${daysBack} days back — a manager can record what happened in a note on today's entry, but the file should not claim a reading was taken on a day nobody took it.`,
            code: 'too_old',
          },
          { status: 400 },
        );
      }
      if (daysBack > 0 && backdateReason.length < 4) {
        return Response.json(
          { error: 'Say why this reading is being entered for an earlier day.', code: 'backdate_reason_required' },
          { status: 400 },
        );
      }

      /* ── THE RANGE, RESOLVED ONCE AND FROZEN ─────────────────────────────── */
      const range = resolveFssaiRange(db, { logKind, equipmentId, equipmentKind, materialId, uom });

      /* ⚠️ THE UNIT MISMATCH, AND WHY IT IS A REFUSAL AND NOT A CONVERSION.
       * A rule written in °C and a reading taken in °F are both valid, and
       * comparing 40 (F) against a 0–5 (C) range passes a fridge that is actually
       * at 4.4 °C only by accident. `fssaiTempInC` exists and could convert — but
       * then `min_used` / `max_used` would be frozen in one unit and `value_num`
       * in another, and the record would print a range that was never applied to
       * the number beside it. So the person is told, and chooses. */
      const rangeIsTemp = range.uom === 'C' || range.uom === 'F';
      if (range.source !== 'none' && rangeIsTemp && range.uom !== uom) {
        return Response.json(
          {
            error: `The rule for this is written in °${range.uom} and the reading was entered in °${uom}. Enter it in °${range.uom} so the record shows the range that was actually applied to the number beside it.`,
            code: 'uom_mismatch', expected_uom: range.uom,
          },
          { status: 400 },
        );
      }

      const typedElapsed = tm.value;
      /* The clock only applies to the two kinds the FSSAI rule is a RATE for. A
       * number typed on a fridge reading is ignored rather than silently judged. */
      const clockApplies = !!kindMeta.window_minutes;
      const maxMinutesUsed = clockApplies ? range.max_minutes : null;

      const id = generateId();
      const readingAt = fssaiClock(body?.reading_at)
        || new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

      /* A TIME IN THE FUTURE is refused, like a date in the future. Measured
       * 2026-10-15: a cooling reading at the target timed three hours ahead was
       * filed, closed its batch as "reached in time" (so the overdue job skipped
       * it), and every real reading after it was refused as out of order. */
      if (businessDate === today) {
        const nowMinute = fssaiNowMinuteIST();
        const atMinute = fssaiClockMinute(businessDate, readingAt);
        if (nowMinute !== null && atMinute !== null && atMinute > nowMinute + FSSAI_FUTURE_TIME_TOLERANCE_MINUTES) {
          return Response.json(
            { error: `${readingAt} today has not happened yet. Enter the time the reading was actually taken.`, code: 'future_time' },
            { status: 400 },
          );
        }
      }

      /* ── ONE BATCH, ONE CURVE ────────────────────────────────────────────
       * A cooling or reheating reading is placed on its batch's curve, and its
       * minutes are COUNTED from that batch's first reading — never typed per
       * reading. The first reading is also where the schedule line starts, which
       * is what lets a reading taken half-way down be judged against where it
       * should be by then instead of against the final target. */
      let curve: FssaiCurveResolution | null = null;
      if (clockApplies) {
        curve = resolveFssaiCurve(db, {
          logKind,
          curveId: str(body?.curve_id),
          batchId: str(body?.batch_id),
          newCurve: body?.new_curve === true,
          typedElapsed,
          businessDate,
          readingAt,
          uom,
          maxMinutes: maxMinutesUsed,
          subject: { equipmentId, materialId, itemLabel, areaLabel, outletId },
          value,
          anchor: range.start_value,
          /* The rule's target now — the goal of a batch begun before the rule. */
          goal: range.target !== null ? range.target : (kindMeta.direction === 'hot' ? range.min : range.max),
          /* "Moved here" — the only way a picked batch takes a reading at another place. */
          moved: body?.moved === true,
        });
        if (!curve.ok) {
          return Response.json(
            { error: curve.error, code: curve.code, ...(curve.curve_id ? { curve_id: curve.curve_id, curve_label: curve.curve_label || '' } : {}) },
            { status: curve.status },
          );
        }
      }
      const placed = curve && curve.ok ? curve : null;
      const elapsed = placed ? placed.elapsed : null;

      /* ONE RULE PER BATCH (2026-10-15). A reading JOINING a batch is judged on
       * the rule frozen on the batch's first reading — its time limit, target and
       * bounds — not on whatever the rule says now. Measured: an admin lengthened
       * cooling from 240 to 480 minutes half-way through a batch, and 10 °C at
       * minute 300 then passed, while the batch's own summary and the overdue job
       * still used 240. A batch whose first reading was never judged on a clock
       * (no rule then) takes the rule as it is now for its first reading that IS,
       * and every later reading copies THAT one (`placed.rule`, closing round
       * 2026-10-15 — the jobs and the batch summary read the same reading). */
      const batchRule = placed && placed.rule && placed.rule.max_minutes !== null ? placed.rule : null;
      const ruleUsed = batchRule
        ? {
          standard_id: batchRule.standard_id || range.standard_id,
          min: batchRule.min_used, max: batchRule.max_used, target: batchRule.target_used,
          max_minutes: batchRule.max_minutes as number | null,
        }
        : { standard_id: range.standard_id, min: range.min, max: range.max, target: range.target, max_minutes: maxMinutesUsed };
      const limitUsed = clockApplies ? ruleUsed.max_minutes : null;
      /* The curve's key goes in batch_id: the production batch when one was named,
       * otherwise the id of the curve's first reading — THIS reading, when it
       * starts one. Any other kind keeps whatever batch it was given. */
      const batchIdToStore = placed ? (placed.key || id) : str(body?.batch_id);

      /* WHERE THIS BATCH'S SCHEDULE LINE STARTS — at minute 0 and only there:
       * the batch's own 0-minute reading (this one, if it starts the batch at 0),
       * else the rule's starting temperature, else nowhere (and a reading short
       * of the target is then failed). The choice is FROZEN on the row below, so
       * voiding a reading or editing the rule later cannot move this verdict's
       * line. fssaiCurveLineStart is the one rule; see it for why a part-way
       * first reading can never be its own start. */
      const lineStart: FssaiCurveStart | null = placed
        ? fssaiCurveLineStart({ first: placed.start, ruled: placed.rule, self: { value, elapsed: placed.elapsed }, anchor: range.start_value, direction: kindMeta.direction })
        : null;
      /* The batch's own 0-minute reading, for the verdict's words only (its line
       * may start from the rule's stricter figure instead). */
      const firstValue = placed
        ? (placed.start ? ((placed.start.elapsed ?? 0) === 0 ? placed.start.value : null) : (placed.elapsed === 0 ? value : null))
        : null;

      const verdict = judgeFssaiReading({
        value,
        min: ruleUsed.min,
        max: ruleUsed.max,
        uomForWords: uom === 'C' || uom === 'F' ? `°${uom}` : uom,
        elapsedMinutes: elapsed,
        maxMinutes: limitUsed,
        target: ruleUsed.target,
        direction: kindMeta.direction,
        curveStart: lineStart ? { value: lineStart.value, elapsedMinutes: lineStart.minute, source: lineStart.source, firstValue } : null,
        /* This reading starts its batch at minute 0: the clock begins here. */
        batchStart: !!placed && !placed.start && placed.elapsed === 0,
        /* The batch already reached its target: judged on whether it is still there. */
        reachedBefore: placed && placed.reached
          ? { value: placed.reached.value, elapsed: placed.reached.elapsed, reading_at: placed.reached.reading_at }
          : null,
      });

      const actionTaken = str(body?.action_taken).slice(0, 2000);
      const note = str(body?.note).slice(0, 2000);

      /* A FAILURE MUST SAY WHAT WAS DONE. A record that says "the cold room was at
       * 11 °C" and nothing else is the entry an inspector opens first, and "we
       * noticed" is not a corrective action. The corrective action raised below is
       * the FOLLOW-UP; this is what happened in the moment. */
      if (verdict.is_fail && !actionTaken) {
        return Response.json(
          {
            error: `${verdict.fail_reason} Say what you did about it — moved the stock, called the engineer, threw it away. The follow-up job is raised automatically, but the file has to say what happened in the moment.`,
            code: 'action_taken_required',
            fail_reason: verdict.fail_reason,
          },
          { status: 400 },
        );
      }

      let raised: ReturnType<typeof raiseFssaiRecordCa> = null;
      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO fssai_temperature_logs
             (id, business_date, reading_at, shift, log_kind, source_kind,
              run_id, response_id, receiving_line_id,
              equipment_id, equipment_label, equipment_kind, area_label, department_id,
              material_id, item_label, batch_id, standard_id,
              value_num, uom, decimals, min_used, max_used, target_used,
              elapsed_minutes, max_minutes_used,
              is_fail, is_judged, fail_reason, action_taken, ca_id, note,
              status, recorded_by, recorded_name, outlet_id,
              curve_start_used, curve_start_minute, curve_start_source)
           VALUES (?, ?, ?, ?, ?, 'manual', '', '', '',
                   ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, '', ?,
                   'submitted', ?, ?, ?,
                   ?, ?, ?)`,
        ).run(
          id, businessDate, readingAt, shift, logKind,
          equipmentId, equipmentLabel, equipmentKind, areaLabel, departmentId,
          materialId, itemLabel, batchIdToStore, ruleUsed.standard_id,
          value, uom, range.decimals, ruleUsed.min, ruleUsed.max, ruleUsed.target,
          elapsed, limitUsed,
          verdict.is_fail, verdict.is_judged, verdict.fail_reason, actionTaken, note,
          me.email || '', me.name || '', outletId,
          lineStart ? lineStart.value : null, lineStart ? lineStart.minute : null, lineStart ? lineStart.source : '',
        );

        /* ── OWNER §4: OUT OF RANGE RAISES A CORRECTIVE ACTION ──────────────
         * Inside this transaction so an action can never exist against a reading
         * that was not stored. `raiseFssaiRecordCa` is itself best-effort and
         * returns null rather than throwing, so the opposite can happen — a
         * reading with no action — and that is the deliberate trade (§7 Q4): the
         * FAILURE is on the record in red either way. */
        if (verdict.is_fail) {
          const where = [equipmentLabel || areaLabel || itemLabel, shift].filter(Boolean).join(' · ');
          /* A cooling or reheating failure is about the FOOD — "Cooling behind
           * schedule — Chicken curry", not "— Kitchen": the place is where the pot
           * stood. Every other kind names the unit or place first, as before. */
          const subjectWords = clockApplies
            ? [itemLabel, equipmentLabel || areaLabel].filter(Boolean).join(' · ')
            : (equipmentLabel || areaLabel || itemLabel);
          raised = raiseFssaiRecordCa(db, {
            sourceKind: 'temperature',
            entityTable: 'fssai_temperature_logs',
            entityId: id,
            /* The title says WHICH rule failed (fssaiFailKindWords): "behind schedule",
             * "reached its target late", "went back past its target", … */
            title: `${fssaiTempLogKindLabel(logKind)} ${fssaiFailKindWords(verdict.fail_kind)} — ${subjectWords || 'unnamed'}`,
            description: [
              `${verdict.fail_reason}`,
              `Read as ${fssaiDisplayReading(value, range.decimals)} °${uom} at ${readingAt} on ${businessDate}${where ? ` (${where})` : ''}.`,
              batchRule
                ? `Judged against ${rangeWords(ruleUsed.min, ruleUsed.max, uom)}${limitUsed !== null ? ` within ${limitUsed} minutes` : ''} — the rule as it stood when this batch started.`
                : (range.source === 'none' ? '' : `Judged against ${rangeWords(range.min, range.max, uom)} — ${range.standard_label}.`),
              placed ? placed.how : '',
              actionTaken ? `Done at the time: “${actionTaken}”` : '',
              note ? `Note on the reading: “${note}”` : '',
            ].filter(Boolean).join(' '),
            /* URGENT for a cold unit, HIGH otherwise. A warm cold room is losing
             * stock and safety by the hour; a single out-of-range probe into one
             * dish is serious but not the building. Severity only sets the due
             * date (`fssaiCaDueDate`) and the sort order — it changes no rule. */
            severity: equipmentKind === 'cold_room' || equipmentKind === 'freezer' || equipmentKind === 'chiller'
              ? 'urgent' : 'high',
            equipmentId,
            departmentId,
            businessDate,
            actor: { ...me, name: me.name },
            outletId,
          });
          if (raised) {
            db.prepare(`UPDATE fssai_temperature_logs SET ca_id = ? WHERE id = ?`).run(raised.id, id);
          }
        }

        /* BEST-EFFORT AUDIT, and this is the §7 Q4 side of the line: this row is a
         * reading a member of staff really took, so it must survive a log write
         * that will not insert. (The supervisory decisions below — void, verify —
         * use the THROWING writer, exactly as the corrective-action route does.) */
        fssaiAuditBestEffort(db, {
          entity_table: 'fssai_temperature_logs', entity_id: id, action: 'create',
          after: {
            business_date: businessDate, reading_at: readingAt, log_kind: logKind,
            equipment_label: equipmentLabel, area_label: areaLabel, item_label: itemLabel,
            value_num: value, uom, min_used: ruleUsed.min, max_used: ruleUsed.max, target_used: ruleUsed.target,
            standard_id: ruleUsed.standard_id, is_judged: verdict.is_judged, is_fail: verdict.is_fail,
            fail_kind: verdict.fail_kind,
            ...(placed ? {
              batch_id: batchIdToStore, curve_mode: placed.mode, elapsed_minutes: elapsed,
              elapsed_typed: typedElapsed, max_minutes_used: limitUsed,
              moved_here: body?.moved === true,
              rule_frozen_from_batch: !!batchRule,
              ...(batchRule && (range.max_minutes !== batchRule.max_minutes || range.target !== batchRule.target_used)
                ? { rule_now: { max_minutes: range.max_minutes, target: range.target, min: range.min, max: range.max } } : {}),
              reached_before: placed.reached ? { id: placed.reached.id, reading_at: placed.reached.reading_at, elapsed: placed.reached.elapsed } : null,
              curve_start_id: placed.start ? placed.start.id : id,
              curve_start_used: lineStart ? lineStart.value : null,
              curve_start_minute: lineStart ? lineStart.minute : null,
              curve_start_source: lineStart ? lineStart.source : '',
            } : {}),
          },
          reason: daysBack > 0
            ? `Entered for ${businessDate}, ${daysBack} day(s) back. Reason given: ${backdateReason}`
            : (verdict.is_fail ? `Out of range: ${verdict.fail_reason}` : 'Reading recorded'),
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      });
      tx();

      /* A PHOTOGRAPH, IF ONE CAME WITH IT — outside the transaction on purpose.
       * A 400 KB data URI that will not store must not roll back the reading. */
      let photo: any = null;
      if (str(body?.photo_data_uri)) {
        const w = writeFssaiAttachment(db, {
          entityTable: 'fssai_temperature_logs', entityId: id, kind: 'photo',
          dataUri: str(body.photo_data_uri), filename: str(body?.photo_filename),
          caption: str(body?.photo_caption), actorEmail: me.email, outletId,
        });
        photo = w.ok ? { ok: true, id: w.id, bytes: w.bytes } : { ok: false, error: w.error };
      }

      const row = db.prepare(`${LOG_SELECT} WHERE t.id = ?`).get(id) as any;
      const r: any = raised;
      return Response.json({
        ok: true,
        reading: shapeLog(row, photo?.ok ? 1 : 0),
        corrective_action: r ? { id: r.id, ca_number: r.ca_number, due_date: r.due_date, severity: r.severity } : null,
        photo,
        /* Which batch this reading went onto, and the minutes the file counted —
         * so the person can see at once if it joined the wrong pot. */
        curve: placed ? {
          id: batchIdToStore,
          mode: placed.mode,
          elapsed_minutes: elapsed,
          elapsed_typed: typedElapsed,
          max_minutes: limitUsed,
          /* true = judged on the rule frozen when the batch started. */
          rule_frozen_from_batch: !!batchRule,
          reached_before: placed.reached ? { id: placed.reached.id, reading_at: placed.reached.reading_at, elapsed_minutes: placed.reached.elapsed } : null,
          start: placed.start
            ? { id: placed.start.id, business_date: placed.start.business_date, reading_at: placed.start.reading_at, value_num: placed.start.value }
            : { id, business_date: businessDate, reading_at: readingAt, value_num: value },
          /* Where this verdict's schedule line started, as frozen on the row. */
          line_start: lineStart,
          how: placed.how,
        } : null,
        /* THE ONE SENTENCE THAT MUST NOT BE LEFT TO THE SCREEN. An unjudged
         * reading is NOT a pass, and the person who just took it is the person who
         * most needs to know that. */
        note_to_staff: [
          verdict.is_judged
            ? (verdict.is_fail
              ? `Recorded as a failure. ${r ? `A follow-up job (${r.ca_number}) has been raised and is due by ${r.due_date}.` : 'The follow-up job could not be raised — tell a manager; the failure is on the record either way.'}`
              : `Recorded. ${verdict.why}`)
            : (range.source === 'none'
              ? 'Recorded, but nothing judged it: no safe range has been set for this. It is NOT counted as a pass. Ask an administrator to set the range on the unit or add a rule in Settings.'
              : `Recorded, but not judged. ${verdict.why}`),
          placed ? placed.how : '',
        ].filter(Boolean).join(' '),
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * VOID — §19's "void, never delete", with a written reason.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'void') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which reading? No id was sent.' }, { status: 400 });
      const row = db.prepare(`SELECT * FROM fssai_temperature_logs WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That reading is no longer in the file.' }, { status: 404 });

      const reason = str(body?.reason).slice(0, 2000);
      /* ONE SHARED RULE FOR EVERY REGISTER, so eight lanes cannot each drop a
       * different half of it: management only, never the recorder, reason >= 4
       * characters. The refusal comes back in words from the shared helper. */
      const refusal = fssaiVoidRefusal(me, { status: row.status, voided_at: row.voided_at }, reason);
      if (refusal) {
        return Response.json(
          { error: refusal, code: reason.trim().length < 4 ? 'reason_required' : 'not_allowed' },
          { status: reason.trim().length < 4 ? 400 : 403 },
        );
      }
      /* ⚠️ THE HALF `fssaiVoidRefusal` CANNOT ENFORCE. It takes no "who recorded
       * it" argument, so the "never the person who wrote it" rule — which the
       * helper's own comment states as its reason for being management-only — has
       * to be applied here against this table's column. The person who wrote a
       * failing reading is exactly the person with a motive to make it go away,
       * even when that person is a manager. */
      if (String(me.email || '').trim().toLowerCase() === String(row.recorded_by || '').trim().toLowerCase()) {
        return Response.json(
          {
            error: 'You recorded this reading, so you cannot be the one to strike it out. Ask another manager — the point of a void is that somebody else agreed it was entered wrongly.',
            code: 'own_record',
          },
          { status: 403 },
        );
      }

      const tx = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_temperature_logs
              SET status='void', voided_at=datetime('now'), voided_by=?, void_reason=?,
                  updated_at=datetime('now')
            WHERE id=? AND status <> 'void'`,
        ).run(me.email || '', reason, id);
        if (res.changes !== 1) throw new Error('FSSAI_TEMP_MOVED');
        // THROWING writer: this is a supervisory decision, not a staff member's
        // work, so a void with no trail is rolled back rather than applied.
        fssaiAudit(db, {
          entity_table: 'fssai_temperature_logs', entity_id: id, action: 'void',
          field: 'status',
          before: { status: row.status, value_num: fssaiNum(row.value_num), is_fail: Number(row.is_fail) ? 1 : 0 },
          after: { status: 'void', voided_by: me.email || '' },
          reason,
          actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id || '',
        });
      });
      try { tx(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_TEMP_MOVED') {
          return Response.json({ error: 'That reading has already been voided.', code: 'already_moved' }, { status: 409 });
        }
        throw e;
      }

      fssaiAppAudit(db, {
        event_type: 'fssai.temperature.void', entity_type: 'fssai_temperature_logs', entity_id: id,
        actor_email: me.email, before: { status: row.status }, after: { status: 'void' }, note: reason,
      });

      const out = db.prepare(`${LOG_SELECT} WHERE t.id = ?`).get(id) as any;
      return Response.json({
        ok: true,
        reading: shapeLog(out),
        /* SAID OUT LOUD because it is the thing a manager will assume wrongly. */
        note: Number(row.is_fail) && String(row.ca_id || '')
          ? 'Voided with your reason on it. The follow-up job this failure raised is still open — a void says the reading was entered wrongly, not that the fridge was fine. Cancel that job separately if it should not have been raised.'
          : 'Voided with your reason on it. Nothing is removed from the file: the reading stays, struck out, with who voided it and why.',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * VERIFY — the second pair of eyes (§7 Q3), and it changes nothing.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'verify') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which reading? No id was sent.' }, { status: 400 });
      const row = db.prepare(`SELECT * FROM fssai_temperature_logs WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That reading is no longer in the file.' }, { status: 404 });

      if (String(row.status) !== 'submitted') {
        return Response.json(
          {
            error: String(row.status) === 'verified'
              ? 'That reading has already been checked.'
              : 'A voided reading cannot be checked off.',
            code: 'already_moved',
          },
          { status: 409 },
        );
      }
      /* §7 Q3's rule, with its second half intact: any management may verify, but
       * NEVER the person who recorded it. `canVerifyFssai` holds both halves. */
      if (!canVerifyFssai(me, row.recorded_by)) {
        const own = String(me.email || '').toLowerCase() === String(row.recorded_by || '').toLowerCase();
        return Response.json(
          {
            error: own
              ? 'You recorded this reading, so somebody else has to check it. That is the whole point of a second pair of eyes.'
              : 'Only a manager, head of department or administrator can check a recorded reading.',
            code: own ? 'own_record' : 'not_allowed',
          },
          { status: 403 },
        );
      }

      const note = str(body?.note).slice(0, 2000);
      const tx = db.transaction(() => {
        /* ⚠️ THE UPDATE NAMES FOUR COLUMNS AND NOT ONE MORE. Verifying cannot
         * change what the record says — not the reading, not the verdict, not the
         * range that was applied. A caller who sends `value_num`, `is_fail` or
         * `min_used` in the body changes nothing, because nothing below reads them.
         * This is the same construction `/api/fssai/approvals` uses, and it was
         * proved there by a tampering POST leaving the digest byte-identical. */
        const res = db.prepare(
          `UPDATE fssai_temperature_logs
              SET status='verified', verified_by=?, verified_at=datetime('now'),
                  updated_at=datetime('now')
            WHERE id=? AND status='submitted'`,
        ).run(me.email || '', id);
        if (res.changes !== 1) throw new Error('FSSAI_TEMP_MOVED');
        fssaiAudit(db, {
          entity_table: 'fssai_temperature_logs', entity_id: id, action: 'verify',
          field: 'status',
          before: { status: 'submitted' },
          after: { status: 'verified', verified_by: me.email || '' },
          reason: note || 'Checked and accepted',
          actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id || '',
        });
      });
      try { tx(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_TEMP_MOVED') {
          return Response.json({ error: 'Somebody has already decided on this reading.', code: 'already_moved' }, { status: 409 });
        }
        throw e;
      }

      const out = db.prepare(`${LOG_SELECT} WHERE t.id = ?`).get(id) as any;
      return Response.json({
        ok: true,
        reading: shapeLog(out),
        record_unchanged: 'Checking a reading does not change it. The number, the range applied to it and the verdict read exactly as they did.',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * ATTACH — a photograph of the probe display or the unit.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'attach') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which reading? No id was sent.' }, { status: 400 });
      const row = db.prepare(
        `SELECT id, status, recorded_by, department_id, outlet_id FROM fssai_temperature_logs WHERE id = ?`,
      ).get(id) as any;
      if (!row) return Response.json({ error: 'That reading is no longer in the file.' }, { status: 404 });
      if (String(row.status) === 'void') {
        return Response.json({ error: 'A voided reading does not take new photographs.', code: 'voided' }, { status: 409 });
      }
      /* WHO MAY ADD ONE: the person who took the reading, or management. A
       * photograph is evidence about somebody else's check otherwise. */
      const mine = String(me.email || '').toLowerCase() === String(row.recorded_by || '').toLowerCase();
      if (!mine && !isManagement(me)) {
        return Response.json(
          { error: 'Only the person who took this reading, or a manager, can attach a photograph to it.', code: 'not_allowed' },
          { status: 403 },
        );
      }
      /* FOUR PER READING, the same budget as a checklist answer
       * (FSSAI_PHOTO_* in src/lib/fssai.ts). Not a new rule — the same one. */
      /* A VOIDED photograph stays on the record but no longer takes a slot. */
      const have = Number((db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_attachments
          WHERE entity_table='fssai_temperature_logs' AND entity_id=? AND status <> 'void'`,
      ).get(id) as any)?.n) || 0;
      if (have >= 4) {
        return Response.json(
          { error: 'Four photographs is the limit on one reading. Remove one if you need a different picture.', code: 'too_many' },
          { status: 409 },
        );
      }
      const w = writeFssaiAttachment(db, {
        entityTable: 'fssai_temperature_logs', entityId: id, kind: str(body?.kind) || 'photo',
        dataUri: str(body?.data_uri), filename: str(body?.filename), caption: str(body?.caption),
        actorEmail: me.email, outletId: outletId || row.outlet_id || '',
      });
      if (!w.ok) return Response.json({ error: w.error }, { status: w.status });
      fssaiAuditBestEffort(db, {
        entity_table: 'fssai_temperature_logs', entity_id: id, action: 'update',
        field: 'attachment', after: { attachment_id: w.id, bytes: w.bytes },
        reason: 'Photograph attached', actor: { email: me.email, name: me.name },
        outlet_id: outletId || row.outlet_id || '',
      });
      return Response.json({ ok: true, id: w.id, bytes: w.bytes, photo_count: have + 1 });
    }

    return Response.json(
      { error: `"${action}" is not something that can be done to a temperature reading. Use record, void, verify or attach.` },
      { status: 400 },
    );
  } catch (e: any) {
    console.error('POST /api/fssai/temperature failed:', e);
    return Response.json({ error: e?.message || 'Failed to record that' }, { status: 500 });
  }
}

/* No DELETE and no edit. A reading entered wrongly is VOIDED by management with a
 * written reason and a fresh one is taken; the file then shows both, which is the
 * only way a register can say what changed and why (owner §19). A register whose
 * history can be edited is not a register. */
