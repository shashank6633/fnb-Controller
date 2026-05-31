import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Manage the Slack incoming-webhook URL used by the party-refresh notifier.
 * Stored in settings.slack_webhook_url. Masked on read so the secret doesn't
 * leak to non-admins or screenshots.
 *
 *   GET    /api/admin/slack-webhook → { configured: bool, masked?: 'https://...AB12' }
 *   POST   /api/admin/slack-webhook → save (admin)
 *          body: { url: string }   // empty string clears
 *   POST   /api/admin/slack-webhook?test=1 → send a test message via the saved URL
 */
export const dynamic = 'force-dynamic';

function mask(url: string): string {
  if (!url) return '';
  if (url.length <= 12) return '****';
  return url.slice(0, 8) + '…' + url.slice(-6);
}

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }
    const db = getDb();
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'slack_webhook_url'`).get() as { value: string } | undefined;
    const url = row?.value || '';
    return Response.json({ configured: !!url, masked: url ? mask(url) : '' });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }
    const db = getDb();
    const url = new URL(request.url);
    const test = url.searchParams.get('test') === '1';

    if (test) {
      const row = db.prepare(`SELECT value FROM settings WHERE key = 'slack_webhook_url'`).get() as { value: string } | undefined;
      const webhook = row?.value?.trim();
      if (!webhook) return Response.json({ error: 'No Slack webhook configured. Save one first.' }, { status: 400 });
      const r = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `✅ Test ping from F&B Controller — Slack integration is working.\nIf you can read this, party approval alerts will reach you.`,
        }),
      });
      if (!r.ok) {
        return Response.json({ error: `Slack returned ${r.status}: ${await r.text().catch(() => '')}` }, { status: 502 });
      }
      return Response.json({ ok: true, sent: true });
    }

    // Save
    const b = await request.json();
    const newUrl = String(b?.url || '').trim();
    if (newUrl && !/^https:\/\/hooks\.slack\.com\//.test(newUrl)) {
      return Response.json({ error: 'URL must start with https://hooks.slack.com/' }, { status: 400 });
    }
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('slack_webhook_url', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(newUrl);
    return Response.json({ ok: true, configured: !!newUrl, masked: newUrl ? mask(newUrl) : '' });
  } catch (e: any) {
    console.error('[/api/admin/slack-webhook]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
