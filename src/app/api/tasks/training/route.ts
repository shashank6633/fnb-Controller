/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageTasks, parseMentions } from '@/lib/tasks';

/**
 * Training Tasks (/api/tasks/training).
 *
 * GET  /api/tasks/training?q=&status=&department=&from=&to=&limit=
 *        → { rows: TrainingSession[] } — list/search training sessions, newest
 *          session_date first. Any signed-in user may read.
 * POST /api/tasks/training  { title, trainer?, department?, session_date?,
 *          duration_minutes?, attendees?[]|attendees_json, status?, feedback? }
 *        → create a session. Notifies each attendee (task_notifications) and
 *          parses @mentions in feedback. Gate: canManageTasks.
 * PUT  /api/tasks/training  { id, ...fields }
 *        → partial update (attendance / completion / feedback / status). When
 *          the session is newly marked completed, its attendees get a
 *          completion notification. Also accepts a single-attendee completion
 *          toggle: { id, attendee_email, attendee_completed } flips that one
 *          attendee's completed flag (+completed_at) inside attendees_json,
 *          leaving the rest of the roster untouched. Gate: canManageTasks.
 * DELETE /api/tasks/training?id=  → remove a session. Gate: canManageTasks.
 *
 * Signed-out → 401. Non-manager mutations → 403.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VALID_STATUS = ['scheduled', 'completed', 'cancelled'] as const;

/** Normalise an attendees payload (array of strings/objects, or JSON string) to a JSON string. */
function normAttendees(attendees: any, attendeesJson: any): string {
  let arr: any = attendees;
  if (arr == null && attendeesJson != null) {
    if (typeof attendeesJson === 'string') {
      try { arr = JSON.parse(attendeesJson); } catch { arr = []; }
    } else arr = attendeesJson;
  }
  if (!Array.isArray(arr)) return '[]';
  const out = arr
    .map((a) => {
      if (a == null) return null;
      if (typeof a === 'string') { const s = a.trim(); return s ? { email: s, name: s } : null; }
      const email = String(a.email ?? '').trim();
      const name = String(a.name ?? '').trim();
      if (!email && !name) return null;
      const rec: { email: string; name: string; completed?: boolean; completed_at?: string } = { email, name: name || email };
      // Preserve per-attendee completion state across edits (Phase-2).
      if (a.completed != null) rec.completed = !!a.completed;
      if (a.completed_at != null) rec.completed_at = String(a.completed_at);
      return rec;
    })
    .filter(Boolean);
  return JSON.stringify(out);
}

