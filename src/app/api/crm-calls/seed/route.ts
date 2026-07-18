/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { normalizePhone } from '@/lib/ct/phone';
import { ctSetting, setCtSetting, slaDueAt } from '@/lib/ct/settings';

/**
 * CRM Call-to-Table — Demo seed (/api/crm-calls/seed). Admin-only, POST.
 *
 * Creates a realistic demo dataset: 25 guests, ~120 calls over 30 days,
 * ~40 bookings across statuses (with call-to-table attribution respected),
 * recoveries in mixed lifecycle states and a few follow-ups.
 *
 * Idempotent via ct_settings 'seed_done' — pass { force: true } to add
 * another batch anyway. Rows are INSERTed directly (deterministic-ish seeded
 * RNG); the ingest pipeline is deliberately NOT used here.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Deterministic PRNG so repeated seeds shape the same dataset.
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  'Aarav Sharma', 'Priya Reddy', 'Vikram Rao', 'Ananya Iyer', 'Rohan Mehta',
  'Sneha Kapoor', 'Arjun Nair', 'Divya Patel', 'Karthik Menon', 'Lakshmi Devi',
  'Rahul Verma', 'Meera Krishnan', 'Sanjay Gupta', 'Pooja Choudhary', 'Aditya Kulkarni',
  'Kavya Nambiar', 'Nikhil Joshi', 'Shruti Desai', 'Varun Malhotra', 'Ishita Banerjee',
  'Harsha Vardhan', 'Nandini Rao', 'Suresh Babu', 'Ritika Singh', 'Manoj Kumar',
];

// Guests 0 and 1 are the VIPs.
const TAG_SETS: string[][] = [
  ['vip', 'regular'], ['vip', 'anniversary'],
  ['regular'], ['corporate'], ['family'], ['birthday-month'],
  [], ['veg'], ['regular', 'wine-lover'], [],
];

const AGENTS = ['priya.gre', 'rahul.gre', 'sneha.gre'];
const UNKNOWN_PHONES = [
  '+917702001122', '+919000012345', '+918885551234',
  '+917013990011', '+919912345678', '+918096123456',
];
const DISPOSITIONS = ['enquiry', 'enquiry', 'event_enquiry', 'follow_up_needed', 'no_action', 'complaint', 'wrong_number'];
const SLOTS = ['13:00', '19:00', '19:30', '20:00', '20:30', '21:00'];
const OCCASIONS = ['', '', 'Birthday', 'Anniversary', '', 'Corporate dinner', ''];

const MIN = 60_000;
const DAY = 86_400_000;

type SeedCall = {
  id: string; guestIdx: number | null; phone: string;
  direction: 'inbound' | 'outbound'; status: string;
  startedMs: number; answeredMs: number | null; endedMs: number;
  durationSec: number; agent: string; queue: string;
  disposition: string; dispositionNote: string; recordingUrl: string;
};

type SeedBooking = {
  id: string; guestIdx: number; sourceCallId: string | null;
  bookingDate: string; slot: string; partySize: number;
  occasion: string; status: string; channel: string;
  notes: string; createdMs: number;
};

type SeedRecovery = {
  id: string; callId: string; guestIdx: number | null; phone: string;
  missedMs: number; slaDueIso: string; status: string; assignedTo: string;
  attempts: Array<{ at: string; by: string; method: string; outcome: string }>;
  firstAttemptMs: number | null; recoveredMs: number | null;
  recoveryCallId: string | null; recoveryBookingId: string | null;
  escalated: number; escalatedMs: number | null; resolutionNote: string;
};

const iso = (ms: number) => new Date(ms).toISOString();
/** IST calendar date (YYYY-MM-DD) of a UTC instant. */
const istDate = (ms: number) => new Date(ms + 330 * MIN).toISOString().slice(0, 10);

