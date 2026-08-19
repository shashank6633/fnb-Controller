/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canAdminHr, isHrDocType } from '@/lib/hr';
import { storeHrDocument, HR_DOC_MAX_BYTES } from '@/lib/hr-files';
import { reportServerError } from '@/lib/error-alerts';
import { todayIST } from '@/lib/format-date';

/**
 * HR Document Vault (/api/hr/documents) — Phase 4.
 * Contract: docs/HRMS_DECISIONS.md (D4: BLOBs in SQLite, HR-only gate;
 * §2.1: the proxy does NOT protect API GETs — this handler is the boundary).
 *
 * GET  ?employee_id=&expiring_days=&page=&pageSize=
 *        → { rows, total, page, pageSize }
 *      METADATA ONLY — the data BLOB never rides JSON. Rows are every
 *      hr_documents column except `data`, plus employee_name / employee_code
 *      (LEFT JOIN hr_employees — a dangling employee_id degrades to blank,
 *      never drops the document). expiring_days=N keeps only documents whose
 *      expiry_date falls on or before todayIST + N days (expiry alerts).
 *
 * POST multipart/form-data (file|data field + employee_id, doc_type, ...)
 *      or JSON { data:"data:<mime>;base64,...", filename?, employee_id, ... }
 *        → { document } (metadata, no bytes)
 *      Content-Length pre-check against HR_DOC_MAX_BYTES BEFORE buffering
 *      (Next 16 + proxy silently truncates >10MB — WE are the gate, D4).
 *      Mime allowlist: pdf / jpeg / png / webp. SVG is rejected outright
 *      (active content). employee_id must be a real hr_employees.id.
 *
 * PATCH JSON { id, action: 'verify'|'reject' } → { document }
 *      Sets verify_status verified/rejected + verified_by (the hr/bank house
 *      shape the /hr/documents page sends). Audited as hr.document.verify —
 *      metadata only, never the bytes.
 *
 * DELETE ?id= (or JSON { id })
 *      HARD delete of the document row (owner ruling: allowed for admins).
 *      Audited as hr.document.delete recording filename + type + size —
 *      NEVER the bytes.
 *
 * Whole gate: canAdminHr on every verb — the /hr/documents catalog page is
 * adminOnly, and the API re-checks because the flag alone is never the
 * boundary (§2.2). Errors return GENERIC messages only (e.message can leak
 * schema/PII for HR data).
 */
export const dynamic = 'force-dynamic';

/**
 * Body allowance for the Content-Length pre-check: the 5 MB cap applies to the
 * DECODED document, but the body carries base64 (+1/3) and multipart/JSON
 * framing, so a compliant 4.9 MB file arrives as a ~6.6 MB request. Anything
 * beyond this bound cannot contain a legal document — reject before buffering.
 */
const MAX_BODY_BYTES = HR_DOC_MAX_BYTES + Math.ceil(HR_DOC_MAX_BYTES / 3) + 64 * 1024;

const TOO_LARGE_MSG = 'Document too large - 5MB max';

/** Mime allowlist (D4 vault: documents + raster scans only). */
const ALLOWED_MIMES = new Set<string>([
  'application/pdf',
  'image/jpeg',
  'image/jpg', // some cameras/browsers still emit the legacy alias
  'image/png',
  'image/webp',
]);

