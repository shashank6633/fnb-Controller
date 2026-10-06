/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  canRunFssaiCheck, fssaiToday, fssaiRangeCheck, fssaiDisplayReading,
  FSSAI_OIL_METHODS, FSSAI_OIL_ACTIONS, FSSAI_OIL_TPM_LIMIT_PCT, FSSAI_SHIFTS,
  FSSAI_CHECK_RESULTS, isFssaiCheckResult, fssaiCheckResultIsFail,
  fssaiCheckResultAnswered, fssaiCheckResultLabel,
  fssaiRecordStatusMeta, isFssaiRecordStatus, fssaiVoidRefusal, isFssaiShift,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAuditBestEffort,
  fssaiAppAudit, str,
} from '@/lib/fssai-server';
import {
  P5_LIST_LIMIT, num, readBusinessDate, readClock, p5VisibilityClause, p5CanSee,
  attachP5Files, readP5AttachmentIndex, readP5Standard, raiseP5CorrectiveAction,
  voidP5Record, real, voidFields, p5UnjudgedNotice,
} from '../_p5/records';

/**
 * FRYER OIL (/api/fssai/oil) — owner §12.
 *
 * ── THE RULE THIS ROUTE EXISTS TO MAKE REAL ─────────────────────────────────
 * Frying oil above 25% total polar materials must not be used. That number is
 * NOT in this file and must never be: §5 says the limits are configurable, so
 * the limit comes out of fssai_temp_standards (applies_to 'oil', the seed's code
 * 'OIL-TPM') and the limit that was ACTUALLY applied is then FROZEN onto the
 * record as max_tpm_used. Tightening the standard next month therefore cannot
 * retrospectively fail a fryer that passed. FSSAI_OIL_TPM_LIMIT_PCT is imported
 * only to be OFFERED on the form as a starting figure — it is never a comparison
 * target, and the one place it appears below says so.
 *
 * ── THE GUARD THAT WOULD OTHERWISE NEVER FIRE, AND WHAT WAS DONE ABOUT IT ───
 * MEASURED: fssai_temp_standards holds NO rows. The seed that fills it is P8's
 * and the standards screen is P4's, so a route that could only judge against a
 * stored standard would write is_judged = 0 on every oil check for ever — a
 * guard that reads correctly and never fires, which is the exact pattern this
 * project has already paid for four times. So there are THREE honest states and
 * the record says which one it is in:
 *   1. a stored standard applies  → standard_id set, max_tpm_used frozen from it;
 *   2. no standard exists but the person doing the check types the limit their
 *      meter or SOP uses → standard_id '', max_tpm_used frozen from what they
 *      typed, which is auditable and is still not a hard-coded number;
 *   3. neither → the reading is kept and is_judged = 0, and every screen says
 *      out loud that nothing was judged (p5UnjudgedNotice).
 * A sensory check needs no limit at all: 'Not in order' on smell, foam or smoke
 * is a person's judgement and counts as a failure on its own.
 *
 *   GET  ?id=<check>
 *   GET  [?from=&to=&equipment_id=&status=&fail=1&q=]
 *   POST { action: 'record' | 'void', … }
 */
export const dynamic = 'force-dynamic';

/** The three sensory checkpoints, in the order the fryer is judged. */
const OIL_SENSORY = [
  { key: 'chk_smell', label: 'Smell', hint: 'Rancid, fishy or burnt.' },
  { key: 'chk_foaming', label: 'Foaming', hint: 'Foam that does not settle.' },
  { key: 'chk_smoking', label: 'Smoking', hint: 'Smoking below its normal frying temperature.' },
] as const;

/** See the note in the FIFO route: a stand-in reason, never written anywhere. */
const VOID_REASON_PROBE = '----';

const OIL_SELECT = `
  SELECT o.*, d.name AS department_name, e.name AS equipment_name, e.kind AS equipment_kind,
         rm.name AS material_name, st.code AS standard_code, st.label AS standard_label,
         c.ca_number AS ca_number, c.status AS ca_status,
         dp.business_date AS disposal_date, dp.receipt_no AS disposal_receipt
    FROM fssai_oil_checks o
    LEFT JOIN departments              d  ON d.id = o.department_id
    LEFT JOIN fssai_equipment          e  ON e.id = o.equipment_id
    LEFT JOIN raw_materials            rm ON rm.id = o.material_id
    LEFT JOIN fssai_temp_standards     st ON st.id = o.standard_id
    LEFT JOIN fssai_corrective_actions c  ON c.id = o.ca_id
    LEFT JOIN fssai_oil_disposals      dp ON dp.id = o.disposal_id`;

