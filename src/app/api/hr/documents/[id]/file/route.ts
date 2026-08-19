/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canAdminHr } from '@/lib/hr';
import { readHrDocument } from '@/lib/hr-files';
import { reportServerError } from '@/lib/error-alerts';

/**
 * Serve a stored HR document's bytes (GET /api/hr/documents/:id/file).
 * Contract: docs/HRMS_DECISIONS.md D4 — the byte-serving discipline is copied
 * from /api/tasks/files/[id], with two deliberate differences:
 *
 *   1. Gate: canAdminHr, not "any signed-in user" — the /hr/documents page is
 *      adminOnly and the API re-checks (§2.1/§2.2: the proxy does not protect
 *      API GETs; the tier flag alone is never the boundary).
 *   2. Cache-Control: `private, no-store`, NOT the task-files 1-year immutable
 *      cache — a revoked contract or an ex-employee's Aadhaar must not live in
 *      a browser cache for a year (D4b).
 *
 * Kept from the task-files discipline:
 *   · active/scriptable mimes (svg/html/xml) are coerced to
 *     application/octet-stream so a stored blob can never execute on this
 *     origin (belt-and-braces on top of the upload-side allowlist);
 *   · Content-Disposition: attachment with a sanitized ASCII fallback filename
 *     (no CR/LF/") plus RFC 5987 filename*=UTF-8'' so Telugu/Hindi/emoji
 *     names survive without tripping the Latin1 header limit;
 *   · X-Content-Type-Options: nosniff.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const { id } = await params;
    const row = readHrDocument(getDb(), id);
    if (!row || !row.data || row.data.length === 0) {
      return Response.json({ error: 'Document not found' }, { status: 404 });
    }

    // better-sqlite3 returns a Node Buffer for a BLOB column. Copy into a
    // fresh Uint8Array so the Web Response body gets a clean ArrayBuffer view.
    const bytes = Uint8Array.from(row.data);

    const rawMime = (row.mime || 'application/octet-stream').toLowerCase();
    // Never hand back an active/renderable-as-script type on the app origin.
    const isActive =
      rawMime.includes('svg') ||
      rawMime.includes('html') ||
      rawMime === 'application/xml' ||
      rawMime === 'text/xml';
    const mime = isActive ? 'application/octet-stream' : rawMime;

    // RFC 5987 filename pair: header values must be Latin1-safe (the Response
    // constructor throws TypeError on chars > U+00FF — a Telugu/Hindi/emoji
    // filename would otherwise turn into a permanent 500). So: an ASCII
    // fallback in `filename=` plus the original name percent-encoded in
    // `filename*=UTF-8''...` for compliant browsers.
    const rawName = (row.filename || 'document').replace(/[\r\n"]/g, '');
    const asciiName =
      // eslint-disable-next-line no-control-regex
      rawName.replace(/[^\x20-\x7e]/g, '_').trim() || 'document';
    // encodeURIComponent leaves !'()* unescaped; RFC 5987 attr-char excludes
    // them, so escape those too.
    const encName = encodeURIComponent(rawName || 'document').replace(
      /['()!*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.byteLength),
        // Always download rather than render top-level: a stored blob must
        // never execute as a document on the fnb-controller origin.
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encName}`,
        // Stop MIME sniffing so a mislabelled blob can't become HTML/JS.
        'X-Content-Type-Options': 'nosniff',
        // NO long-lived cache for identity documents — ever (D4b).
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    // Generic message only — e.message can leak schema/PII for HR data.
    console.error('[hr-documents-file:GET]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load document' }, { status: 500 });
  }
}
