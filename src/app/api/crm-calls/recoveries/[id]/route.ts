/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { emitCt, pushRecentCt, type CtEvent } from '@/lib/ct/bus';
import { slaDueAt } from '@/lib/ct/settings';

/**
 * CRM Call-to-Table — single recovery lifecycle (/api/crm-calls/recoveries/:id).
 *
 * PUT { action, ... }:
 *   'attempt'     { method: 'callback'|'whatsapp'|'sms', outcome? }
 *                 → appends to attempts[], sets first_attempt_at once,
 *                   status='attempting'. Allowed on pending/attempting/expired/
 *                   unreachable (an expired recovery can still be worked —
 *                   EXPIRED is a flag, not a dead end), never on resolved rows.
 *   'unreachable' { resolution_note? } → status='unreachable'; requires at
 *                 least one recorded attempt OR a note (no silent give-ups).
 *   'note'        { resolution_note } → updates resolution_note only.
 *   'assign'      { assigned_to } → sets the owner ('' = back to pool).
 *   'match_call'  { call_id } → manual fallback when the outbound CDR wasn't
 *                 auto-matched: links recovery_call_id + status='attempting'.
 *   'resolve'     { resolution_note? } → manual recovery: status='recovered',
 *                 recovered_at=now.
 *   'reopen'      → back to status='pending' (clears recovered_at).
 *
 * After any status change we emit { type:'recovery_update', recoveryCount }
 * on the CT bus (SSE badge + poll fallback ring buffer).
 *
 * Any signed-in user (GRE access is governed by page-access). CSRF on PUT is
 * enforced by the client `api()` helper + proxy.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ATTEMPT_METHODS = ['callback', 'whatsapp', 'sms'] as const;
const ACTIONS = ['attempt', 'unreachable', 'note', 'assign', 'match_call', 'resolve', 'reopen'] as const;
const RESOLVED_STATUSES = ['recovered', 'auto_resolved'];

function parseJsonArray(text: unknown): any[] {
  if (typeof text !== 'string' || !text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function openRecoveryCount(db: any): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM ct_recoveries WHERE status IN ('pending', 'attempting')`
  ).get() as any;
  return row?.n ?? 0;
}

function emitRecoveryUpdate(db: any): void {
  const evt: CtEvent = {
    type: 'recovery_update',
    recoveryCount: openRecoveryCount(db),
    at: new Date().toISOString(),
  };
  emitCt(evt);
  pushRecentCt(evt);
}

function cleanNote(v: unknown): string {
  return String(v ?? '').trim().slice(0, 2000);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const row = db.prepare(`
    SELECT r.*, g.name AS guest_name, g.tags AS guest_tags
    FROM ct_recoveries r
    LEFT JOIN ct_guests g ON g.id = r.guest_id
    WHERE r.id = ?
  `).get(id) as any;
  if (!row) return Response.json({ error: 'Recovery not found' }, { status: 404 });
  return Response.json({
    recovery: { ...row, attempts: parseJsonArray(row.attempts), guest_tags: parseJsonArray(row.guest_tags) },
  });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  const { id } = await params;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }

  const action = String(body.action || '').trim();
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return Response.json({ error: `action must be one of ${ACTIONS.join(', ')}` }, { status: 400 });
  }

  const db = getDb();
  const existing = db.prepare('SELECT * FROM ct_recoveries WHERE id = ?').get(id) as any;
  if (!existing) return Response.json({ error: 'Recovery not found' }, { status: 404 });

  const now = new Date().toISOString();
  const attempts = parseJsonArray(existing.attempts);
  const sets: string[] = [];
  const sqlParams: any[] = [];
  let newStatus: string | null = null; // set when the action moves status

  switch (action) {
    case 'attempt': {
      const method = String(body.method || '').trim();
      if (!(ATTEMPT_METHODS as readonly string[]).includes(method)) {
        return Response.json({ error: `method must be one of ${ATTEMPT_METHODS.join(', ')}` }, { status: 400 });
      }
      if (RESOLVED_STATUSES.includes(existing.status)) {
        return Response.json({ error: `Recovery is already ${existing.status} — reopen it first` }, { status: 400 });
      }
      attempts.push({
        at: now,
        by: me.email,
        method,
        outcome: String(body.outcome ?? '').trim().slice(0, 500),
      });
      sets.push('attempts = ?');
      sqlParams.push(JSON.stringify(attempts));
      if (!existing.first_attempt_at) {
        sets.push('first_attempt_at = ?');
        sqlParams.push(now);
      }
      newStatus = 'attempting';
      break;
    }
    case 'unreachable': {
      const note = cleanNote(body.resolution_note ?? body.note);
      if (attempts.length === 0 && !note) {
        return Response.json({ error: 'Record at least one attempt or add a note before marking unreachable' }, { status: 400 });
      }
      if (note) {
        sets.push('resolution_note = ?');
        sqlParams.push(note);
      }
      newStatus = 'unreachable';
      break;
    }
    case 'note': {
      if (body.resolution_note === undefined && body.note === undefined) {
        return Response.json({ error: 'resolution_note required' }, { status: 400 });
      }
      sets.push('resolution_note = ?');
      sqlParams.push(cleanNote(body.resolution_note ?? body.note));
      break;
    }
    case 'assign': {
      if (body.assigned_to === undefined) {
        return Response.json({ error: 'assigned_to required (\'\' to unassign)' }, { status: 400 });
      }
      sets.push('assigned_to = ?');
      sqlParams.push(String(body.assigned_to ?? '').trim().slice(0, 200));
      break;
    }
    case 'match_call': {
      const callId = String(body.call_id || '').trim();
      if (!callId) return Response.json({ error: 'call_id required' }, { status: 400 });
      const call = db.prepare('SELECT id FROM ct_calls WHERE id = ?').get(callId) as any;
      if (!call) return Response.json({ error: 'call_id: call not found' }, { status: 400 });
      if (RESOLVED_STATUSES.includes(existing.status)) {
        return Response.json({ error: `Recovery is already ${existing.status} — reopen it first` }, { status: 400 });
      }
      sets.push('recovery_call_id = ?');
      sqlParams.push(callId);
      newStatus = 'attempting';
      break;
    }
    case 'resolve': {
      const note = cleanNote(body.resolution_note);
      if (note) {
        sets.push('resolution_note = ?');
        sqlParams.push(note);
      }
      sets.push('recovered_at = ?');
      sqlParams.push(now);
      newStatus = 'recovered';
      break;
    }
    case 'reopen': {
      // Reset the SLA clock from NOW (business-hours aware) and clear the
      // escalation flag — otherwise the stale past sla_due_at would make the
      // next sweep immediately re-escalate/expire the just-reopened recovery.
      sets.push('recovered_at = NULL');
      sets.push('sla_due_at = ?');
      sqlParams.push(slaDueAt(now, db));
      sets.push('escalated = 0');
      sets.push('escalated_at = NULL');
      newStatus = 'pending';
      break;
    }
  }

  const statusChanged = newStatus !== null && newStatus !== existing.status;
  if (newStatus !== null) {
    sets.push('status = ?');
    sqlParams.push(newStatus);
  }
  sets.push('updated_at = ?');
  sqlParams.push(now);

  sqlParams.push(id);
  db.prepare(`UPDATE ct_recoveries SET ${sets.join(', ')} WHERE id = ?`).run(...sqlParams);

  if (statusChanged) {
    try {
      emitRecoveryUpdate(db);
    } catch (e) {
      console.warn('[ct] recovery_update emit failed', e);
    }
  }

  const updated = db.prepare(`
    SELECT r.*, g.name AS guest_name, g.tags AS guest_tags
    FROM ct_recoveries r
    LEFT JOIN ct_guests g ON g.id = r.guest_id
    WHERE r.id = ?
  `).get(id) as any;

  return Response.json({
    success: true,
    recovery: updated
      ? { ...updated, attempts: parseJsonArray(updated.attempts), guest_tags: parseJsonArray(updated.guest_tags) }
      : null,
  });
}