/** Trimmed string from any body/form value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** Every hr_documents column EXCEPT the data BLOB — metadata never bytes. */
const DOC_META_SELECT = `
  SELECT d.id, d.employee_id, d.doc_type, d.doc_number, d.issue_date,
         d.expiry_date, d.filename, d.mime, d.size_bytes, d.verify_status,
         d.verified_by, d.uploaded_by, d.created_at,
         e.full_name AS employee_name, e.employee_code AS employee_code
  FROM hr_documents d
  LEFT JOIN hr_employees e ON e.id = d.employee_id`;

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;

    // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
    // SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    const where: string[] = [];
    const params: any[] = [];

    const employee_id = s(sp.get('employee_id'));
    if (employee_id) {
      where.push('d.employee_id = ?');
      params.push(employee_id);
    }

    // expiring_days=N → expiry_date within the next N days (or already past).
    // expiry_date is a plain IST YYYY-MM-DD; '' = no expiry and is skipped.
    const expiringRaw = sp.get('expiring_days');
    if (expiringRaw !== null && s(expiringRaw) !== '') {
      const days = Math.max(0, parseInt(expiringRaw, 10) || 0);
      const base = new Date(`${todayIST()}T00:00:00Z`);
      base.setUTCDate(base.getUTCDate() + days);
      const threshold = base.toISOString().slice(0, 10);
      where.push(`d.expiry_date != '' AND d.expiry_date <= ?`);
      params.push(threshold);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const db = getDb();
    // COUNT(*) shares the exact WHERE + params so total and rows never disagree.
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_documents d ${whereSql}`)
      .get(...params) as { n: number };

    const rows = db
      .prepare(
        `${DOC_META_SELECT} ${whereSql}
         ORDER BY d.created_at DESC, d.id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize);

    return Response.json({ rows, total: totalRow.n, page, pageSize });
  } catch (e) {
    console.error('[hr-documents:GET]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load documents' }, { status: 500 });
  }
}

interface Decoded {
  buf: Buffer;
  mime: string;
  filename: string;
}

