import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /quiz/link/<code>   (PUBLIC — see src/proxy.ts isPublic)
 *
 * Serves the standalone guest quiz app — a true mobile-first, full-viewport
 * page (public/quiz-assets/guest-quiz.html), the same escape mechanism as
 * /menu (src/app/menu/route.ts). It CANNOT be a page.tsx: AppShell wraps every
 * page route and UserBar client-side-redirects logged-out visitors to /login,
 * which would bounce guests. The page reads the link code from
 * location.pathname and drives the PUBLIC /api/crm/guest-quiz/* routes
 * (self-contained inline CSS + vanilla JS, AKAN warm palette, 3 screens:
 * registration → timed quiz → report card, with tab-switch anti-cheat).
 */
const PAGE = path.join(process.cwd(), 'public', 'quiz-assets', 'guest-quiz.html');

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  // The link code is validated client-side via /api/crm/guest-quiz/link/[code]
  // (invalid/expired/maxed links render the in-app error screen), so the
  // handler only needs to serve the shell.
  await params;
  try {
    const html = fs.readFileSync(PAGE, 'utf8');
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=0, must-revalidate',
      },
    });
  } catch (e: any) {
    console.error('[/quiz/link GET]', e?.message);
    return new Response('The quiz is temporarily unavailable.', { status: 500 });
  }
}
