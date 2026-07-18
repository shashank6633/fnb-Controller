import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { normalizePhone } from '@/lib/ct/phone';
import { getAgentMap, getUserNamesByEmail, resolveAgentLabel } from '@/lib/ct/agents';

/**
 * GET /api/crm-calls/calls — Call Log list (Call-to-Table CRM).
 *
 * Query params (all optional):
 *   direction   inbound | outbound
 *   status      ringing | answered | abandoned | voicemail | missed
 *               ('missed' is the FAMILY: missed + abandoned + voicemail —
 *                matches the filter-bar chip; use 'abandoned'/'voicemail'
 *                for the exact single status)
 *   agent       exact match on ct_calls.agent_user
 *   from / to   date range on the call start (IST-day aligned when passed as
 *               YYYY-MM-DD; full ISO accepted as-is). Timestamps in the DB are
 *               UTC ISO, so YYYY-MM-DD is converted via +05:30.
 *   phone       full number (any format → normalized E.164 exact match) or a
 *               partial digit string (LIKE match, min 4 digits)
 *   guest_id    exact match (linked calls only)
 *   disposition one of the enum values, or 'missing' (answered calls with no
 *               disposition yet — the "needs disposition" chip).
 *               needs_disposition=1 is an alias for disposition=missing.
 *   page / pageSize   1-based, default 1 / 50 (pageSize capped at 200)
 *
 * Response: { calls, total, page, pageSize, summary }
 *   summary is computed with the status/direction/disposition filters REMOVED
 *   (date/phone/guest/agent kept) so the filter bar shows stable counts while
 *   a chip is active: { total, inbound, outbound, answered, missed, ringing,
 *   needs_disposition }.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MISSED_FAMILY = ['missed', 'abandoned', 'voicemail'];

/** Start-of-call expression — CDR upserts fill started_at, live ring rows may
 *  only have created_at. One expression so filter + sort agree. */
const STARTED = `COALESCE(NULLIF(c.started_at, ''), c.created_at)`;

