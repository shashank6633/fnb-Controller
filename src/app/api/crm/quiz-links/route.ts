/**
 * CRM — Shareable guest quiz links (HOD or ADMIN).
 *
 * GET  /api/crm/quiz-links
 *   → { links: [{ ...link, session_count, completed_count, cheated_count,
 *                 passed_count, creator_name, url }] }
 *   `url` is the origin-relative share path (/quiz/link/CODE) — the client
 *   prepends window.location.origin.
 *
 * POST /api/crm/quiz-links
 *   { title, difficulty, question_count, pass_threshold, max_attempts, expires_at? | expiry_days? }
 *   → 201 { link } with a fresh 8-char base64url link_code.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from 'crypto';
import { getCurrentUser, type SessionUser } from '@/lib/auth';
import { getDb, generateId } from '@/lib/db';

export const dynamic = 'force-dynamic';

async function requireHod(): Promise<{ ok: true; user: SessionUser } | { ok: false; status: number; message: string }> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, status: 401, message: 'Sign in required' };
  if (me.role !== 'admin' && !me.is_head_chef) {
    return { ok: false, status: 403, message: 'HOD or admin access required' };
  }
  return { ok: true, user: me };
}

function linkWithCounts(db: any, id: string) {
  return db.prepare(`
    SELECT l.*, u.name AS creator_name,
      (SELECT COUNT(*) FROM crm_guest_quiz_sessions s WHERE s.link_id = l.id) AS session_count,
      (SELECT COUNT(*) FROM crm_guest_quiz_sessions s WHERE s.link_id = l.id AND s.status = 'completed') AS completed_count,
      (SELECT COUNT(*) FROM crm_guest_quiz_sessions s WHERE s.link_id = l.id AND s.status = 'cheated') AS cheated_count,
      (SELECT COUNT(*) FROM crm_guest_quiz_sessions s
        WHERE s.link_id = l.id AND s.status = 'completed' AND s.total_questions > 0
          AND (s.score * 100.0 / s.total_questions) >= l.pass_threshold) AS passed_count
    FROM crm_quiz_links l LEFT JOIN users u ON u.id = l.created_by
    WHERE l.id = ?
  `).get(id) as any;
}

function serialize(l: any) {
  return {
    ...l,
    is_active: !!l.is_active,
    url: `/quiz/link/${l.link_code}`,
  };
}

export async function GET() {
  const gate = await requireHod();
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const db = getDb();
  const links = (db.prepare(`
    SELECT l.*, u.name AS creator_name,
      (SELECT COUNT(*) FROM crm_guest_quiz_sessions s WHERE s.link_id = l.id) AS session_count,
      (SELECT COUNT(*) FROM crm_guest_quiz_sessions s WHERE s.link_id = l.id AND s.status = 'completed') AS completed_count,
      (SELECT COUNT(*) FROM crm_guest_quiz_sessions s WHERE s.link_id = l.id AND s.status = 'cheated') AS cheated_count,
      (SELECT COUNT(*) FROM crm_guest_quiz_sessions s
        WHERE s.link_id = l.id AND s.status = 'completed' AND s.total_questions > 0
          AND (s.score * 100.0 / s.total_questions) >= l.pass_threshold) AS passed_count
    FROM crm_quiz_links l LEFT JOIN users u ON u.id = l.created_by
    ORDER BY l.created_at DESC
  `).all() as any[]).map(serialize);

  return Response.json({ links });
}

export async function POST(req: Request) {
  const gate = await requireHod();
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any;
  try { body = await req.json(); } catch {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  const title = String(body?.title || '').trim() || 'AKAN Staff Quiz';
  const difficulty = String(body?.difficulty || 'medium');
  if (!['easy', 'medium', 'hard'].includes(difficulty)) {
    return Response.json({ error: 'difficulty must be easy, medium or hard' }, { status: 400 });
  }
  const questionCount = Number(body?.question_count ?? 10);
  if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 50) {
    return Response.json({ error: 'question_count must be between 1 and 50' }, { status: 400 });
  }
  const passThreshold = Number(body?.pass_threshold ?? 60);
  if (!Number.isFinite(passThreshold) || passThreshold < 0 || passThreshold > 100) {
    return Response.json({ error: 'pass_threshold must be between 0 and 100' }, { status: 400 });
  }
  const maxAttempts = Number(body?.max_attempts ?? 100);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    return Response.json({ error: 'max_attempts must be at least 1' }, { status: 400 });
  }

  let expiresAt: string | null = null;
  if (body?.expires_at) {
    const d = new Date(String(body.expires_at));
    if (isNaN(d.getTime())) return Response.json({ error: 'expires_at is not a valid date' }, { status: 400 });
    expiresAt = d.toISOString();
  } else if (body?.expiry_days) {
    const days = Number(body.expiry_days);
    if (!Number.isFinite(days) || days <= 0) {
      return Response.json({ error: 'expiry_days must be a positive number' }, { status: 400 });
    }
    expiresAt = new Date(Date.now() + days * 86400 * 1000).toISOString();
  }

  const db = getDb();

  // 8-char base64url code; retry on the (astronomically unlikely) collision.
  let linkCode = '';
  for (let i = 0; i < 5; i++) {
    const candidate = randomBytes(6).toString('base64url'); // 6 bytes → exactly 8 chars
    const clash = db.prepare('SELECT 1 FROM crm_quiz_links WHERE link_code = ?').get(candidate);
    if (!clash) { linkCode = candidate; break; }
  }
  if (!linkCode) return Response.json({ error: 'Could not generate a unique link code, try again' }, { status: 500 });

  const id = generateId();
  db.prepare(`
    INSERT INTO crm_quiz_links (id, link_code, title, difficulty, question_count, pass_threshold, max_attempts, expires_at, is_active, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, linkCode, title, difficulty, questionCount, passThreshold, maxAttempts, expiresAt, gate.user.id);

  return Response.json({ message: 'Quiz link created', link: serialize(linkWithCounts(db, id)) }, { status: 201 });
}
