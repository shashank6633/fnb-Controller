import { randomBytes } from 'crypto';
import { getDb } from '@/lib/db';
import { renderGuestPage } from '@/lib/valet/guest-page';
import { guestEntry } from '@/lib/valet/guest';

/**
 * GET /valet-pass — the guest's valet pass and guest-led check-in page.
 * PUBLIC (exact path in proxy.ts VALET_GUEST_PATHS). Serves one self-contained
 * HTML document like /menu does, so no staff React shell or poller runs for a
 * guest. It renders no guest data itself — the page fetches its own passes
 * with the httpOnly device cookie — so the HTML is the same for everyone.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const entry = (url.searchParams.get('e') || '').slice(0, 64);
  let venueName = '';
  let lang: 'en' | 'hi' = 'en';
  let business = '';
  try {
    const db = getDb();
    business = ((db.prepare(`SELECT value FROM settings WHERE key = 'business_name'`).get() as { value?: string } | undefined)?.value || '').slice(0, 60);
    if (entry) {
      const e = guestEntry(db, entry);
      if (e.ok) { venueName = e.venue_name; lang = e.language === 'hi' ? 'hi' : 'en'; }
    }
  } catch { /* render the shell anyway; the page shows a friendly error on its own fetches */ }
  const nonce = randomBytes(16).toString('base64');
  const html = renderGuestPage({ nonce, lang, entry, venueName, businessName: business });
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, private, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    },
  });
}
