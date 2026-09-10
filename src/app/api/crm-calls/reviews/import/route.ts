/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import {
  RAW_PAYLOAD_MAX_BYTES, REVIEW_SOURCES, SourceNotConfiguredError,
  ensureReviewSchema, reviewSource, runIngest,
  type RawDocument, type ReviewSourceKey,
} from '@/lib/reviews';
import { decodeUpload, detectKind } from '@/lib/reviews/parse';

/**
 * CRM — Google Reviews import (POST /api/crm-calls/reviews/import). ADMIN ONLY.
 *
 * The one writer the page can reach. Everything it does is
 * `runIngest()` — collect from a source, archive the raw bytes, parse, upsert —
 * and everything it returns is that call's own IngestResult. This route adds no
 * counting of its own, because the counters the owner reads after an import
 * (added / already known / changed / refused) have to be the same numbers the
 * engine's suite asserts.
 *
 * ── WHY ADMIN AND NOT MANAGEMENT ────────────────────────────────────────────
 * The report itself is mgmtOnly. Writing to it is not the same act: an import
 * rewrites the venue's own review history, and a wrong file — the neighbouring
 * outlet's export, a spreadsheet with US date order — lands as real rows under
 * the same identity keys. requireRole('admin') matches every other bulk-import
 * door in this app (unit-audit, liquor brand-map, biometric).
 *
 * ── IDEMPOTENT BY CONSTRUCTION ──────────────────────────────────────────────
 * Re-importing the same export changes nothing: every write is an upsert on
 * (location_key, identity_key). That is what makes "what was added vs what we
 * already knew" a truthful thing to show — `unchanged` is not a rounding error,
 * it is the count of rows the file re-stated identically.
 *
 * ── OVERSIZE FILES ARE REFUSED, NOT TRUNCATED ───────────────────────────────
 * The engine stores a document over RAW_PAYLOAD_MAX_BYTES truncated-and-flagged
 * so provenance survives. That is right for an API page. It is wrong for an
 * upload: truncating a reviews.json at 8 MB produces invalid JSON, so the whole
 * document then fails to parse and the owner reads "unparseable" for a file
 * that is merely too big. Refused here with the actual size, which is the
 * message he can act on.
 */

export const dynamic = 'force-dynamic';

/** One upload can carry several files (Takeout splits large exports). */
const MAX_DOCUMENTS = 20;

