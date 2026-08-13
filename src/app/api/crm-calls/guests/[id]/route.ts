import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import { normalizePhone } from '@/lib/ct/phone';
import { guestMetrics, guestMetricsByPhone } from '@/lib/ct/metrics';
import { getAgentMap, getUserNamesByEmail, resolveAgentLabel } from '@/lib/ct/agents';
import { norm10, loyaltyDetail, diningDetail } from '@/lib/ct/guest-unify';
import { recordingRetentionStatus } from '@/lib/ct/retention';

/**
 * GET /api/crm-calls/guests/[id]
 *   → { guest, metrics, timeline }
 *   timeline[] = unified reverse-chron merge of the guest's story:
 *     { type:'call',      at, ... has_recording }   (recording URL is NEVER exposed —
 *                                                    playback goes through /api/telecmi/recording/[callId])
 *     { type:'booking',   at, ... }
 *     { type:'follow_up', at, due_at, status, ... }
 *
 *   A call row states its OUTCOME as a fact the server has already settled,
 *   so the page only picks words for it and cannot reach a different verdict:
 *     answered     — status is 'answered', nothing else
 *     in_progress  — still ringing and not yet ended; no verdict is due
 *     answered_by  — the person who ANSWERED, or '' when naming one would be
 *                    a guess. Never set on an outbound call: there the guest
 *                    answered and the agent on the row is the GRE who dialled.
 *     dialled_by   — outbound only: the GRE who placed the call.
 *     rang_team    — unanswered inbound only: the team the call rang. A call
 *                    nobody answered names no person, and this data cannot
 *                    apportion a miss to one member of a ring group.
 *   A missed call and the callback that recovered it stay TWO rows. They are
 *   two facts, and collapsing them would erase the miss.
 *
 * PUT /api/crm-calls/guests/[id]
 *   Field edit: { name?, alt_phone?, email?, tags?[], notes?, dob?, anniversary?, preferences?{}, source? }
 *   OR one action:
 *     { action:'add_follow_up', due_at, note?, assigned_to?, call_id? }
 *     { action:'complete_follow_up', follow_up_id }
 *     { action:'add_note', note }   → appends an IST-timestamped, attributed line to notes
 */
export const dynamic = 'force-dynamic';

// Shape per CRM_DECISIONS.md — guestMetrics (fleet-built lib).
interface GuestMetrics {
  total_calls: number;
  calls_30d: number;
  missed_calls: number;
  last_call_at: string | null;
  total_bookings: number;
  completed_visits: number;
  no_shows: number;
  last_visit_at: string | null;
  conversion_rate: number;
  badge: string;
}

const EMPTY_METRICS: GuestMetrics = {
  total_calls: 0, calls_30d: 0, missed_calls: 0, last_call_at: null,
  total_bookings: 0, completed_visits: 0, no_shows: 0, last_visit_at: null,
  conversion_rate: 0, badge: 'NEW CALLER',
};

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    const v = JSON.parse(text);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

type GuestRow = {
  id: string; outlet_id: string; phone_e164: string; name: string; alt_phone: string;
  email: string; tags: string; source: string; notes: string; dob: string;
  anniversary: string; preferences: string; created_at: string; updated_at: string;
};

