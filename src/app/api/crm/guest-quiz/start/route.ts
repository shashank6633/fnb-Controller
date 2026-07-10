/**
 * POST /api/crm/guest-quiz/start — PUBLIC by design (no staff session).
 *
 * Guests (job candidates / trial staff) open a shared /quiz/link/<code> URL and
 * register with name + mobile + position. The proxy whitelists this path;
 * security comes from the link gates (active / expiry / max attempts) and the
 * one-attempt-per-mobile rule below. Correct answers stay server-side in the
 * questions_json snapshot.
 */
import { getDb, generateId } from '@/lib/db';
import {
  getLinkByCode,
  validateLink,
  buildGuestQuiz,
  stripQuestion,
} from '@/lib/crm-guest-quiz';

const POSITIONS = new Set(['Captain', 'Waiter', 'Chef', 'Bartender', 'Host', 'Manager', 'Other']);

export async function POST(req: Request) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const linkCode = String(body.link_code || '').trim();
    const name = String(body.name || '').trim();
    const rawMobile = String(body.mobile || '').trim();
    const position = String(body.position || '').trim();

    if (!linkCode || !name || !rawMobile || !position) {
      return Response.json({ error: 'Name, mobile number, and position are required' }, { status: 400 });
    }
    if (name.length > 80) {
      return Response.json({ error: 'Name is too long' }, { status: 400 });
    }
    if (!POSITIONS.has(position)) {
      return Response.json({ error: 'Please select a valid position' }, { status: 400 });
    }

    // Normalize Indian mobiles: strip non-digits, drop a leading 91/0.
    let mobile = rawMobile.replace(/\D/g, '');
    if (mobile.length === 12 && mobile.startsWith('91')) mobile = mobile.slice(2);
    if (mobile.length === 11 && mobile.startsWith('0')) mobile = mobile.slice(1);
    if (mobile.length !== 10) {
      return Response.json({ error: 'Please enter a valid 10-digit mobile number' }, { status: 400 });
    }

    const link = getLinkByCode(linkCode);
    const linkError = validateLink(link);
    if (linkError || !link) {
      return Response.json({ error: linkError || 'Invalid quiz link' }, { status: link ? 400 : 404 });
    }

    const db = getDb();

    // One attempt per mobile per link — a finished (or cheat-terminated)
    // session blocks a re-take. An abandoned 'active' session does not.
    const existing = db
      .prepare(
        `SELECT id FROM crm_guest_quiz_sessions
         WHERE link_id = ? AND guest_mobile = ? AND status IN ('completed','cheated')`,
      )
      .get(link.id, mobile);
    if (existing) {
      return Response.json(
        { error: 'You have already completed this quiz. Contact your manager for a new link.' },
        { status: 400 },
      );
    }

    const questions = buildGuestQuiz(link.question_count, link.difficulty, position);
    if (questions.length < 5) {
      return Response.json({ error: 'Not enough questions available. Please try again later.' }, { status: 500 });
    }

    const sessionId = generateId();
    const createSession = db.transaction(() => {
      db.prepare(
        `INSERT INTO crm_guest_quiz_sessions
           (id, link_id, guest_name, guest_mobile, guest_position, questions_json,
            total_questions, score, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active')`,
      ).run(sessionId, link.id, name, mobile, position, JSON.stringify(questions), questions.length);
      db.prepare('UPDATE crm_quiz_links SET attempt_count = attempt_count + 1 WHERE id = ?').run(link.id);
    });
    createSession();

    return Response.json({
      guest_session_id: sessionId,
      total_questions: questions.length,
      total: questions.length,
      difficulty: link.difficulty,
      pass_threshold: link.pass_threshold,
      question_number: 1,
      question: stripQuestion(questions[0], 1),
    });
  } catch (e: any) {
    console.error('[/api/crm/guest-quiz/start POST]', e);
    return Response.json({ error: 'Failed to start quiz. Please try again.' }, { status: 500 });
  }
}
