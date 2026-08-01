import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { normalizePhone } from '@/lib/ct/phone';
import { ctSetting, isTelecmiConfigured, telecmiSecret } from '@/lib/ct/settings';
import { emitCt, pushRecentCt } from '@/lib/ct/bus';

/**
 * POST /api/telecmi/click-to-call — GRE taps "Call" on a guest / recovery card.
 *
 * Body: { phone?: string, guest_id?: string, recovery_id?: string }
 *   - phone resolution order: explicit phone → guest lookup → recovery lookup.
 *   - With real TeleCMI creds (env TELECMI_APPID/TELECMI_SECRET): POST the
 *     originate REST endpoint with a hard 5s timeout. Without creds the call is
 *     MOCKED ({ mocked: true }) so the whole flow is testable in dev.
 *     TELECMI_APPID is not part of the admin click2call body — it stays in env
 *     purely as the "are we live?" gate in isTelecmiConfigured().
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

// Wire format below follows the TeleCMI "Click-To-Call (Admin)" doc verbatim:
// POST /v2/webrtc/click2call with { user_id, secret, to, extra_params, webrtc,
// followme, callerid }. An earlier revision guessed /v2/click_to_call with
// { appid, secret, to, agent } — that path does not exist and "agent"/"appid"
// are not request fields, so every real dial 404'd. Please do not "restore" it.
const DEFAULT_ORIGINATE_URL = 'https://rest.telecmi.com/v2/webrtc/click2call';

/** ctSetting('telecmi_base_url') may be a base ('https://rest.telecmi.com/v2')
 *  or the full originate endpoint — accept both, because the settings field
 *  invites an admin to paste either. Also tolerate a base left over from the
 *  wrong-path era ('…/v2/click_to_call'), which would otherwise concatenate
 *  into a nonsense URL the moment we append the real path. */
function originateUrl(base: string): string {
  let b = (base || '').trim().replace(/\/+$/, '');
  if (!b) return DEFAULT_ORIGINATE_URL;
  if (/\/webrtc\/click2call$/i.test(b)) return b;
  b = b.replace(/\/click_to_call$/i, '');
  return `${b}/webrtc/click2call`;
}

/** Reverse-lookup the caller's TeleCMI user id from the agent_map setting
 *  ({ telecmiAgentId: fnbUserEmail }). '' when unmapped.
 *
 *  agent_map is the right source for click2call's `user_id`: TeleCMI's CDR
 *  reports the handling extension as `agent: "201_1111112"` — the same
 *  "<ext>_<appid>" shape click2call documents for `user_id` — so the ids we
 *  already map per GRE are exactly the ids the originate call expects. */
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

  if (isTelecmiConfigured(db)) {
    const url = originateUrl(ctSetting(db, 'telecmi_base_url'));

    // click2call rings user_id FIRST, then dials `to` — so an absent user_id
    // does not merely lose attribution, it means TeleCMI has no extension to
    // ring and the dial cannot happen. Falling back to some other agent would
    // ring the wrong GRE's handset, so refuse loudly and say where to fix it.
    const userId = telecmiAgentFor(db, me.email);
    if (!userId) {
      return Response.json(
        {
          ok: false,
          mocked: false,
          error: `No TeleCMI agent is mapped to ${me.email}. Add the mapping in CRM Settings → Agent Mapping, then try the call again.`,
          provider_response: null,
        },
        { status: 400 },
      );
    }

    // `to` must be digits-only with country code, as a NUMBER (no plus/spaces/
    // dashes) — normalizePhone already yields +<digits>, so drop the plus.
    const digits = phone.replace(/\D/g, '');
    const payload = {
      user_id: userId,                              // STRING, e.g. "101_1111112"
      // Resolver, not process.env — a DB-configured account passes
      // isTelecmiConfigured(db) above and must post a real secret here.
      secret: telecmiSecret(db),
      to: /^\d+$/.test(digits) ? Number(digits) : digits,
      extra_params: { crm: true },                  // echoed back on the CDR
      webrtc: true,
      followme: false,
      // callerid is optional and we have no ct setting holding a DID; sending a
      // made-up number would spoof the outbound id, so omit it and let TeleCMI
      // use the account default.
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