function isSource(v: string): v is ReviewSourceKey {
  return (REVIEW_SOURCES as readonly string[]).includes(v);
}

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const db = ensureReviewSchema(getDb());
  const ct = req.headers.get('content-type') || '';

  let sourceKey = '';
  let locationKey = '';
  let label = '';
  let dateOrderRaw = '';
  let expectedRaw = '';
  const documents: RawDocument[] = [];
  /** What decodeUpload() decided per file, echoed back so a CP1252 export is
   *  visible to the person importing rather than only to the database. */
  const decodedNotes: Array<{ file: string; encoding: string; fell_back: boolean; replacement_chars: number }> = [];

  try {
    if (ct.includes('multipart/form-data')) {
      const form = await req.formData();
      sourceKey = String(form.get('source') || '').trim();
      locationKey = String(form.get('location') || '').trim();
      label = String(form.get('label') || '').trim();
      dateOrderRaw = String(form.get('date_order') || '').trim();
      expectedRaw = String(form.get('expected_total') || '').trim();

      const files = form.getAll('file').filter(f => typeof f === 'object' && f !== null) as File[];
      for (const f of files) {
        if (f.size > RAW_PAYLOAD_MAX_BYTES) {
          return Response.json({
            error: `“${f.name}” is ${(f.size / 1048576).toFixed(1)} MB. The limit for one file is ` +
                   `${(RAW_PAYLOAD_MAX_BYTES / 1048576).toFixed(0)} MB — split the export and import the parts ` +
                   `separately. Importing the same review twice is safe; it will be counted as already known.`,
          }, { status: 413 });
        }
        // NOT `await f.text()`. That is UTF-8-only and silently substitutes
        // U+FFFD for every byte it cannot read, so Excel's CP1252 "CSV" landed
        // as `Priy\uFFFD Reddy` with zero errors — stored wrong, archived
        // wrong (so replay could never repair it), and keyed wrong, which made
        // a corrected re-import DUPLICATE the reviews instead of fixing them.
        // decodeUpload() reads the actual bytes and says what it decided.
        const decoded = decodeUpload(new Uint8Array(await f.arrayBuffer()));
        decodedNotes.push({
          file: f.name || 'upload',
          encoding: decoded.encoding,
          fell_back: decoded.fell_back,
          replacement_chars: decoded.replacement_chars,
        });
        documents.push({
          kind: detectKind(decoded.text), payload: decoded.text, label: f.name || 'upload',
        });
      }

      // A pasted block can accompany files, or stand alone.
      const pasted = String(form.get('text') || '');
      if (pasted.trim()) {
        documents.push({ kind: detectKind(pasted), payload: pasted, label: label || 'pasted text' });
      }
    } else {
      const body = await req.json().catch(() => ({} as any));
      sourceKey = String(body.source || '').trim();
      locationKey = String(body.location || '').trim();
      label = String(body.label || '').trim();
      dateOrderRaw = String(body.date_order || '').trim();
      expectedRaw = body.expected_total === null || body.expected_total === undefined
        ? '' : String(body.expected_total).trim();

      const text = typeof body.text === 'string' ? body.text : '';
      if (text.trim()) {
        if (Buffer.byteLength(text, 'utf8') > RAW_PAYLOAD_MAX_BYTES) {
          return Response.json({ error: 'The pasted text is larger than the 8 MB limit for one document.' }, { status: 413 });
        }
        documents.push({ kind: detectKind(text), payload: text, label: label || 'pasted text' });
      }
    }
  } catch {
    return Response.json({ error: "Couldn't read the upload." }, { status: 400 });
  }

  if (!isSource(sourceKey)) {
    return Response.json({
      error: `Unknown source “${sourceKey}”. Expected one of: ${REVIEW_SOURCES.join(', ')}.`,
    }, { status: 400 });
  }
  if (documents.length > MAX_DOCUMENTS) {
    return Response.json({ error: `Too many files in one import (${documents.length}); the limit is ${MAX_DOCUMENTS}.` }, { status: 400 });
  }

  const source = reviewSource(sourceKey, db);
  if (source.kind === 'manual' && documents.length === 0) {
    return Response.json({ error: 'Nothing to import — choose a file or paste some rows.' }, { status: 400 });
  }

  const expectedTotal = expectedRaw === '' ? null : Number(expectedRaw);
  if (expectedTotal !== null && (!Number.isFinite(expectedTotal) || expectedTotal < 0)) {
    return Response.json({ error: 'The listing total must be a whole number, or left blank.' }, { status: 400 });
  }

  const dateOrder = dateOrderRaw === 'mdy' ? 'mdy' : 'dmy';

  try {
    const result = await runIngest({
      source: sourceKey,
      db,
      locationKey,
      actor: auth.user.email || auth.user.name || auth.user.id,
      label: label || (documents[0]?.label ?? source.label),
      dateOrder,
      expectedTotal: expectedTotal === null ? null : Math.round(expectedTotal),
      collect: { documents },
    });

    return Response.json({
      ok: true,
      source: sourceKey,
      source_label: source.label,
      documents: documents.length,
      /** Per-file encoding verdicts. `fell_back: true` means the file was NOT
       *  UTF-8 and was read as windows-1252 (Excel's default) — worth telling
       *  the owner, because it is the one case where a character could still be
       *  wrong. `replacement_chars > 0` means characters were already lost
       *  before the upload reached us. */
      encodings: decodedNotes,
      // Verbatim from the engine. `inserted` is what this file added, `unchanged`
      // is what it re-stated identically, `updated` is what it changed on rows we
      // already had (an edited review, or a reply that arrived since).
      result,
    });
  } catch (e: any) {
    if (e instanceof SourceNotConfiguredError) {
      // Not a fault. The owner has paperwork outstanding, and the list of it is
      // the useful part of this response — a 500 with a stack trace would be a
      // lie about whose problem it is.
      return Response.json({
        error: e.message,
        not_configured: true,
        prerequisites: e.prerequisites,
        status_detail: source.status(),
      }, { status: 409 });
    }
    const message = String(e?.message || e).slice(0, 600);
    return Response.json({ error: message || 'The import failed.' }, { status: 500 });
  }
}
