/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageTasks, parseMentions } from '@/lib/tasks';

/**
 * Knowledge Tests (/api/tasks/knowledge-tests).
 *
 * GET  /api/tasks/knowledge-tests
 *        ?view=list (default) → { rows: KnowledgeTest[] }. Managers see all;
 *              staff see only active tests. Each row carries my_last_result +
 *              attempt_count for the current user (question answers stripped for
 *              non-managers so the test stays takeable).
 *        ?view=leaderboard&test_id= → { rows } best-score-per-user, desc.
 *        ?view=history[&test_id=][&user_email=] → my (or, for managers, any)
 *              attempt history.
 *        ?view=test&test_id= → { test } full test incl. questions_json (answers
 *              stripped for non-managers).
 * POST /api/tasks/knowledge-tests
 *        { action:'create', title, description?, questions[]|questions_json,
 *          time_limit_minutes?, pass_score?, is_active? }  → create. Manager.
 *        { action:'submit', test_id, answers[], duration_minutes? } → auto-score
 *          MCQ/image questions, store knowledge_test_results, passed if
 *          score >= pass_score. Any signed-in user.
 * PUT  { id, ...fields }  → edit a test. Manager.
 * DELETE ?id=[&hard=1]    → soft-deactivate (is_active=0), or hard delete. Manager.
 *
 * Signed-out → 401. Non-manager create/edit/delete → 403.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/* ── question / scoring helpers ─────────────────────────────────────────── */

function parseQuestions(raw: any): any[] {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { return []; } }
  return Array.isArray(arr) ? arr : [];
}

/** Normalise questions payload → clean array + JSON string. */
function normQuestions(questions: any, questionsJson: any): { arr: any[]; json: string } {
  const src = questions != null ? questions : questionsJson;
  const arr = parseQuestions(src)
    .map((q: any) => {
      if (!q || typeof q !== 'object') return null;
      const type = ['mcq', 'image', 'practical'].includes(q.type) ? q.type : 'mcq';
      const qText = String(q.q ?? q.question ?? '').trim();
      if (!qText) return null;
      const options = Array.isArray(q.options) ? q.options.map((o: any) => String(o)) : [];
      return {
        q: qText,
        type,
        options,
        answer: q.answer == null ? '' : String(q.answer),
        image_url: String(q.image_url ?? ''),
      };
    })
    .filter(Boolean);
  return { arr, json: JSON.stringify(arr) };
}

/** Strip the `answer` key from questions so a taker can't read the key. */
function stripAnswers(questionsJson: string): string {
  return JSON.stringify(parseQuestions(questionsJson).map((q: any) => ({ ...q, answer: undefined })));
}

const canon = (v: any) => String(v ?? '').trim().toLowerCase();

/**
 * Auto-score a submission. MCQ/image questions with a defined answer are graded;
 * practical questions are left for manual review. Answer may match the option
 * text or its 0-based index.
 */
function scoreSubmission(questions: any[], answers: any[]): { score: number; hasPractical: boolean } {
  let auto = 0, correct = 0, hasPractical = false;
  questions.forEach((q, i) => {
    if (q?.type === 'practical') { hasPractical = true; return; }
    if (q?.answer == null || String(q.answer).trim() === '') return; // ungraded
    auto++;
    const given = answers?.[i];
    const key = canon(q.answer);
    if (canon(given) === key) { correct++; return; }
    // index-style answer: q.answer is an index into options, given is the text (or vice-versa)
    const opts = Array.isArray(q.options) ? q.options : [];
    const givenIdx = Number(given);
    if (Number.isInteger(givenIdx) && opts[givenIdx] != null && canon(opts[givenIdx]) === key) { correct++; return; }
    const keyIdx = Number(q.answer);
    if (Number.isInteger(keyIdx) && opts[keyIdx] != null && canon(opts[keyIdx]) === canon(given)) { correct++; }
  });
  const score = auto > 0 ? Math.round((correct / auto) * 1000) / 10 : 0;
  return { score, hasPractical };
}

function notify(db: any, recipient: string, kind: string, title: string, body: string) {
  if (!recipient || !recipient.includes('@')) return;
  db.prepare(
    `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
     VALUES (?, ?, ?, ?, ?, '', '/tasks/knowledge-tests')`,
  ).run(generateId(), recipient, kind, title, body);
}

function recordMentions(db: any, text: string, byEmail: string) {
  for (const tok of parseMentions(text)) {
    const isEmail = tok.includes('@');
    db.prepare(
      `INSERT INTO task_mentions (id, task_id, comment_id, mentioned_email, mentioned_name, mentioned_by)
       VALUES (?, '', '', ?, ?, ?)`,
    ).run(generateId(), isEmail ? tok : '', isEmail ? '' : tok, byEmail);
    if (isEmail) notify(db, tok, 'mention', 'You were mentioned on a knowledge test', text.slice(0, 200));
  }
}

