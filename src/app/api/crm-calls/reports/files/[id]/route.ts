/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { getReportFile } from '@/lib/wa-report-send';

/**
 * GET /api/crm-calls/reports/files/[id] — download one stored report PDF.
 *
 * PRIVATE BY CONSTRUCTION. These files are our sales and stock figures, and
 * they must never be publicly linkable:
 *   • the path sits under /api/crm-calls, which src/proxy.ts already requires a
 *     session for, and it matches nothing in isPublic(). Note the trap that
 *     shapes this path: isPublic() returns true for ANY pathname containing
 *     '/print' — so a report route must never be named /reports/print/… .
 *   • it self-gates anyway (the task_files / inbox-media pattern): a proxy that
 *     only proves a cookie exists is not authorisation.
 *   • isManagement — admin | manager | HOD — the same tier that already gates
 *     the table-wise Sales download and the Sales Reports section. Sales and
 *     stock figures are not open to all staff the way guest history is.
 *
 * This route is also WHY the send path uploads bytes to Meta rather than
 * handing Meta a link: Meta's link fetcher is unauthenticated, so a
 * link-shaped rail would have needed a public version of this very route.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Only the types we ourselves store. Never echo a stored MIME back unchecked —
 *  that is how an active type (svg/html) becomes stored XSS on the app origin. */
const SERVEABLE = new Set(['application/pdf', 'image/png', 'image/jpeg']);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!isManagement(me)) {
    return Response.json({ error: 'Reports are limited to admins, managers and heads of department.' }, { status: 403 });
  }

  try {
    const { id } = await params;
    const fileId = Number(id);
    if (!Number.isFinite(fileId) || fileId <= 0) return Response.json({ error: 'Bad file id' }, { status: 400 });

    const row = getReportFile(getDb(), fileId);
    if (!row || !row.data) return Response.json({ error: 'Report file not found' }, { status: 404 });

    // new Uint8Array(buf) copies in one go; Uint8Array.from() walks element by
    // element, which is a visible cost at report sizes.
    const bytes = new Uint8Array(row.data);
    const mime = SERVEABLE.has(String(row.mime || '').toLowerCase())
      ? String(row.mime).toLowerCase()
      : 'application/octet-stream';
    // Strip anything that could break out of the header (quotes, CR/LF, path
    // separators) — the filename is data we stored, but it originates from a
    // report generator, not from this route.
    const safeName = (row.filename || `report-${fileId}`).replace(/[^\w.\- ]+/g, '_').slice(0, 120);

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(row.size || bytes.byteLength),
        // Always a download, never an inline render on the app origin.
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'X-Content-Type-Options': 'nosniff',
        // no-store, NOT the immutable caching the inbox-media route uses:
        // these rows are immutable too, but leaving a P&L in a shared
        // browser's disk cache is a different question from caching a guest's
        // photo.
        'Cache-Control': 'private, no-store, max-age=0',
      },
    });
  } catch (e: any) {
    console.error('GET /api/crm-calls/reports/files/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to load report file' }, { status: 500 });
  }
}
