/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  canRunFssaiCheck, fssaiToday, isISODate, daysBetweenISO, fssaiRangeCheck,
  fssaiDisplayReading, FSSAI_WATER_TEST_KINDS, fssaiWaterTestKind,
  fssaiRecordStatusMeta, isFssaiRecordStatus, fssaiVoidRefusal,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAuditBestEffort,
  fssaiAppAudit, str,
} from '@/lib/fssai-server';
import {
  P5_LIST_LIMIT, num, nullableInt, readBusinessDate, readClock,
  p5VisibilityClause, p5CanSee, attachP5Files, readP5AttachmentIndex,
  readP5Standard, raiseP5CorrectiveAction, voidP5Record, real, voidFields,
  p5UnjudgedNotice,
} from '../_p5/records';

/**
 * WATER AND ICE (/api/fssai/water) — owner §13.
 *
 * ── WHY A LAB CERTIFICATE AND A CHLORINE READING SHARE ONE TABLE ────────────
 * Because the question an inspector asks is ONE question: "show me your water
 * records". Splitting them means every report unions two tables and the screen
 * shows two unrelated lists. So fssai_water_tests holds both, and `test_kind`
 * says which shape a row is. The ONE value a report ranges over — the daily
 * reading — is `value_num`, a REAL column that can be indexed and compared; the
 * lab's variable parameter list is `parameters_json`, for exactly the reason
 * fssai_questions.options_json is JSON (ordered, variable-length, never filtered
 * in SQL). That split is deliberate, not inconsistent.
 *
 * ── THE TWO VERDICTS, AND WHY THEY ARE NOT THE SAME THING ───────────────────
 *   · A READING is judged against a range, exactly as a fryer is: the owner's
 *     standard if one exists, otherwise a range typed by the person doing the
 *     test, otherwise nothing is judged and the record says so (is_judged = 0).
 *     Chlorine and pH are different rules about the same tap, and
 *     fssai_temp_standards has one applies_to column, so the lookup asks for the
 *     test's own code first — see readP5Standard's note on that convention.
 *   · A LAB REPORT is not ours to judge. The laboratory printed a verdict and
 *     this route records THAT, in `result`, as printed. Re-deriving pass/fail
 *     from the parameter rows would mean the app contradicting a signed
 *     certificate, which is the last thing a compliance file should do. What the
 *     route does do is notice when the lab's own parameter rows say 'fail' while
 *     the overall result says 'pass', and put that in fail_reason so nobody has
 *     to read the PDF to spot it.
 *
 *   GET  ?id=<test>
 *   GET  [?from=&to=&test_kind=&lab=1&status=&fail=1&due=1&q=]
 *   POST { action: 'record' | 'void', … }
 */
export const dynamic = 'force-dynamic';

/** See the note in the FIFO route: a stand-in reason, never written anywhere. */
const VOID_REASON_PROBE = '----';

/** How many parameter rows one lab report may carry. A potability certificate
 *  runs to perhaps 25 lines; 80 is generous and stops a runaway body. */
const MAX_LAB_PARAMETERS = 80;

/** The lab's own verdict, as printed. '' means the certificate did not say. */
const LAB_RESULTS = ['', 'pass', 'fail'] as const;

/**
 * The kinds of record that are meaningless without a number.
 *
 * An ice check, a tank cleaning and a filter change are satisfied by words or a
 * date — holding them to a reading would mean a cleaned tank could not be
 * recorded at all. These four are a measurement or they are nothing.
 */
const NUMBER_REQUIRED_KINDS: readonly string[] = ['chlorine', 'tds', 'ph', 'hardness'];

/**
 * The code a water test asks fssai_temp_standards for before falling back to a
 * generic 'water' standard. A CONVENTION THIS PHASE PROPOSES — the table and its
 * seed belong to other phases, so nothing here assumes such a row exists.
 */
function waterStandardCode(testKind: string): string {
  return `WATER-${testKind.replace(/[^a-z0-9]+/gi, '-').toUpperCase()}`;
}

interface LabParameter {
  name: string;
  value: string;
  uom: string;
  limit: string;
  result: string;
}