/** Parse a `data:<mime>;base64,<payload>` URI into a Buffer + mime. */
function parseDataUri(uri: string): Decoded | null {
  const m = /^data:([^;,]*)(;[^,]*)?,([\s\S]*)$/.exec(uri);
  if (!m) return null;
  const mime = (m[1] || '').trim().toLowerCase() || 'application/octet-stream';
  const meta = m[2] || '';
  const payload = m[3] || '';
  // A malformed payload (bad %-escapes in the plain-text branch, or garbage
  // base64) must surface as a clean 400 via the null path — decodeURIComponent
  // throws URIError, which would otherwise bubble to the generic 500.
  try {
    const buf = /;base64/i.test(meta)
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    return { buf, mime, filename: '' };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    // Cheap pre-check BEFORE buffering the body (copy of /api/error-report):
    // App Router has no default body-size limit, and the proxy would silently
    // truncate >10MB — reject declared-oversize requests up front.
    const declaredLen = Number(request.headers.get('content-length') || 0);
    if (declaredLen > MAX_BODY_BYTES) {
      return Response.json({ error: TOO_LARGE_MSG }, { status: 400 });
    }

    // Metadata fields arrive alongside the bytes in either shape.
    const meta = {
      employee_id: '',
      doc_type: '',
      doc_number: '',
      issue_date: '',
      expiry_date: '',
      filename: '',
    };

    let decoded: Decoded | null = null;
    // A data: URI was supplied but could not be decoded — a distinct 400 from
    // "no file at all" so the client knows to re-attach, not re-select.
    let malformed = false;
    const ctype = (request.headers.get('content-type') || '').toLowerCase();

    if (ctype.includes('multipart/form-data')) {
      const form = await request.formData();
      const entry = (form.get('file') ?? form.get('data')) as unknown;
      if (entry && typeof entry === 'object' && 'arrayBuffer' in (entry as any)) {
        const file = entry as File;
        const ab = await file.arrayBuffer();
        decoded = {
          buf: Buffer.from(ab),
          mime: (file.type || 'application/octet-stream').toLowerCase(),
          filename: file.name || '',
        };
      } else if (typeof entry === 'string') {
        decoded = parseDataUri(entry);
        malformed = entry.startsWith('data:') && !decoded;
      }
      meta.employee_id = s(form.get('employee_id'));
      meta.doc_type = s(form.get('doc_type'));
      meta.doc_number = s(form.get('doc_number'));
      meta.issue_date = s(form.get('issue_date'));
      meta.expiry_date = s(form.get('expiry_date'));
      meta.filename = s(form.get('filename'));
    } else {
      // JSON { data:"data:<mime>;base64,...", filename?, employee_id, ... }
      const body = (await request.json().catch(() => null)) as any;
      const raw = body?.data;
      if (typeof raw === 'string' && raw.startsWith('data:')) {
        decoded = parseDataUri(raw);
        malformed = !decoded;
      }
      meta.employee_id = s(body?.employee_id);
      meta.doc_type = s(body?.doc_type);
      meta.doc_number = s(body?.doc_number);
      meta.issue_date = s(body?.issue_date);
      meta.expiry_date = s(body?.expiry_date);
      meta.filename = s(body?.filename);
    }

    if (malformed) {
      return Response.json(
        { error: 'That file could not be read - re-attach it' },
        { status: 400 },
      );
    }
    if (!decoded || !decoded.buf || decoded.buf.length === 0) {
      return Response.json(
        { error: 'No file received. Send a data: URI or a multipart file.' },
        { status: 400 },
      );
    }
    if (meta.filename) decoded.filename = meta.filename;

    // The accurate size gate on the DECODED bytes (the pre-check above only
    // bounds the wire body). hr-files re-asserts this cap as the last line.
    if (decoded.buf.length > HR_DOC_MAX_BYTES) {
      return Response.json({ error: TOO_LARGE_MSG }, { status: 400 });
    }

    // Mime allowlist. SVG (and anything else active) never gets stored —
    // belt-and-braces on top of the allowlist itself.
    const mime = (decoded.mime || '').toLowerCase();
    if (mime.includes('svg')) {
      return Response.json(
        { error: 'SVG files are not allowed. Upload a PDF or a PNG/JPG/WEBP image.' },
        { status: 400 },
      );
    }
    if (!ALLOWED_MIMES.has(mime)) {
      return Response.json(
        { error: 'Unsupported file type. Allowed: PDF, JPG, PNG, WEBP.' },
        { status: 400 },
      );
    }

    // Vocab gate: a typo'd doc_type must not create a row the type filters can
    // never find. '' is allowed (schema default — "untyped").
    if (meta.doc_type && !isHrDocType(meta.doc_type)) {
      return Response.json({ error: 'Invalid document type' }, { status: 400 });
    }

    // Date format gate: the expiring filter and the bell bucket compare these
    // lexicographically, so a non-YYYY-MM-DD value would silently never alert.
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (meta.issue_date && !DATE_RE.test(meta.issue_date)) {
      return Response.json(
        { error: 'Issue date must be YYYY-MM-DD' },
        { status: 400 },
      );
    }
    if (meta.expiry_date && !DATE_RE.test(meta.expiry_date)) {
      return Response.json(
        { error: 'Expiry date must be YYYY-MM-DD' },
        { status: 400 },
      );
    }

    if (!meta.employee_id) {
      return Response.json({ error: 'Employee is required' }, { status: 400 });
    }

    const db = getDb();
    // Referential check on CREATE (backend-mapping rule): employee_id must be
    // a real hr_employees.id. Reads stay LEFT-JOIN tolerant; writes do not.
    const emp = db
      .prepare('SELECT id FROM hr_employees WHERE id = ?')
      .get(meta.employee_id) as any;
    if (!emp) {
      return Response.json({ error: 'Selected employee was not found' }, { status: 400 });
    }

    const filename = (decoded.filename || 'document').slice(0, 200);

    // Store + audit in ONE transaction (everything inside is synchronous; the
    // buffer was fully resolved above — no await inside, per house rule).
    let docId = '';
    const create = db.transaction(() => {
      docId = storeHrDocument(db, {
        employee_id: meta.employee_id,
        doc_type: meta.doc_type,
        doc_number: meta.doc_number,
        issue_date: meta.issue_date,
        expiry_date: meta.expiry_date,
        filename,
        mime,
        buffer: decoded!.buf,
        uploadedBy: me.email,
      });
      // Audit the upload — metadata only, NEVER the bytes.
      logAuditEvent(db, {
        event_type: 'hr.document.upload',
        entity_type: 'hr_document',
        entity_id: docId,
        actor_email: me.email,
        after: {
          employee_id: meta.employee_id,
          doc_type: meta.doc_type,
          filename,
          mime,
          size_bytes: decoded!.buf.length,
          expiry_date: meta.expiry_date,
        },
      });
    });
    create();

    const document = db.prepare(`${DOC_META_SELECT} WHERE d.id = ?`).get(docId);
    return Response.json({ document });
  } catch (e) {
    console.error('[hr-documents:POST]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to upload document' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    // JSON { id, action } — exactly what /hr/documents sends (hr/bank shape).
    const body = (await request.json().catch(() => null)) as any;
    const id = s(body?.id);
    if (!id) return Response.json({ error: 'Document id is required' }, { status: 400 });
    const action = s(body?.action);
    if (action !== 'verify' && action !== 'reject') {
      return Response.json({ error: 'Action must be verify or reject' }, { status: 400 });
    }

    const db = getDb();
    // Metadata only — the bytes never enter the audit trail.
    const existing = db
      .prepare(
        `SELECT id, employee_id, doc_type, filename, mime, size_bytes,
                verify_status, verified_by
         FROM hr_documents WHERE id = ?`,
      )
      .get(id) as any;
    if (!existing) return Response.json({ error: 'Document not found' }, { status: 404 });

    const verify_status = action === 'verify' ? 'verified' : 'rejected';

    const decide = db.transaction(() => {
      db.prepare(
        'UPDATE hr_documents SET verify_status = ?, verified_by = ? WHERE id = ?',
      ).run(verify_status, me.email, id);
      logAuditEvent(db, {
        event_type: 'hr.document.verify',
        entity_type: 'hr_document',
        entity_id: id,
        actor_email: me.email,
        before: {
          verify_status: existing.verify_status,
          verified_by: existing.verified_by,
        },
        after: {
          action,
          verify_status,
          verified_by: me.email,
          employee_id: existing.employee_id,
          doc_type: existing.doc_type,
          filename: existing.filename,
        },
      });
    });
    decide();

    const document = db.prepare(`${DOC_META_SELECT} WHERE d.id = ?`).get(id);
    return Response.json({ document });
  } catch (e) {
    console.error('[hr-documents:PATCH]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update verification' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    // Accept ?id= or JSON { id } — the collection route owns delete (the only
    // [id] child is the byte-streaming /file endpoint).
    const sp = new URL(request.url).searchParams;
    let id = s(sp.get('id'));
    if (!id) {
      const body = (await request.json().catch(() => null)) as any;
      id = s(body?.id);
    }
    if (!id) return Response.json({ error: 'Document id is required' }, { status: 400 });

    const db = getDb();
    // Metadata only — the bytes never enter the audit trail.
    const row = db
      .prepare(
        `SELECT id, employee_id, doc_type, doc_number, filename, mime, size_bytes,
                verify_status, uploaded_by, created_at
         FROM hr_documents WHERE id = ?`,
      )
      .get(id) as any;
    if (!row) return Response.json({ error: 'Document not found' }, { status: 404 });

    // HARD delete (owner ruling): the vault row and its BLOB go together.
    // The audit event records filename + type so the deletion stays traceable.
    const drop = db.transaction(() => {
      db.prepare('DELETE FROM hr_documents WHERE id = ?').run(id);
      logAuditEvent(db, {
        event_type: 'hr.document.delete',
        entity_type: 'hr_document',
        entity_id: id,
        actor_email: me.email,
        before: {
          employee_id: row.employee_id,
          doc_type: row.doc_type,
          filename: row.filename,
          mime: row.mime,
          size_bytes: row.size_bytes,
          verify_status: row.verify_status,
          uploaded_by: row.uploaded_by,
          created_at: row.created_at,
        },
      });
    });
    drop();

    return Response.json({ ok: true });
  } catch (e) {
    console.error('[hr-documents:DELETE]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to delete document' }, { status: 500 });
  }
}
