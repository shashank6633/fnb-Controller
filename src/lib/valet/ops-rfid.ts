/**
 * VALET optional UHF RFID (spec §10, docs/valet/DESIGN.md §6b).
 *
 * An ADAPTER and a SIMULATOR, off by default. A reader is registered to ONE
 * outlet with a token shown once (SHA-256 stored). Each read is normalised
 * (event id, reader, EPC, antenna, zone, observed + received time) and judged:
 *   replay      same reader + event id seen before (storage-unique)
 *   stale       observed longer ago than the allowed clock skew
 *   future      observed further ahead than the allowed clock skew
 *   duplicate   same reader + EPC within the de-dupe window
 *   unknown_tag EPC not mapped to a key tag at this outlet
 *   invalid     malformed (not stored)
 *   accepted    an OBSERVATION: "keys for tag 07 seen near Key cabinet"
 * Nothing here changes a car, a pickup or custody; nothing authorises a handover
 * or identifies an owner. The outlet's rfid.mode decides what is accepted:
 * 'off' nothing, 'simulator' only the admin's simulator, 'live' only readers.
 */
import type { DB, Actor, OutletValet } from './core';
import { fail, logEvent, newId, withTx, loadOutletValet } from './core';
import { sha256, randomToken, rateLimit } from './credentials';
import { nowIso, cleanText, normTagCode } from './config';

export const RFID_MAX_BATCH = 200;
export const RFID_QUIET_MINUTES = 5;

export interface ReaderRow {
  id: string; outlet_id: string; name: string; zone_id: string | null; token_hash: string; enabled: number;
  created_at: string; last_seen_at: string | null; last_event_at: string | null; events_accepted: number; events_rejected: number;
}
export interface RawRead { event_id?: unknown; epc?: unknown; antenna?: unknown; observed_at?: unknown }
export type ReadStatus = 'accepted' | 'duplicate' | 'stale' | 'future' | 'replay' | 'unknown_tag' | 'invalid';

/** EPCs are hex; spaces/dashes from a label are ignored. '' = not a valid EPC. */
export function normEpc(v: unknown): string {
  const e = String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^[0-9A-F]{8,64}$/.test(e) ? e : '';
}

function readerOf(db: DB, outletId: string, readerId: string): ReaderRow {
  const r = db.prepare('SELECT * FROM valet_rfid_readers WHERE id = ? AND outlet_id = ?').get(String(readerId || ''), outletId) as ReaderRow | undefined;
  if (!r) fail(404, 'not_found', 'Reader not found at this outlet.');
  return r!;
}

export function readerHealth(r: Pick<ReaderRow, 'enabled' | 'last_seen_at'>, now: Date = new Date()): 'disabled' | 'never' | 'ok' | 'quiet' {
  if (!r.enabled) return 'disabled';
  if (!r.last_seen_at) return 'never';
  return now.getTime() - Date.parse(r.last_seen_at) <= RFID_QUIET_MINUTES * 60_000 ? 'ok' : 'quiet';
}

/** Admin: register a reader. The token is returned ONCE — it is not stored. */
export function registerReader(db: DB, ov: OutletValet, actor: Actor, input: { name?: string; zone_id?: string }, now: Date = new Date()) {
  const at = nowIso(now);
  const name = cleanText(input.name, 60);
  if (!name) fail(400, 'name_required', 'Give the reader a name, e.g. "Key cabinet".');
  const zone = input.zone_id ? db.prepare('SELECT id FROM valet_zones WHERE id = ? AND outlet_id = ?').get(String(input.zone_id), ov.outlet_id) as { id: string } | undefined : undefined;
  if (input.zone_id && !zone) fail(404, 'zone_not_found', 'That zone is not at this outlet.');
  const token = randomToken(32);
  const id = newId();
  db.prepare(`INSERT INTO valet_rfid_readers (id, outlet_id, name, zone_id, token_hash, enabled, created_at, created_by) VALUES (?,?,?,?,?,1,?,?)`)
    .run(id, ov.outlet_id, name, zone?.id ?? null, sha256(token), at, actor.id);
  logEvent(db, { outlet_id: ov.outlet_id, event_type: 'rfid.reader_registered', actor, at, data: { reader: name } });
  return { reader_id: id, token };
}

