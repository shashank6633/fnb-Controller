/**
 * CRM — Single quiz link (HOD or ADMIN).
 *
 * PUT    /api/crm/quiz-links/:id   toggle is_active / edit title, pass_threshold,
 *                                  max_attempts, expires_at, difficulty, question_count
 * DELETE /api/crm/quiz-links/:id   only when the link has NO guest sessions
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getCurrentUser, type SessionUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

async function requireHod(): Promise<{ ok: true; user: SessionUser } | { ok: false; status: number; message: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, status: 401, message: 'Sign in required' };
  if (me.role !== 'admin' && !me.is_head_chef) {
    return { ok: false, status: 403, message: 'HOD or admin access required' };
  }
  return { ok: true, user: me };
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireHod();
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const { id } = await params;
  const db = getDb();
  const link = db.prepare('SELECT * FROM crm_quiz_links WHERE id = ?').get(id) as any;
  if (!link) return Response.json({ error: 'Quiz link not found' }, { status: 404 });

  let body: any;
  try { body = await req.json(); } catch {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  const title = body?.title !== undefined ? String(body.title).trim() : link.title;
  if (!title) return Response.json({ error: 'title cannot be empty' }, { status: 400 });

  const isActive = body?.is_active !== undefined ? (body.is_active ? 1 : 0) : link.is_active;

  const passThreshold = body?.pass_threshold !== undefined ? Number(body.pass_threshold) : link.pass_threshold;
  if (!Number.isFinite(passThreshold) || passThreshold < 0 || passThreshold > 100) {
    return Response.json({ error: 'pass_threshold must be between 0 and 100' }, { status: 400 });
  }

  const maxAttempts = body?.max_attempts !== undefined ? Number(body.max_attempts) : link.max_attempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    return Response.json({ error: 'max_attempts must be at least 1' }, { status: 400 });
  }

  const difficulty = body?.difficulty !== undefined ? String(body.difficulty) : link.difficulty;
  if (!['easy', 'medium', 'hard'].includes(difficulty)) {
    return Response.json({ error: 'difficulty must be easy, medium or hard' }, { status: 400 });
  }

  const questionCount = body?.question_count !== undefined ? Number(body.question_count) : link.question_count;
  if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 50) {
    return Response.json({ error: 'question_count must be between 1 and 50' }, { status: 400 });
  }

  let expiresAt: string | null = link.expires_at;
  if (body?.expires_at !== undefined) {
    if (body.expires_at === null || body.expires_at === '') {
      expiresAt = null;
    } else {
      const d = new Date(String(body.expires_at));
      if (isNaN(d.getTime())) return Response.json({ error: 'expires_at is not a valid date' }, { status: 400 });
      expiresAt = d.toISOString();
    }
  }

  db.prepare(`
    UPDATE crm_quiz_links
    SET title = ?, is_active = ?, pass_threshold = ?, max_attempts = ?, difficulty = ?, question_count = ?, expires_at = ?
    WHERE id = ?
  `).run(title, isActive, passThreshold, maxAttempts, difficulty, questionCount, expiresAt, id);

  const updated = db.prepare('SELECT * FROM crm_quiz_links WHERE id = ?').get(id) as any;
  return Response.json({ message: 'Quiz link updated', link: { ...updated, is_active: !!updated.is_active, url: `/quiz/link/${updated.link_code}` } });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireHod();
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const { id } = await params;
  const db = getDb();
  const link = db.prepare('SELECT * FROM crm_quiz_links WHERE id = ?').get(id) as any;
  if (!link) return Response.json({ error: 'Quiz link not found' }, { status: 404 });

  const sessions = (db.prepare('SELECT COUNT(*) AS n FROM crm_guest_quiz_sessions WHERE link_id = ?').get(id) as any).n as number;
  if (sessions > 0) {
    return Response.json({
      error: `This link has ${sessions} attempt${sessions === 1 ? '' : 's'} — deactivate it instead of deleting (results are kept for records)`,
    }, { status: 400 });
  }

  db.prepare('DELETE FROM crm_quiz_links WHERE id = ?').run(id);
  return Response.json({ message: 'Quiz link deleted' });
}
