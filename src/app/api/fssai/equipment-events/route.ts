/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  FSSAI_EQUIPMENT_EVENT_KINDS, FSSAI_EQUIPMENT_KINDS, FSSAI_TEMP_UOMS,
  FSSAI_RECORD_STATUSES, fssaiVoidRefusal, fssaiToday, isISODate, addDaysISO,
  daysBetweenISO, fssaiRecordStatusMeta, fssaiDisplayReading, fssaiRangeCheck,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAuditBestEffort, fssaiAppAudit,
  str, FSSAI_NO_MATCH,
} from '@/lib/fssai-server';
import {
  writeFssaiAttachment, fssaiAttachmentCounts, fssaiRecordVisibility, fssaiClock,
  fssaiNum, fssaiInt, FSSAI_BACKDATE_DAYS,
} from '../_p4/lib';

/**
 * WHAT HAPPENED TO A UNIT (/api/fssai/equipment-events) — the other half of the
 * cold-room file.
 *
 * A temperature log says what a unit READ. This says what was DONE to it:
 * defrosted, deep-cleaned, broke down, was mended, was taken out of use, put back,
 * had its filter changed — and, the one an inspector always asks for, had its
 * THERMOMETER CHECKED AGAINST A KNOWN REFERENCE.
 *
 * ── WHY THIS IS NOT A TWELFTH TABLE PER EVENT ───────────────────────────────
 * Calibration lives here rather than in its own table because the shape is
 * identical to every other event: a before value, a known reference, an after
 * value and a verdict. A separate table would need its own CRUD for four columns.
 *
 * ── WHY THE CALIBRATION VERDICT IS COMPUTED HERE AND NOT FROM A STANDARD ────
 * A probe is judged against a TOLERANCE around a reference the person brings with
 * them (ice is 0 °C, boiling water is 100 °C at sea level), not against a stored
 * safe range for a fridge. `fssai_temp_standards` has no tolerance column and this
 * lane may not add one, so the tolerance arrives on the request, defaults to the
 * figure in `CALIBRATION_TOLERANCE_C` below, and — critically — the DEVIATION and
 * the verdict are FROZEN onto the row (`deviation`, `is_fail`) at write. Changing
 * the default tomorrow cannot re-grade a probe that passed.
 *
 * ── A BREAKDOWN IS NOT A FAILED CHECK ───────────────────────────────────────
 * `is_fail` on this table means "this event records something wrong with the unit"
 * — a breakdown, or a probe outside tolerance. It does NOT mean a reading failed;
 * that lives on `fssai_temperature_logs`. Keeping them apart is what lets a report
 * say "the freezer failed twice and was mended once" instead of counting the
 * repair as a third failure.
 *
 * ── NO DELETE, NO EDIT (owner §19) ──────────────────────────────────────────
 * An event is VOIDED by management with a written reason. There is no edit action
 * and no UPDATE of any value column — grep below, the only UPDATEs name `status`
 * and the void trio.
 *
 *   GET  ?id=<id>                                     one event with its photographs
 *   GET  ?due=1                                       what is overdue or coming up
 *   GET  [?equipment_id=&event_kind=&from=&to=&status=&fails=1&q=]
 *   POST { action: 'record' | 'void' | 'attach', … }
 */
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 300;

/**
 * HOW FAR OUT A PROBE MAY READ AND STILL PASS, in °C, when the caller does not say.
 *
 * ⚠️ A DEFAULT, NOT A RULE, and it is overridable per event (`tolerance`). It is
 * ±1 °C, which is the figure a food thermometer is normally expected to hold. It
 * is NOT read from `fssai_temp_standards` because that table has no tolerance
 * column, and inventing a second meaning for `min_value`/`max_value` there would
 * be a silent second convention on a table P5 also writes — exactly the
 * rival-helper trap. Named here, in one place, visible on the API response, and
 * frozen onto every row it judges. Raised in FSSAI-BUILD-STATE.md §7 for the owner.
 */
const CALIBRATION_TOLERANCE_C = 1;