function istDayToUtcIso(v: string, endOfDay: boolean): string | null {
  // YYYY-MM-DD → the IST day boundary as a UTC instant
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Not signed in' }, { status: 401 });

  const db = getDb();
  const sp = new URL(req.url).searchParams;

  // ── Shared filters (also applied to the summary) ────────────────────────
  const base: string[] = [];
  const baseParams: unknown[] = [];

  const from = sp.get('from');
  if (from) {
    const iso = istDayToUtcIso(from.trim(), false);
    if (iso) { base.push(`${STARTED} >= ?`); baseParams.push(iso); }
  }
  const to = sp.get('to');
  if (to) {
    const iso = istDayToUtcIso(to.trim(), true);
    if (iso) { base.push(`${STARTED} <= ?`); baseParams.push(iso); }
  }
  const agent = sp.get('agent');
  if (agent) { base.push('c.agent_user = ?'); baseParams.push(agent.trim()); }

  const guestId = sp.get('guest_id');
  if (guestId) { base.push('c.guest_id = ?'); baseParams.push(guestId.trim()); }

  const phoneQ = sp.get('phone');
  if (phoneQ) {
    const norm = normalizePhone(phoneQ);
    const digits = phoneQ.replace(/\D/g, '');
    if (norm) { base.push('c.phone_e164 = ?'); baseParams.push(norm); }
    else if (digits.length >= 4) { base.push('c.phone_e164 LIKE ?'); baseParams.push(`%${digits}%`); }
    // fewer than 4 digits and unnormalizable → ignore (would match everything)
  }

  // ── Chip filters (excluded from the summary) ────────────────────────────
  const chip: string[] = [];
  const chipParams: unknown[] = [];

  const direction = sp.get('direction');
  if (direction === 'inbound' || direction === 'outbound') {
    chip.push('c.direction = ?'); chipParams.push(direction);
  }
  const status = sp.get('status');
  if (status === 'missed') {
    chip.push(`c.status IN (${MISSED_FAMILY.map(() => '?').join(',')})`);
    chipParams.push(...MISSED_FAMILY);
  } else if (status && ['ringing', 'answered', 'abandoned', 'voicemail'].includes(status)) {
    chip.push('c.status = ?'); chipParams.push(status);
  }
  const disposition = sp.get('disposition');
  if (disposition === 'missing' || sp.get('needs_disposition') === '1') {
    chip.push(`c.status = 'answered' AND c.disposition = ''`);
  } else if (disposition) {
    chip.push('c.disposition = ?'); chipParams.push(disposition.trim());
  }

  // parseInt (not Number) so a float/scientific value like 3.7 or 1e999 can't
  // reach LIMIT/OFFSET and trip SQLite's OP_MustBeInt → "datatype mismatch" 500.
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize') || '50', 10) || 50));

  const whereAll = [...base, ...chip];
  const whereSql = whereAll.length ? `WHERE ${whereAll.join(' AND ')}` : '';
  const allParams = [...baseParams, ...chipParams];

  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM ct_calls c ${whereSql}`)
    .get(...allParams) as { n: number };

  // Guest join: direct link first (g), then unlinked calls matched by phone
  // (gp) — ct_guests.phone_e164 is UNIQUE so gp yields at most one row.
  const rows = db.prepare(`
    SELECT c.id, c.telecmi_call_id, c.phone_e164, c.direction, c.status,
           c.agent_user, c.queue, c.started_at, c.answered_at, c.ended_at,
           c.duration_sec, c.disposition, c.disposition_note, c.created_at,
           c.analysis_status, c.analysis_score, c.analysis_outcome,
           CASE WHEN NULLIF(c.recording_url, '') IS NULL THEN 0 ELSE 1 END AS has_recording,
           COALESCE(NULLIF(c.guest_id, ''), gp.id) AS guest_id,
           COALESCE(NULLIF(g.name, ''), NULLIF(gp.name, ''), '') AS guest_name,
           COALESCE(g.tags, gp.tags, '[]') AS guest_tags
    FROM ct_calls c
    LEFT JOIN ct_guests g  ON g.id = c.guest_id
    LEFT JOIN ct_guests gp ON (c.guest_id IS NULL OR c.guest_id = '')
                          AND gp.phone_e164 = c.phone_e164
    ${whereSql}
    ORDER BY ${STARTED} DESC
    LIMIT ? OFFSET ?
  `).all(...allParams, pageSize, (page - 1) * pageSize) as any[];

  // Agent id → staff label maps, loaded once per request (avoid N+1).
  const agentMap = getAgentMap(db);
  const userNames = getUserNamesByEmail(db);

  const calls = rows.map(r => {
    let tags: string[] = [];
    try { const t = JSON.parse(r.guest_tags || '[]'); if (Array.isArray(t)) tags = t; } catch { /* keep [] */ }
    const { guest_tags: _drop, ...rest } = r;
    return {
      ...rest,
      has_recording: !!rest.has_recording,
      guest_tags: tags,
      agent_display: resolveAgentLabel(r.agent_user, agentMap, userNames),
    };
  });

  // ── Summary for the filter bar (base filters only) ──────────────────────
  const baseWhereSql = base.length ? `WHERE ${base.join(' AND ')}` : '';
  const s = db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN c.direction = 'inbound'  THEN 1 ELSE 0 END), 0) AS inbound,
           COALESCE(SUM(CASE WHEN c.direction = 'outbound' THEN 1 ELSE 0 END), 0) AS outbound,
           COALESCE(SUM(CASE WHEN c.status = 'answered'    THEN 1 ELSE 0 END), 0) AS answered,
           COALESCE(SUM(CASE WHEN c.status IN ('missed','abandoned','voicemail') THEN 1 ELSE 0 END), 0) AS missed,
           COALESCE(SUM(CASE WHEN c.status = 'ringing'     THEN 1 ELSE 0 END), 0) AS ringing,
           COALESCE(SUM(CASE WHEN c.status = 'answered' AND c.disposition = '' THEN 1 ELSE 0 END), 0) AS needs_disposition
    FROM ct_calls c ${baseWhereSql}
  `).get(...baseParams) as any;

  return Response.json({
    calls,
    total: totalRow.n,
    page,
    pageSize,
    summary: {
      total: s.total, inbound: s.inbound, outbound: s.outbound,
      answered: s.answered, missed: s.missed, ringing: s.ringing,
      needs_disposition: s.needs_disposition,
    },
  });
}
