/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageHr, canAdminHr } from '@/lib/hr';
import { EXITED_STATUSES } from '@/lib/hr-attendance';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Knowledge Tests (/api/hr/tests) — Phase 5.
 * Contract: docs/HRMS_DECISIONS.md (§5 hr_tests / hr_test_questions /
 * hr_test_attempts; employee_id = hr_employees.id, actors = me.email).
 *
 * THE answer-key rule (hr.ts HrTestQuestion): `correct` exists in JSON ONLY on
 * the manager/admin surface. The taker projection (action:'start') never
 * SELECTs the column at all — projected out in SQL, not deleted post-hoc.
 *
 * GET  ?test_id=<id> → { test, questions, attempts }
 *      Manager surface: active questions INCLUDE correct (+ parsed `options`),
 *      ordered by sort_order; attempts carry employee_name / employee_code
 *      (LEFT JOIN — dangling ids degrade to blank), newest first (cap 200).
 * GET  ?q=&department_id=&is_active=&page=&pageSize=
 *        → { rows, total, page, pageSize }
 *      Each row = hr_tests + department_name / designation_name +
 *      question_count (active) / attempt_count.
 *
 * POST (no action) { name (required), department_id?, designation_id?,
 *        pass_score?, max_attempts?, time_limit_minutes?, shuffle? } → { test }
 *      canManageHr. References validated at CREATE (400 named message);
 *      duplicate active name → 409.
 * POST { action:'question', test_id, kind?, question, options?, correct,
 *        sort_order? } → { question }                            canAdminHr
 *      kind 'mcq' (default) | 'true_false' (options default True/False).
 *      correct MUST be one of the options. Any question mutation bumps
 *      hr_tests.version — attempts freeze the version they ran against.
 * POST { action:'start', test_id, employee_id }
 *        → { attempt, questions, time_limit_minutes }            canManageHr
 *      409 once max_attempts is reached. An unfinished attempt is RESUMED
 *      (returned again), never duplicated. Questions come WITHOUT correct,
 *      shuffled (questions AND options) when test.shuffle. Exited employees
 *      (EXITED_STATUSES from hr-attendance) are refused with a named 400;
 *      suspended staff MAY take tests.
 * POST { action:'submit', attempt_id, answers_json } → { attempt, result }
 *      canManageHr. Scores SERVER-SIDE against the stored answer key; passed
 *      by test.pass_score; stamps finished_at. A finished attempt is
 *      IMMUTABLE — re-submitting is a 409. Audit: hr.test.attempt.
 *
 * PUT  { id, ...test fields } → { test }                          canManageHr
 * PUT  { question_id, ...question fields } → { question }         canAdminHr
 * DELETE ?id= (test, canManageHr) | ?question_id= (question, canAdminHr)
 *        → { ok: true }             (soft: is_active = 0 — rows never removed)
 *
 * Every verb gates through getCurrentUser (the proxy does NOT protect API
 * GETs, HRMS_DECISIONS §2.1). Errors return GENERIC messages only —
 * e.message can leak schema/PII for HR data.
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** Non-negative integer; garbage → 0. */
function int0(v: unknown): number {
  return Math.max(0, parseInt(String(v ?? '0'), 10) || 0);
}

/** Fisher-Yates in place (used only when test.shuffle = 1). */
function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** options_json → string[] ([] on corrupt JSON — degrade, never throw). */
function parseOptions(json: unknown): string[] {
  try {
    const parsed = JSON.parse(String(json ?? '[]'));
    return Array.isArray(parsed) ? parsed.map((o) => String(o)) : [];
  } catch {
    return [];
  }
}

/**
 * Normalise a submitted options array: trimmed, blanks dropped, de-duplicated,
 * 2-12 entries. Returns null when the shape is invalid (caller 400s).
 */
function cleanOptions(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const opt = s(raw);
    if (!opt || seen.has(opt)) continue;
    seen.add(opt);
    out.push(opt);
  }
  if (out.length < 2 || out.length > 12) return null;
  return out;
}

const QUESTION_KINDS = ['mcq', 'true_false'] as const;