export async function POST(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  if (!body || typeof body !== 'object') body = {};

  const db = getDb();
  if (ctSetting(db, 'seed_done') === '1' && !body.force) {
    return Response.json({ skipped: true, reason: 'Seed already ran. POST { "force": true } to add another batch.' });
  }

  const rnd = mulberry32(20260718);
  const runTag = Date.now().toString(36); // keeps telecmi_call_id unique across forced re-runs
  const now = Date.now();
  let cdrSeq = 0;
  const nextTelecmiId = () => `seed-${runTag}-${++cdrSeq}`;

  /** UTC ms for an IST wall-clock time `daysAgo` days back. */
  const istStamp = (daysAgo: number, h: number, m: number, s: number): number => {
    const d = new Date(now - daysAgo * DAY);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, s) - 330 * MIN;
  };
  /** Random IST business-hours time (12:00–23:30). */
  const bizTime = (): { h: number; m: number } => {
    const h = 12 + Math.floor(rnd() * 12);
    const m = h === 23 ? Math.floor(rnd() * 31) : Math.floor(rnd() * 60);
    return { h, m };
  };
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];

  // ── 1. Guests ─────────────────────────────────────────────────────────────
  const guestIds: string[] = [];
  const guestPhones: string[] = [];
  const guestRows: any[] = [];
  for (let i = 0; i < 25; i++) {
    const phone = normalizePhone(String(9848010000 + i * 137));
    const tags = i < 2 ? TAG_SETS[i] : TAG_SETS[2 + (i % 8)];
    const createdMs = now - (31 + Math.floor(rnd() * 30)) * DAY;
    guestPhones.push(phone);
    guestRows.push({
      id: generateId(),
      phone,
      name: NAMES[i],
      email: i % 4 === 0 ? `${NAMES[i].toLowerCase().replace(/\s+/g, '.')}@example.com` : '',
      tags: JSON.stringify(tags),
      source: i % 6 === 5 ? 'walk-in' : 'call',
      notes: i === 0 ? 'Prefers corner table on Floor 1. Always confirm on WhatsApp.' : i === 1 ? 'Anniversary regular — arrange candle setup.' : '',
      dob: i % 5 === 2 ? `199${i % 10}-0${1 + (i % 9)}-1${i % 9}` : '',
      anniversary: i % 7 === 1 ? `201${i % 10}-1${i % 2}-0${1 + (i % 9)}` : '',
      preferences: i % 3 === 0 ? JSON.stringify({ seating: pick(['indoor', 'outdoor', 'private']), spice: pick(['mild', 'medium', 'high']) }) : '{}',
      createdAt: iso(createdMs),
    });
  }

  // ── 2. Historical calls (days 1–29, IST 12:00–23:30) ─────────────────────
  const calls: SeedCall[] = [];
  for (let i = 0; i < 105; i++) {
    const daysAgo = 1 + (i % 29);
    const { h, m } = bizTime();
    const startedMs = istStamp(daysAgo, h, m, Math.floor(rnd() * 60));
    const direction: 'inbound' | 'outbound' = rnd() < 0.72 ? 'inbound' : 'outbound';

    let status: string;
    const r = rnd();
    if (direction === 'inbound') status = r < 0.62 ? 'answered' : r < 0.9 ? 'missed' : r < 0.96 ? 'abandoned' : 'voicemail';
    else status = r < 0.82 ? 'answered' : 'missed';

    // Repeat-caller bias: low guest indices call more often.
    const unknown = rnd() < 0.18;
    const guestIdx = unknown ? null : Math.floor(Math.pow(rnd(), 1.6) * 25);
    const phone = guestIdx === null ? UNKNOWN_PHONES[i % UNKNOWN_PHONES.length] : guestPhones[guestIdx];

    let answeredMs: number | null = null;
    let endedMs: number;
    let durationSec = 0;
    if (status === 'answered') {
      answeredMs = startedMs + (5 + Math.floor(rnd() * 18)) * 1000;
      durationSec = 45 + Math.floor(rnd() * 540);
      endedMs = answeredMs + durationSec * 1000;
    } else {
      endedMs = startedMs + (12 + Math.floor(rnd() * 35)) * 1000;
    }

    const answered = status === 'answered';
    calls.push({
      id: generateId(),
      guestIdx,
      phone,
      direction,
      status,
      startedMs,
      answeredMs,
      endedMs,
      durationSec,
      agent: answered || direction === 'outbound' ? pick(AGENTS) : '',
      queue: direction === 'inbound' ? 'reception' : '',
      disposition: answered && rnd() < 0.5 ? pick(DISPOSITIONS) : '',
      dispositionNote: '',
      recordingUrl: answered && rnd() < 0.12 ? `https://rest.telecmi.com/v2/play/seed-${runTag}-${i}` : '',
    });
  }

  // ── 3. Recent calls (today): 4 answered + 3 fresh missed ────────────────
  for (let k = 0; k < 4; k++) {
    const startedMs = now - (60 + k * 47) * MIN;
    const guestIdx = k * 3 % 25;
    const durationSec = 90 + Math.floor(rnd() * 300);
    calls.push({
      id: generateId(), guestIdx, phone: guestPhones[guestIdx],
      direction: 'inbound', status: 'answered',
      startedMs, answeredMs: startedMs + 8000, endedMs: startedMs + 8000 + durationSec * 1000,
      durationSec, agent: AGENTS[k % AGENTS.length], queue: 'reception',
      disposition: k === 0 ? 'enquiry' : '', dispositionNote: '', recordingUrl: '',
    });
  }
  const recentMissed: SeedCall[] = [];
  for (let k = 0; k < 3; k++) {
    const startedMs = now - (22 + k * 14) * MIN;
    const guestIdx = k === 2 ? null : (5 + k * 7) % 25; // one unknown caller in the live queue
    const c: SeedCall = {
      id: generateId(), guestIdx,
      phone: guestIdx === null ? UNKNOWN_PHONES[0] : guestPhones[guestIdx],
      direction: 'inbound', status: 'missed',
      startedMs, answeredMs: null, endedMs: startedMs + 25_000,
      durationSec: 0, agent: '', queue: 'reception',
      disposition: '', dispositionNote: '', recordingUrl: '',
    };
    calls.push(c);
    recentMissed.push(c);
  }

  // ── 4. Recoveries from historical missed-family inbound calls ───────────
  const missedFamily = calls.filter(
    (c) => c.direction === 'inbound' && ['missed', 'abandoned', 'voicemail'].includes(c.status) && !recentMissed.includes(c),
  ).sort((a, b) => a.startedMs - b.startedMs); // oldest first

  const newest = missedFamily.slice(-6);            // still-active states
  const older = missedFamily.slice(0, -6);          // terminal states
  const olderWithGuest = older.filter((c) => c.guestIdx !== null);
  const olderRest = older.filter((c) => !olderWithGuest.slice(0, 8).includes(c));

  const recoveries: SeedRecovery[] = [];
  const bookings: SeedBooking[] = [];
  const baseRecovery = (c: SeedCall): SeedRecovery => ({
    id: generateId(), callId: c.id, guestIdx: c.guestIdx, phone: c.phone,
    missedMs: c.endedMs, slaDueIso: slaDueAt(iso(c.endedMs), db),
    status: 'pending', assignedTo: '', attempts: [],
    firstAttemptMs: null, recoveredMs: null, recoveryCallId: null,
    recoveryBookingId: null, escalated: 0, escalatedMs: null, resolutionNote: '',
  });

  // Keep callback calls inside business hours (12:00–23:15 IST): a missed call
  // near closing would otherwise produce a "callback" after midnight.
  const clampToBizHours = (ms: number): number => {
    const ist = ms + 330 * MIN; // IST wall clock on a fake-UTC axis
    const minOfDay = Math.floor((ist % DAY) / MIN);
    if (minOfDay >= 12 * 60 && minOfDay <= 23 * 60 + 15) return ms;
    const istMidnight = ist - (ist % DAY);
    const noonSlot = (12 * 60 + 5 + Math.floor(rnd() * 55)) * MIN; // 12:05–13:00 IST
    const target = minOfDay < 12 * 60 ? istMidnight + noonSlot : istMidnight + DAY + noonSlot;
    return target - 330 * MIN;
  };

  // 4a. RECOVERED ×8 — callback outbound answered call; 5 also convert to a booking.
  const recoveredSrc = olderWithGuest.slice(0, 8);
  recoveredSrc.forEach((c, idx) => {
    const cbStart = Math.min(clampToBizHours(c.endedMs + (25 + Math.floor(rnd() * 90)) * MIN), now - 10 * MIN);
    const cbDur = 60 + Math.floor(rnd() * 240);
    const agent = AGENTS[idx % AGENTS.length];
    const cb: SeedCall = {
      id: generateId(), guestIdx: c.guestIdx, phone: c.phone,
      direction: 'outbound', status: 'answered',
      startedMs: cbStart, answeredMs: cbStart + 6000, endedMs: cbStart + 6000 + cbDur * 1000,
      durationSec: cbDur, agent, queue: '',
      disposition: idx < 5 ? 'booking_made' : 'no_action',
      dispositionNote: idx < 5 ? 'Booked on missed-call callback' : '',
      recordingUrl: '',
    };
    calls.push(cb);

    const rec = baseRecovery(c);
    rec.status = 'recovered';
    rec.assignedTo = agent;
    rec.attempts = [{ at: iso(cbStart), by: agent, method: 'callback', outcome: 'answered' }];
    rec.firstAttemptMs = cbStart;
    rec.recoveredMs = cb.endedMs;
    rec.recoveryCallId = cb.id;
    rec.resolutionNote = 'Guest answered the callback';

    if (idx < 5) {
      const bkCreated = cb.endedMs + 4 * MIN;
      const bk: SeedBooking = {
        id: generateId(), guestIdx: c.guestIdx as number, sourceCallId: cb.id,
        bookingDate: istDate(cb.endedMs + DAY), slot: pick(SLOTS),
        partySize: 2 + Math.floor(rnd() * 5),
        occasion: pick(OCCASIONS), status: pick(['completed', 'completed', 'seated', 'confirmed', 'completed']),
        channel: 'call', notes: 'Recovered via missed-call callback', createdMs: bkCreated,
      };
      bookings.push(bk);
      rec.recoveryBookingId = bk.id;
      rec.resolutionNote = 'Recovered — guest booked a table on callback';
    }
    recoveries.push(rec);
  });

  // 4b. Terminal states for the remaining older missed calls.
  const terminalQueue: string[] = [
    ...Array(6).fill('auto_resolved'), ...Array(3).fill('unreachable'), ...Array(2).fill('expired'),
  ];
  olderRest.forEach((c, idx) => {
    const state = terminalQueue[idx] || 'auto_resolved';
    const rec = baseRecovery(c);
    if (state === 'auto_resolved') {
      rec.status = 'auto_resolved';
      rec.resolutionNote = 'Guest called back and was answered — auto-resolved';
    } else if (state === 'unreachable') {
      const a1 = c.endedMs + 20 * MIN;
      const a2 = c.endedMs + 70 * MIN;
      const agent = AGENTS[idx % AGENTS.length];
      rec.status = 'unreachable';
      rec.assignedTo = agent;
      rec.attempts = [
        { at: iso(a1), by: agent, method: 'callback', outcome: 'no_answer' },
        { at: iso(a2), by: agent, method: 'callback', outcome: 'no_answer' },
      ];
      rec.firstAttemptMs = a1;
      rec.resolutionNote = 'No answer after 2 callback attempts';
    } else {
      rec.status = 'expired';
      rec.escalated = 1;
      rec.escalatedMs = new Date(rec.slaDueIso).getTime();
      rec.resolutionNote = 'Expired without a callback attempt';
    }
    recoveries.push(rec);
  });

  // 4c. Newest historical missed → attempting ×4 + breached-pending ×2.
  newest.forEach((c, idx) => {
    const rec = baseRecovery(c);
    if (idx < 4) {
      const a1 = Math.min(c.endedMs + 25 * MIN, now - 5 * MIN);
      const agent = AGENTS[idx % AGENTS.length];
      rec.status = 'attempting';
      rec.assignedTo = agent;
      rec.attempts = [{ at: iso(a1), by: agent, method: 'callback', outcome: 'no_answer' }];
      rec.firstAttemptMs = a1;
    } else {
      // Breached: SLA passed, escalated, still pending — the red rows in the queue.
      rec.status = 'pending';
      rec.escalated = 1;
      rec.escalatedMs = new Date(rec.slaDueIso).getTime() + 5 * MIN;
    }
    recoveries.push(rec);
  });

  // 4d. Fresh pending recoveries (SLA due in the near future) from today's missed.
  recentMissed.forEach((c, idx) => {
    const rec = baseRecovery(c);
    rec.slaDueIso = iso(now + (15 + idx * 12) * MIN); // 15 / 27 / 39 min from now
    recoveries.push(rec);
  });

  // ── 5. Bookings ──────────────────────────────────────────────────────────
  // 5a. Call-attributed ×12 (answered inbound, known guest; booking within window).
  const attributable = calls.filter(
    (c) => c.direction === 'inbound' && c.status === 'answered' && c.guestIdx !== null && c.startedMs < now - DAY,
  );
  const attributedStatuses = ['completed', 'confirmed', 'completed', 'seated', 'no_show', 'completed', 'cancelled', 'completed', 'confirmed', 'completed', 'no_show', 'completed'];
  for (let k = 0; k < 12 && k * 3 < attributable.length; k++) {
    const c = attributable[k * 3];
    c.disposition = 'booking_made';
    c.dispositionNote = 'Table booked during the call';
    bookings.push({
      id: generateId(), guestIdx: c.guestIdx as number, sourceCallId: c.id,
      bookingDate: istDate(c.endedMs + Math.floor(rnd() * 3) * DAY),
      slot: pick(SLOTS), partySize: 2 + Math.floor(rnd() * 6),
      occasion: pick(OCCASIONS), status: attributedStatuses[k],
      channel: 'call', notes: '', createdMs: c.endedMs + (5 + Math.floor(rnd() * 40)) * MIN,
    });
  }

  // 5b. Miscellaneous bookings to reach ~40 (mix of past + upcoming).
  const miscCount = 40 - bookings.length;
  for (let k = 0; k < miscCount; k++) {
    const guestIdx = Math.floor(rnd() * 25);
    const upcoming = k % 4 === 0;
    const dateMs = upcoming ? now + (1 + Math.floor(rnd() * 7)) * DAY : now - (1 + Math.floor(rnd() * 25)) * DAY;
    const status = upcoming
      ? pick(['pending', 'confirmed', 'confirmed'])
      : pick(['completed', 'completed', 'completed', 'seated', 'no_show', 'cancelled']);
    const partySize = rnd() < 0.1 ? 10 + Math.floor(rnd() * 10) : 2 + Math.floor(rnd() * 6);
    bookings.push({
      id: generateId(), guestIdx, sourceCallId: null,
      bookingDate: istDate(dateMs), slot: pick(SLOTS), partySize,
      occasion: pick(OCCASIONS), status,
      channel: k % 5 === 4 ? 'walk_in' : 'call',
      notes: '', createdMs: Math.min(dateMs - (1 + Math.floor(rnd() * 2)) * DAY, now - 5 * MIN),
    });
  }

  // ── 6. Follow-ups (~6) ───────────────────────────────────────────────────
  const fuNotes = [
    'Wants weekend availability — call back with options',
    'Send event menu on WhatsApp',
    'Asked about private dining for 12 — share pricing',
    'Confirm cake arrangement for birthday booking',
    'Check preferred wine stock before visit',
    'Call to confirm anniversary table decor',
  ];
  const fuCalls = calls.filter((c) => c.disposition === 'follow_up_needed' && c.guestIdx !== null).slice(0, 6);
  const followUps: Array<{ id: string; guestIdx: number; callId: string | null; dueMs: number; assignedTo: string; status: string; note: string; createdMs: number }> = [];
  for (let k = 0; k < 6; k++) {
    const c = fuCalls[k];
    const guestIdx = c ? (c.guestIdx as number) : (3 + k * 5) % 25;
    const dueMs = k === 4 ? now - DAY : k === 5 ? now - 2 * DAY : now + (1 + k) * DAY; // 2 overdue
    followUps.push({
      id: generateId(), guestIdx, callId: c ? c.id : null,
      dueMs, assignedTo: AGENTS[k % AGENTS.length],
      status: k === 5 ? 'done' : 'open',
      note: fuNotes[k], createdMs: c ? c.endedMs : now - 3 * DAY,
    });
  }

  // ── 7. Insert everything in one transaction ──────────────────────────────
  const selGuest = db.prepare('SELECT id FROM ct_guests WHERE phone_e164 = ?');
  const insGuest = db.prepare(`
    INSERT INTO ct_guests (id, phone_e164, name, email, tags, source, notes, dob, anniversary, preferences, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insCall = db.prepare(`
    INSERT INTO ct_calls (id, telecmi_call_id, guest_id, phone_e164, direction, status, agent_user, queue,
      started_at, answered_at, ended_at, duration_sec, recording_url, raw_payload, disposition, disposition_note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insBooking = db.prepare(`
    INSERT INTO ct_bookings (id, guest_id, source_call_id, booking_date, slot_time, party_size, occasion,
      section_pref, status, created_by, channel, advance_amount, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insRecovery = db.prepare(`
    INSERT OR IGNORE INTO ct_recoveries (id, call_id, guest_id, phone_e164, missed_at, detected_via, sla_due_at,
      status, assigned_to, attempts, first_attempt_at, recovered_at, recovery_call_id, recovery_booking_id,
      escalated, escalated_at, resolution_note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'cdr', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insFollowUp = db.prepare(`
    INSERT INTO ct_follow_ups (id, guest_id, call_id, due_at, assigned_to, status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const counts = { guests: 0, calls: 0, bookings: 0, recoveries: 0, follow_ups: 0 };

  db.transaction(() => {
    // Guests: upsert by phone so forced re-runs reuse existing profiles.
    for (const g of guestRows) {
      const existing = selGuest.get(g.phone) as any;
      if (existing?.id) {
        guestIds.push(existing.id);
      } else {
        insGuest.run(g.id, g.phone, g.name, g.email, g.tags, g.source, g.notes, g.dob, g.anniversary, g.preferences, g.createdAt, g.createdAt);
        guestIds.push(g.id);
        counts.guests++;
      }
    }
    const gid = (idx: number | null): string | null => (idx === null ? null : guestIds[idx]);

    for (const c of calls) {
      insCall.run(
        c.id, nextTelecmiId(), gid(c.guestIdx), c.phone, c.direction, c.status, c.agent, c.queue,
        iso(c.startedMs), c.answeredMs ? iso(c.answeredMs) : null, iso(c.endedMs), c.durationSec,
        c.recordingUrl, JSON.stringify({ seed: true }), c.disposition, c.dispositionNote, iso(c.startedMs),
      );
      counts.calls++;
    }

    for (const b of bookings) {
      insBooking.run(
        b.id, guestIds[b.guestIdx], b.sourceCallId, b.bookingDate, b.slot, b.partySize, b.occasion,
        '', b.status, gate.user.email, b.channel, 0, b.notes, iso(b.createdMs), iso(b.createdMs),
      );
      counts.bookings++;
    }

    for (const r of recoveries) {
      const updatedMs = r.recoveredMs ?? r.escalatedMs ?? r.firstAttemptMs ?? r.missedMs;
      const res = insRecovery.run(
        r.id, r.callId, gid(r.guestIdx), r.phone, iso(r.missedMs), r.slaDueIso, r.status, r.assignedTo,
        JSON.stringify(r.attempts), r.firstAttemptMs ? iso(r.firstAttemptMs) : null,
        r.recoveredMs ? iso(r.recoveredMs) : null, r.recoveryCallId, r.recoveryBookingId,
        r.escalated, r.escalatedMs ? iso(r.escalatedMs) : null, r.resolutionNote,
        iso(r.missedMs), iso(updatedMs),
      );
      if (res.changes > 0) counts.recoveries++;
    }

    for (const f of followUps) {
      insFollowUp.run(f.id, guestIds[f.guestIdx], f.callId, iso(f.dueMs), f.assignedTo, f.status, f.note, iso(f.createdMs));
      counts.follow_ups++;
    }

    setCtSetting(db, 'seed_done', '1');
  })();

  return Response.json({ success: true, skipped: false, forced: !!body.force, counts });
}
