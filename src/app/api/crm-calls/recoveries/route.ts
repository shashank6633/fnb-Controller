/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { sweep } from '@/lib/ct/ingest';

/**
 * CRM Call-to-Table — Recovery Queue (/api/crm-calls/recoveries).
 *
 * GET → the missed-call recovery queue. Always runs `sweep()` first so
 *       overdue/orphaned recoveries are up to date before we read.
 *   ?count=1                → fast path { count } of pending+attempting
 *                             (sidebar badge / inbox poll).
 *   ?status=a,b | all       → comma list filter (default 'pending,attempting')
 *   ?assigned_to=<who>      → 'unassigned' matches the empty pool
 *   ?from=YYYY-MM-DD&to=    → missed_at date range
 *   Rows join ct_guests (name/tags — VIP-tagged guests sort first) and the
 *   source ct_calls row, and carry sla_state: 'ok' | 'warning' (<10 min left)
 *   | 'breached'. Response also includes { counts } by status for the tabs.
 *
 * Any signed-in user (GRE access is governed by page-access).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const RECOVERY_STATUSES = ['pending', 'attempting', 'recovered', 'unreachable', 'expired', 'auto_resolved'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WARNING_WINDOW_MS = 10 * 60 * 1000;
const QUEUE_LIMIT = 500;

function slaState(slaDueAtIso: string, nowMs: number): 'ok' | 'warning' | 'breached' {
  const due = Date.parse(slaDueAtIso || '');
  if (!Number.isFinite(due)) return 'ok';
  const left = due - nowMs;
  if (left <= 0) return 'breached';
  if (left < WARNING_WINDOW_MS) return 'warning';
  return 'ok';
}

function parseJsonArray(text: unknown): any[] {
  if (typeof text !== 'string' || !text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function isVip(tags: any[]): boolean {
  return tags.some(t => String(t).trim().toLowerCase() === 'vip');
}

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const db = getDb();

  // Keep the queue honest before reading: reconcile orphan ring events and
  // escalate/expire overdue recoveries. Never let a sweep failure break reads.
  try {
    sweep();
  } catch (e) {
    console.warn('[ct] sweep failed (recoveries GET)', e);
  }

  const sp = new URL(req.url).searchParams;

  // Fast path for badges/pollers: just the open-queue size.
  if (sp.get('count') === '1') {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM ct_recoveries WHERE status IN ('pending', 'attempting')`
    ).get() as any;
    return Response.json({ count: row?.n ?? 0 });
  }

  // Non-status filters apply to BOTH the row query and the per-status tab
  // counts (so tab numbers stay consistent with the visible filter set).
  const baseWhere: string[] = [];
  const baseParams: any[] = [];

  const assignedTo = (sp.get('assigned_to') || '').trim();
  if (assignedTo) {
    if (assignedTo.toLowerCase() === 'unassigned') {
      baseWhere.push(`(r.assigned_to IS NULL OR r.assigned_to = '')`);
    } else {
      baseWhere.push('r.assigned_to = ?');
      baseParams.push(assignedTo);
    }
  }
  const from = (sp.get('from') || '').trim();
  if (from) {
    if (!DATE_RE.test(from)) return Response.json({ error: 'from must be YYYY-MM-DD' }, { status: 400 });
    baseWhere.push('substr(r.missed_at, 1, 10) >= ?');
    baseParams.push(from);
  }
  const to = (sp.get('to') || '').trim();
  if (to) {
    if (!DATE_RE.test(to)) return Response.json({ error: 'to must be YYYY-MM-DD' }, { status: 400 });
    baseWhere.push('substr(r.missed_at, 1, 10) <= ?');
    baseParams.push(to);
  }

  // Status filter: comma list, default the open queue; 'all' disables.
  const where = [...baseWhere];
  const params = [...baseParams];
  const rawStatus = (sp.get('status') || 'pending,attempting').trim();
  if (rawStatus && rawStatus.toLowerCase() !== 'all') {
    const statuses = rawStatus.split(',').map(s => s.trim()).filter(Boolean);
    for (const s of statuses) {
      if (!(RECOVERY_STATUSES as readonly string[]).includes(s)) {
        return Response.json({ error: `status must be a comma list of ${RECOVERY_STATUSES.join(', ')} (or 'all')` }, { status: 400 });
      }
    }
    if (statuses.length) {
      where.push(`r.status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT r.*,
           g.name AS guest_name, g.tags AS guest_tags,
           c.id AS src_call_id, c.telecmi_call_id AS src_telecmi_call_id,
           c.direction AS src_direction, c.status AS src_status,
           c.agent_user AS src_agent_user, c.queue AS src_queue,
           c.started_at AS src_started_at, c.ended_at AS src_ended_at,
           c.duration_sec AS src_duration_sec, c.disposition AS src_disposition,
           c.recording_url AS src_recording_url
    FROM ct_recoveries r
    LEFT JOIN ct_guests g ON g.id = r.guest_id
    LEFT JOIN ct_calls c ON c.id = r.call_id
    ${whereSql}
    ORDER BY r.sla_due_at ASC, r.missed_at ASC
    LIMIT ${QUEUE_LIMIT}
  `).all(...params) as any[];

  const nowMs = Date.now();
  const recoveries = rows.map(r => {
    const tags = parseJsonArray(r.guest_tags);
    const vip = isVip(tags);
    const {
      guest_tags: _gt,
      src_call_id, src_telecmi_call_id, src_direction, src_status, src_agent_user,
      src_queue, src_started_at, src_ended_at, src_duration_sec, src_disposition,
      src_recording_url,
      ...rest
    } = r;
    return {
      ...rest,
      attempts: parseJsonArray(r.attempts),
      guest_tags: tags,
      is_vip: vip,
      sla_state: slaState(r.sla_due_at, nowMs),
      // Source call snapshot. recording_url is deliberately reduced to a flag —
      // playback goes through the authed /api/telecmi/recording/[callId] proxy.
      call: src_call_id ? {
        id: src_call_id,
        telecmi_call_id: src_telecmi_call_id,
        direction: src_direction,
        status: src_status,
        agent_user: src_agent_user,
        queue: src_queue,
        started_at: src_started_at,
        ended_at: src_ended_at,
        duration_sec: src_duration_sec,
        disposition: src_disposition,
        has_recording: !!src_recording_url,
      } : null,
    };
  });

  // VIP missed calls float to the top; within each band, most-urgent SLA first
  // (the SQL already ordered by sla_due_at, sort() is stable).
  recoveries.sort((a, b) => (a.is_vip === b.is_vip ? 0 : a.is_vip ? -1 : 1));

  // Per-status counts for the tab strip (same non-status filters applied).
  const baseWhereSql = baseWhere.length ? `WHERE ${baseWhere.join(' AND ')}` : '';
  const countRows = db.prepare(
    `SELECT r.status AS status, COUNT(*) AS n FROM ct_recoveries r ${baseWhereSql} GROUP BY r.status`
  ).all(...baseParams) as any[];
  const counts: Record<string, number> = {};
  for (const s of RECOVERY_STATUSES) counts[s] = 0;
  for (const row of countRows) {
    if (row.status in counts) counts[row.status] = row.n;
  }

  return Response.json({ recoveries, counts, total: recoveries.length });
}