/** Test + joined display names + counters. */
const TEST_SELECT = `
  SELECT t.*,
         d.name  AS department_name,
         ds.name AS designation_name,
         (SELECT COUNT(*) FROM hr_test_questions q
           WHERE q.test_id = t.id AND q.is_active = 1) AS question_count,
         (SELECT COUNT(*) FROM hr_test_attempts a WHERE a.test_id = t.id) AS attempt_count
  FROM hr_tests t
  LEFT JOIN departments d      ON d.id  = t.department_id
  LEFT JOIN hr_designations ds ON ds.id = t.designation_id
`;

/** Attempt + employee display names (LEFT JOIN — dangling ids stay blank). */
const ATTEMPT_SELECT = `
  SELECT a.*,
         e.full_name AS employee_name,
         e.employee_code AS employee_code
  FROM hr_test_attempts a
  LEFT JOIN hr_employees e ON e.id = a.employee_id
`;

/** One test with joined names, or null. */
function loadTest(db: any, id: string): any {
  return db.prepare(`${TEST_SELECT} WHERE t.id = ?`).get(id) ?? null;
}

/**
 * TAKER projection: the answer key is NEVER selected — the SQL projection has
 * no `correct` column, so it cannot leak through any serializer. Shuffles
 * question order AND option order when the test says so (options are matched
 * by VALUE at scoring time, so reordering them is safe).
 */