/* ── GET ────────────────────────────────────────────────────────────────── */

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const manage = canManageTasks(me);

  try {
    const url = new URL(request.url);
    const view = url.searchParams.get('view') || 'list';
    const testId = url.searchParams.get('test_id') || '';
    const db = getDb();

    if (view === 'leaderboard') {
      if (!testId) return Response.json({ error: 'test_id required' }, { status: 400 });
      const rows = db.prepare(
        `SELECT user_email, user_name, MAX(score) AS best_score, COUNT(*) AS attempts,
                MAX(passed) AS ever_passed, MAX(taken_at) AS last_taken
         FROM knowledge_test_results WHERE test_id = ?
         GROUP BY user_email ORDER BY best_score DESC, last_taken ASC`,
      ).all(testId);
      return Response.json({ rows });
    }

    if (view === 'history') {
      // Non-managers may only see their own history.
      const target = manage ? (url.searchParams.get('user_email') || '') : me.email;
      const where: string[] = [];
      const args: any[] = [];
      if (testId) { where.push('r.test_id = ?'); args.push(testId); }
      if (target) { where.push('r.user_email = ?'); args.push(target); }
      const rows = db.prepare(
        `SELECT r.*, t.title AS test_title, t.pass_score
         FROM knowledge_test_results r
         LEFT JOIN knowledge_tests t ON t.id = r.test_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY r.taken_at DESC, r.created_at DESC LIMIT 500`,
      ).all(...args);
      return Response.json({ rows });
    }

    if (view === 'test') {
      if (!testId) return Response.json({ error: 'test_id required' }, { status: 400 });
      const test = db.prepare(`SELECT * FROM knowledge_tests WHERE id = ?`).get(testId) as any;
      if (!test) return Response.json({ error: 'Test not found' }, { status: 404 });
      if (!manage && !test.is_active) return Response.json({ error: 'Test not available' }, { status: 403 });
      if (!manage) test.questions_json = stripAnswers(test.questions_json);
      return Response.json({ test });
    }

    // default: list
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const where: string[] = [];
    const args: any[] = [];
    if (!manage) where.push('is_active = 1');
    if (q) { where.push('(LOWER(title) LIKE ? OR LOWER(description) LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    const tests = db.prepare(
      `SELECT * FROM knowledge_tests
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY is_active DESC, created_at DESC`,
    ).all(...args) as any[];

    const lastRes = db.prepare(
      `SELECT * FROM knowledge_test_results WHERE test_id = ? AND user_email = ?
       ORDER BY taken_at DESC, created_at DESC LIMIT 1`,
    );
    const cnt = db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_test_results WHERE test_id = ? AND user_email = ?`,
    );

    const rows = tests.map((t) => {
      const last = lastRes.get(t.id, me.email) as any;
      const attempts = (cnt.get(t.id, me.email) as any)?.n ?? 0;
      const questions = parseQuestions(t.questions_json);
      return {
        ...t,
        // Managers keep the key; takers get answers stripped.
        questions_json: manage ? t.questions_json : stripAnswers(t.questions_json),
        question_count: questions.length,
        my_last_result: last ? { score: last.score, passed: last.passed, taken_at: last.taken_at, reviewed: last.reviewed } : null,
        attempt_count: attempts,
      };
    });
    return Response.json({ rows });
  } catch (e: any) {
    console.error('GET /api/tasks/knowledge-tests failed:', e);
    return Response.json({ error: e?.message || 'Failed to load tests' }, { status: 500 });
  }
}

/* ── POST (create | submit) ─────────────────────────────────────────────── */

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const action = String(body?.action ?? (body?.answers != null ? 'submit' : 'create'));

  const db = getDb();

  /* --- submit an attempt (any signed-in user) --- */
  if (action === 'submit') {
    const testId = String(body?.test_id ?? '').trim();
    if (!testId) return Response.json({ error: 'test_id required' }, { status: 400 });
    try {
      const test = db.prepare(`SELECT * FROM knowledge_tests WHERE id = ?`).get(testId) as any;
      if (!test) return Response.json({ error: 'Test not found' }, { status: 404 });
      if (!test.is_active && !canManageTasks(me)) return Response.json({ error: 'Test is not active' }, { status: 403 });

      const questions = parseQuestions(test.questions_json);
      const answers = Array.isArray(body?.answers) ? body.answers : [];
      const { score, hasPractical } = scoreSubmission(questions, answers);
      const passed = score >= (test.pass_score || 0) ? 1 : 0;
      const reviewed = hasPractical ? 0 : 1; // practical answers need manual review
      const takenAt = new Date().toISOString();

      const id = generateId();
      db.prepare(
        `INSERT INTO knowledge_test_results
          (id, test_id, user_email, user_name, score, answers_json, passed, reviewed, taken_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, testId, me.email, me.name || me.email, score, JSON.stringify(answers), passed, reviewed, takenAt);

      // Let the test author know an attempt came in.
      if (test.created_by && test.created_by !== me.email) {
        notify(db, test.created_by, 'test_submitted', `Test attempt: ${test.title}`,
          `${me.name || me.email} scored ${score}% (${passed ? 'passed' : 'failed'})${hasPractical ? ' — practical review pending' : ''}.`);
      }

      const result = db.prepare(`SELECT * FROM knowledge_test_results WHERE id = ?`).get(id);
      return Response.json({ result, score, passed: !!passed, reviewed: !!reviewed, needs_review: hasPractical, pass_score: test.pass_score });
    } catch (e: any) {
      console.error('POST submit knowledge-test failed:', e);
      return Response.json({ error: e?.message || 'Failed to submit test' }, { status: 500 });
    }
  }

  /* --- create a test (managers only) --- */
  if (!canManageTasks(me)) return Response.json({ error: 'Not authorised' }, { status: 403 });
  const title = String(body?.title ?? '').trim();
  if (!title) return Response.json({ error: 'Title is required' }, { status: 400 });
  const description = String(body?.description ?? '').trim();
  const { json: questions_json } = normQuestions(body?.questions, body?.questions_json);
  const time_limit_minutes = Math.max(0, parseInt(String(body?.time_limit_minutes ?? 0), 10) || 0);
  let pass_score = parseInt(String(body?.pass_score ?? 60), 10);
  if (!Number.isFinite(pass_score)) pass_score = 60;
  pass_score = Math.min(Math.max(pass_score, 0), 100);
  const is_active = body?.is_active === 0 || body?.is_active === false ? 0 : 1;

  try {
    const id = generateId();
    db.prepare(
      `INSERT INTO knowledge_tests
        (id, title, description, questions_json, time_limit_minutes, pass_score, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, title, description, questions_json, time_limit_minutes, pass_score, is_active, me.email);
    if (description) recordMentions(db, description, me.email);
    const test = db.prepare(`SELECT * FROM knowledge_tests WHERE id = ?`).get(id);
    return Response.json({ test, created: true });
  } catch (e: any) {
    console.error('POST create knowledge-test failed:', e);
    return Response.json({ error: e?.message || 'Failed to create test' }, { status: 500 });
  }
}

/* ── PUT (edit a test) ──────────────────────────────────────────────────── */

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageTasks(me)) return Response.json({ error: 'Not authorised' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = String(body?.id ?? '').trim();
  if (!id) return Response.json({ error: 'Test id is required' }, { status: 400 });

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT id FROM knowledge_tests WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'Test not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];
    const setField = (col: string, val: any) => { sets.push(`${col} = ?`); args.push(val); };

    if (body.title != null) { const t = String(body.title).trim(); if (!t) return Response.json({ error: 'Title cannot be empty' }, { status: 400 }); setField('title', t); }
    if (body.description != null) setField('description', String(body.description).trim());
    if (body.questions != null || body.questions_json != null) setField('questions_json', normQuestions(body.questions, body.questions_json).json);
    if (body.time_limit_minutes != null) setField('time_limit_minutes', Math.max(0, parseInt(String(body.time_limit_minutes), 10) || 0));
    if (body.pass_score != null) { let p = parseInt(String(body.pass_score), 10); if (!Number.isFinite(p)) p = 60; setField('pass_score', Math.min(Math.max(p, 0), 100)); }
    if (body.is_active != null) setField('is_active', body.is_active === 0 || body.is_active === false ? 0 : 1);

    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });
    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE knowledge_tests SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    const test = db.prepare(`SELECT * FROM knowledge_tests WHERE id = ?`).get(id);
    return Response.json({ test, updated: true });
  } catch (e: any) {
    console.error('PUT /api/tasks/knowledge-tests failed:', e);
    return Response.json({ error: e?.message || 'Failed to update test' }, { status: 500 });
  }
}

/* ── DELETE (soft deactivate | hard delete) ─────────────────────────────── */

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageTasks(me)) return Response.json({ error: 'Not authorised' }, { status: 403 });

  try {
    const url = new URL(request.url);
    const id = (url.searchParams.get('id') || '').trim();
    const hard = url.searchParams.get('hard') === '1';
    if (!id) return Response.json({ error: 'Test id is required' }, { status: 400 });

    const db = getDb();
    if (hard) {
      const info = db.prepare(`DELETE FROM knowledge_tests WHERE id = ?`).run(id);
      if (info.changes === 0) return Response.json({ error: 'Test not found' }, { status: 404 });
      return Response.json({ deleted: true });
    }
    const info = db.prepare(`UPDATE knowledge_tests SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    if (info.changes === 0) return Response.json({ error: 'Test not found' }, { status: 404 });
    return Response.json({ deactivated: true });
  } catch (e: any) {
    console.error('DELETE /api/tasks/knowledge-tests failed:', e);
    return Response.json({ error: e?.message || 'Failed to delete test' }, { status: 500 });
  }
}