/**
 * The lab's parameter rows, validated. Everything is kept as the STRING the
 * certificate printed — "< 0.1", "Absent", "nil" are all real entries on a real
 * potability report and none of them is a number. Forcing them through
 * parseFloat would turn "Absent" into NaN and "< 0.1" into 0.1, which is the
 * opposite of what the certificate says.
 */
function readLabParameters(v: unknown): { ok: true; rows: LabParameter[] } | { ok: false; error: string } {
  if (v === undefined || v === null || v === '') return { ok: true, rows: [] };
  if (!Array.isArray(v)) return { ok: false, error: 'The test parameters did not arrive as a list.' };
  if (v.length > MAX_LAB_PARAMETERS) {
    return { ok: false, error: `A report can carry up to ${MAX_LAB_PARAMETERS} parameters; this one sent ${v.length}.` };
  }
  const rows: LabParameter[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'One of the test parameters is not a row of values.' };
    }
    const name = str((raw as any).name).slice(0, 200);
    if (!name) return { ok: false, error: 'Every test parameter needs a name — which substance or measure it is.' };
    /* `result` IS DELIBERATELY NOT CONSTRAINED TO A LIST. A laboratory writes
     * what a laboratory writes — "Within limit", "Absent", "Satisfactory" — and
     * refusing the ones this route has not heard of would stop a real
     * certificate being filed. Only the words this route ACTS on are matched
     * (fail / exceeds limit / present, below); everything else is stored
     * verbatim and shown exactly as printed. */
    rows.push({
      name,
      value: str((raw as any).value).slice(0, 120),
      uom: str((raw as any).uom).slice(0, 40),
      limit: str((raw as any).limit).slice(0, 120),
      result: str((raw as any).result).slice(0, 40).toLowerCase(),
    });
  }
  return { ok: true, rows };
}

function parseStoredParameters(text: unknown): LabParameter[] {
  try {
    const v = JSON.parse(String(text || '[]'));
    if (!Array.isArray(v)) return [];
    return v.filter((r) => r && typeof r === 'object').map((r: any) => ({
      name: String(r.name || ''), value: String(r.value ?? ''),
      uom: String(r.uom || ''), limit: String(r.limit ?? ''), result: String(r.result || ''),
    }));
  } catch {
    // A row whose JSON will not parse must not take a whole screen down with it.
    return [];
  }
}

const WATER_SELECT = `
  SELECT w.*, d.name AS department_name, e.name AS equipment_name,
         st.code AS standard_code, st.label AS standard_label,
         c.ca_number AS ca_number, c.status AS ca_status
    FROM fssai_water_tests w
    LEFT JOIN departments              d  ON d.id = w.department_id
    LEFT JOIN fssai_equipment          e  ON e.id = w.equipment_id
    LEFT JOIN fssai_temp_standards     st ON st.id = w.standard_id
    LEFT JOIN fssai_corrective_actions c  ON c.id = w.ca_id`;