function serializeGuest(row: GuestRow) {
  return {
    ...row,
    tags: parseJson<string[]>(row.tags, []),
    preferences: parseJson<Record<string, unknown>>(row.preferences, {}),
  };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const { id } = await params;
    const db = getDb();
    const outletId = await getCurrentOutletId();

    // Resolve the guest. `id` is either a ct_guests.id OR a synthetic
    // `phone:<10-digit>` handle (a guest who only exists in loyalty/dining). A
    // phone handle upgrades to the real row if one was created in the meantime.
    let row: GuestRow | undefined;
    let synthetic = false;
    let phone = '';
    if (id.startsWith('phone:')) {
      const k = norm10(id.slice('phone:'.length));
      if (!k) return Response.json({ error: 'Guest not found' }, { status: 404 });
      phone = normalizePhone(k);
      row = db.prepare('SELECT * FROM ct_guests WHERE phone_e164 = ?').get(phone) as GuestRow | undefined;
      if (!row) synthetic = true;
    } else {
      row = db.prepare('SELECT * FROM ct_guests WHERE id = ?').get(id) as GuestRow | undefined;
      if (!row) return Response.json({ error: 'Guest not found' }, { status: 404 });
      phone = row.phone_e164;
    }

    // Loyalty + dining 360 (both keyed by the last-10-digit phone). Loyalty is
    // management-only (parity with /api/crm/guests); dining is open (parity with
    // /api/customers).
    const loyalty = isManagement(me) ? loyaltyDetail(db, phone) : null;
    const dining = diningDetail(db, outletId, phone);

    // A synthetic guest has no ct_guests row yet — synthesize a display object
    // from the loyalty/dining names so the profile still renders.
    if (synthetic) {
      const name = (loyalty?.loyalty.name || dining.summary.name || '').trim();
      row = {
        id: `phone:${norm10(phone)}`, outlet_id: '', phone_e164: phone, name,
        alt_phone: '', email: '', tags: '[]', source: loyalty ? 'loyalty' : 'dine-in',
        notes: '', dob: '', anniversary: '', preferences: '{}',
        created_at: dining.summary.first_seen || loyalty?.loyalty.first_visit_at || '',
        updated_at: dining.summary.last_seen || loyalty?.loyalty.last_visit_at || '',
      } as GuestRow;
    }

    const guestKey = synthetic ? '' : row!.id;
    let metrics: GuestMetrics = EMPTY_METRICS;
    try {
      metrics = ((synthetic
        ? guestMetricsByPhone(db, phone)
        : guestMetrics(db, guestKey)) as GuestMetrics) || EMPTY_METRICS;
    } catch (e) {
      console.error('GET /api/crm-calls/guests/[id]: metrics failed, serving empty metrics:', e);
    }

    // ── Unified timeline ──
    type TimelineEntry = { type: 'call' | 'booking' | 'follow_up'; at: string } & Record<string, unknown>;
    const timeline: TimelineEntry[] = [];

    // Agent id → staff label maps, loaded once per request (avoid N+1).
    const agentMap = getAgentMap(db);
    const userNames = getUserNamesByEmail(db);

    const calls = db.prepare(
      `SELECT id, telecmi_call_id, direction, status, agent_user, queue,
              started_at, answered_at, ended_at, duration_sec, recording_url,
              disposition, disposition_note, created_at,
              analysis_status, analysis_score, analysis_outcome,
              duration_source, duration_verified
       FROM ct_calls
       WHERE (guest_id = @gid AND @gid <> '') OR (phone_e164 = @phone AND @phone <> '')`,
    ).all({ gid: guestKey, phone }) as any[];
    const seenCallIds = new Set<string>();
    for (const c of calls) {
      if (seenCallIds.has(c.id)) continue;
      seenCallIds.add(c.id);

      // ── What happened on this call, settled here rather than in the page ──
      // Three states and no fourth. A row is ANSWERED only when the status
      // says so; it is still RINGING while ct_calls holds the live 'ringing'
      // state with no ended_at (declaring "not answered" on a call that is
      // still in progress would be a verdict on an unfinished call — the
      // stale-ring sweeper in ingest.ts is what finally turns an abandoned
      // ring into 'missed' + ended_at); everything else is NOT ANSWERED.
      const answered = c.status === 'answered';
      const inProgress = c.status === 'ringing' && !String(c.ended_at || '').trim();
      const outbound = c.direction === 'outbound';
      // One label per row from maps loaded once above — unmapped ids come back
      // as the raw id, which is the intended display, not a gap to hide.
      const agentLabel = resolveAgentLabel(c.agent_user, agentMap, userNames);

      timeline.push({
        type: 'call',
        at: c.started_at || c.created_at || '',
        id: c.id,
        direction: c.direction,
        status: c.status,
        agent_user: c.agent_user,
        agent_display: agentLabel,
        queue: c.queue,
        answered,
        in_progress: inProgress,
        // WHO ANSWERED — named only where naming one is true. On an inbound
        // call that is the agent TeleCMI reports. On an OUTBOUND call the
        // GUEST answered and agent_user is the GRE who dialled (log-callback
        // writes the caller's own email into that column), so crediting them
        // as the answerer would be false; they surface as dialled_by instead.
        answered_by: answered && !outbound ? agentLabel : '',
        // WHO PLACED IT — outbound only, for the same reason.
        dialled_by: outbound ? agentLabel : '',
        // WHO MISSED IT can only be answered as a TEAM. Measured across every
        // call in this database when this was written: not one inbound call
        // that went unanswered carries an agent. Nobody picked up, so TeleCMI
        // names nobody. The queue/team that rang is the honest answer, and
        // per-agent blame across a ring group is not derivable from these
        // CDRs. Outbound is excluded — it rings the guest, not a team.
        rang_team: !answered && !outbound ? String(c.queue || '').trim() : '',
        started_at: c.started_at,
        answered_at: c.answered_at,
        ended_at: c.ended_at,
        duration_sec: c.duration_sec,
        // HOW FAR duration_sec CAN BE TRUSTED. Only the Call Back flow (a GRE
        // dialling from their own handset) writes duration_source; a PBX-timed
        // CDR and every row predating that flow carry '', and the page leaves
        // those looking exactly as they always have. Both fields travel because
        // neither settles it alone — see src/lib/ct/duration-trust.ts.
        duration_source: c.duration_source || '',
        duration_verified: c.duration_verified || 0,
        disposition: c.disposition,
        disposition_note: c.disposition_note,
        analysis_status: c.analysis_status,
        analysis_score: c.analysis_score,
        analysis_outcome: c.analysis_outcome,
        // PLAYABLE, not "a URL exists" — same rule as the Call Log. Past the
        // retention window the proxy answers 410 and an <audio> element throws
        // that body away, so offering the control here produced a dead player
        // with no explanation. Judged by the shared helper rather than a second
        // copy of the arithmetic; this row already carries both anchors.
        has_recording: !!(c.recording_url && String(c.recording_url).trim())
          && !recordingRetentionStatus(db, c as any).expired,
      });
    }

    // Index-backed on guest_id, and bounded so one guest can never page the
    // whole archive into a timeline. is_duplicate = 0 keeps Reservego's same-day
    // re-emissions out of the 360 — they are the same visit, and showing three
    // of them is how the guest's history stops matching their metrics (which
    // computeGuestMetrics derives from the deduped rows).
    //
    // WHY 500 IS NOT A REAL LIMIT: the heaviest guest in the 04-10-2025 export
    // (11,832 rows, 3.4 months) has 8 bookings, so 500 is ~50 years of that
    // guest. It is a fuse against a mis-keyed import, not a paging rule — and
    // the newest are kept, because that is what the timeline shows first.
    const bookings = guestKey ? db.prepare(
      `SELECT id, source_call_id, booking_date, slot_time, party_size, occasion, section_pref,
              status, created_by, channel, advance_amount, notes, created_at, updated_at
       FROM ct_bookings WHERE guest_id = ? AND is_duplicate = 0
       ORDER BY COALESCE(NULLIF(booking_date, ''), created_at) DESC
       LIMIT 500`,
    ).all(guestKey) as any[] : [];
    for (const b of bookings) {
      timeline.push({
        type: 'booking',
        at: b.created_at || '',
        id: b.id,
        source_call_id: b.source_call_id,
        booking_date: b.booking_date,
        slot_time: b.slot_time,
        party_size: b.party_size,
        occasion: b.occasion,
        section_pref: b.section_pref,
        status: b.status,
        created_by: b.created_by,
        channel: b.channel,
        advance_amount: b.advance_amount,
        notes: b.notes,
      });
    }

    const followUps = guestKey ? db.prepare(
      `SELECT id, call_id, due_at, assigned_to, status, note, created_at
       FROM ct_follow_ups WHERE guest_id = ?`,
    ).all(guestKey) as any[] : [];
    for (const f of followUps) {
      timeline.push({
        type: 'follow_up',
        at: f.created_at || '',
        id: f.id,
        call_id: f.call_id,
        due_at: f.due_at,
        assigned_to: f.assigned_to,
        status: f.status,
        note: f.note,
      });
    }

    // Reverse-chron; entries with no timestamp sink to the bottom.
    timeline.sort((a, b) => {
      if (!a.at && !b.at) return 0;
      if (!a.at) return 1;
      if (!b.at) return -1;
      return a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
    });

    return Response.json(
      {
        guest: { ...serializeGuest(row!), synthetic },
        metrics,
        timeline,
        loyalty: loyalty?.loyalty ?? null,
        loyalty_visits: loyalty?.visits ?? [],
        dining: dining.summary,
        dining_orders: dining.orders,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('GET /api/crm-calls/guests/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to load guest' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const { id } = await params;
    const db = getDb();
    // A synthetic (loyalty/dining-only) guest has no ct_guests row yet — the
    // client must POST /api/crm-calls/guests to save it before notes/follow-ups.
    if (id.startsWith('phone:')) {
      const k = norm10(id.slice('phone:'.length));
      return Response.json(
        { error: 'Save this guest to the CRM first', needs_create: true, phone: k ? normalizePhone(k) : '' },
        { status: 409 },
      );
    }
    const row = db.prepare('SELECT * FROM ct_guests WHERE id = ?').get(id) as GuestRow | undefined;
    if (!row) return Response.json({ error: 'Guest not found' }, { status: 404 });

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const now = new Date().toISOString();

    // ── Actions ──
    if (body?.action) {
      switch (body.action) {
        case 'add_follow_up': {
          const dueRaw = String(body?.due_at ?? '').trim();
          const due = new Date(dueRaw);
          if (!dueRaw || isNaN(due.getTime())) {
            return Response.json({ error: 'A valid due_at is required' }, { status: 400 });
          }
          const fuId = generateId();
          db.prepare(`
            INSERT INTO ct_follow_ups (id, guest_id, call_id, due_at, assigned_to, status, note, created_at)
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
          `).run(
            fuId, id,
            body?.call_id ? String(body.call_id) : null,
            due.toISOString(),
            String(body?.assigned_to ?? me.email ?? ''),
            String(body?.note ?? ''),
            now,
          );
          return Response.json({ success: true, follow_up_id: fuId });
        }
        case 'complete_follow_up': {
          const fuId = String(body?.follow_up_id ?? '').trim();
          if (!fuId) return Response.json({ error: 'follow_up_id required' }, { status: 400 });
          const res = db.prepare(
            `UPDATE ct_follow_ups SET status = 'done' WHERE id = ? AND guest_id = ?`,
          ).run(fuId, id);
          if (res.changes === 0) {
            return Response.json({ error: 'Follow-up not found for this guest' }, { status: 404 });
          }
          return Response.json({ success: true });
        }
        case 'add_note': {
          const note = String(body?.note ?? '').trim();
          if (!note) return Response.json({ error: 'note required' }, { status: 400 });
          const stamp = new Date().toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true,
          });
          const line = `[${stamp} · ${me.name || me.email}] ${note}`;
          const notes = row.notes ? `${row.notes}\n${line}` : line;
          db.prepare('UPDATE ct_guests SET notes = ?, updated_at = ? WHERE id = ?').run(notes, now, id);
          const fresh = db.prepare('SELECT * FROM ct_guests WHERE id = ?').get(id) as GuestRow;
          return Response.json({ success: true, guest: serializeGuest(fresh) });
        }
        default:
          return Response.json({ error: `Unknown action '${body.action}'` }, { status: 400 });
      }
    }

    // ── Field edit ──
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (body?.name !== undefined) { sets.push('name = ?'); vals.push(String(body.name ?? '').trim()); }
    if (body?.alt_phone !== undefined) {
      const raw = String(body.alt_phone ?? '').trim();
      sets.push('alt_phone = ?');
      vals.push(raw ? (normalizePhone(raw) || raw) : '');
    }
    if (body?.email !== undefined) { sets.push('email = ?'); vals.push(String(body.email ?? '').trim()); }
    if (body?.tags !== undefined) {
      if (!Array.isArray(body.tags)) return Response.json({ error: 'tags must be an array' }, { status: 400 });
      sets.push('tags = ?');
      vals.push(JSON.stringify(body.tags.map((t: unknown) => String(t))));
    }
    if (body?.notes !== undefined) { sets.push('notes = ?'); vals.push(String(body.notes ?? '')); }
    if (body?.dob !== undefined) { sets.push('dob = ?'); vals.push(String(body.dob ?? '')); }
    if (body?.anniversary !== undefined) { sets.push('anniversary = ?'); vals.push(String(body.anniversary ?? '')); }
    if (body?.preferences !== undefined) {
      if (typeof body.preferences !== 'object' || body.preferences === null || Array.isArray(body.preferences)) {
        return Response.json({ error: 'preferences must be an object' }, { status: 400 });
      }
      sets.push('preferences = ?');
      vals.push(JSON.stringify(body.preferences));
    }
    if (body?.source !== undefined) { sets.push('source = ?'); vals.push(String(body.source ?? '') || 'call'); }

    if (sets.length === 0) return Response.json({ error: 'nothing to update' }, { status: 400 });
    sets.push('updated_at = ?');
    vals.push(now, id);
    db.prepare(`UPDATE ct_guests SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    const fresh = db.prepare('SELECT * FROM ct_guests WHERE id = ?').get(id) as GuestRow;
    return Response.json({ success: true, guest: serializeGuest(fresh) });
  } catch (e: any) {
    console.error('PUT /api/crm-calls/guests/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to update guest' }, { status: 500 });
  }
}