export function rotateReaderToken(db: DB, ov: OutletValet, actor: Actor, readerId: string, now: Date = new Date()) {
  const at = nowIso(now);
  const r = readerOf(db, ov.outlet_id, readerId);
  const token = randomToken(32);
  db.prepare('UPDATE valet_rfid_readers SET token_hash = ?, token_rotated_at = ? WHERE id = ?').run(sha256(token), at, r.id);
  logEvent(db, { outlet_id: ov.outlet_id, event_type: 'rfid.token_rotated', actor, at, data: { reader: r.name } });
  return { reader_id: r.id, token };
}

export function setReaderEnabled(db: DB, ov: OutletValet, actor: Actor, readerId: string, enabled: boolean, now: Date = new Date()) {
  const at = nowIso(now);
  const r = readerOf(db, ov.outlet_id, readerId);
  db.prepare('UPDATE valet_rfid_readers SET enabled = ?, disabled_at = ? WHERE id = ?').run(enabled ? 1 : 0, enabled ? null : at, r.id);
  logEvent(db, { outlet_id: ov.outlet_id, event_type: enabled ? 'rfid.reader_enabled' : 'rfid.reader_disabled', actor, at, data: { reader: r.name } });
  return { reader_id: r.id, enabled };
}

/** Head: record the RFID EPC printed on / encoded in a key tag ('' clears it). */
export function setTagEpc(db: DB, ov: OutletValet, actor: Actor, input: { tag_id?: string; epc?: unknown }, now: Date = new Date()) {
  const at = nowIso(now);
  const t = db.prepare('SELECT id, code FROM valet_tags WHERE id = ? AND outlet_id = ?').get(String(input.tag_id || ''), ov.outlet_id) as { id: string; code: string } | undefined;
  if (!t) fail(404, 'not_found', 'Tag not found at this outlet.');
  const raw = String(input.epc ?? '').trim();
  const epc = raw ? normEpc(raw) : '';
  if (raw && !epc) fail(400, 'bad_epc', 'An RFID EPC is 8–64 hexadecimal characters (0–9, A–F).');
  if (epc) {
    const other = db.prepare('SELECT code FROM valet_tags WHERE outlet_id = ? AND rfid_epc = ? AND id <> ?').get(ov.outlet_id, epc, t!.id) as { code: string } | undefined;
    if (other) fail(409, 'epc_in_use', `That EPC is already on tag ${other.code}.`);
  }
  db.prepare('UPDATE valet_tags SET rfid_epc = ?, updated_at = ? WHERE id = ?').run(epc || null, at, t!.id);
  logEvent(db, { outlet_id: ov.outlet_id, event_type: epc ? 'tag.rfid_set' : 'tag.rfid_cleared', actor, at, data: { tag: t!.code } });
  return { tag_id: t!.id, epc };
}

export function listReaders(db: DB, outletId: string, now: Date = new Date()) {
  return (db.prepare(`SELECT r.id, r.name, r.zone_id, z.name AS zone_name, r.enabled, r.created_at, r.last_seen_at, r.last_event_at,
                             r.events_accepted, r.events_rejected
                      FROM valet_rfid_readers r LEFT JOIN valet_zones z ON z.id = r.zone_id
                      WHERE r.outlet_id = ? ORDER BY r.enabled DESC, r.name`).all(outletId) as (ReaderRow & { zone_name: string | null })[])
    .map(r => ({ ...r, health: readerHealth(r, now) }));
}

export function recentReads(db: DB, outletId: string, limit = 30) {
  return db.prepare(`SELECT e.received_at, e.observed_at, e.source, e.event_id, e.epc, e.antenna, e.status, r.name AS reader_name, t.code AS tag_code
                     FROM valet_rfid_events e JOIN valet_rfid_readers r ON r.id = e.reader_id LEFT JOIN valet_tags t ON t.id = e.tag_id
                     WHERE e.outlet_id = ? ORDER BY e.received_at DESC LIMIT ?`).all(outletId, limit);
}

