import { getCurrentUser } from '@/lib/auth';
import { generateId } from '@/lib/db';
import {
  billHandoverDb,
  canRecordBillHandover,
  canViewBillHandovers,
  getBillHandover,
  recordBillHandoverEvent,
  ACCOUNTS_ROLE_NAME,
  BH_FILE_MAX_BYTES,
  BH_RECEIVED,
  BH_VOID,
} from '@/lib/bill-handover';

/**
 * THE BILL SCAN — "invoice/bill attachment if applicable"
 * ======================================================
 *
 *   POST   /api/bill-submissions/:id/attachment   (multipart: file=, or JSON
 *          { data: "data:<mime>;base64,..." , filename? })  -> { file }
 *   GET    /api/bill-submissions/:id/attachment[?file_id=]  -> the bytes
 *   GET    /api/bill-submissions/:id/attachment?list=1      -> { files } (metadata)
 *   DELETE /api/bill-submissions/:id/attachment?file_id=    -> { ok: true }
 *
 * ── SIZE: 600 KB, AND WHY IT IS NOT 5 MB ───────────────────────────────────
 * The production proxy's real ceiling is 1 MB, not the 25 MB this repo's
 * deploy/nginx.conf claims — src/app/crm-calls/database/page.tsx:81-85 records a
 * direct probe of the live box: 900 KB reaches the app, 1,100 KB is refused with
 * a 413. Those AWS deploy scripts are stale, so the repo's config is not
 * evidence. (Flagged in the map as unreproduced from here: re-probe production
 * before changing this number, in either direction.)
 *
 * The HRMS vault is the house BLOB precedent and it is ALREADY BROKEN on
 * production for exactly this reason: it caps at 5 MB (hr-files.ts:18, whose
 * comment still says "nginx allows 25 MB"), so a 4 MB scan passes every check it
 * makes, is POSTed raw, and nginx returns an HTML 413 that the client's
 * `res.json()` inside an empty catch swallows into "Could not upload the
 * document" — no size, no cause, no remedy. That is precisely the silent failure
 * the brief forbids, so this route does NOT copy it.
 *
 * THREE LAYERS, so a big file never fails silently:
 *   (a) the CLIENT must compress before sending — port the ladder in the
 *       menu-image uploader (EXIF-correct decode, long-edge ladder, WebP else
 *       JPEG) but ASPECT-PRESERVING, not its square crop: a bill is portrait and
 *       cropping it square destroys the total. A phone photo of a bill is
 *       routinely 3-5 MB and must never leave the phone at that size;
 *   (b) a Content-Length pre-check HERE, before buffering, returning JSON that
 *       names the actual size;
 *   (c) a decoded-bytes check as the last line.
 * The client's fetch wrapper must also treat a NON-JSON error body as "the proxy
 * rejected this before the app saw it" — that single missing catch is the whole
 * of the HR vault's bug.
 *
 * A PDF cannot be compressed in the browser, so it is accepted only if it is
 * already under the cap; the refusal names the number.
 *
 * ── THE ATTACHMENT IS OPTIONAL, AND THE RECORD NEVER DEPENDS ON IT ─────────
 * The owner wrote "if applicable". A handover row is complete and submittable
 * with no file at all; bill identity is the evidence and the photo is
 * corroboration. A failed or skipped upload must never block the handover.
 *
 * ── SERVING BYTES BACK ─────────────────────────────────────────────────────
 * Like the HR vault, NOT like the public menu image: authenticated, unexpected
 * mimes coerced to application/octet-stream, Content-Disposition: attachment,
 * X-Content-Type-Options: nosniff, Cache-Control: private, no-store. A vendor
 * bill is commercial data.
 *
 * PATH SAFETY, checked rather than assumed: this path contains no "print"
 * substring (proxy.ts:125 makes any such path PUBLICLY UNAUTHENTICATED) and ends
 * in no file extension (proxy.ts:141 would make that public too). Never put bill
 * bytes under /api/customer/, which is public by design.
 */
export const dynamic = 'force-dynamic';

/** Wire allowance: base64 is +1/3, plus multipart/JSON framing and a filename. */
const MAX_BODY_BYTES = BH_FILE_MAX_BYTES + Math.ceil(BH_FILE_MAX_BYTES / 3) + 32 * 1024;