function shapeOilCheck(row: any) {
  const method = String(row.method || '');
  return {
    id: String(row.id),
    business_date: String(row.business_date || ''),
    checked_at: String(row.checked_at || ''),
    shift: String(row.shift || ''),
    equipment_id: String(row.equipment_id || ''),
    /* The registered name wins over the stored label when the fryer is in the
     * equipment register; the label is what was typed when it is not. One of the
     * two is always present — the route refuses a check against nothing. */
    equipment_label: String(row.equipment_name || row.equipment_label || ''),
    equipment_kind: String(row.equipment_kind || ''),
    department_id: String(row.department_id || ''),
    department_name: String(row.department_name || ''),
    oil_type: String(row.oil_type || ''),
    material_id: String(row.material_id || ''),
    material_name: String(row.material_name || ''),
    run_id: String(row.run_id || ''),
    method,
    method_label: FSSAI_OIL_METHODS.find((m) => m.key === method)?.label || method,
    /* NULL means NOT MEASURED and is never rendered as 0 — 0% TPM is a reading
     * of brand-new oil and would quietly pass every limit there is. */
    tpm_pct: real(row.tpm_pct),
    ffa_pct: real(row.ffa_pct),
    temp_c: real(row.temp_c),
    colour_grade: String(row.colour_grade || ''),
    sensory: OIL_SENSORY.map((s) => ({
      key: s.key,
      label: s.label,
      result: String(row[s.key] || ''),
      result_label: fssaiCheckResultLabel(row[s.key]),
      is_fail: fssaiCheckResultIsFail(row[s.key]),
    })),
    max_tpm_used: real(row.max_tpm_used),
    standard_id: String(row.standard_id || ''),
    standard_code: String(row.standard_code || ''),
    standard_label: String(row.standard_label || ''),
    /* FROZEN AT WRITE and never recomputed on read (RECON §10 R3). The display
     * string is derived, the verdict is not. */
    is_fail: Number(row.is_fail) === 1,
    is_judged: Number(row.is_judged) === 1,
    fail_reason: String(row.fail_reason || ''),
    tpm_display: fssaiDisplayReading(real(row.tpm_pct), 1),
    action_taken: String(row.action_taken || ''),
    action_label: FSSAI_OIL_ACTIONS.find((a) => a.key === String(row.action_taken || ''))?.label
      || String(row.action_taken || ''),
    oil_changed: Number(row.oil_changed) === 1,
    qty_discarded: real(row.qty_discarded),
    qty_added: real(row.qty_added),
    qty_uom: String(row.qty_uom || ''),
    hours_in_use: real(row.hours_in_use),
    disposal_id: String(row.disposal_id || ''),
    disposal_date: String(row.disposal_date || ''),
    disposal_receipt: String(row.disposal_receipt || ''),
    ca_id: String(row.ca_id || ''),
    ca_number: String(row.ca_number || ''),
    ca_status: String(row.ca_status || ''),
    note: String(row.note || ''),
    status: String(row.status || 'submitted'),
    status_label: fssaiRecordStatusMeta(row.status).label,
    recorded_by: String(row.recorded_by || ''),
    recorded_name: String(row.recorded_name || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
    ...voidFields(row),
  };
}

/* ------------------------------------------------------------------ *
 * GET
 * ------------------------------------------------------------------ */

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const url = new URL(request.url);

    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(`${OIL_SELECT} WHERE o.id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That oil check no longer exists.' }, { status: 404 });
      if (!p5CanSee(me, row)) {
        return Response.json({ error: 'That oil check belongs to another department.' }, { status: 403 });
      }
      const voidRefusal = fssaiVoidRefusal(me, row, VOID_REASON_PROBE);
      return Response.json({
        check: shapeOilCheck(row),
        photos: readP5AttachmentIndex(db, 'fssai_oil_checks', [id]).get(id) || [],
        can_void: !voidRefusal,
        void_refusal: voidRefusal,
      });
    }

    const where: string[] = [];
    const args: any[] = [];

    const from = str(url.searchParams.get('from'));
    const to = str(url.searchParams.get('to'));
    if (from) { where.push('o.business_date >= ?'); args.push(from); }
    if (to) { where.push('o.business_date <= ?'); args.push(to); }

    const equipmentId = str(url.searchParams.get('equipment_id'));
    if (equipmentId) { where.push('o.equipment_id = ?'); args.push(equipmentId); }

    const status = str(url.searchParams.get('status')) || 'live';
    if (status === 'live') where.push(`o.status <> 'void'`);
    else if (status !== 'all') {
      if (!isFssaiRecordStatus(status)) {
        return Response.json({ error: `"${status}" is not a state a record can be in.` }, { status: 400 });
      }
      where.push('o.status = ?'); args.push(status);
    }

    /* `fail=1` means FAILED, not "unjudged". The distinction is the whole reason
     * is_judged exists: a fryer nobody has a limit for is not a passing fryer. */
    if (url.searchParams.get('fail') === '1') where.push(`o.is_fail = 1 AND o.status <> 'void'`);
    if (url.searchParams.get('unjudged') === '1') where.push(`o.is_judged = 0 AND o.status <> 'void'`);

    const vis = p5VisibilityClause(me, 'o');
    if (vis.sql) { where.push(vis.sql); args.push(...vis.args); }

    const rows = db.prepare(
      `${OIL_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY o.business_date DESC, o.checked_at DESC, o.created_at DESC, o.rowid DESC
       LIMIT ${P5_LIST_LIMIT}`,
    ).all(...args) as any[];

    const q = str(url.searchParams.get('q')).toLowerCase();
    const shaped = rows.map(shapeOilCheck).filter((r) => !q
      || r.equipment_label.toLowerCase().includes(q)
      || r.oil_type.toLowerCase().includes(q)
      || r.material_name.toLowerCase().includes(q)
      || r.fail_reason.toLowerCase().includes(q)
      || r.note.toLowerCase().includes(q)
      || r.recorded_by.toLowerCase().includes(q));

    const photos = readP5AttachmentIndex(db, 'fssai_oil_checks', shaped.map((r) => r.id));

    const visCount = p5VisibilityClause(me, 'o');
    const countRows = db.prepare(
      `SELECT status, is_fail, is_judged, COUNT(*) AS n FROM fssai_oil_checks o
        ${visCount.sql ? `WHERE ${visCount.sql}` : ''}
        GROUP BY status, is_fail, is_judged`,
    ).all(...visCount.args) as any[];
    const live = countRows.filter((c) => String(c.status) !== 'void');
    const sum = (f: (c: any) => boolean) => live.filter(f).reduce((t, c) => t + (Number(c.n) || 0), 0);

    /* The fryers this screen can offer. ⚠️ MEASURED: fssai_equipment is EMPTY
     * until P4 seeds it, so the form also accepts a typed fryer name and the
     * screen says why. A dropdown with nothing in it and no explanation reads as
     * a broken screen. */
    const fryers = db.prepare(
      `SELECT id, name, code, location_label, department_id
         FROM fssai_equipment
        WHERE is_active = 1 AND kind = 'fryer'
        ORDER BY sort_order ASC, name ASC`,
    ).all() as any[];

    const standard = readP5Standard(db, { appliesTo: 'oil', equipmentKind: 'fryer' });

    return Response.json({
      checks: shaped.map((r) => ({ ...r, photos: photos.get(r.id) || [] })),
      counts: {
        live: sum(() => true),
        failed: sum((c) => Number(c.is_fail) === 1),
        unjudged: sum((c) => Number(c.is_judged) === 0),
        void: countRows.filter((c) => String(c.status) === 'void').reduce((t, c) => t + (Number(c.n) || 0), 0),
      },
      fryers,
      /* What a NEW check will be judged against, resolved by the same function
       * the POST uses, so the form shows the limit the record will actually
       * freeze. null means the owner has not set one. */
      standard,
      unjudged_notice: standard ? '' : p5UnjudgedNotice('frying oil', 'the food-safety standards settings'),
      /* OFFERED, NEVER APPLIED. The form may pre-fill this figure so somebody
       * typing a limit for the first time starts from the FSSAI one; the record
       * freezes whatever was actually used, and nothing in this module compares a
       * reading against this constant. */
      suggested_limit_tpm_pct: FSSAI_OIL_TPM_LIMIT_PCT,
      sensory: OIL_SENSORY,
      can_record: canRunFssaiCheck(me),
      is_management: isManagement(me),
      me: me.email || '',
      vocab: {
        methods: FSSAI_OIL_METHODS,
        actions: FSSAI_OIL_ACTIONS,
        shifts: FSSAI_SHIFTS,
        check_results: FSSAI_CHECK_RESULTS,
      },
      truncated: rows.length >= P5_LIST_LIMIT,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/oil failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the oil checks' }, { status: 500 });
  }
}

/* ------------------------------------------------------------------ *
 * POST
 * ------------------------------------------------------------------ */

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
    const today = fssaiToday();
    const action = str(body?.action) || 'record';

    /* ══ VOID (owner §19) ═══════════════════════════════════════════════════ */
    if (action === 'void') {
      const id = str(body?.id);
      const reason = str(body?.reason).slice(0, 1000);
      if (!id) return Response.json({ error: 'Which check? No id was sent.' }, { status: 400 });
      const row = db.prepare(`SELECT * FROM fssai_oil_checks WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That oil check no longer exists.' }, { status: 404 });

      const refusal = fssaiVoidRefusal(me, row, reason);
      if (refusal) {
        const needsReason = !fssaiVoidRefusal(me, row, VOID_REASON_PROBE);
        return Response.json({ error: refusal }, { status: needsReason ? 400 : 403 });
      }

      const doVoid = db.transaction(() => {
        const changes = voidP5Record(db, 'fssai_oil_checks', {
          id, reason, actor: { email: me.email, name: me.name },
        });
        if (changes !== 1) throw new Error('FSSAI_OIL_ALREADY_VOID');
        fssaiAudit(db, {
          entity_table: 'fssai_oil_checks', entity_id: id, action: 'void', field: 'status',
          before: {
            status: String(row.status || ''), is_fail: Number(row.is_fail),
            tpm_pct: real(row.tpm_pct), max_tpm_used: real(row.max_tpm_used),
          },
          after: { status: 'void' },
          reason, actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id,
        });
      });
      try { doVoid(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_OIL_ALREADY_VOID') {
          return Response.json({ error: 'That oil check has already been voided.' }, { status: 409 });
        }
        throw e;
      }

      fssaiAppAudit(db, {
        event_type: 'fssai.oil.void', entity_type: 'fssai_oil_checks', entity_id: id,
        actor_email: me.email, before: { status: row.status }, after: { status: 'void' }, note: reason,
      });

      const fresh = db.prepare(`${OIL_SELECT} WHERE o.id = ?`).get(id) as any;
      return Response.json({
        ok: true, check: shapeOilCheck(fresh),
        kept: 'The check stays in the file with your reason on it. A reading is never deleted.',
      });
    }

    if (action !== 'record') {
      return Response.json(
        { error: `"${action}" is not something this screen does. Use record or void.` },
        { status: 400 },
      );
    }

    /* ══ RECORD A CHECK ═════════════════════════════════════════════════════ */
    if (!canRunFssaiCheck(me)) {
      return Response.json({ error: 'You are not able to file food-safety records.' }, { status: 403 });
    }

    const date = readBusinessDate(body?.business_date, today);
    if (!date.ok) return Response.json({ error: date.error }, { status: 400 });

    const shift = str(body?.shift);
    if (shift && !isFssaiShift(shift)) {
      return Response.json({ error: `"${shift}" is not one of the shifts.` }, { status: 400 });
    }

    const method = str(body?.method);
    if (!FSSAI_OIL_METHODS.some((m) => m.key === method)) {
      return Response.json(
        { error: 'Say how the oil was judged — a TPM meter, a test strip, or look and smell.' },
        { status: 400 },
      );
    }

    /* WHICH FRYER. Registered equipment is preferred; a typed name is accepted
     * because fssai_equipment is empty until P4 seeds it, and a check against
     * "the fryer" with no name is a record nobody can act on. */
    let equipmentId = str(body?.equipment_id);
    let equipmentLabel = str(body?.equipment_label).slice(0, 200);
    let departmentId = str(body?.department_id) || me.department_id || '';
    if (equipmentId) {
      const e = db.prepare(
        `SELECT id, name, kind, department_id FROM fssai_equipment WHERE id = ? AND is_active = 1`,
      ).get(equipmentId) as any;
      if (!e) {
        return Response.json({ error: 'That fryer is not in the equipment register, or it has been retired.' }, { status: 400 });
      }
      equipmentLabel = String(e.name || '');
      if (!str(body?.department_id) && String(e.department_id || '')) departmentId = String(e.department_id);
    } else if (!equipmentLabel) {
      return Response.json(
        { error: 'Which fryer? Pick it from the register, or type which one this was.' },
        { status: 400 },
      );
    }

    const materialId = str(body?.material_id);
    let oilType = str(body?.oil_type).slice(0, 200);
    if (materialId) {
      const m = db.prepare(`SELECT id, name FROM raw_materials WHERE id = ?`).get(materialId) as any;
      if (!m) return Response.json({ error: 'That oil is not in the Item Master.' }, { status: 400 });
      if (!oilType) oilType = String(m.name || '');
    }

    const tpm = num(body?.tpm_pct);
    if (tpm !== null && (tpm < 0 || tpm > 100)) {
      return Response.json({ error: `${tpm}% is not a TPM reading. It is a percentage, so between 0 and 100.` }, { status: 400 });
    }
    const ffa = num(body?.ffa_pct);
    if (ffa !== null && (ffa < 0 || ffa > 100)) {
      return Response.json({ error: `${ffa}% is not an FFA reading. It is a percentage, so between 0 and 100.` }, { status: 400 });
    }

    /* The three sensory checkpoints, each a THREE-WAY tick-box. '' is "not
     * assessed" and is never counted as a pass — the measured reason is in
     * src/lib/fssai.ts: all six of the GRN's integer QC booleans read 0 across
     * all 29 deliveries, and that 0 cannot say whether anybody looked. */
    const sensory: Record<string, string> = {};
    for (const s of OIL_SENSORY) {
      const v = str((body as any)?.[s.key]);
      if (v && !isFssaiCheckResult(v)) {
        return Response.json({ error: `"${v}" is not an answer for ${s.label}. Use in order, not in order, or not applicable.` }, { status: 400 });
      }
      sensory[s.key] = v;
    }

    const anySensoryAnswered = OIL_SENSORY.some((s) => fssaiCheckResultAnswered(sensory[s.key]));
    const sensoryFails = OIL_SENSORY.filter((s) => fssaiCheckResultIsFail(sensory[s.key]));

    /* A CHECK HAS TO SAY SOMETHING. A meter method with no reading and no
     * sensory answer is an empty row that would sit in the file looking like a
     * check was done. */
    if (tpm === null && ffa === null && !anySensoryAnswered && !str(body?.colour_grade)) {
      return Response.json(
        {
          error: 'Nothing was recorded. Enter the meter reading, or answer at least one of smell, foaming and smoking.',
          code: 'empty_check',
        },
        { status: 400 },
      );
    }

    /* ── THE LIMIT, AND WHERE IT CAME FROM ──────────────────────────────────
     * Preference order, and each step is honest about itself:
     *   1. the owner's stored standard (standard_id recorded);
     *   2. a limit the person typed, when there is no standard (standard_id '');
     *   3. nothing — the reading is kept and is_judged stays 0.
     * Whatever is used is FROZEN into max_tpm_used, so this record can always be
     * re-read against the rule it was actually judged by. */
    const standard = readP5Standard(db, {
      appliesTo: 'oil',
      equipmentKind: 'fryer',
      materialId,
      outletId,
    });
    const typedLimit = num(body?.limit_tpm_pct);
    if (typedLimit !== null && (typedLimit <= 0 || typedLimit > 100)) {
      return Response.json({ error: `A limit of ${typedLimit}% is not a TPM limit. Use a percentage above 0.` }, { status: 400 });
    }
    /* A stored standard always wins, INCLUDING when its own maximum is blank —
     * an owner who created an "oil" standard with no upper bound has said
     * something, and letting a typed figure override it would make the standard
     * screen a suggestion. A typed limit is only consulted when no standard
     * exists at all. */
    const maxTpm = standard ? standard.max_value : typedLimit;
    const standardId = standard?.id || '';

    const range = fssaiRangeCheck(tpm, null, maxTpm, '%');
    const isJudged = range.judged || anySensoryAnswered;
    const isFail = range.out_of_range || sensoryFails.length > 0;

    const failReason = [
      range.out_of_range ? range.why : '',
      sensoryFails.length
        ? `${sensoryFails.map((s) => s.label.toLowerCase()).join(', ')} not in order.`
        : '',
    ].filter(Boolean).join(' ').slice(0, 500);

    const actionTaken = str(body?.action_taken);
    if (actionTaken && !FSSAI_OIL_ACTIONS.some((a) => a.key === actionTaken)) {
      return Response.json({ error: `"${actionTaken}" is not one of the things that can be done to the oil.` }, { status: 400 });
    }
    const oilChanged = actionTaken === 'changed' ? 1 : (Number(body?.oil_changed) === 1 ? 1 : 0);

    const id = generateId();
    const files = Array.isArray(body?.photos) ? body.photos : [];

    /* SEVERITY IS THE REAL STATE OF THE FRYER, not a constant.
     * Oil that failed and is STILL IN USE is the worst row this screen can hold
     * — the food being cooked right now is being cooked in it — so it is urgent.
     * A failure already dealt with (changed, withdrawn, filtered) is high. A
     * sensory-only failure with no measurement is medium. */
    const stillInUse = !actionTaken || actionTaken === 'topped_up';
    const severity = isFail
      ? (stillInUse ? 'urgent' : (range.out_of_range ? 'high' : 'medium'))
      : 'medium';

    let raised: ReturnType<typeof raiseP5CorrectiveAction> = null;
    let attached: ReturnType<typeof attachP5Files> = [];

    const write = db.transaction(() => {
      db.prepare(
        `INSERT INTO fssai_oil_checks
           (id, business_date, checked_at, shift, equipment_id, equipment_label, department_id,
            oil_type, material_id, run_id, response_id, method, tpm_pct, ffa_pct, temp_c,
            colour_grade, chk_smell, chk_foaming, chk_smoking, max_tpm_used, standard_id,
            is_fail, is_judged, fail_reason, action_taken, oil_changed, qty_discarded,
            qty_added, qty_uom, hours_in_use, disposal_id, ca_id, note, status,
            recorded_by, recorded_name, outlet_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, 'submitted', ?, ?, ?)`,
      ).run(
        id, date.date, readClock(body?.checked_at), shift,
        equipmentId, equipmentLabel, departmentId,
        oilType, materialId, method,
        tpm, ffa, num(body?.temp_c), str(body?.colour_grade).slice(0, 100),
        sensory.chk_smell, sensory.chk_foaming, sensory.chk_smoking,
        maxTpm, standardId,
        isFail ? 1 : 0, isJudged ? 1 : 0, failReason,
        actionTaken, oilChanged, num(body?.qty_discarded), num(body?.qty_added),
        str(body?.qty_uom) || 'L', num(body?.hours_in_use),
        str(body?.note).slice(0, 2000), me.email || '', me.name || '', outletId,
      );

      attached = attachP5Files(db, {
        entityTable: 'fssai_oil_checks', entityId: id, files,
        actor: { email: me.email, name: me.name }, outletId,
      });

      /* A JUDGED FAILURE RAISES THE ACTION THAT FIXES IT, automatically.
       * Unlike the expiry register (where a single out-of-date tub is a rotation
       * slip and the switch is on the form), oil above the limit is a breach of a
       * rule the owner himself set, and §4's "out of range automatically raises a
       * corrective action" is the whole reason the limit is configurable. */
      if (isFail) {
        raised = raiseP5CorrectiveAction(db, {
          sourceKind: 'oil',
          title: `Fryer oil not fit for use — ${equipmentLabel}`,
          description: [
            `${equipmentLabel}${oilType ? ` (${oilType})` : ''} failed its oil check on ${date.date}${shift ? ` (${shift})` : ''}.`,
            failReason,
            tpm !== null && maxTpm !== null
              ? `Reading ${fssaiDisplayReading(tpm, 1)}% against a limit of ${fssaiDisplayReading(maxTpm, 1)}%${standard ? ` (${standard.label || standard.code})` : ' typed in at the time of the check, because no standard was set'}.`
              : '',
            actionTaken
              ? `At the time of the check the oil was: ${FSSAI_OIL_ACTIONS.find((a) => a.key === actionTaken)?.label}.`
              : 'At the time of the check the oil was still in use. That is why this is urgent.',
            'The reading on the record does not change. This action is about the oil and the fryer.',
          ].filter(Boolean).join(' '),
          severity,
          departmentId,
          equipmentId,
          businessDate: date.date,
          recordTable: 'fssai_oil_checks', recordId: id,
          actor: { email: me.email, name: me.name }, outletId,
        });
        if (raised) {
          db.prepare(`UPDATE fssai_oil_checks SET ca_id = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(raised.id, id);
        }
      }

      fssaiAuditBestEffort(db, {
        entity_table: 'fssai_oil_checks', entity_id: id, action: 'create',
        after: {
          business_date: date.date, equipment_id: equipmentId, equipment_label: equipmentLabel,
          method, tpm_pct: tpm, max_tpm_used: maxTpm, standard_id: standardId,
          is_fail: isFail ? 1 : 0, is_judged: isJudged ? 1 : 0, fail_reason: failReason,
          action_taken: actionTaken, photos: attached.length,
        },
        reason: date.backdated ? `Filed on ${today} for ${date.date}.` : '',
        actor: { email: me.email, name: me.name }, outlet_id: outletId,
      });
    });

    try {
      write();
    } catch (e: any) {
      const m = String(e?.message || '');
      if (m.startsWith('P5_BAD_PHOTO:')) {
        return Response.json({ error: m.slice('P5_BAD_PHOTO:'.length) }, { status: 413 });
      }
      if (m.startsWith('P5_TOO_MANY_PHOTOS:')) {
        return Response.json({ error: m.slice('P5_TOO_MANY_PHOTOS:'.length) }, { status: 400 });
      }
      throw e;
    }

    fssaiAppAudit(db, {
      event_type: 'fssai.oil.record', entity_type: 'fssai_oil_checks', entity_id: id,
      actor_email: me.email,
      after: { equipment_label: equipmentLabel, tpm_pct: tpm, is_fail: isFail ? 1 : 0 },
      note: failReason,
    });

    const fresh = db.prepare(`${OIL_SELECT} WHERE o.id = ?`).get(id) as any;
    return Response.json({
      ok: true,
      check: shapeOilCheck(fresh),
      photos: attached,
      verdict: {
        is_judged: isJudged,
        is_fail: isFail,
        /* The sentence the screen shows. `why` from fssaiRangeCheck when a limit
         * applied, the honest "nothing was judged" when none did. */
        why: isFail
          ? failReason
          : (isJudged ? (range.judged ? range.why : 'Everything checked was in order.') : range.why),
        limit_used: maxTpm,
        limit_source: standard ? 'standard' : (maxTpm === null ? 'none' : 'typed_at_the_check'),
        standard: standard ? { id: standard.id, code: standard.code, label: standard.label } : null,
      },
      corrective_action: raised,
      ...(isFail && !raised
        ? { corrective_action_warning: 'The check is saved and the failure stands. A corrective action could not be raised against it — raise one by hand. The reading on the record is unaffected.' }
        : {}),
      ...(!isJudged
        ? { unjudged_notice: p5UnjudgedNotice('frying oil', 'the food-safety standards settings') }
        : {}),
    });
  } catch (e: any) {
    console.error('POST /api/fssai/oil failed:', e);
    return Response.json({ error: e?.message || 'Failed to save the oil check' }, { status: 500 });
  }
}

/* No DELETE and no PUT. A reading is an observation of a moment that has passed:
 * it is voided with a written reason (§19) and a fresh check is recorded, so the
 * file shows both. is_fail, is_judged and max_tpm_used are frozen at write and
 * are never recomputed on read — tightening the standard next month must not
 * retrospectively fail a fryer that passed. */