function shapeWaterTest(row: any, today: string) {
  const kind = String(row.test_kind || '');
  const meta = fssaiWaterTestKind(kind);
  const nextDue = String(row.next_due_date || '');
  return {
    id: String(row.id),
    business_date: String(row.business_date || ''),
    tested_at: String(row.tested_at || ''),
    test_kind: kind,
    test_kind_label: meta?.label || kind,
    is_lab: !!meta?.is_lab,
    source_point: String(row.source_point || ''),
    equipment_id: String(row.equipment_id || ''),
    equipment_label: String(row.equipment_name || ''),
    department_id: String(row.department_id || ''),
    department_name: String(row.department_name || ''),
    run_id: String(row.run_id || ''),
    /* NULL means NOT MEASURED. 0 ppm of free chlorine is a real and serious
     * reading, so the two can never be allowed to collapse into one another. */
    value_num: real(row.value_num),
    uom: String(row.uom || ''),
    decimals: Number(row.decimals) || 0,
    value_display: fssaiDisplayReading(real(row.value_num), Number(row.decimals) || 0),
    min_used: real(row.min_used),
    max_used: real(row.max_used),
    standard_id: String(row.standard_id || ''),
    standard_code: String(row.standard_code || ''),
    standard_label: String(row.standard_label || ''),
    lab_name: String(row.lab_name || ''),
    lab_licence_no: String(row.lab_licence_no || ''),
    report_no: String(row.report_no || ''),
    sample_date: String(row.sample_date || ''),
    report_date: String(row.report_date || ''),
    parameters: parseStoredParameters(row.parameters_json),
    result: String(row.result || ''),
    document_id: String(row.document_id || ''),
    /* FROZEN AT WRITE, never recomputed on read. */
    is_fail: Number(row.is_fail) === 1,
    is_judged: Number(row.is_judged) === 1,
    fail_reason: String(row.fail_reason || ''),
    action_taken: String(row.action_taken || ''),
    next_due_date: nextDue,
    /* The due state IS derived on every read — the opposite rule to the verdict,
     * and for the opposite reason: a stored "due" goes stale at midnight, and a
     * water test rendering "up to date" the day after it lapsed is the worst row
     * this screen could print. */
    days_to_due: isISODate(nextDue) ? daysBetweenISO(today, nextDue) : null,
    is_overdue: isISODate(nextDue) ? nextDue < today : false,
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
    const today = fssaiToday();

    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(`${WATER_SELECT} WHERE w.id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That water record no longer exists.' }, { status: 404 });
      if (!p5CanSee(me, row)) {
        return Response.json({ error: 'That water record belongs to another department.' }, { status: 403 });
      }
      const voidRefusal = fssaiVoidRefusal(me, row, VOID_REASON_PROBE);
      return Response.json({
        test: shapeWaterTest(row, today),
        documents: readP5AttachmentIndex(db, 'fssai_water_tests', [id]).get(id) || [],
        can_void: !voidRefusal,
        void_refusal: voidRefusal,
      });
    }

    const where: string[] = [];
    const args: any[] = [];

    const from = str(url.searchParams.get('from'));
    const to = str(url.searchParams.get('to'));
    if (from) { where.push('w.business_date >= ?'); args.push(from); }
    if (to) { where.push('w.business_date <= ?'); args.push(to); }

    const testKind = str(url.searchParams.get('test_kind'));
    if (testKind) {
      if (!fssaiWaterTestKind(testKind)) {
        return Response.json({ error: `"${testKind}" is not a kind of water or ice record.` }, { status: 400 });
      }
      where.push('w.test_kind = ?'); args.push(testKind);
    }
    /* The two shapes, as a filter, because the screen shows them as two lists and
     * the names of the lab kinds live in ONE place (FSSAI_WATER_TEST_KINDS.is_lab)
     * rather than being typed out here. */
    const labKinds = FSSAI_WATER_TEST_KINDS.filter((k) => k.is_lab).map((k) => k.key);
    if (url.searchParams.get('lab') === '1' && labKinds.length) {
      where.push(`w.test_kind IN (${labKinds.map(() => '?').join(',')})`);
      args.push(...labKinds);
    } else if (url.searchParams.get('lab') === '0' && labKinds.length) {
      where.push(`w.test_kind NOT IN (${labKinds.map(() => '?').join(',')})`);
      args.push(...labKinds);
    }

    const status = str(url.searchParams.get('status')) || 'live';
    if (status === 'live') where.push(`w.status <> 'void'`);
    else if (status !== 'all') {
      if (!isFssaiRecordStatus(status)) {
        return Response.json({ error: `"${status}" is not a state a record can be in.` }, { status: 400 });
      }
      where.push('w.status = ?'); args.push(status);
    }

    if (url.searchParams.get('fail') === '1') where.push(`w.is_fail = 1 AND w.status <> 'void'`);
    if (url.searchParams.get('unjudged') === '1') where.push(`w.is_judged = 0 AND w.status <> 'void'`);
    if (url.searchParams.get('due') === '1') {
      where.push(`w.next_due_date <> '' AND w.next_due_date <= ? AND w.status <> 'void'`);
      args.push(today);
    }

    const vis = p5VisibilityClause(me, 'w');
    if (vis.sql) { where.push(vis.sql); args.push(...vis.args); }

    const rows = db.prepare(
      `${WATER_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY w.business_date DESC, w.tested_at DESC, w.created_at DESC, w.rowid DESC
       LIMIT ${P5_LIST_LIMIT}`,
    ).all(...args) as any[];

    const q = str(url.searchParams.get('q')).toLowerCase();
    const shaped = rows.map((r) => shapeWaterTest(r, today)).filter((r) => !q
      || r.source_point.toLowerCase().includes(q)
      || r.lab_name.toLowerCase().includes(q)
      || r.report_no.toLowerCase().includes(q)
      || r.lab_licence_no.toLowerCase().includes(q)
      || r.test_kind_label.toLowerCase().includes(q)
      || r.note.toLowerCase().includes(q)
      || r.recorded_by.toLowerCase().includes(q));

    const docs = readP5AttachmentIndex(db, 'fssai_water_tests', shaped.map((r) => r.id));

    /* THE COUNTS ARE SCOPED THE SAME WAY THE LIST IS — the visibility rule AND
     * the readings/certificates split. The screen shows the two shapes as two
     * tabs, so a tab reading "6" above a list of 3 would make every number on
     * this page untrustworthy. Date and text filters deliberately do NOT narrow
     * them: those are the user narrowing a view, and the chip is the total they
     * are narrowing out of. */
    const countWhere: string[] = [];
    const countArgs: any[] = [];
    const visCount = p5VisibilityClause(me, 'w');
    if (visCount.sql) { countWhere.push(visCount.sql); countArgs.push(...visCount.args); }
    if (labKinds.length && url.searchParams.get('lab') === '1') {
      countWhere.push(`w.test_kind IN (${labKinds.map(() => '?').join(',')})`);
      countArgs.push(...labKinds);
    } else if (labKinds.length && url.searchParams.get('lab') === '0') {
      countWhere.push(`w.test_kind NOT IN (${labKinds.map(() => '?').join(',')})`);
      countArgs.push(...labKinds);
    }
    const countRows = db.prepare(
      `SELECT status, is_fail, is_judged, test_kind, next_due_date, COUNT(*) AS n
         FROM fssai_water_tests w
        ${countWhere.length ? `WHERE ${countWhere.join(' AND ')}` : ''}
        GROUP BY status, is_fail, is_judged, test_kind, next_due_date`,
    ).all(...countArgs) as any[];
    const live = countRows.filter((c) => String(c.status) !== 'void');
    const sum = (f: (c: any) => boolean) => live.filter(f).reduce((t, c) => t + (Number(c.n) || 0), 0);

    /* WATER EQUIPMENT. ⚠️ MEASURED: fssai_equipment is EMPTY until P4 seeds it,
     * so the form also accepts a typed source point, and the screen says why
     * rather than showing an empty dropdown that reads as a bug. */
    const equipment = db.prepare(
      `SELECT id, name, code, kind, location_label, department_id
         FROM fssai_equipment
        WHERE is_active = 1 AND kind IN ('water_filter','other')
        ORDER BY sort_order ASC, name ASC`,
    ).all() as any[];

    /* The standards a NEW record of each kind would be judged against, resolved
     * by the same function the POST uses so the form shows the limit the record
     * will actually freeze. */
    const standards = FSSAI_WATER_TEST_KINDS.filter((k) => !k.is_lab).map((k) => ({
      test_kind: k.key,
      code_looked_for: waterStandardCode(k.key),
      standard: readP5Standard(db, { appliesTo: 'water', preferCode: waterStandardCode(k.key) }),
    }));

    return Response.json({
      tests: shaped.map((r) => ({ ...r, documents: docs.get(r.id) || [] })),
      counts: {
        live: sum(() => true),
        failed: sum((c) => Number(c.is_fail) === 1),
        unjudged: sum((c) => Number(c.is_judged) === 0),
        lab_reports: sum((c) => labKinds.includes(String(c.test_kind))),
        due: sum((c) => String(c.next_due_date || '') !== '' && String(c.next_due_date) <= today),
        void: countRows.filter((c) => String(c.status) === 'void').reduce((t, c) => t + (Number(c.n) || 0), 0),
      },
      equipment,
      standards,
      /* One sentence per kind that has no standard, so a screen never has to
       * invent the wording and three screens never invent three. */
      unjudged_notice: standards.every((s) => !s.standard)
        ? p5UnjudgedNotice('water and ice readings', 'the food-safety standards settings')
        : '',
      can_record: canRunFssaiCheck(me),
      is_management: isManagement(me),
      me: me.email || '',
      vocab: {
        test_kinds: FSSAI_WATER_TEST_KINDS,
        lab_results: LAB_RESULTS,
        max_lab_parameters: MAX_LAB_PARAMETERS,
        /* THE KINDS WHOSE WHOLE POINT IS A NUMBER, served rather than repeated on
         * the screen. The form needs to know which boxes are compulsory, and a
         * second copy of this list in the page would drift the moment a kind is
         * added — the rival-helper trap in miniature. */
        number_kinds: NUMBER_REQUIRED_KINDS,
      },
      truncated: rows.length >= P5_LIST_LIMIT,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/water failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the water records' }, { status: 500 });
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
      if (!id) return Response.json({ error: 'Which record? No id was sent.' }, { status: 400 });
      const row = db.prepare(`SELECT * FROM fssai_water_tests WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That water record no longer exists.' }, { status: 404 });

      const refusal = fssaiVoidRefusal(me, row, reason);
      if (refusal) {
        const needsReason = !fssaiVoidRefusal(me, row, VOID_REASON_PROBE);
        return Response.json({ error: refusal }, { status: needsReason ? 400 : 403 });
      }

      const doVoid = db.transaction(() => {
        const changes = voidP5Record(db, 'fssai_water_tests', {
          id, reason, actor: { email: me.email, name: me.name },
        });
        if (changes !== 1) throw new Error('FSSAI_WATER_ALREADY_VOID');
        fssaiAudit(db, {
          entity_table: 'fssai_water_tests', entity_id: id, action: 'void', field: 'status',
          before: {
            status: String(row.status || ''), test_kind: String(row.test_kind || ''),
            value_num: real(row.value_num), result: String(row.result || ''),
            is_fail: Number(row.is_fail),
          },
          after: { status: 'void' },
          reason, actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id,
        });
      });
      try { doVoid(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_WATER_ALREADY_VOID') {
          return Response.json({ error: 'That water record has already been voided.' }, { status: 409 });
        }
        throw e;
      }

      fssaiAppAudit(db, {
        event_type: 'fssai.water.void', entity_type: 'fssai_water_tests', entity_id: id,
        actor_email: me.email, before: { status: row.status }, after: { status: 'void' }, note: reason,
      });

      const fresh = db.prepare(`${WATER_SELECT} WHERE w.id = ?`).get(id) as any;
      return Response.json({
        ok: true, test: shapeWaterTest(fresh, today),
        kept: 'The record stays in the file with your reason on it. A reading is never deleted.',
      });
    }

    if (action !== 'record') {
      return Response.json(
        { error: `"${action}" is not something this screen does. Use record or void.` },
        { status: 400 },
      );
    }

    /* ══ RECORD ═════════════════════════════════════════════════════════════ */
    if (!canRunFssaiCheck(me)) {
      return Response.json({ error: 'You are not able to file food-safety records.' }, { status: 403 });
    }

    const date = readBusinessDate(body?.business_date, today);
    if (!date.ok) return Response.json({ error: date.error }, { status: 400 });

    const testKind = str(body?.test_kind);
    const kindMeta = fssaiWaterTestKind(testKind);
    if (!kindMeta) {
      return Response.json(
        { error: 'Say what kind of record this is — a lab report, a chlorine reading, an ice check, a filter change, and so on.' },
        { status: 400 },
      );
    }
    const isLab = !!kindMeta.is_lab;

    const equipmentId = str(body?.equipment_id);
    let departmentId = str(body?.department_id) || me.department_id || '';
    let sourcePoint = str(body?.source_point).slice(0, 200);
    if (equipmentId) {
      const e = db.prepare(
        `SELECT id, name, department_id FROM fssai_equipment WHERE id = ? AND is_active = 1`,
      ).get(equipmentId) as any;
      if (!e) {
        return Response.json({ error: 'That equipment is not in the register, or it has been retired.' }, { status: 400 });
      }
      if (!sourcePoint) sourcePoint = String(e.name || '');
      if (!str(body?.department_id) && String(e.department_id || '')) departmentId = String(e.department_id);
    }
    /* WHERE THE SAMPLE CAME FROM is the one thing a water record cannot be
     * without: "the water was fine" says nothing if nobody knows which tap. */
    if (!sourcePoint && !equipmentId) {
      return Response.json(
        { error: 'Where was this taken? Name the tap, tank, RO outlet or ice machine.' },
        { status: 400 },
      );
    }

    const nextDue = str(body?.next_due_date);
    if (nextDue && !isISODate(nextDue)) {
      return Response.json({ error: `"${nextDue}" is not a date. Use the date picker.` }, { status: 400 });
    }
    const note = str(body?.note).slice(0, 2000);
    const actionTaken = str(body?.action_taken).slice(0, 500);

    let valueNum: number | null = null;
    let uom = '';
    let decimals = 2;
    let minUsed: number | null = null;
    let maxUsed: number | null = null;
    let standardId = '';
    let standard: ReturnType<typeof readP5Standard> = null;
    let isJudged = false;
    let isFail = false;
    let failReason = '';
    let why = '';

    let labName = '';
    let labLicence = '';
    let reportNo = '';
    let sampleDate = '';
    let reportDate = '';
    let result = '';
    let parameters: LabParameter[] = [];

    if (isLab) {
      /* ── A LABORATORY CERTIFICATE ─────────────────────────────────────────
       * The lab's verdict is recorded, not recomputed. Which laboratory and
       * under what licence is the point of the record — an inspector checks the
       * lab is notified before he reads the numbers. */
      labName = str(body?.lab_name).slice(0, 200);
      labLicence = str(body?.lab_licence_no).slice(0, 120);
      reportNo = str(body?.report_no).slice(0, 120);
      sampleDate = str(body?.sample_date);
      reportDate = str(body?.report_date);
      result = str(body?.result).toLowerCase();

      if (!labName) {
        return Response.json({ error: 'Which laboratory issued this report?' }, { status: 400 });
      }
      if (!(LAB_RESULTS as readonly string[]).includes(result)) {
        return Response.json(
          { error: `"${str(body?.result)}" is not a result. Record what the certificate printed: pass or fail. Leave it blank only if it genuinely does not say.` },
          { status: 400 },
        );
      }
      for (const [label, v] of [['sample date', sampleDate], ['report date', reportDate]] as const) {
        if (v && !isISODate(v)) {
          return Response.json({ error: `The ${label} "${v}" is not a date. Use the date picker.` }, { status: 400 });
        }
      }
      /* A report dated BEFORE the sample was taken is almost always the two
       * dates entered the wrong way round, and it would make the file look
       * fabricated to anybody who checked. */
      if (sampleDate && reportDate && reportDate < sampleDate) {
        return Response.json(
          { error: `The report (${reportDate}) cannot be dated before the sample was taken (${sampleDate}). Check the two dates.` },
          { status: 400 },
        );
      }

      const params = readLabParameters(body?.parameters);
      if (!params.ok) return Response.json({ error: params.error }, { status: 400 });
      parameters = params.rows;

      const failedParams = parameters.filter(
        (p) => p.result === 'fail' || p.result === 'exceeds limit' || p.result === 'present',
      );

      /* THE LAB'S OWN VERDICT IS THE VERDICT. is_judged is 1 the moment the
       * certificate said something, and is_fail follows what it said. */
      isJudged = result === 'pass' || result === 'fail' || parameters.length > 0;
      isFail = result === 'fail';

      failReason = isFail
        ? `The laboratory reported a FAIL${failedParams.length ? ` on ${failedParams.map((p) => p.name).join(', ')}` : ''}.`
        : '';
      /* AND THE ONE THING THE APP DOES ADD: if the overall line says pass while a
       * parameter row says fail, that disagreement goes on the record rather than
       * waiting for somebody to read the PDF. It does NOT flip the verdict — the
       * certificate is the certificate. */
      if (!isFail && failedParams.length) {
        failReason = `The report is marked ${result || 'with no overall result'}, but ${failedParams.length} parameter${failedParams.length === 1 ? '' : 's'} (${failedParams.map((p) => p.name).join(', ')}) ${failedParams.length === 1 ? 'is' : 'are'} outside its limit. Read the certificate before relying on the overall line.`;
      }
      why = isFail ? failReason : (isJudged ? 'The laboratory reported a pass.' : 'The certificate carries no result.');
    } else {
      /* ── A READING TAKEN HERE ─────────────────────────────────────────────── */
      valueNum = num(body?.value_num);
      uom = str(body?.uom).slice(0, 20);
      const decRaw = nullableInt(body?.decimals);
      decimals = decRaw !== null && decRaw >= 0 && decRaw <= 3 ? decRaw : 2;

      standard = readP5Standard(db, {
        appliesTo: 'water',
        preferCode: waterStandardCode(testKind),
        outletId,
      });
      const typedMin = num(body?.min_value);
      const typedMax = num(body?.max_value);
      if (typedMin !== null && typedMax !== null && typedMin > typedMax) {
        return Response.json(
          { error: `The range reads ${typedMin} to ${typedMax}, which is the wrong way round.` },
          { status: 400 },
        );
      }
      /* Same rule as the fryer: a stored standard always wins, a typed range is
       * consulted only when there is no standard at all, and whichever applied is
       * FROZEN onto the record. */
      minUsed = standard ? standard.min_value : typedMin;
      maxUsed = standard ? standard.max_value : typedMax;
      standardId = standard?.id || '';
      if (standard && !uom) uom = standard.uom;

      /* A RECORD HAS TO SAY SOMETHING, and NUMBER_REQUIRED_KINDS is the one list
       * that decides which kinds owe a reading — the same list the GET serves to
       * the form, so the compulsory box and the refusal cannot disagree. */
      const needsNumber = NUMBER_REQUIRED_KINDS.includes(testKind);
      if (needsNumber && valueNum === null) {
        return Response.json(
          { error: `A ${kindMeta.label.toLowerCase()} record needs the reading. Enter it, or choose a different kind of record.`, code: 'reading_required' },
          { status: 400 },
        );
      }
      if (!needsNumber && valueNum === null && !note && !actionTaken && !nextDue) {
        return Response.json(
          { error: 'Nothing was recorded. Write what was done, or set the date it is next due.', code: 'empty_record' },
          { status: 400 },
        );
      }

      const range = fssaiRangeCheck(valueNum, minUsed, maxUsed, uom);
      isJudged = range.judged;
      isFail = range.out_of_range;
      failReason = isFail ? range.why.slice(0, 500) : '';
      why = range.why;
    }

    const id = generateId();
    const files = Array.isArray(body?.documents) ? body.documents : [];

    /* Water is drinking water, and ice goes into a glass. A failure here is high
     * by default and urgent when the lab itself said fail — there is no "we will
     * look at it next week" version of unsafe water. */
    const severity = isLab ? 'urgent' : 'high';

    let raised: ReturnType<typeof raiseP5CorrectiveAction> = null;
    let attached: ReturnType<typeof attachP5Files> = [];

    const write = db.transaction(() => {
      db.prepare(
        `INSERT INTO fssai_water_tests
           (id, business_date, tested_at, test_kind, source_point, equipment_id, department_id,
            run_id, response_id, value_num, uom, decimals, min_used, max_used, standard_id,
            lab_name, lab_licence_no, report_no, sample_date, report_date, parameters_json,
            result, document_id, is_fail, is_judged, fail_reason, action_taken, next_due_date,
            ca_id, note, status, recorded_by, recorded_name, outlet_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, '', ?, 'submitted', ?, ?, ?)`,
      ).run(
        id, date.date, readClock(body?.tested_at), testKind, sourcePoint, equipmentId, departmentId,
        valueNum, uom, decimals, minUsed, maxUsed, standardId,
        labName, labLicence, reportNo, sampleDate, reportDate, JSON.stringify(parameters),
        result, isFail ? 1 : 0, isJudged ? 1 : 0, failReason, actionTaken, nextDue,
        note, me.email || '', me.name || '', outletId,
      );

      attached = attachP5Files(db, {
        entityTable: 'fssai_water_tests', entityId: id, files,
        actor: { email: me.email, name: me.name }, outletId,
      });

      if (isFail) {
        raised = raiseP5CorrectiveAction(db, {
          sourceKind: 'water',
          title: `${kindMeta.label} failed — ${sourcePoint}`,
          description: [
            `${kindMeta.label} at ${sourcePoint} failed on ${date.date}.`,
            failReason,
            !isLab && valueNum !== null
              ? `Reading ${fssaiDisplayReading(valueNum, decimals)}${uom ? ` ${uom}` : ''} against ${minUsed === null ? '' : `a minimum of ${minUsed}`}${minUsed !== null && maxUsed !== null ? ' and ' : ''}${maxUsed === null ? '' : `a maximum of ${maxUsed}`}${standard ? ` (${standard.label || standard.code})` : ', typed in at the time of the test because no standard was set'}.`
              : '',
            isLab && reportNo ? `Report ${reportNo}${labName ? ` from ${labName}` : ''}.` : '',
            'Until this is dealt with, the water from this point should not be treated as fit to drink or to make ice with. The reading on the record does not change.',
          ].filter(Boolean).join(' '),
          severity,
          departmentId,
          equipmentId,
          businessDate: date.date,
          recordTable: 'fssai_water_tests', recordId: id,
          actor: { email: me.email, name: me.name }, outletId,
        });
        if (raised) {
          db.prepare(`UPDATE fssai_water_tests SET ca_id = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(raised.id, id);
        }
      }

      fssaiAuditBestEffort(db, {
        entity_table: 'fssai_water_tests', entity_id: id, action: 'create',
        after: {
          business_date: date.date, test_kind: testKind, source_point: sourcePoint,
          value_num: valueNum, uom, min_used: minUsed, max_used: maxUsed,
          standard_id: standardId, result, lab_name: labName, report_no: reportNo,
          is_fail: isFail ? 1 : 0, is_judged: isJudged ? 1 : 0, fail_reason: failReason,
          next_due_date: nextDue, parameters: parameters.length, documents: attached.length,
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
      event_type: 'fssai.water.record', entity_type: 'fssai_water_tests', entity_id: id,
      actor_email: me.email,
      after: { test_kind: testKind, source_point: sourcePoint, value_num: valueNum, result, is_fail: isFail ? 1 : 0 },
      note: failReason,
    });

    const fresh = db.prepare(`${WATER_SELECT} WHERE w.id = ?`).get(id) as any;
    return Response.json({
      ok: true,
      test: shapeWaterTest(fresh, today),
      documents: attached,
      verdict: {
        is_judged: isJudged,
        is_fail: isFail,
        why,
        min_used: minUsed,
        max_used: maxUsed,
        limit_source: isLab ? 'the laboratory' : (standard ? 'standard' : (minUsed === null && maxUsed === null ? 'none' : 'typed_at_the_test')),
        standard: standard ? { id: standard.id, code: standard.code, label: standard.label } : null,
      },
      corrective_action: raised,
      ...(isFail && !raised
        ? { corrective_action_warning: 'The record is saved and the failure stands. A corrective action could not be raised against it — raise one by hand.' }
        : {}),
      ...(!isJudged && !isLab
        ? { unjudged_notice: p5UnjudgedNotice(`${kindMeta.label.toLowerCase()} readings`, 'the food-safety standards settings') }
        : {}),
    });
  } catch (e: any) {
    console.error('POST /api/fssai/water failed:', e);
    return Response.json({ error: e?.message || 'Failed to save the water record' }, { status: 500 });
  }
}

/* No DELETE and no PUT. A reading or a certificate is voided with a written
 * reason (§19) and a fresh record filed; is_fail, is_judged, min_used and
 * max_used are frozen at write and never recomputed on read. The one thing that
 * IS derived live is whether the next test is due — a stored "due" goes stale at
 * midnight. */
