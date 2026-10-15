/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { isManagement } from '@/lib/auth';
import { fssaiToday } from '@/lib/fssai';
import { requireFssaiUser, str } from '@/lib/fssai-server';
import { businessName, slug } from '../../_p9/lib';
import { buildAuditFile } from '../lib';
import { buildAuditFilePdf, MAX_SCANS_PER_SECTION } from '../pdf-render';
import { loadScanImages } from '../scans';

/**
 * THE WHOLE AUDIT FILE AS ONE PDF (/api/fssai/audit-file/pdf?days=&copy=).
 *
 *   copy=handover   (default) — what is on file, stated as facts, to print or
 *                   hand to the inspector. Nothing in it describes a gap
 *                   (Inspection Mode's rule, FSSAI-BUILD-STATE.md §7 Q11), and
 *                   it says how many of the 20 it contains (cover, contents,
 *                   every footer) so it never passes for the complete file.
 *   copy=readiness  — the management copy: all 20 with PRESENT / EXPIRING /
 *                   MISSING and what closes each. Marked on every page as not
 *                   for handing over.
 *
 * The content is buildAuditFile() — the same function the page reads — drawn
 * by ./pdf-render with pdfkit, the library the digital bill already uses.
 *
 * ── WHY THE PATH HAS NO "print" IN IT ───────────────────────────────────────
 * proxy.ts matches public paths by pattern below its /api/ floor, and a
 * '/print' segment was once enough to make an API route public. This route
 * gates itself regardless: requireFssaiUser + isManagement, as Inspection Mode
 * and the report PDFs do.
 *
 * Served `inline` so it opens in the browser's viewer (print from there), with
 * a filename for saving. Read-only.
 */
export const dynamic = 'force-dynamic';

/** Rows per table in the PDF: enough for 90 days of a busy log, bounded so a runaway register cannot make a 600-page file. */
const PDF_ROWS = 300;

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me as any;
  if (!isManagement(me)) {
    return Response.json(
      { error: 'The audit file is management only. Ask a manager or an administrator to download it.' },
      { status: 403 },
    );
  }

  const url = new URL(request.url);
  const copy = str(url.searchParams.get('copy')) === 'readiness' ? 'readiness' : 'handover';

  try {
    const db = getDb();
    const today = fssaiToday();
    const file = buildAuditFile(db, today, { days: Number(url.searchParams.get('days')) || undefined, rowLimit: PDF_ROWS });
    const included = copy === 'readiness' ? file.items : file.items.filter((i) => i.held);
    // `scans` holds LIVE copies only (buildAuditFile moves voided files out), and
    // loadScanImages refuses a voided id again — a voided scan is never drawn.
    // Load only the images the renderer will draw (it draws at most
    // MAX_SCANS_PER_SECTION per record and names the rest), so a large staff
    // roster of certificates cannot pull hundreds of images into memory.
    // The handover draws only the copies it may carry (sc.in_handover: never the
    // scan of an expired paper) — load exactly those, in the renderer's order.
    const ids = included.flatMap((i) => i.scans
      .filter((sc) => sc.has_image && (copy === 'readiness' || sc.in_handover))
      .slice(0, MAX_SCANS_PER_SECTION).map((sc) => sc.attachment_id));
    const images = ids.length ? loadScanImages(db, ids) : new Map<string, { mime: string; bytes: Buffer }>();
    const name = businessName(db);

    const pdf = await buildAuditFilePdf({
      file,
      businessName: name,
      copy,
      preparedBy: String(me.name || me.email || ''),
      images,
    });
    const bytes = new Uint8Array(pdf);
    const fname = `fssai-audit-file${copy === 'readiness' ? '-management-copy' : ''}${name ? `-${slug(name)}` : ''}-${today}.pdf`;
    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${fname}"`,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'no-store',
        // The count the copy prints about itself, for a caller that only reads headers.
        'X-Audit-File-Records': `${file.handover.count}/${file.handover.total}`,
      },
    });
  } catch (e: any) {
    console.error('GET /api/fssai/audit-file/pdf failed:', e);
    return Response.json({ error: e?.message || 'Could not produce the audit file PDF' }, { status: 500 });
  }
}
