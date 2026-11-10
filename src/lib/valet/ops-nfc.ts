/**
 * VALET NFC (spec §10, docs/valet/DESIGN.md §6b).
 *
 * An NFC sticker or card holds ONE public HTTPS URL and nothing else:
 *   - venue check-in card      /valet-pass?e=<entry token>          (any guest)
 *   - table / bill-folder card /valet-pass?e=<entry token>&paper=1  (any guest)
 *   - key-tag sticker          /valet/attendant?nfc=<nfc_ref>       (signed-in valet staff)
 * The key-tag reference is an opaque random ADDRESS, not a credential: resolving
 * it needs a staff sign-in AND an assignment to the tag's outlet, and a car is
 * still released only by the guest's code / claim code / head recovery. Static
 * NFC contents can be copied — re-issuing the reference kills the old sticker.
 *
 * Phones open these URLs with their own NFC (iPhone and Android). Web NFC
 * (Android Chrome) is an optional staff convenience in the browser; nothing
 * here depends on it.
 */
import type { SessionUser } from '@/lib/auth';
import type { DB, Actor, OutletValet } from './core';
import { fail, logEvent, requireStaff, withTx, ValetError } from './core';
import { raiseAlert } from './ops-pickup';
import { crockfordCode } from './credentials';
import { nowIso, cleanText } from './config';

export const NFC_REF_LEN = 12;
export const keyTagPath = (ref: string) => `/valet/attendant?nfc=${encodeURIComponent(ref)}`;

interface TagRow { id: string; outlet_id: string; code: string; status: string; nfc_ref: string | null; nfc_chip_serial: string | null }

function tagOf(db: DB, outletId: string, tagId: string): TagRow {
  const t = db.prepare('SELECT id, outlet_id, code, status, nfc_ref, nfc_chip_serial FROM valet_tags WHERE id = ? AND outlet_id = ?')
    .get(String(tagId || ''), outletId) as TagRow | undefined;
  if (!t) fail(404, 'not_found', 'Tag not found at this outlet.');
  return t!;
}

/** Give a key tag an NFC link, or re-issue it (the old sticker stops working). */
export function issueNfcRef(db: DB, ov: OutletValet, actor: Actor, tagId: string, now: Date = new Date()) {
  const at = nowIso(now);
  return withTx(db, () => {
    const t = tagOf(db, ov.outlet_id, tagId);
    if (t.status === 'retired' || t.status === 'lost') fail(409, 'tag_inactive', `Tag ${t.code} is ${t.status} — give the new tag a link instead.`);
    let ref = '';
    for (let i = 0; i < 10 && !ref; i++) {
      const c = crockfordCode(NFC_REF_LEN);
      if (!db.prepare('SELECT 1 FROM valet_tags WHERE nfc_ref = ?').get(c)) ref = c;
    }
    if (!ref) fail(500, 'ref_exhausted', 'Could not make a new link. Try again.');
    db.prepare('UPDATE valet_tags SET nfc_ref = ?, nfc_issued_at = ?, nfc_chip_serial = NULL, updated_at = ? WHERE id = ?').run(ref, at, at, t.id);
    logEvent(db, { outlet_id: ov.outlet_id, event_type: t.nfc_ref ? 'tag.nfc_reissued' : 'tag.nfc_issued', actor, at, data: { tag: t.code } });
    return { tag_id: t.id, tag_code: t.code, nfc_ref: ref, path: keyTagPath(ref), reissued: !!t.nfc_ref };
  });
}

/** Remove a key tag's NFC link (sticker removed / tag out of use). */
export function clearNfcRef(db: DB, ov: OutletValet, actor: Actor, tagId: string, now: Date = new Date()) {
  const at = nowIso(now);
  const t = tagOf(db, ov.outlet_id, tagId);
  if (!t.nfc_ref) return { tag_id: t.id, cleared: false };
  db.prepare('UPDATE valet_tags SET nfc_ref = NULL, nfc_issued_at = NULL, nfc_chip_serial = NULL, updated_at = ? WHERE id = ?').run(at, t.id);
  logEvent(db, { outlet_id: ov.outlet_id, event_type: 'tag.nfc_cleared', actor, at, data: { tag: t.code } });
  return { tag_id: t.id, cleared: true };
}

/** Every key-tag link of an outlet — for printing / bulk writing with a phone app. */
export function nfcLinks(db: DB, outletId: string) {
  return (db.prepare(`SELECT id, code, status, nfc_ref, nfc_issued_at FROM valet_tags
                      WHERE outlet_id = ? AND nfc_ref IS NOT NULL ORDER BY length(code_norm), code_norm`).all(outletId) as
    { id: string; code: string; status: string; nfc_ref: string; nfc_issued_at: string }[])
    .map(r => ({ ...r, path: keyTagPath(r.nfc_ref) }));
}

/**
 * A staff phone opened a key-tag sticker (OS tap) or read one with Web NFC.
 * Resolves the reference to the tag and, if the venue holds a car on it, that
 * car — for staff of the tag's outlet only. Anyone else learns nothing beyond
 * "not available to you". `chipSerial` (Web NFC only) feeds the copy check.
 */
export function resolveNfc(db: DB, user: SessionUser | null, ref: string, chipSerial: string, now: Date = new Date()) {
  const at = nowIso(now);
  const r = String(ref || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const t = r.length === NFC_REF_LEN
    ? db.prepare('SELECT id, outlet_id, code, status, nfc_ref, nfc_chip_serial FROM valet_tags WHERE nfc_ref = ?').get(r) as TagRow | undefined
    : undefined;
  // Same answer for "no such link" and "not your outlet": someone holding a
  // sticker cannot tell a live link from a dead one. (Signed-out → 401 first.)
  const hidden = () => fail(404, 'nfc_unknown', 'This key tag link is not available — it may have been re-issued, or belong to an outlet you do not work at.');
  if (!user) fail(401, 'unauthenticated', 'Sign in.');
  if (!t) hidden();
  let ov: OutletValet;
  try { ov = requireStaff(db, user, t!.outlet_id, 'attendant').ov; }
  catch (e) { if (e instanceof ValetError && e.status === 403) hidden(); throw e; }
  let copyWarning = false;
  const serial = cleanText(chipSerial, 64).toUpperCase();
  if (serial) {
    if (!t!.nfc_chip_serial) db.prepare('UPDATE valet_tags SET nfc_chip_serial = ? WHERE id = ?').run(serial, t!.id);
    else if (t!.nfc_chip_serial !== serial) {
      copyWarning = true;
      raiseAlert(db, ov.outlet_id, null, null, 'nfc_copy', `Tag ${t!.code}: its NFC link was read from a different chip — possible copied sticker. Re-issue the link.`, `nfc_copy:${t!.id}`, at);
    }
  }
  const s = db.prepare(`SELECT id, state FROM valet_vehicle_sessions WHERE tag_id = ? AND state NOT IN ('HANDED_OVER','VOIDED')`).get(t!.id) as
    { id: string; state: string } | undefined;
  return { outlet_id: ov.outlet_id, tag_id: t!.id, tag_code: t!.code, tag_status: t!.status, session_id: s?.id ?? null, state: s?.state ?? null, copy_warning: copyWarning };
}