const EVENT_SELECT = `
  SELECT v.id, v.equipment_id, v.equipment_label, v.event_kind, v.business_date, v.event_at,
         v.department_id, v.detail, v.performed_by, v.vendor_id, v.reference_no,
         v.downtime_minutes, v.value_before, v.reference_value, v.value_after, v.deviation,
         v.uom, v.is_fail, v.next_due_date, v.document_id, v.ca_id, v.status,
         v.voided_at, v.voided_by, v.void_reason, v.created_by, v.outlet_id,
         v.created_at, v.updated_at,
         IFNULL(d.name,'')  AS department_name,
         IFNULL(e.name,'')  AS equipment_name_now,
         IFNULL(e.kind,'')  AS equipment_kind,
         IFNULL(ve.name,'') AS vendor_name
    FROM fssai_equipment_events v
    LEFT JOIN departments d ON d.id = v.department_id
    LEFT JOIN fssai_equipment e ON e.id = v.equipment_id
    LEFT JOIN vendors ve ON ve.id = v.vendor_id`;

function shapeEvent(row: any, photoCount = 0) {
  const kind = String(row.event_kind || '');
  return {
    id: String(row.id),
    equipment_id: String(row.equipment_id || ''),
    /* The frozen label leads, as on the temperature log: an event must keep
     * naming the unit it happened to even after the unit is renamed or retired. */
    equipment_label: String(row.equipment_label || ''),
    equipment_name_now: String(row.equipment_name_now || ''),
    equipment_kind: String(row.equipment_kind || ''),
    equipment_kind_label: FSSAI_EQUIPMENT_KINDS.find((k) => k.key === String(row.equipment_kind))?.label || '',
    event_kind: kind,
    event_kind_label: FSSAI_EQUIPMENT_EVENT_KINDS.find((k) => k.key === kind)?.label || kind,
    business_date: String(row.business_date || ''),
    event_at: String(row.event_at || ''),
    department_id: String(row.department_id || ''),
    department_name: String(row.department_name || ''),
    detail: String(row.detail || ''),
    performed_by: String(row.performed_by || ''),
    vendor_id: String(row.vendor_id || ''),
    vendor_name: String(row.vendor_name || ''),
    reference_no: String(row.reference_no || ''),
    downtime_minutes: fssaiInt(row.downtime_minutes),
    value_before: fssaiNum(row.value_before),
    reference_value: fssaiNum(row.reference_value),
    value_after: fssaiNum(row.value_after),
    deviation: fssaiNum(row.deviation),
    display_deviation: fssaiDisplayReading(fssaiNum(row.deviation), 1),
    uom: String(row.uom || 'C'),
    is_fail: Number(row.is_fail) ? 1 : 0,
    next_due_date: String(row.next_due_date || ''),
    /* Derived on EVERY read, never stored: a stored "overdue" goes stale at
     * midnight, and a service rendering "due" the day after it lapsed is the kind
     * of row that makes a whole register untrustworthy. (The same reasoning
     * `fssaiDocState` carries for a licence.) */
    is_overdue: !!String(row.next_due_date || '')
      && isISODate(String(row.next_due_date))
      && String(row.next_due_date) < fssaiToday()
      && String(row.status || '') !== 'void',
    document_id: String(row.document_id || ''),
    ca_id: String(row.ca_id || ''),
    status: String(row.status || 'submitted'),
    status_label: fssaiRecordStatusMeta(row.status).label,
    voided_at: String(row.voided_at || ''),
    voided_by: String(row.voided_by || ''),
    void_reason: String(row.void_reason || ''),
    created_by: String(row.created_by || ''),
    created_at: String(row.created_at || ''),
    photo_count: photoCount,
  };
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;
  const mgmt = isManagement(me);

  try {
    const db = getDb();
    const url = new URL(request.url);

    /* ══ ONE EVENT ══════════════════════════════════════════════════════════ */
    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(`${EVENT_SELECT} WHERE v.id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That entry is no longer in the file.' }, { status: 404 });
      if (!mgmt) {
        const dept = String(row.department_id || '');
        const mine = String(me.email || '').toLowerCase() === String(row.created_by || '').toLowerCase();
        if (dept && dept !== me.department_id && !mine) {
          return Response.json({ error: 'That entry belongs to another department.' }, { status: 403 });
        }
      }
      const photos = db.prepare(
        `SELECT id, kind, mime, size_bytes, caption, filename, created_by, created_at,
                (data_uri <> '') AS has_image
           FROM fssai_attachments
          WHERE entity_table = 'fssai_equipment_events' AND entity_id = ?
          ORDER BY created_at ASC`,
      ).all(id) as any[];
      return Response.json({
        event: shapeEvent(row, photos.length),
        photos: photos.map((p) => ({
          id: String(p.id), kind: String(p.kind || 'photo'), mime: String(p.mime || ''),
          size_bytes: Number(p.size_bytes) || 0, caption: String(p.caption || ''),
          filename: String(p.filename || ''), created_by: String(p.created_by || ''),
          created_at: String(p.created_at || ''), has_image: Number(p.has_image) ? 1 : 0,
        })),
        cannot_change: 'An entry cannot be edited. If it was written wrongly a manager voids it with a reason and a fresh one is written — the file then shows both.',
      });
    }

    /* ══ ONE PHOTOGRAPH ═════════════════════════════════════════════════════ */
    const photoId = str(url.searchParams.get('photo_id'));
    if (photoId) {
      const p = db.prepare(
        `SELECT a.id, a.data_uri, a.mime, a.caption, a.size_bytes, a.image_dropped_at,
                v.department_id, v.created_by
           FROM fssai_attachments a
           JOIN fssai_equipment_events v ON v.id = a.entity_id
          WHERE a.id = ? AND a.entity_table = 'fssai_equipment_events'`,
      ).get(photoId) as any;
      if (!p) return Response.json({ error: 'That photograph is no longer in the file.' }, { status: 404 });
      if (!mgmt) {
        const dept = String(p.department_id || '');
        const mine = String(me.email || '').toLowerCase() === String(p.created_by || '').toLowerCase();
        if (dept && dept !== me.department_id && !mine) {
          return Response.json({ error: 'That photograph belongs to another department.' }, { status: 403 });
        }
      }
      return Response.json({
        id: String(p.id), data_uri: String(p.data_uri || ''), mime: String(p.mime || ''),
        caption: String(p.caption || ''), size_bytes: Number(p.size_bytes) || 0,
        image_dropped_at: String(p.image_dropped_at || ''),
      });
    }

    /* ══ WHAT IS OVERDUE, AND WHAT IS COMING ════════════════════════════════
     * The LATEST next-due date per (unit, event kind) and nothing older, because a
     * unit serviced in March and again in September has two rows carrying two due
     * dates and only the later one is a real obligation. A list that showed both
     * would print a permanent overdue for a unit that is perfectly up to date —
     * the shape that teaches people to ignore a register.
     * ════════════════════════════════════════════════════════════════════════ */
    if (url.searchParams.get('due') === '1') {
      const today = fssaiToday();
      const horizon = addDaysISO(today, 30);
      const rows = db.prepare(
        `SELECT equipment_id, equipment_label, event_kind, next_due_date, business_date, id,
                department_id, reference_no
           FROM (
             SELECT v.*, ROW_NUMBER() OVER (
                      PARTITION BY v.equipment_id, v.event_kind
                      ORDER BY v.next_due_date DESC, v.business_date DESC, v.rowid DESC
                    ) AS rn
               FROM fssai_equipment_events v
              WHERE v.status <> 'void' AND v.next_due_date <> ''
           )
          WHERE rn = 1 AND next_due_date <= ?
          ORDER BY next_due_date ASC`,
      ).all(horizon) as any[];
      return Response.json({
        today,
        horizon_days: 30,
        due: rows.map((r) => ({
          id: String(r.id),
          equipment_id: String(r.equipment_id || ''),
          equipment_label: String(r.equipment_label || ''),
          event_kind: String(r.event_kind || ''),
          event_kind_label: FSSAI_EQUIPMENT_EVENT_KINDS.find((k) => k.key === String(r.event_kind))?.label || String(r.event_kind || ''),
          next_due_date: String(r.next_due_date || ''),
          last_done: String(r.business_date || ''),
          reference_no: String(r.reference_no || ''),
          department_id: String(r.department_id || ''),
          days_late: daysBetweenISO(String(r.next_due_date), today),
          is_overdue: String(r.next_due_date) < today,
        })),
      });
    }

    /* ══ THE LIST ═══════════════════════════════════════════════════════════ */
    const where: string[] = [];
    const args: any[] = [];

    const equipmentId = str(url.searchParams.get('equipment_id'));
    if (equipmentId) { where.push('v.equipment_id = ?'); args.push(equipmentId); }

    const eventKind = str(url.searchParams.get('event_kind'));
    if (eventKind) {
      if (!FSSAI_EQUIPMENT_EVENT_KINDS.some((k) => k.key === eventKind)) {
        return Response.json({ error: `"${eventKind}" is not a kind of entry this register keeps.` }, { status: 400 });
      }
      where.push('v.event_kind = ?'); args.push(eventKind);
    }

    const from = str(url.searchParams.get('from'));
    const to = str(url.searchParams.get('to'));
    if (from) {
      if (!isISODate(from)) return Response.json({ error: 'That "from" date is not a real date.' }, { status: 400 });
      where.push('v.business_date >= ?'); args.push(from);
    }
    if (to) {
      if (!isISODate(to)) return Response.json({ error: 'That "to" date is not a real date.' }, { status: 400 });
      where.push('v.business_date <= ?'); args.push(to);
    }

    const status = str(url.searchParams.get('status')) || 'live';
    if (status === 'live') where.push(`v.status <> 'void'`);
    else if (status !== 'all') {
      if (!FSSAI_RECORD_STATUSES.some((s) => s.key === status)) {
        return Response.json({ error: `"${status}" is not a state an entry can be in.` }, { status: 400 });
      }
      where.push('v.status = ?'); args.push(status);
    }

    if (url.searchParams.get('fails') === '1') where.push('v.is_fail = 1');

    const vis = fssaiRecordVisibility(me, { department: 'v.department_id', recordedBy: 'v.created_by' }, mgmt, FSSAI_NO_MATCH);
    if (vis.sql) { where.push(vis.sql); args.push(...vis.args); }

    const rows = db.prepare(
      `${EVENT_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY v.business_date DESC, v.event_at DESC, v.created_at DESC, v.rowid DESC
       LIMIT ${LIST_LIMIT}`,
    ).all(...args) as any[];

    const photoCounts = fssaiAttachmentCounts(db, 'fssai_equipment_events', rows.map((r) => String(r.id)));
    const q = str(url.searchParams.get('q')).toLowerCase();
    const shaped = rows
      .map((r) => shapeEvent(r, photoCounts.get(String(r.id)) || 0))
      .filter((r) => !q
        || r.equipment_label.toLowerCase().includes(q)
        || r.detail.toLowerCase().includes(q)
        || r.performed_by.toLowerCase().includes(q)
        || r.vendor_name.toLowerCase().includes(q)
        || r.reference_no.toLowerCase().includes(q)
        || r.event_kind_label.toLowerCase().includes(q));

    return Response.json({
      events: shaped,
      counts: {
        total: shaped.length,
        fails: shaped.filter((e) => e.is_fail).length,
        overdue: shaped.filter((e) => e.is_overdue).length,
      },
      vocab: {
        event_kinds: FSSAI_EQUIPMENT_EVENT_KINDS,
        uoms: FSSAI_TEMP_UOMS,
        statuses: FSSAI_RECORD_STATUSES,
      },
      calibration_tolerance: CALIBRATION_TOLERANCE_C,
      is_management: mgmt,
      me: me.email || '',
      today: fssaiToday(),
      earliest_backdate: addDaysISO(fssaiToday(), -FSSAI_BACKDATE_DAYS),
      truncated: rows.length >= LIST_LIMIT,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/equipment-events failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the equipment register' }, { status: 500 });
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
     * RECORD
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'record') {
      const eventKind = str(body?.event_kind);
      if (!FSSAI_EQUIPMENT_EVENT_KINDS.some((k) => k.key === eventKind)) {
        return Response.json({ error: 'Say what kind of entry this is — a defrost, a breakdown, a repair, a calibration.' }, { status: 400 });
      }

      const equipmentId = str(body?.equipment_id);
      if (!equipmentId) {
        return Response.json({ error: 'Which unit is this about? An entry with no unit cannot be read later.' }, { status: 400 });
      }
      const eq = db.prepare(`SELECT id, name, kind, department_id, is_active FROM fssai_equipment WHERE id = ?`).get(equipmentId) as any;
      if (!eq) return Response.json({ error: 'That unit is not on the equipment register.' }, { status: 400 });
      /* ⚠️ A RETIRED UNIT IS ALLOWED HERE, unlike a temperature reading, and the
       * difference is deliberate: 'back_in_service' and a final repair are exactly
       * the entries a unit needs while it is out of use. A reading implies the unit
       * is in service; an event does not. */

      const detail = str(body?.detail).slice(0, 4000);
      if (!detail) {
        return Response.json(
          {
            error: 'Write down what was actually done. An entry that only says "defrost" tells an inspector nothing about whether the unit was emptied, cleaned or checked afterwards.',
            code: 'detail_required',
          },
          { status: 400 },
        );
      }

      const today = fssaiToday();
      const businessDate = isISODate(str(body?.business_date)) ? str(body.business_date) : today;
      const daysBack = daysBetweenISO(businessDate, today);
      if (!Number.isFinite(daysBack) || daysBack < 0) {
        return Response.json({ error: 'An entry cannot be dated in the future.', code: 'future_date' }, { status: 400 });
      }
      /* ⚠️ THE BACKDATE WINDOW IS WIDER HERE THAN ON A READING, AND THAT IS NOT
       * AN INCONSISTENCY. A reading is an observation of a moment: entering one for
       * last Tuesday is claiming somebody stood in front of a fridge on a day
       * nobody did, which is why §7 Q9's one-day window is right there. A repair is
       * a FACT WITH PAPER — a job sheet, an invoice, a certificate — and a
       * contractor's visit is routinely entered when the paperwork arrives a week
       * later. Refusing it would push the entry out of the file altogether, which
       * is the worse outcome. Still bounded (90 days), still demanding a reason
       * past the one-day mark, and the reason goes into the audit row.
       * Raised in FSSAI-BUILD-STATE.md §7 for the owner to confirm or narrow. */
      const EVENT_BACKDATE_DAYS = 90;
      if (daysBack > EVENT_BACKDATE_DAYS) {
        return Response.json(
          { error: `${businessDate} is ${daysBack} days back. Entries older than ${EVENT_BACKDATE_DAYS} days cannot be added — record it with today's date and say in the note when it happened.`, code: 'too_old' },
          { status: 400 },
        );
      }
      const backdateReason = str(body?.backdate_reason).slice(0, 1000);
      if (daysBack > FSSAI_BACKDATE_DAYS && backdateReason.length < 4) {
        return Response.json(
          { error: 'Say why this is being entered for an earlier day — "the job sheet arrived today" is enough.', code: 'backdate_reason_required' },
          { status: 400 },
        );
      }

      const nextDue = str(body?.next_due_date);
      if (nextDue && !isISODate(nextDue)) {
        return Response.json({ error: 'That next-due date is not a real date.' }, { status: 400 });
      }
      if (nextDue && nextDue < businessDate) {
        /* A due date BEFORE the thing was done would print as permanently overdue
         * the moment it was saved. Refused rather than stored, because an
         * always-red row is how a register stops being read. */
        return Response.json(
          { error: `The next one cannot be due on ${nextDue}, before this one happened on ${businessDate}. It would show as overdue the moment you saved it.` },
          { status: 400 },
        );
      }

      const vendorId = str(body?.vendor_id);
      if (vendorId) {
        const v = db.prepare(`SELECT id FROM vendors WHERE id = ?`).get(vendorId) as any;
        if (!v) return Response.json({ error: 'That contractor is not in the vendor list.' }, { status: 400 });
      }

      const uom = (str(body?.uom) || 'C').toUpperCase() === 'F' ? 'F' : 'C';
      const valueBefore = fssaiNum(body?.value_before);
      const referenceValue = fssaiNum(body?.reference_value);
      const valueAfter = fssaiNum(body?.value_after);
      const downtime = fssaiInt(body?.downtime_minutes);
      if (downtime !== null && downtime < 0) {
        return Response.json({ error: 'Downtime cannot be negative.' }, { status: 400 });
      }

      /* ── THE VERDICT, FROZEN ─────────────────────────────────────────────
       * TWO different meanings of `is_fail`, and both are explicit rather than
       * inferred:
       *   · a CALIBRATION fails when the probe read further from the reference
       *     than the tolerance allows. The deviation is stored so a report can
       *     show the drift over time without re-deriving it;
       *   · a BREAKDOWN is a failure by definition — the unit stopped holding
       *     temperature. Nothing else on this table is a failure: a defrost, a
       *     clean, a repair and a filter change are all things that went RIGHT.
       */
      let deviation: number | null = null;
      let isFail = 0;
      let failWhy = '';
      const tolerance = fssaiNum(body?.tolerance) ?? CALIBRATION_TOLERANCE_C;

      if (eventKind === 'calibration') {
        if (valueBefore === null || referenceValue === null) {
          return Response.json(
            {
              error: 'A calibration needs both numbers: what the thermometer read, and what it should have read. Ice is 0 °C and boiling water is 100 °C — without the pair there is nothing to compare.',
              code: 'calibration_values_required',
            },
            { status: 400 },
          );
        }
        if (!(tolerance > 0)) {
          return Response.json({ error: 'The tolerance has to be more than zero.' }, { status: 400 });
        }
        deviation = Number((valueBefore - referenceValue).toFixed(4));
        /* The shared range test, so the words match every other reading in the
         * module: within ±tolerance of the reference. Unrounded, deliberately —
         * rounding a 1.4 °C drift to 1 would pass a probe that is out. */
        const check = fssaiRangeCheck(valueBefore, referenceValue - tolerance, referenceValue + tolerance, `°${uom}`);
        isFail = check.out_of_range ? 1 : 0;
        failWhy = check.out_of_range
          ? `The thermometer read ${fssaiDisplayReading(valueBefore, 1)} °${uom} against a reference of ${fssaiDisplayReading(referenceValue, 1)} °${uom} — ${fssaiDisplayReading(Math.abs(deviation), 1)} °${uom} out, and the tolerance is ${tolerance} °${uom}.`
          : '';
        if (isFail && valueAfter === null && !/adjust|replac|discard|withdraw|out of use|repair/i.test(detail)) {
          /* A PROBE THAT FAILED AND WAS NOT DEALT WITH is the single most
           * consequential loose end on this table: every temperature in the file
           * taken with it is now suspect. So either the reading after adjustment is
           * given, or the note has to say what was done with it. */
          return Response.json(
            {
              error: `${failWhy} Say what you did with the thermometer — adjusted it, replaced it, took it out of use — or enter what it read after adjusting. Every temperature taken with this probe depends on the answer.`,
              code: 'calibration_outcome_required',
            },
            { status: 400 },
          );
        }
      } else if (eventKind === 'breakdown') {
        isFail = 1;
        failWhy = 'The unit stopped holding temperature.';
      }

      const id = generateId();
      const eventAt = fssaiClock(body?.event_at);

      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO fssai_equipment_events
             (id, equipment_id, equipment_label, event_kind, business_date, event_at,
              department_id, detail, performed_by, vendor_id, reference_no,
              downtime_minutes, value_before, reference_value, value_after, deviation,
              uom, is_fail, next_due_date, document_id, ca_id, status, created_by, outlet_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 'submitted', ?, ?)`,
        ).run(
          id, equipmentId, String(eq.name || ''), eventKind, businessDate, eventAt,
          str(body?.department_id) || String(eq.department_id || ''),
          detail,
          /* `performed_by` is free text ON PURPOSE: a defrost is done by a member
           * of staff (an email) and a repair by a contractor's engineer (a name
           * nobody in this app has an account for). §3's "no new employee master"
           * means this cannot become a people table, and `hr_employees` is empty
           * anyway (§7 Q18). Defaults to whoever is signed in. */
          str(body?.performed_by).slice(0, 200) || me.email || '',
          vendorId, str(body?.reference_no).slice(0, 120),
          downtime, valueBefore, referenceValue, valueAfter, deviation,
          uom, isFail, nextDue,
          me.email || '', outletId,
        );
        fssaiAuditBestEffort(db, {
          entity_table: 'fssai_equipment_events', entity_id: id, action: 'create',
          after: {
            equipment_id: equipmentId, equipment_label: String(eq.name || ''), event_kind: eventKind,
            business_date: businessDate, detail: detail.slice(0, 500), is_fail: isFail,
            value_before: valueBefore, reference_value: referenceValue, deviation,
            tolerance_used: eventKind === 'calibration' ? tolerance : null,
            next_due_date: nextDue,
          },
          reason: daysBack > FSSAI_BACKDATE_DAYS
            ? `Entered for ${businessDate}, ${daysBack} day(s) back. Reason given: ${backdateReason}`
            : (failWhy || 'Entry recorded'),
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      });
      tx();

      let photo: any = null;
      if (str(body?.photo_data_uri)) {
        const w = writeFssaiAttachment(db, {
          entityTable: 'fssai_equipment_events', entityId: id, kind: str(body?.photo_kind) || 'photo',
          dataUri: str(body.photo_data_uri), filename: str(body?.photo_filename),
          caption: str(body?.photo_caption), actorEmail: me.email, outletId,
        });
        photo = w.ok ? { ok: true, id: w.id, bytes: w.bytes } : { ok: false, error: w.error };
      }

      const row = db.prepare(`${EVENT_SELECT} WHERE v.id = ?`).get(id) as any;
      return Response.json({
        ok: true,
        event: shapeEvent(row, photo?.ok ? 1 : 0),
        photo,
        tolerance_used: eventKind === 'calibration' ? tolerance : null,
        note_to_staff: isFail
          ? `Recorded as a fault. ${failWhy}${eventKind === 'calibration' ? ' Readings already in the file keep the verdicts they were given — this entry is what tells a reader the probe was out.' : ''}`
          : (nextDue ? `Recorded. The next one is due on ${nextDue}.` : 'Recorded.'),
        /* STATED, because a reader will reasonably wonder. An out-of-tolerance
         * probe does not re-grade the readings taken with it, and pretending
         * otherwise would mean rewriting frozen verdicts — which this module never
         * does. The honest answer is that the calibration entry sits in the file
         * beside them. */
        records_unchanged: eventKind === 'calibration' && isFail
          ? 'This does not change any temperature already in the file. Their verdicts stay as they were given; this entry is what lets a reader see the probe was out when they were taken.'
          : '',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * VOID — §19, management only, with a reason, never the writer.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'void') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which entry? No id was sent.' }, { status: 400 });
      const row = db.prepare(`SELECT * FROM fssai_equipment_events WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That entry is no longer in the file.' }, { status: 404 });

      const reason = str(body?.reason).slice(0, 2000);
      const refusal = fssaiVoidRefusal(me, { status: row.status, voided_at: row.voided_at }, reason);
      if (refusal) {
        return Response.json(
          { error: refusal, code: reason.trim().length < 4 ? 'reason_required' : 'not_allowed' },
          { status: reason.trim().length < 4 ? 400 : 403 },
        );
      }
      // The half the shared helper cannot see — see the identical note in the
      // temperature route.
      if (String(me.email || '').trim().toLowerCase() === String(row.created_by || '').trim().toLowerCase()) {
        return Response.json(
          { error: 'You wrote this entry, so you cannot be the one to strike it out. Ask another manager.', code: 'own_record' },
          { status: 403 },
        );
      }

      const tx = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_equipment_events
              SET status='void', voided_at=datetime('now'), voided_by=?, void_reason=?,
                  updated_at=datetime('now')
            WHERE id=? AND status <> 'void'`,
        ).run(me.email || '', reason, id);
        if (res.changes !== 1) throw new Error('FSSAI_EVENT_MOVED');
        fssaiAudit(db, {
          entity_table: 'fssai_equipment_events', entity_id: id, action: 'void', field: 'status',
          before: { status: row.status, event_kind: row.event_kind, detail: String(row.detail || '').slice(0, 500) },
          after: { status: 'void', voided_by: me.email || '' },
          reason,
          actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id || '',
        });
      });
      try { tx(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_EVENT_MOVED') {
          return Response.json({ error: 'That entry has already been voided.', code: 'already_moved' }, { status: 409 });
        }
        throw e;
      }

      fssaiAppAudit(db, {
        event_type: 'fssai.equipment_event.void', entity_type: 'fssai_equipment_events', entity_id: id,
        actor_email: me.email, before: { status: row.status }, after: { status: 'void' }, note: reason,
      });

      const out = db.prepare(`${EVENT_SELECT} WHERE v.id = ?`).get(id) as any;
      return Response.json({
        ok: true,
        event: shapeEvent(out),
        note: String(row.next_due_date || '')
          ? 'Voided with your reason on it. It carried a next-due date, so the due list will now fall back to the entry before it — check that the unit is not quietly shown as up to date.'
          : 'Voided with your reason on it. Nothing is removed from the file.',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * ATTACH — the job sheet, the certificate, the photograph of the fault.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'attach') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which entry? No id was sent.' }, { status: 400 });
      const row = db.prepare(
        `SELECT id, status, created_by, department_id, outlet_id FROM fssai_equipment_events WHERE id = ?`,
      ).get(id) as any;
      if (!row) return Response.json({ error: 'That entry is no longer in the file.' }, { status: 404 });
      if (String(row.status) === 'void') {
        return Response.json({ error: 'A voided entry does not take new attachments.', code: 'voided' }, { status: 409 });
      }
      const mine = String(me.email || '').toLowerCase() === String(row.created_by || '').toLowerCase();
      if (!mine && !isManagement(me)) {
        return Response.json(
          { error: 'Only the person who wrote this entry, or a manager, can attach something to it.', code: 'not_allowed' },
          { status: 403 },
        );
      }
      const have = Number((db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_attachments WHERE entity_table='fssai_equipment_events' AND entity_id=?`,
      ).get(id) as any)?.n) || 0;
      if (have >= 4) {
        return Response.json({ error: 'Four attachments is the limit on one entry.', code: 'too_many' }, { status: 409 });
      }
      const w = writeFssaiAttachment(db, {
        entityTable: 'fssai_equipment_events', entityId: id, kind: str(body?.kind) || 'document',
        dataUri: str(body?.data_uri), filename: str(body?.filename), caption: str(body?.caption),
        actorEmail: me.email, outletId: outletId || row.outlet_id || '',
      });
      if (!w.ok) return Response.json({ error: w.error }, { status: w.status });
      fssaiAuditBestEffort(db, {
        entity_table: 'fssai_equipment_events', entity_id: id, action: 'update',
        field: 'attachment', after: { attachment_id: w.id, bytes: w.bytes },
        reason: 'Attachment added', actor: { email: me.email, name: me.name },
        outlet_id: outletId || row.outlet_id || '',
      });
      return Response.json({ ok: true, id: w.id, bytes: w.bytes, photo_count: have + 1 });
    }

    return Response.json(
      { error: `"${action}" is not something that can be done to an equipment entry. Use record, void or attach.` },
      { status: 400 },
    );
  } catch (e: any) {
    console.error('POST /api/fssai/equipment-events failed:', e);
    return Response.json({ error: e?.message || 'Failed to record that' }, { status: 500 });
  }
}

/* No DELETE and no edit. An entry written wrongly is VOIDED by management with a
 * written reason (owner §19) — the file then shows both the original and the
 * correction, which is the only way it can say what changed and why. */
