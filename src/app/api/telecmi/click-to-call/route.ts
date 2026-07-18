import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { normalizePhone } from '@/lib/ct/phone';
import { ctSetting, isTelecmiConfigured } from '@/lib/ct/settings';
import { emitCt, pushRecentCt } from '@/lib/ct/bus';

/**
 * POST /api/telecmi/click-to-call — GRE taps "Call" on a guest / recovery card.
 *
 * Body: { phone?: string, guest_id?: string, recovery_id?: string }
 *   - phone resolution order: explicit phone → guest lookup → recovery lookup.
 *   - With real TeleCMI creds (env TELECMI_APPID/TELECMI_SECRET): POST the
 *     originate REST endpoint with a hard 5s timeout. Without creds the call is
 *     MOCKED ({ mocked: true }) so the whole flow is testable in dev.
 *   - recovery_id: on a successful originate (real or mocked), append an
 *     attempt { at, by, method: 'callback', outcome: 'initiated' }, move
 *     pending→attempting (expired recoveries may still be worked, per the
 *     lifecycle contract), and stamp first_attempt_at once.
 *
 * Secrets never leave the server; the provider_response is returned verbatim
 * for the admin to debug, but it never contains our credentials.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEFAULT_ORIGINATE_URL = 'https://rest.telecmi.com/v2/click_to_call';

/** ctSetting('telecmi_base_url') may be a base ('https://rest.telecmi.com/v2')
 *  or the full originate endpoint — accept both. */
function originateUrl(base: string): string {
  const b = (base || '').trim().replace(/\/+$/, '');
  if (!b) return DEFAULT_ORIGINATE_URL;
  return /click_to_call$/i.test(b) ? b : `${b}/click_to_call`;
}

/** Reverse-lookup the caller's TeleCMI agent id from the agent_map setting
 *  ({ telecmiAgentId: fnbUserEmail }). '' when unmapped. */
function telecmiAgentFor(db: ReturnType<typeof getDb>, email: string): string {
  try {
    const map = JSON.parse(ctSetting(db, 'agent_map') || '{}') as Record<string, string>;
    for (const [agentId, mappedEmail] of Object.entries(map)) {
      if (String(mappedEmail).trim().toLowerCase() === email.trim().toLowerCase()) return agentId;
    }
  } catch { /* malformed agent_map — treat as unmapped */ }
  return '';
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty/malformed body handled below */ }
  const guestId = String(body?.guest_id || '');
  const recoveryId = String(body?.recovery_id || '');

  const db = getDb();

  // ── Resolve the number to dial ───────────────────────────────────────────
  let phone = '';
  if (body?.phone) {
    phone = normalizePhone(body.phone);
    if (!phone) return Response.json({ error: 'Not a dialable phone number' }, { status: 400 });
  } else if (guestId) {
    const g = db.prepare(`SELECT phone_e164 FROM ct_guests WHERE id = ?`).get(guestId) as any;
    if (!g) return Response.json({ error: 'Guest not found' }, { status: 404 });
    phone = normalizePhone(g.phone_e164);
  } else if (recoveryId) {
    const r = db.prepare(`SELECT phone_e164 FROM ct_recoveries WHERE id = ?`).get(recoveryId) as any;
    if (!r) return Response.json({ error: 'Recovery not found' }, { status: 404 });
    phone = normalizePhone(r.phone_e164);
  }
  if (!phone) return Response.json({ error: 'Provide phone, guest_id or recovery_id' }, { status: 400 });

  // ── Originate (real or mocked) ───────────────────────────────────────────
  let ok = false;
  let mocked = false;
  let providerResponse: any = null;

  if (isTelecmiConfigured()) {
    const url = originateUrl(ctSetting(db, 'telecmi_base_url'));
    const appidRaw = process.env.TELECMI_APPID || '';
    const digits = phone.replace(/^\+/, '');
    const agent = telecmiAgentFor(db, me.email);
    const payload = {
      // TeleCMI expects numeric appid/to on most accounts; pass through as-is otherwise.
      appid: /^\d+$/.test(appidRaw) ? Number(appidRaw) : appidRaw,
      secret: process.env.TELECMI_SECRET || '',
      to: /^\d+$/.test(digits) ? Number(digits) : digits,
      ...(agent ? { agent } : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text();
      try { providerResponse = JSON.parse(text); } catch { providerResponse = text.slice(0, 500); }
      if (!res.ok) {
        return Response.json(
          { ok: false, mocked: false, error: `TeleCMI responded ${res.status}`, provider_response: providerResponse },
          { status: 502 },
        );
      }
      ok = true;
    } catch (e: any) {
      const msg = e?.name === 'AbortError'
        ? 'TeleCMI click-to-call timed out (5s)'
        : `TeleCMI click-to-call failed: ${e?.message || e}`;
      return Response.json({ ok: false, mocked: false, error: msg }, { status: 502 });
    } finally {
      clearTimeout(timer);
    }
  } else {
    // No creds → mock success so dev/staging flows (recovery attempts, UI) work.
    ok = true;
    mocked = true;
  }

  // ── Log the attempt on the recovery (only when the dial actually fired) ──
  let recoveryUpdated = false;
  if (ok && recoveryId) {
    const rec = db.prepare(`SELECT id, status, attempts, first_attempt_at FROM ct_recoveries WHERE id = ?`).get(recoveryId) as any;
    if (rec) {
      const now = new Date().toISOString();
      let attempts: any[] = [];
      try { attempts = JSON.parse(rec.attempts || '[]'); } catch { attempts = []; }
      if (!Array.isArray(attempts)) attempts = [];
      attempts.push({ at: now, by: me.email, method: 'callback', outcome: 'initiated' });
      // pending→attempting; expired recoveries may still be worked (contract),
      // terminal-good states (recovered/auto_resolved/unreachable) keep their status.
      const newStatus = rec.status === 'pending' || rec.status === 'expired' ? 'attempting' : rec.status;
      db.prepare(`
        UPDATE ct_recoveries
        SET attempts = ?, status = ?, first_attempt_at = COALESCE(first_attempt_at, ?), updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(attempts), newStatus, now, now, recoveryId);
      recoveryUpdated = true;

      const pending = db.prepare(
        `SELECT COUNT(*) AS n FROM ct_recoveries WHERE status IN ('pending','attempting')`,
      ).get() as any;
      const evt = { type: 'recovery_update' as const, phone, recoveryCount: Number(pending?.n) || 0, at: now };
      emitCt(evt);
      pushRecentCt(evt);
    }
  }

  return Response.json({ ok, mocked, phone, provider_response: providerResponse, recovery_updated: recoveryUpdated });
}