/** At most this many pages of one bill. A bill is a page or two, not an album. */
const MAX_FILES_PER_BILL = 5;

const ALLOWED_MIMES = new Set<string>([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function kb(n: number): string {
  return `${Math.round(n / 1024)} KB`;
}

const TOO_LARGE = (n: number) =>
  `That file is ${kb(n)}. Bill scans must be under ${kb(BH_FILE_MAX_BYTES)} — compress the photo (or retake it at a lower resolution) and try again.`;

/**
 * Trust the BYTES, not the declared type — a client can claim any content-type.
 * (Same stance as menu-items/image's sniffImageMime.) Returns null when the
 * bytes are not one of the four allowed shapes, which is also how SVG and every
 * other active format falls out without needing its own rule.
 */
function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'application/pdf'; // %PDF
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function parseDataUri(raw: string): Buffer | null {
  try {
    const m = raw.match(/^data:[^;,]*;base64,([\s\S]*)$/);
    if (!m) return null;
    const buf = Buffer.from(m[1], 'base64');
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

/** Safe ASCII fallback + RFC 5987 for the real name (the HR vault's shape). */
function contentDisposition(filename: string): string {
  const safe = (filename || 'bill').replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'bill';
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename || safe)}`;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canViewBillHandovers(me)) {
    return Response.json(
      { error: `Only the Store team or the ${ACCOUNTS_ROLE_NAME} team can view vendor bills.` },
      { status: 403 },
    );
  }

  try {
    const { id } = await params;
    const sp = new URL(request.url).searchParams;
    const db = billHandoverDb();

    if (!getBillHandover(db, id)) {
      return Response.json({ error: 'That bill record no longer exists.' }, { status: 404 });
    }

    // Metadata listing — the BLOB never rides a JSON response.
    if (sp.get('list') === '1') {
      const files = db
        .prepare(
          `SELECT id, handover_id, filename, mime, size_bytes, uploaded_by_id, uploaded_by_name, uploaded_at
             FROM bill_handover_files WHERE handover_id = ? ORDER BY uploaded_at ASC`,
        )
        .all(id);
      return Response.json({ files });
    }

    const fileId = String(sp.get('file_id') ?? '').trim();
    const row = (
      fileId
        ? db
            .prepare('SELECT * FROM bill_handover_files WHERE id = ? AND handover_id = ?')
            .get(fileId, id)
        : db
            .prepare(
              'SELECT * FROM bill_handover_files WHERE handover_id = ? ORDER BY uploaded_at ASC LIMIT 1',
            )
            .get(id)
    ) as { filename: string; mime: string; data: Buffer } | undefined;

    if (!row) return Response.json({ error: 'No bill scan is attached.' }, { status: 404 });

    const declared = String(row.mime || '').toLowerCase();
    // Anything not on the allowlist is handed back as an unknown download rather
    // than something the browser might render inside our origin.
    const serveAs = ALLOWED_MIMES.has(declared) ? declared : 'application/octet-stream';

    return new Response(new Uint8Array(row.data), {
      status: 200,
      headers: {
        'Content-Type': serveAs,
        'Content-Disposition': contentDisposition(row.filename),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    console.error('GET /api/bill-submissions/[id]/attachment failed:', e);
    return Response.json({ error: 'Could not load the bill scan.' }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canRecordBillHandover(me)) {
    return Response.json(
      { error: 'Only Management or the Store Manager can attach a vendor bill scan.' },
      { status: 403 },
    );
  }

  try {
    // (b) Pre-check BEFORE buffering. A JSON error with the number in it, so the
    //     client never has to guess — and never sees a bare proxy 413.
    const declaredLen = Number(request.headers.get('content-length') || 0);
    if (declaredLen > MAX_BODY_BYTES) {
      return Response.json({ error: TOO_LARGE(declaredLen), max_bytes: BH_FILE_MAX_BYTES }, { status: 413 });
    }

    const { id } = await params;
    const db = billHandoverDb();
    const handover = getBillHandover(db, id);
    if (!handover) return Response.json({ error: 'That bill record no longer exists.' }, { status: 404 });
    if (handover.status === BH_VOID) {
      return Response.json({ error: 'That bill record was voided.' }, { status: 400 });
    }
    // Once Accounts has confirmed, the record is settled evidence. Only an admin
    // may add to it after that, and the addition is logged on the trail.
    if (handover.status === BH_RECEIVED && me.role !== 'admin') {
      return Response.json(
        { error: 'Accounts has already confirmed that bill; its attachments are settled.' },
        { status: 409 },
      );
    }

    const existing = db
      .prepare('SELECT COUNT(*) AS n FROM bill_handover_files WHERE handover_id = ?')
      .get(id) as { n: number };
    if ((existing?.n ?? 0) >= MAX_FILES_PER_BILL) {
      return Response.json(
        { error: `A bill can carry at most ${MAX_FILES_PER_BILL} scans.` },
        { status: 409 },
      );
    }

    let buf: Buffer | null = null;
    let filename = '';
    const ctype = (request.headers.get('content-type') || '').toLowerCase();

    if (ctype.includes('multipart/form-data')) {
      const form = await request.formData();
      const entry = (form.get('file') ?? form.get('data')) as unknown;
      if (entry && typeof entry === 'object' && 'arrayBuffer' in (entry as Record<string, unknown>)) {
        const f = entry as File;
        buf = Buffer.from(await f.arrayBuffer());
        filename = f.name || '';
      } else if (typeof entry === 'string') {
        buf = parseDataUri(entry);
      }
      const fn = form.get('filename');
      if (typeof fn === 'string' && fn.trim()) filename = fn.trim();
    } else {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const raw = body?.data;
      if (typeof raw === 'string' && raw.startsWith('data:')) buf = parseDataUri(raw);
      const fn = body?.filename;
      if (typeof fn === 'string' && fn.trim()) filename = fn.trim();
    }

    if (!buf || buf.length === 0) {
      return Response.json(
        { error: 'No file received. Attach a photo or PDF of the bill.' },
        { status: 400 },
      );
    }
    // (c) The accurate gate, on the decoded bytes.
    if (buf.length > BH_FILE_MAX_BYTES) {
      return Response.json({ error: TOO_LARGE(buf.length), max_bytes: BH_FILE_MAX_BYTES }, { status: 413 });
    }

    const sniffed = sniffMime(buf);
    if (!sniffed || !ALLOWED_MIMES.has(sniffed)) {
      return Response.json(
        { error: 'That file is not a bill scan. Attach a JPG, PNG, WEBP or PDF.' },
        { status: 400 },
      );
    }

    const fileId = generateId();
    const storedName = filename || `bill-${fileId.slice(0, 8)}`;
    db.prepare(
      `INSERT INTO bill_handover_files
         (id, handover_id, filename, mime, size_bytes, data, uploaded_by_id, uploaded_by_name, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(fileId, id, storedName, sniffed, buf.length, buf, me.id, me.name || '');

    recordBillHandoverEvent(db, id, 'attachment_added', me, `${storedName} (${kb(buf.length)}, ${sniffed})`);

    return Response.json(
      { file: { id: fileId, handover_id: id, filename: storedName, mime: sniffed, size_bytes: buf.length } },
      { status: 201 },
    );
  } catch (e) {
    console.error('POST /api/bill-submissions/[id]/attachment failed:', e);
    return Response.json({ error: 'Could not attach that bill scan.' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // Removing evidence is an admin act, and it still leaves a trail row behind.
  if (me.role !== 'admin') {
    return Response.json({ error: 'Only an Administrator can remove a bill scan.' }, { status: 403 });
  }

  try {
    const { id } = await params;
    const fileId = String(new URL(request.url).searchParams.get('file_id') ?? '').trim();
    if (!fileId) return Response.json({ error: 'Which scan? Pass file_id.' }, { status: 400 });

    const db = billHandoverDb();
    const row = db
      .prepare('SELECT filename, size_bytes FROM bill_handover_files WHERE id = ? AND handover_id = ?')
      .get(fileId, id) as { filename: string; size_bytes: number } | undefined;
    if (!row) return Response.json({ error: 'That scan no longer exists.' }, { status: 404 });

    db.prepare('DELETE FROM bill_handover_files WHERE id = ? AND handover_id = ?').run(fileId, id);
    recordBillHandoverEvent(db, id, 'attachment_removed', me, `${row.filename} (${kb(row.size_bytes)})`);

    return Response.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/bill-submissions/[id]/attachment failed:', e);
    return Response.json({ error: 'Could not remove that bill scan.' }, { status: 500 });
  }
}