function takerQuestions(db: any, testId: string, shuffle: number): any[] {
  const rows = db
    .prepare(
      `SELECT id, kind, question, options_json, sort_order
       FROM hr_test_questions
       WHERE test_id = ? AND is_active = 1
       ORDER BY sort_order, id`,
    )
    .all(testId) as any[];
  const mapped = rows.map((q) => ({
    id: q.id,
    kind: q.kind,
    question: q.question,
    options: parseOptions(q.options_json),
    sort_order: q.sort_order,
  }));
  if (shuffle) {
    shuffleInPlace(mapped);
    for (const q of mapped) shuffleInPlace(q.options);
  }
  return mapped;
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;

    // ---- detail: one test + authoring questions (WITH correct) + attempts ----
    const test_id = s(sp.get('test_id'));
    if (test_id) {
      const db = getDb();
      const test = loadTest(db, test_id);
      if (!test) return Response.json({ error: 'Test not found' }, { status: 404 });

      // Manager/authoring surface — correct is INCLUDED here (and only here).
      const questions = (
        db
          .prepare(
            `SELECT * FROM hr_test_questions
             WHERE test_id = ? AND is_active = 1
             ORDER BY sort_order, id`,
          )
          .all(test_id) as any[]
      ).map((q) => ({ ...q, options: parseOptions(q.options_json) }));

      const attempts = db
        .prepare(
          `${ATTEMPT_SELECT} WHERE a.test_id = ?
           ORDER BY a.started_at DESC, a.id LIMIT 200`,
        )
        .all(test_id);

      return Response.json({ test, questions, attempts });
    }

    // ---- list ----
    // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
    // SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    // ONE clause + params feeds both COUNT(*) and the page query, so total
    // and rows can never disagree.
    const clauses: string[] = [];
    const params: any[] = [];
    const q = s(sp.get('q'));
    if (q) {
      clauses.push('t.name LIKE ?');
      params.push(`%${q}%`);
    }
    const department_id = s(sp.get('department_id'));
    if (department_id) {
      clauses.push('t.department_id = ?');
      params.push(department_id);
    }
    const is_active = s(sp.get('is_active'));
    if (is_active === '0' || is_active === '1') {
      clauses.push('t.is_active = ?');
      params.push(parseInt(is_active, 10));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const db = getDb();
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_tests t ${where}`)
      .get(...params) as { n: number };

    const rows = db
      .prepare(
        `${TEST_SELECT} ${where}
         ORDER BY t.name COLLATE NOCASE, t.id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize);

    return Response.json({ rows, total: totalRow.n, page, pageSize });
  } catch (e) {
    console.error('[hr-tests] GET failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load tests' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    let body: any = {};
    try { body = await request.json(); } catch { /* handled by field checks below */ }
    const action = s(body?.action);

    // ================= question authoring (canAdminHr) =================
    if (action === 'question') {
      // Question mutations are ADMIN acts — the answer key is the whole value
      // of the test.
      if (!canAdminHr(me)) {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }
      const test_id = s(body?.test_id);
      if (!test_id) return Response.json({ error: 'Test is required' }, { status: 400 });
      const kind = s(body?.kind) || 'mcq';
      if (!QUESTION_KINDS.includes(kind as any)) {
        return Response.json({ error: 'Invalid question kind' }, { status: 400 });
      }
      const question = s(body?.question);
      if (!question) return Response.json({ error: 'Question text is required' }, { status: 400 });

      // true_false without explicit options gets the canonical pair; mcq must
      // supply 2-12 distinct options.
      const options =
        body?.options === undefined && kind === 'true_false'
          ? ['True', 'False']
          : cleanOptions(body?.options);
      if (options === null) {
        return Response.json(
          { error: 'Options must be 2 to 12 distinct choices' },
          { status: 400 },
        );
      }
      const correct = s(body?.correct);
      if (!correct || !options.includes(correct)) {
        return Response.json(
          { error: 'Correct answer must be one of the options' },
          { status: 400 },
        );
      }

      const db = getDb();
      const test = db.prepare('SELECT * FROM hr_tests WHERE id = ?').get(test_id) as any;
      if (!test) return Response.json({ error: 'Selected test was not found' }, { status: 400 });

      const id = generateId();
      const create = db.transaction(() => {
        const sort_order =
          body?.sort_order !== undefined
            ? int0(body.sort_order)
            : ((db
                .prepare(
                  'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM hr_test_questions WHERE test_id = ?',
                )
                .get(test_id) as any)?.n ?? 1);
        db.prepare(
          `INSERT INTO hr_test_questions
             (id, test_id, kind, question, options_json, correct, sort_order, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(id, test_id, kind, question, JSON.stringify(options), correct, sort_order);
        // Any question change bumps the test version — attempts freeze the
        // version they ran against (hr_test_attempts.test_version).
        db.prepare('UPDATE hr_tests SET version = version + 1 WHERE id = ?').run(test_id);
        logAuditEvent(db, {
          event_type: 'hr.test.question.create',
          entity_type: 'hr_test_question',
          entity_id: id,
          actor_email: me.email,
          after: { id, test_id, kind, question, options, correct, sort_order },
        });
      });
      create();

      const row = db.prepare('SELECT * FROM hr_test_questions WHERE id = ?').get(id) as any;
      return Response.json({ question: { ...row, options: parseOptions(row.options_json) } });
    }

    // ================= attempt: start (canManageHr) =================
    if (action === 'start') {
      const test_id = s(body?.test_id);
      if (!test_id) return Response.json({ error: 'Test is required' }, { status: 400 });
      const employee_id = s(body?.employee_id);
      if (!employee_id) return Response.json({ error: 'Employee is required' }, { status: 400 });

      const db = getDb();
      const test = db.prepare('SELECT * FROM hr_tests WHERE id = ?').get(test_id) as any;
      if (!test) return Response.json({ error: 'Selected test was not found' }, { status: 400 });
      if (!test.is_active) {
        return Response.json({ error: 'This test is inactive' }, { status: 400 });
      }
      const emp = db
        .prepare('SELECT id, status FROM hr_employees WHERE id = ?')
        .get(employee_id) as any;
      if (!emp) {
        return Response.json({ error: 'Selected employee was not found' }, { status: 400 });
      }
      // Exit gate (engine's exported subset — never re-declared): employees
      // who have LEFT cannot start attempts. Suspended staff MAY take tests —
      // suspension blocks punches, not learning — so only exits are refused.
      if (EXITED_STATUSES.has(String(emp.status ?? '').trim())) {
        return Response.json(
          {
            error:
              'This employee has exited (resigned/terminated/former) and cannot take tests. ' +
              'Suspended staff may still take tests.',
          },
          { status: 400 },
        );
      }
      const activeQ = (
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM hr_test_questions WHERE test_id = ? AND is_active = 1',
          )
          .get(test_id) as any
      ).n as number;
      if (activeQ === 0) {
        return Response.json({ error: 'This test has no questions yet' }, { status: 400 });
      }

      const prior = db
        .prepare(
          `SELECT * FROM hr_test_attempts
           WHERE test_id = ? AND employee_id = ? ORDER BY attempt_no`,
        )
        .all(test_id, employee_id) as any[];

      // An unfinished attempt is RESUMED, never duplicated — it was
      // legitimately started and still owns its attempt_no slot.
      const open = prior.find((a) => a.finished_at === '');
      if (open) {
        return Response.json({
          attempt: open,
          questions: takerQuestions(db, test_id, test.shuffle),
          time_limit_minutes: test.time_limit_minutes,
        });
      }
      const maxAttempts = Math.max(1, Number(test.max_attempts) || 1);
      if (prior.length >= maxAttempts) {
        return Response.json(
          { error: `Maximum attempts (${maxAttempts}) reached for this employee` },
          { status: 409 },
        );
      }

      const id = generateId();
      const attempt_no =
        prior.reduce((mx, a) => Math.max(mx, Number(a.attempt_no) || 0), 0) + 1;
      try {
        db.prepare(
          `INSERT INTO hr_test_attempts
             (id, test_id, test_version, employee_id, attempt_no, answers_json)
           VALUES (?, ?, ?, ?, ?, '{}')`,
        ).run(id, test_id, test.version, employee_id, attempt_no);
      } catch (e: any) {
        // UNIQUE(test_id, employee_id, attempt_no) — two concurrent starts;
        // the loser gets a clean 409, never a 500.
        if (String(e?.code || '').startsWith('SQLITE_CONSTRAINT')) {
          return Response.json(
            { error: 'Another attempt was just started for this employee' },
            { status: 409 },
          );
        }
        throw e;
      }

      const attempt = db.prepare('SELECT * FROM hr_test_attempts WHERE id = ?').get(id);
      return Response.json({
        attempt,
        questions: takerQuestions(db, test_id, test.shuffle),
        time_limit_minutes: test.time_limit_minutes,
      });
    }

    // ================= attempt: submit (canManageHr) =================
    if (action === 'submit') {
      const attempt_id = s(body?.attempt_id);
      if (!attempt_id) return Response.json({ error: 'Attempt id is required' }, { status: 400 });

      // answers_json: object (or JSON string) of {question_id: chosen_option}.
      let answersRaw: any = body?.answers_json;
      if (typeof answersRaw === 'string') {
        try { answersRaw = JSON.parse(answersRaw); } catch { answersRaw = null; }
      }
      if (answersRaw === null || typeof answersRaw !== 'object' || Array.isArray(answersRaw)) {
        return Response.json({ error: 'Answers are required' }, { status: 400 });
      }
      const answers: Record<string, string> = {};
      let nKeys = 0;
      for (const [k, v] of Object.entries(answersRaw)) {
        if (++nKeys > 1000) {
          return Response.json({ error: 'Too many answers' }, { status: 400 });
        }
        answers[k] = s(v);
      }

      const db = getDb();
      const attempt = db
        .prepare('SELECT * FROM hr_test_attempts WHERE id = ?')
        .get(attempt_id) as any;
      if (!attempt) return Response.json({ error: 'Attempt not found' }, { status: 404 });
      // Attempts are IMMUTABLE once finished — the register of who scored
      // what is never rewritten.
      if (attempt.finished_at !== '') {
        return Response.json(
          { error: 'This attempt has already been submitted' },
          { status: 409 },
        );
      }

      // Score server-side against the stored answer key. Scoring runs over
      // the CURRENT active questions — if the admin edited the paper
      // mid-attempt the drift is visible as attempt.test_version ≠
      // test.version, never hidden.
      const questions = db
        .prepare(
          'SELECT id, correct FROM hr_test_questions WHERE test_id = ? AND is_active = 1',
        )
        .all(attempt.test_id) as { id: string; correct: string }[];
      const total = questions.length;
      let correctCount = 0;
      for (const q of questions) {
        if ((answers[q.id] ?? '') === s(q.correct)) correctCount++;
      }
      const score = total ? Math.round((correctCount / total) * 10000) / 100 : 0;

      const test = db
        .prepare('SELECT pass_score FROM hr_tests WHERE id = ?')
        .get(attempt.test_id) as any;
      const passScore = Number(test?.pass_score ?? 60);
      const passed = score >= passScore ? 1 : 0;

      const submit = db.transaction(() => {
        // finished_at = '' guard: a lost race with another submit is a clean
        // 409 (thrown + mapped below), never a silent double-write.
        const res = db
          .prepare(
            `UPDATE hr_test_attempts
             SET answers_json = ?, score = ?, passed = ?, finished_at = datetime('now')
             WHERE id = ? AND finished_at = ''`,
          )
          .run(JSON.stringify(answers), score, passed, attempt_id);
        if (res.changes !== 1) throw new Error('ATTEMPT_ALREADY_FINISHED');
        logAuditEvent(db, {
          event_type: 'hr.test.attempt',
          entity_type: 'hr_test_attempt',
          entity_id: attempt_id,
          actor_email: me.email,
          after: {
            test_id: attempt.test_id,
            test_version: attempt.test_version,
            employee_id: attempt.employee_id,
            attempt_no: attempt.attempt_no,
            score,
            passed,
            correct: correctCount,
            total,
          },
        });
      });
      try {
        submit();
      } catch (e) {
        if (e instanceof Error && e.message === 'ATTEMPT_ALREADY_FINISHED') {
          return Response.json(
            { error: 'This attempt has already been submitted' },
            { status: 409 },
          );
        }
        throw e;
      }

      const finished = db.prepare(`${ATTEMPT_SELECT} WHERE a.id = ?`).get(attempt_id);
      return Response.json({ attempt: finished, result: { total, correct: correctCount } });
    }

    if (action) return Response.json({ error: 'Unknown action' }, { status: 400 });

    // ================= create test (canManageHr) =================
    const name = s(body?.name);
    if (!name) return Response.json({ error: 'Test name is required' }, { status: 400 });

    const pass_score = body?.pass_score === undefined ? 60 : Number(body.pass_score);
    if (!Number.isFinite(pass_score) || pass_score < 0 || pass_score > 100) {
      return Response.json(
        { error: 'Pass score must be a number between 0 and 100' },
        { status: 400 },
      );
    }
    const max_attempts = body?.max_attempts === undefined ? 3 : int0(body.max_attempts);
    if (max_attempts < 1 || max_attempts > 100) {
      return Response.json(
        { error: 'Max attempts must be between 1 and 100' },
        { status: 400 },
      );
    }
    const time_limit_minutes =
      body?.time_limit_minutes === undefined ? 0 : int0(body.time_limit_minutes);
    const shuffle = body?.shuffle === undefined ? 1 : body.shuffle ? 1 : 0;
    const department_id = s(body?.department_id);
    const designation_id = s(body?.designation_id);

    const db = getDb();
    const dupe = db
      .prepare('SELECT id FROM hr_tests WHERE name = ? COLLATE NOCASE AND is_active = 1')
      .get(name) as any;
    if (dupe) {
      return Response.json(
        { error: 'An active test with that name already exists' },
        { status: 409 },
      );
    }
    // Referenced rows validated at CREATE (400, named) — reads stay tolerant.
    if (department_id) {
      const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id) as any;
      if (!dept) {
        return Response.json({ error: 'Selected department was not found' }, { status: 400 });
      }
    }
    if (designation_id) {
      const desig = db
        .prepare('SELECT id FROM hr_designations WHERE id = ?')
        .get(designation_id) as any;
      if (!desig) {
        return Response.json({ error: 'Selected designation was not found' }, { status: 400 });
      }
    }

    const id = generateId();
    const create = db.transaction(() => {
      db.prepare(
        `INSERT INTO hr_tests
           (id, name, department_id, designation_id, pass_score, max_attempts,
            time_limit_minutes, shuffle, version, is_active, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
      ).run(
        id, name, department_id, designation_id, pass_score, max_attempts,
        time_limit_minutes, shuffle, me.email,
      );
      logAuditEvent(db, {
        event_type: 'hr.test.create',
        entity_type: 'hr_test',
        entity_id: id,
        actor_email: me.email,
        after: {
          id, name, department_id, designation_id, pass_score, max_attempts,
          time_limit_minutes, shuffle, created_by: me.email,
        },
      });
    });
    create();

    return Response.json({ test: loadTest(db, id) });
  } catch (e) {
    console.error('[hr-tests] POST failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to save' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    let body: any = {};
    try { body = await request.json(); } catch { /* handled below */ }

    // ================= update a question (canAdminHr) =================
    const question_id = s(body?.question_id);
    if (question_id) {
      if (!canAdminHr(me)) {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }
      const db = getDb();
      const existing = db
        .prepare('SELECT * FROM hr_test_questions WHERE id = ?')
        .get(question_id) as any;
      if (!existing) return Response.json({ error: 'Question not found' }, { status: 404 });

      // Merge incoming fields over the stored row, then validate the FINAL
      // shape once — so changing options alone still re-checks correct.
      const kind = body.kind !== undefined ? s(body.kind) : existing.kind;
      if (!QUESTION_KINDS.includes(kind as any)) {
        return Response.json({ error: 'Invalid question kind' }, { status: 400 });
      }
      const question = body.question !== undefined ? s(body.question) : existing.question;
      if (!question) {
        return Response.json({ error: 'Question text is required' }, { status: 400 });
      }
      const options =
        body.options !== undefined
          ? cleanOptions(body.options)
          : parseOptions(existing.options_json);
      if (options === null || options.length < 2) {
        return Response.json(
          { error: 'Options must be 2 to 12 distinct choices' },
          { status: 400 },
        );
      }
      const correct = body.correct !== undefined ? s(body.correct) : s(existing.correct);
      if (!correct || !options.includes(correct)) {
        return Response.json(
          { error: 'Correct answer must be one of the options' },
          { status: 400 },
        );
      }
      const sort_order =
        body.sort_order !== undefined ? int0(body.sort_order) : existing.sort_order;
      const is_active =
        body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active;

      const update = db.transaction(() => {
        db.prepare(
          `UPDATE hr_test_questions
           SET kind = ?, question = ?, options_json = ?, correct = ?,
               sort_order = ?, is_active = ?
           WHERE id = ?`,
        ).run(kind, question, JSON.stringify(options), correct, sort_order, is_active, question_id);
        // Any question change bumps the test version (attempts freeze theirs).
        db.prepare('UPDATE hr_tests SET version = version + 1 WHERE id = ?')
          .run(existing.test_id);
        logAuditEvent(db, {
          event_type: 'hr.test.question.update',
          entity_type: 'hr_test_question',
          entity_id: question_id,
          actor_email: me.email,
          before: existing,
          after: { ...existing, kind, question, options_json: JSON.stringify(options), correct, sort_order, is_active },
        });
      });
      update();

      const row = db.prepare('SELECT * FROM hr_test_questions WHERE id = ?').get(question_id) as any;
      return Response.json({ question: { ...row, options: parseOptions(row.options_json) } });
    }

    // ================= update a test (canManageHr) =================
    const id = s(body?.id);
    if (!id) return Response.json({ error: 'Test id is required' }, { status: 400 });

    const db = getDb();
    const existing = db.prepare('SELECT * FROM hr_tests WHERE id = ?').get(id) as any;
    if (!existing) return Response.json({ error: 'Test not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];

    if (body.name !== undefined) {
      const name = s(body.name);
      if (!name) return Response.json({ error: 'Test name cannot be empty' }, { status: 400 });
      const dupe = db
        .prepare(
          'SELECT id FROM hr_tests WHERE name = ? COLLATE NOCASE AND is_active = 1 AND id != ?',
        )
        .get(name, id) as any;
      if (dupe) {
        return Response.json(
          { error: 'An active test with that name already exists' },
          { status: 409 },
        );
      }
      sets.push('name = ?'); args.push(name);
    }
    if (body.department_id !== undefined) {
      const department_id = s(body.department_id);
      if (department_id) {
        const dept = db
          .prepare('SELECT id FROM departments WHERE id = ?')
          .get(department_id) as any;
        if (!dept) {
          return Response.json({ error: 'Selected department was not found' }, { status: 400 });
        }
      }
      sets.push('department_id = ?'); args.push(department_id);
    }
    if (body.designation_id !== undefined) {
      const designation_id = s(body.designation_id);
      if (designation_id) {
        const desig = db
          .prepare('SELECT id FROM hr_designations WHERE id = ?')
          .get(designation_id) as any;
        if (!desig) {
          return Response.json({ error: 'Selected designation was not found' }, { status: 400 });
        }
      }
      sets.push('designation_id = ?'); args.push(designation_id);
    }
    if (body.pass_score !== undefined) {
      const pass_score = Number(body.pass_score);
      if (!Number.isFinite(pass_score) || pass_score < 0 || pass_score > 100) {
        return Response.json(
          { error: 'Pass score must be a number between 0 and 100' },
          { status: 400 },
        );
      }
      sets.push('pass_score = ?'); args.push(pass_score);
    }
    if (body.max_attempts !== undefined) {
      const max_attempts = int0(body.max_attempts);
      if (max_attempts < 1 || max_attempts > 100) {
        return Response.json(
          { error: 'Max attempts must be between 1 and 100' },
          { status: 400 },
        );
      }
      sets.push('max_attempts = ?'); args.push(max_attempts);
    }
    if (body.time_limit_minutes !== undefined) {
      sets.push('time_limit_minutes = ?'); args.push(int0(body.time_limit_minutes));
    }
    if (body.shuffle !== undefined) {
      sets.push('shuffle = ?'); args.push(body.shuffle ? 1 : 0);
    }
    if (body.is_active !== undefined) {
      sets.push('is_active = ?'); args.push(body.is_active ? 1 : 0);
    }
    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    const update = db.transaction(() => {
      db.prepare(`UPDATE hr_tests SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      const after = db.prepare('SELECT * FROM hr_tests WHERE id = ?').get(id);
      logAuditEvent(db, {
        event_type: 'hr.test.update',
        entity_type: 'hr_test',
        entity_id: id,
        actor_email: me.email,
        before: existing,
        after,
      });
    });
    update();

    return Response.json({ test: loadTest(db, id) });
  } catch (e) {
    console.error('[hr-tests] PUT failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const url = new URL(request.url);

    // ================= deactivate a question (canAdminHr) =================
    const question_id = s(url.searchParams.get('question_id'));
    if (question_id) {
      if (!canAdminHr(me)) {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }
      const db = getDb();
      const existing = db
        .prepare('SELECT * FROM hr_test_questions WHERE id = ?')
        .get(question_id) as any;
      if (!existing) return Response.json({ error: 'Question not found' }, { status: 404 });

      if (existing.is_active) {
        const tx = db.transaction(() => {
          db.prepare('UPDATE hr_test_questions SET is_active = 0 WHERE id = ?').run(question_id);
          db.prepare('UPDATE hr_tests SET version = version + 1 WHERE id = ?')
            .run(existing.test_id);
          logAuditEvent(db, {
            event_type: 'hr.test.question.deactivate',
            entity_type: 'hr_test_question',
            entity_id: question_id,
            actor_email: me.email,
            before: existing,
            after: { ...existing, is_active: 0 },
          });
        });
        tx();
      }
      return Response.json({ ok: true });
    }

    // ================= deactivate a test (canManageHr) =================
    // House style is ?id= (vendors, hr/designations); DELETE { id } accepted too.
    let id = s(url.searchParams.get('id'));
    if (!id) {
      try {
        const body: any = await request.json();
        id = s(body?.id);
      } catch { /* no body — handled below */ }
    }
    if (!id) return Response.json({ error: 'Test id is required' }, { status: 400 });

    const db = getDb();
    const existing = db.prepare('SELECT * FROM hr_tests WHERE id = ?').get(id) as any;
    if (!existing) return Response.json({ error: 'Test not found' }, { status: 404 });

    // Soft deactivate is ALWAYS allowed — no in-use guard. Attempts keep the
    // test's label through their joins; only pickers hide it.
    if (existing.is_active) {
      db.prepare('UPDATE hr_tests SET is_active = 0 WHERE id = ?').run(id);
      logAuditEvent(db, {
        event_type: 'hr.test.deactivate',
        entity_type: 'hr_test',
        entity_id: id,
        actor_email: me.email,
        before: existing,
        after: { ...existing, is_active: 0 },
      });
    }
    return Response.json({ ok: true });
  } catch (e) {
    console.error('[hr-tests] DELETE failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to deactivate' }, { status: 500 });
  }
}
