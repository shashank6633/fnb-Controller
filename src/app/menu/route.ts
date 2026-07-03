import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /menu?t=<qr_token>   (PUBLIC — see src/proxy.ts isPublic)
 *
 * Serves the customer ordering web app — a TRUE mobile-first, full-viewport web
 * page (no phone frame/mockup): public/menu-assets/customer.html. It reads the
 * ?t=<token> client-side and fetches the live menu/table + places orders via the
 * public /api/customer/* routes. Premium AKAN blush/cream design, self-contained
 * (inline CSS + vanilla JS, Google Fonts only — no CDN framework / Babel).
 */
const PAGE = path.join(process.cwd(), 'public', 'menu-assets', 'customer.html');

export function GET() {
  try {
    const html = fs.readFileSync(PAGE, 'utf8');
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=0, must-revalidate',
      },
    });
  } catch (e: any) {
    console.error('[/menu GET]', e?.message);
    return new Response('Menu is temporarily unavailable.', { status: 500 });
  }
}
