/* eslint-disable @typescript-eslint/no-explicit-any */
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  APP_SECRET_SETTING_KEY, APP_SECRET_ENV_KEYS,
  webhookSecurityState, resetWebhookTelemetry,
} from '@/lib/wa-template-authoring';

/**
 * THE WHATSAPP APP SECRET — write-only, admin only.
 *
 *   POST   { secret }            → store it; webhook signature checking turns on
 *   DELETE ?confirm=1            → remove it; checking turns OFF (a forgery hole)
 *
 * WHY THIS EXISTS AT ALL. The signature check on /api/whatsapp/webhook is correct
 * and proven, and it was shipping DORMANT: the secret could only come from a
 * server environment variable, none was set, and no route in the app could write
 * one — so the deploy that "closed" the forgery hole left it fully open, with the
 * only cure being a hand-edit of the server's environment. A security control
 * nobody can turn on is not a control.
 *
 * WHY THE URL IS ODD. An app secret is not a template, and this belongs beside the
 * other WhatsApp credentials in /api/whatsapp/config. That route and its
 * WA_CONFIG_KEYS whitelist are outside the change this lane is allowed to make, so
 * it lives under the one WhatsApp path this lane owns — next to the GET that
 * already reports webhook security state. Moving it later is two lines: add
 * 'wa_app_secret' to WA_CONFIG_KEYS and to SECRET_KEYS in src/lib/whatsapp.ts;
 * the reader (webhookAppSecretLookup) needs no change at all.
 *
 * WHERE IT IS STORED, AND WHY THAT IS SAFE TO READ BACK. One `settings` row,
 * `wa_app_secret`. The generic settings endpoint and the admin SQL console both
 * mask any key matching SECRET_KEY_RE — which matches the word "secret" — so the
 * value cannot be read back out of either. The WhatsApp config route iterates its
 * own whitelist and never returns it. This route never returns it. The environment
 * still WINS over it, so a server-provided secret cannot be overridden from a
 * browser.
 */
export const dynamic = 'force-dynamic';

const MIN_SECRET = 16;

export async function POST(request: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

    const b = await request.json().catch(() => ({} as any));
    const secret = String((b as any)?.secret ?? '').trim();
    if (!secret) {
      return Response.json({
        error: 'Paste the app secret from Meta App Dashboard → Settings → Basic → App secret. To switch signature checking off instead, use the remove option — it is not the same thing as an empty value.',
      }, { status: 400 });
    }
    if (/\s/.test(secret)) {
      return Response.json({ error: 'That value contains a space or a line break, so it is not a Meta app secret — it was probably copied with something around it. Copy just the secret.' }, { status: 400 });
    }
    if (secret.length < MIN_SECRET) {
      return Response.json({ error: `That is only ${secret.length} characters. A Meta app secret is a long hexadecimal string (32 characters at the time of writing), and a short value here would refuse every real Meta event while looking switched on.` }, { status: 400 });
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(APP_SECRET_SETTING_KEY, secret);
    // A new secret has verified nothing yet, and the old secret's success says
    // nothing about it: the screen must not show a stale green tick.
    resetWebhookTelemetry(db);

    const state = webhookSecurityState(db);
    const envWins = APP_SECRET_ENV_KEYS.some(k => String(process.env[k] ?? '').trim());
    return Response.json({
      ok: true,
      webhook_security: state,
      note: envWins
        ? `Saved — but the server also sets ${APP_SECRET_ENV_KEYS.find(k => String(process.env[k] ?? '').trim())}, and that one wins. Remove it from the server environment if you want the value saved here to be the one used.`
        : 'Saved. From now on every incoming WhatsApp webhook is checked against it, and anything unsigned or wrongly signed is turned away without being recorded. Send yourself a WhatsApp message to confirm real events still get in — the line above will name the time one last verified. If it never does, the secret is not the right one.',
    });
  } catch (e: any) {
    console.error('[/api/whatsapp/templates/sync/webhook-secret POST]', e);
    return Response.json({ error: e?.message || 'Could not save the app secret.' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const url = new URL(request.url);
    if (url.searchParams.get('confirm') !== '1') {
      return Response.json({
        error: 'Removing the app secret switches webhook signature checking off, and anyone who knows the webhook address can then post invented guest messages and delivery reports into the CRM. Re-send with confirm=1 if that is really what you want.',
        needs_confirmation: true,
      }, { status: 409 });
    }
    const db = getDb();
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(APP_SECRET_SETTING_KEY);
    resetWebhookTelemetry(db);
    return Response.json({
      ok: true,
      webhook_security: webhookSecurityState(db),
      note: 'Removed. Incoming WhatsApp keeps working, and forged WhatsApp events are no longer turned away.',
    });
  } catch (e: any) {
    console.error('[/api/whatsapp/templates/sync/webhook-secret DELETE]', e);
    return Response.json({ error: e?.message || 'Could not remove the app secret.' }, { status: 500 });
  }
}