/** Extract email-looking attendee identifiers from a stored attendees_json string. */
function attendeeEmails(attendeesJson: string): string[] {
  try {
    const arr = JSON.parse(attendeesJson || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .map((a: any) => String(a?.email ?? '').trim())
      .filter((e: string) => e.includes('@'));
  } catch { return []; }
}

function notify(db: any, recipient: string, kind: string, title: string, body: string) {
  if (!recipient || !recipient.includes('@')) return;
  db.prepare(
    `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
     VALUES (?, ?, ?, ?, ?, '', '/tasks/training')`,
  ).run(generateId(), recipient, kind, title, body);
}

/** Parse @mentions in free text → task_mentions rows + notification for email tokens. */
function recordMentions(db: any, text: string, byEmail: string) {
  const tokens = parseMentions(text);
  for (const tok of tokens) {
    const isEmail = tok.includes('@');
    db.prepare(
      `INSERT INTO task_mentions (id, task_id, comment_id, mentioned_email, mentioned_name, mentioned_by)
       VALUES (?, '', '', ?, ?, ?)`,
    ).run(generateId(), isEmail ? tok : '', isEmail ? '' : tok, byEmail);
    if (isEmail) {
      notify(db, tok, 'mention', 'You were mentioned in a training note', text.slice(0, 200));
    }
  }
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const status = url.searchParams.get('status') || '';
    const department = url.searchParams.get('department') || '';
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 2000);

    const where: string[] = [];
    const args: any[] = [];
    if (status && (VALID_STATUS as readonly string[]).includes(status)) { where.push('status = ?'); args.push(status); }
    if (department) { where.push('department = ?'); args.push(department); }
    if (from) { where.push("session_date >= ?"); args.push(from); }
    if (to) { where.push("session_date <= ?"); args.push(to); }
    if (q) { where.push('(LOWER(title) LIKE ? OR LOWER(trainer) LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }

    const db = getDb();
    const rows = db.prepare(
      `SELECT * FROM training_sessions
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY (session_date = '') ASC, session_date DESC, created_at DESC
       LIMIT ?`,
    ).all(...args, limit);
    return Response.json({ rows });
  } catch (e: any) {
    console.error('GET /api/tasks/training failed:', e);
    return Response.json({ error: e?.message || 'Failed to load training sessions' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageTasks(me)) return Response.json({ error: 'Not authorised' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const title = String(body?.title ?? '').trim();
  if (!title) return Response.json({ error: 'Title is required' }, { status: 400 });

  const trainer = String(body?.trainer ?? '').trim();
  const department = String(body?.department ?? '').trim();
  const session_date = String(body?.session_date ?? '').trim();
  const duration_minutes = Math.max(0, parseInt(String(body?.duration_minutes ?? 0), 10) || 0);
  const attendees_json = normAttendees(body?.attendees, body?.attendees_json);
  let status = String(body?.status ?? 'scheduled').trim();
  if (!(VALID_STATUS as readonly string[]).includes(status)) status = 'scheduled';
  const feedback = String(body?.feedback ?? '').trim();

  try {
    const db = getDb();
    const id = generateId();
    db.prepare(
      `INSERT INTO training_sessions
        (id, title, trainer, department, session_date, duration_minutes, attendees_json, status, feedback, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, title, trainer, department, session_date, duration_minutes, attendees_json, status, feedback, me.email);

    for (const email of attendeeEmails(attendees_json)) {
      notify(db, email, 'training_assigned', `Training: ${title}`,
        `You are scheduled for "${title}"${session_date ? ` on ${session_date}` : ''}.`);
    }
    if (feedback) recordMentions(db, feedback, me.email);

    const row = db.prepare(`SELECT * FROM training_sessions WHERE id = ?`).get(id);
    return Response.json({ session: row, created: true });
  } catch (e: any) {
    console.error('POST /api/tasks/training failed:', e);
    return Response.json({ error: e?.message || 'Failed to create training session' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageTasks(me)) return Response.json({ error: 'Not authorised' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = String(body?.id ?? '').trim();
  if (!id) return Response.json({ error: 'Session id is required' }, { status: 400 });

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM training_sessions WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'Session not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];
    const setField = (col: string, val: any) => { sets.push(`${col} = ?`); args.push(val); };

    if (body.title != null) { const t = String(body.title).trim(); if (!t) return Response.json({ error: 'Title cannot be empty' }, { status: 400 }); setField('title', t); }
    if (body.trainer != null) setField('trainer', String(body.trainer).trim());
    if (body.department != null) setField('department', String(body.department).trim());
    if (body.session_date != null) setField('session_date', String(body.session_date).trim());
    if (body.duration_minutes != null) setField('duration_minutes', Math.max(0, parseInt(String(body.duration_minutes), 10) || 0));
    if (body.attendees != null || body.attendees_json != null) setField('attendees_json', normAttendees(body.attendees, body.attendees_json));
    // Single-attendee completion toggle — flips one roster entry, keeps the rest.
    if (body.attendee_email != null) {
      const target = String(body.attendee_email).trim().toLowerCase();
      if (!target) return Response.json({ error: 'attendee_email cannot be empty' }, { status: 400 });
      const completed = body.attendee_completed === true || body.attendee_completed === 1;
      let arr: any[] = [];
      try { const p = JSON.parse(existing.attendees_json || '[]'); if (Array.isArray(p)) arr = p; } catch { arr = []; }
      let found = false;
      const next = arr.map((a: any) => {
        if (String(a?.email ?? '').trim().toLowerCase() === target) {
          found = true;
          return { ...a, completed, completed_at: completed ? new Date().toISOString() : '' };
        }
        return a;
      });
      if (!found) return Response.json({ error: 'Attendee not found on this session' }, { status: 404 });
      setField('attendees_json', JSON.stringify(next));
    }
    let newStatus: string | null = null;
    if (body.status != null) {
      const s = String(body.status).trim();
      if (!(VALID_STATUS as readonly string[]).includes(s)) return Response.json({ error: `status must be one of ${VALID_STATUS.join(', ')}` }, { status: 400 });
      newStatus = s;
      setField('status', s);
    }
    let newFeedback: string | null = null;
    if (body.feedback != null) { newFeedback = String(body.feedback).trim(); setField('feedback', newFeedback); }

    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });
    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE training_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);

    // Notify attendees when a session transitions INTO completed.
    if (newStatus === 'completed' && existing.status !== 'completed') {
      for (const email of attendeeEmails(existing.attendees_json)) {
        notify(db, email, 'training_completed', `Training completed: ${existing.title}`,
          `The session "${existing.title}" has been marked completed.`);
      }
    }
    if (newFeedback) recordMentions(db, newFeedback, me.email);

    const row = db.prepare(`SELECT * FROM training_sessions WHERE id = ?`).get(id);
    return Response.json({ session: row, updated: true });
  } catch (e: any) {
    console.error('PUT /api/tasks/training failed:', e);
    return Response.json({ error: e?.message || 'Failed to update training session' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageTasks(me)) return Response.json({ error: 'Not authorised' }, { status: 403 });

  try {
    const url = new URL(request.url);
    let id = url.searchParams.get('id') || '';
    if (!id) { try { const b = await request.json(); id = String(b?.id ?? ''); } catch { /* ignore */ } }
    id = id.trim();
    if (!id) return Response.json({ error: 'Session id is required' }, { status: 400 });

    const db = getDb();
    const info = db.prepare(`DELETE FROM training_sessions WHERE id = ?`).run(id);
    if (info.changes === 0) return Response.json({ error: 'Session not found' }, { status: 404 });
    return Response.json({ deleted: true });
  } catch (e: any) {
    console.error('DELETE /api/tasks/training failed:', e);
    return Response.json({ error: e?.message || 'Failed to delete training session' }, { status: 500 });
  }
}