/**
 * Judge and record a batch of reads from one reader. Every verdict is returned;
 * all but 'invalid' and 'replay' are stored (replay is the storage-unique key).
 */
export function ingestReads(db: DB, ov: OutletValet, reader: ReaderRow, reads: RawRead[], source: 'reader' | 'simulator', now: Date = new Date()) {
  const at = nowIso(now);
  const cfg = ov.cfg.rfid;
  if (!Array.isArray(reads)) fail(400, 'bad_batch', 'Send {"events": [...]}.');
  if (reads.length > RFID_MAX_BATCH) fail(413, 'batch_too_large', `At most ${RFID_MAX_BATCH} reads per request.`);
  return withTx(db, () => {
    const results: { event_id: string; status: ReadStatus }[] = [];
    let accepted = 0, rejected = 0;
    for (const raw of reads) {
      const eventId = cleanText(raw?.event_id, 80);
      const epc = normEpc(raw?.epc);
      const observed = Date.parse(String(raw?.observed_at ?? ''));
      if (!eventId || !epc || !Number.isFinite(observed)) { results.push({ event_id: eventId, status: 'invalid' }); rejected++; continue; }
      if (db.prepare('SELECT 1 FROM valet_rfid_events WHERE reader_id = ? AND event_id = ?').get(reader.id, eventId)) {
        results.push({ event_id: eventId, status: 'replay' }); rejected++; continue;
      }
      const observedIso = new Date(observed).toISOString();
      const skewMs = cfg.max_skew_seconds * 1000;
      let status: ReadStatus;
      let tag: { id: string } | undefined;
      let sessionId: string | null = null;
      if (observed < now.getTime() - skewMs) status = 'stale';
      else if (observed > now.getTime() + skewMs) status = 'future';
      else if (db.prepare(`SELECT 1 FROM valet_rfid_events WHERE reader_id = ? AND epc = ? AND status = 'accepted'
                           AND observed_at >= ? AND observed_at <= ?`).get(reader.id, epc,
        new Date(observed - cfg.dedupe_seconds * 1000).toISOString(), new Date(observed + cfg.dedupe_seconds * 1000).toISOString())) status = 'duplicate';
      else {
        tag = db.prepare('SELECT id FROM valet_tags WHERE outlet_id = ? AND rfid_epc = ?').get(ov.outlet_id, epc) as { id: string } | undefined;
        if (!tag) status = 'unknown_tag';
        else {
          status = 'accepted';
          sessionId = (db.prepare(`SELECT id FROM valet_vehicle_sessions WHERE tag_id = ? AND state NOT IN ('HANDED_OVER','VOIDED')`).get(tag.id) as { id: string } | undefined)?.id ?? null;
        }
      }
      db.prepare(`INSERT INTO valet_rfid_events (id, outlet_id, reader_id, source, event_id, epc, antenna, zone_id, observed_at, received_at, status, tag_id, session_id)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(newId(), ov.outlet_id, reader.id, source, eventId, epc, cleanText(raw?.antenna, 20),
        reader.zone_id, observedIso, at, status, status === 'accepted' ? tag!.id : null, sessionId);
      results.push({ event_id: eventId, status });
      if (status === 'accepted') accepted++; else rejected++;
    }
    db.prepare(`UPDATE valet_rfid_readers SET last_seen_at = ?, last_event_at = CASE WHEN ? > 0 THEN ? ELSE last_event_at END,
                events_accepted = events_accepted + ?, events_rejected = events_rejected + ? WHERE id = ?`)
      .run(at, reads.length, at, accepted, rejected, reader.id);
    return { accepted, rejected, results };
  });
}

/**
 * The HTTP intake: a reader posts {events: [...]} (an empty list is a heartbeat)
 * with `Authorization: Bearer <token>`. An unknown or disabled token gets the
 * same 401; an outlet not in 'live' mode refuses everything.
 */
export function ingestHttp(db: DB, authorization: string, body: Record<string, unknown>, now: Date = new Date()) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(String(authorization || '').trim());
  const reader = m ? db.prepare('SELECT * FROM valet_rfid_readers WHERE token_hash = ?').get(sha256(m[1])) as ReaderRow | undefined : undefined;
  if (!reader || !reader.enabled) fail(401, 'reader_unauthorised', 'Unknown or disabled reader.');
  const ov = loadOutletValet(db, reader!.outlet_id);
  if (!ov) fail(401, 'reader_unauthorised', 'Unknown or disabled reader.');
  if (ov!.cfg.rfid.mode !== 'live') fail(409, 'rfid_not_live', 'RFID is not switched to live at this outlet.');
  if (!rateLimit(db, `rfid:${reader!.id}`, 120, 60, now)) fail(429, 'rate_limited', 'Too many requests from this reader.');
  return ingestReads(db, ov!, reader!, (body.events ?? []) as RawRead[], 'reader', now);
}

/**
 * Admin's simulator — outlet must be in 'simulator' mode, so simulated reads
 * never mix with real ones. Goes through the SAME judging as a real reader.
 * `event_id` and `age_seconds` let the owner see replay / stale refusals.
 */
export function simulateRead(
  db: DB, ov: OutletValet, actor: Actor,
  input: { reader_id?: string; tag_code?: string; epc?: string; antenna?: string; event_id?: string; age_seconds?: unknown },
  now: Date = new Date(),
) {
  if (ov.cfg.rfid.mode !== 'simulator') fail(409, 'not_simulator', 'Switch this outlet\'s RFID to "simulator" first (Valet Settings → Rules). Simulated reads are refused in live mode.');
  const reader = readerOf(db, ov.outlet_id, String(input.reader_id || ''));
  if (!reader.enabled) fail(409, 'reader_disabled', 'That reader is disabled.');
  let epc = normEpc(input.epc);
  if (!epc && input.tag_code) {
    const t = db.prepare('SELECT rfid_epc FROM valet_tags WHERE outlet_id = ? AND code_norm = ?').get(ov.outlet_id, normTagCode(input.tag_code)) as { rfid_epc: string | null } | undefined;
    if (!t) fail(404, 'tag_not_found', 'No such tag at this outlet.');
    if (!t!.rfid_epc) fail(409, 'no_epc', 'That tag has no RFID EPC yet — set one in Key tags first.');
    epc = t!.rfid_epc!;
  }
  if (!epc) fail(400, 'bad_epc', 'Give a tag number or an EPC.');
  const age = Math.max(0, Math.min(86_400, Math.round(Number(input.age_seconds) || 0)));
  const out = ingestReads(db, ov, reader, [{
    event_id: cleanText(input.event_id, 80) || `sim-${newId()}`, epc, antenna: input.antenna || '1',
    observed_at: new Date(now.getTime() - age * 1000).toISOString(),
  }], 'simulator', now);
  logEvent(db, { outlet_id: ov.outlet_id, event_type: 'rfid.simulated', actor, at: nowIso(now), data: { reader: reader.name, status: out.results[0]?.status } });
  return out;
}

/**
 * What RFID last saw of a tag — for the car drawer. An observation, labelled
 * as such: where, when, how many reads in the last 10 minutes. Never a spot.
 */
export function tagSighting(db: DB, tagId: string | null, now: Date = new Date()) {
  if (!tagId) return null;
  const last = db.prepare(`SELECT e.observed_at, e.source, r.name AS reader_name, z.name AS zone_name
                           FROM valet_rfid_events e JOIN valet_rfid_readers r ON r.id = e.reader_id LEFT JOIN valet_zones z ON z.id = e.zone_id
                           WHERE e.tag_id = ? AND e.status = 'accepted' ORDER BY e.observed_at DESC LIMIT 1`).get(tagId) as
    { observed_at: string; source: string; reader_name: string; zone_name: string | null } | undefined;
  if (!last) return null;
  const reads = (db.prepare(`SELECT COUNT(*) AS n FROM valet_rfid_events WHERE tag_id = ? AND status = 'accepted' AND observed_at >= ?`)
    .get(tagId, new Date(now.getTime() - 10 * 60_000).toISOString()) as { n: number }).n;
  return { ...last, reads_10min: reads, simulated: last.source === 'simulator' };
}
