import { randomUUID } from 'crypto';
import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requireStaff, fail } from '@/lib/valet/core';
import { ingestWhatsApp, simulationReason } from '@/lib/valet/notify';
import { valetTick } from '@/lib/valet/worker';
import { valetJson, readJson } from '@/lib/valet/http';

/**
 * POST — the clearly-labelled MESSAGE SIMULATOR (owner/admin only).
 *   action 'inbound' {phone, text}: pretend a guest sent a WhatsApp message.
 *     Refused while real sending is live — a simulated message must never be
 *     mistaken for, or mixed with, a real guest's.
 *   action 'tick': run one valet worker pass now (escalations, message queue,
 *     delivery-to-simulator) — for a server where the worker is not running.
 * Nothing here contacts WhatsApp. CSRF: '/api/valet/' prefix.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return valetJson(async () => {
    const body = await readJson(req);
    const db = getDb();
    const { ov } = requireStaff(db, await getCurrentUser(), String(body.outlet_id || ''), 'admin', { allowDisabled: true });
    if (body.action === 'tick') return { ok: true, result: await valetTick(db) };
    if (body.action === 'inbound') {
      const live = !simulationReason(ov, 'linked');
      if (live) fail(409, 'live', 'Real WhatsApp sending is live for this outlet — the simulator is switched off. Use a real phone.');
      const phone = String(body.phone || '').replace(/[^\d]/g, '');
      if (phone.length < 8) fail(400, 'phone', 'Enter a test phone number (digits).');
      const text = String(body.text || '').slice(0, 200);
      const payload = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: `sim-${randomUUID()}`, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), text: { body: text } }] } }] }] });
      return { ok: true, simulated: true, did: ingestWhatsApp(db, payload, new Date(), { simulated: true }) };
    }
    fail(400, 'action', 'Unknown simulator action.');
  });
}
