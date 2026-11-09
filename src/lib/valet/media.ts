/**
 * VALET condition photos — PRIVATE BLOB store (the hr-files.ts / task-files.ts
 * pattern, own table). Spec §3 + §11:
 *   - up to 6 per car, each with a position and an optional damage note;
 *   - who captured it and when;
 *   - VALIDATED by content: the type is read from the file's first bytes (JPEG /
 *     PNG / WebP only), never trusted from the client's Content-Type;
 *   - capped in size HERE (the route pre-checks too; Next/nginx do not);
 *   - served only through an authenticated, outlet-scoped route with no-store
 *     caching — there is no public URL for a photo.
 */
import { createHash } from 'crypto';
import type { DB, Actor, OutletValet } from './core';
import { fail, newId, getSession, logEvent, withTx } from './core';
import { isHeld } from './states';
import { nowIso, cleanText } from './config';

export const PHOTO_MAX_BYTES = 2_000_000;
export const PHOTO_MAX_COUNT = 6;
export const PHOTO_POSITIONS = ['front', 'rear', 'left', 'right', 'interior', 'damage', 'other'] as const;

/** Sniff the real image type from the first bytes. null = not an allowed image. */
export function sniffImage(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export function storePhoto(
  db: DB, ov: OutletValet, actor: Actor, input: { session_id: string; position?: string; annotation?: string; data: Buffer },
  now: Date = new Date(),
) {
  const at = nowIso(now);
  if (!input.data.length) fail(400, 'empty', 'The photo is empty. Try again.');
  if (input.data.length > PHOTO_MAX_BYTES) fail(413, 'too_large', 'That photo is too large (max 2 MB). The app shrinks photos itself — try again.');
  const mime = sniffImage(input.data);
  if (!mime) fail(415, 'not_image', 'Only JPEG, PNG or WebP photos can be added.');
  return withTx(db, () => {
    const s = getSession(db, input.session_id, ov.outlet_id);
    if (!isHeld(s.state)) fail(409, 'closed', 'This car has already left.');
    const n = (db.prepare('SELECT COUNT(*) AS n FROM valet_media WHERE session_id = ? AND deleted_at IS NULL').get(s.id) as { n: number }).n;
    if (n >= PHOTO_MAX_COUNT) fail(409, 'limit', `This car already has ${PHOTO_MAX_COUNT} photos.`);
    const position = (PHOTO_POSITIONS as readonly string[]).includes(String(input.position)) ? String(input.position) : 'other';
    const id = newId();
    db.prepare(`INSERT INTO valet_media (id, outlet_id, session_id, position, annotation, mime, size_bytes, sha256, data, captured_by, captured_by_name, captured_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, ov.outlet_id, s.id, position, cleanText(input.annotation, 300), mime, input.data.length,
      createHash('sha256').update(input.data).digest('hex'), input.data, actor.id, actor.name, at);
    logEvent(db, { outlet_id: ov.outlet_id, session_id: s.id, event_type: 'photo.added', actor, at, data: { position, bytes: input.data.length } });
    return { media_id: id, count: n + 1 };
  });
}

export function listPhotos(db: DB, outletId: string, sessionId: string) {
  return db.prepare(`SELECT id, position, annotation, size_bytes, captured_by_name, captured_at, deleted_at IS NOT NULL AS deleted
                     FROM valet_media WHERE session_id = ? AND outlet_id = ? ORDER BY captured_at`).all(sessionId, outletId);
}

export function readPhoto(db: DB, outletId: string, mediaId: string): { mime: string; data: Buffer } | null {
  const r = db.prepare(`SELECT mime, data FROM valet_media WHERE id = ? AND outlet_id = ? AND deleted_at IS NULL AND data IS NOT NULL`)
    .get(String(mediaId || ''), outletId) as { mime: string; data: Buffer } | undefined;
  return r ?? null;
}
