/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  canManageFssaiCa, fssaiToday, fssaiRecordStatusMeta, fssaiPestSeverityMeta,
  FSSAI_PEST_TYPES, FSSAI_PEST_EVIDENCE_KINDS, FSSAI_PEST_SEVERITIES, FSSAI_CA_SEVERITIES,
} from '@/lib/fssai';
import { requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAppAudit, str } from '@/lib/fssai-server';
import {
  voidP6Record, raiseP6CorrectiveAction, nextP6CaNumber, p6ConstraintMessage,
  isoDateOrBlank, isoStampOrBlank, intOrNull,
} from '../../p6-shared';
import {
  attachPestFile, voidPestFile, pestFilesFor, canVoidPestFiles, PEST_ACTIVE_FILES_PER_RECORD,
} from '../_pest/files';

/**
 * PEST CONTROL — WHAT OUR OWN STAFF SAW BETWEEN VISITS (owner §7).
 * /api/fssai/pest/sightings
 *
 * ── THE HALF THAT MAKES THE REGISTER CREDIBLE ───────────────────────────────
 * A pest file containing only contractor reports says that nobody in the kitchen
 * was watching. This is the other half, and its single most important property
 * is that it is OPEN TO EVERY SIGNED-IN USER. A porter who sees droppings behind
 * the dry store at eleven at night must be able to file it from where he is
 * standing, on his own phone, in four taps. A screen that required a manager
 * would be a screen that recorded nothing — which is worse than no screen,
 * because an empty sightings log is read as "no pests".
 *
 * `evidence_kind` therefore matters as much as `pest_type`: droppings, gnaw
 * marks, smears and a glue-board catch are what staff actually find, and a log
 * that only accepts a live sighting records almost nothing.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 * There is no deduplication rule and no "one sighting per area per shift" index.
 * Two people really can see two rats, and a schema that refused the second would
 * be hiding the infestation it exists to reveal. Two rows is the honest record;
 * the SEVERITY field ('One-off' / 'Recurring' / 'Infestation') is how the file
 * says the difference.
 *
 * Nor does a sighting raise a corrective action by itself. It needs an owner and
 * a date that only a person can choose, and this project has been bitten four
 * times by a guard that reads correctly and never fires — an auto-raised action
 * with nobody's name on it is exactly that shape. The response tells the screen
 * to push for one (`advice`); it does not invent it.
 *
 * A photograph attached by mistake is VOIDED, never stripped ('void_file', or
 * its old name 'remove_file'): it must be on THIS sighting, and it stays on the
 * record marked void with its reason — decision in ../_pest/files.ts. Activity
 * found on the monitoring sheet (/api/fssai/pest/checks) arrives here as a
 * sighting too, so a pest seen anywhere is in one register.
 *
 *   GET  ?id=<id>                                       one sighting + its photographs
 *   GET  [?from=&to=&pest_type=&severity=&status=&department_id=&device_id=&open=1&q=]
 *   POST { action: 'create' | 'update' | 'close' | 'link_service' | 'void'
 *                 | 'attach' | 'void_file' | 'remove_file' | 'raise_ca', … }
 *
 * NO DELETE (§19).
 */
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 300;

const SELECT = `
  SELECT g.*,
         d.name  AS department_name,
         dev.code AS device_code, dev.device_kind AS device_kind, dev.location_label AS device_location,
         s.service_no AS service_no, s.business_date AS service_date, s.status AS service_status,
         ca.ca_number AS ca_number, ca.status AS ca_status, ca.due_date AS ca_due_date,
         ca.owner_email AS ca_owner_email, ca.severity AS ca_severity
    FROM fssai_pest_sightings g
    LEFT JOIN departments        d   ON d.id   = g.department_id
    LEFT JOIN fssai_pest_devices dev ON dev.id = g.device_id
    LEFT JOIN fssai_pest_services s  ON s.id   = g.service_id
    LEFT JOIN fssai_corrective_actions ca ON ca.id = g.ca_id`;

function shape(row: any, files: any[] = []) {
  const voided = !!str(row.voided_at);
  const statusMeta = fssaiRecordStatusMeta(voided ? 'void' : str(row.status));
  const sev = fssaiPestSeverityMeta(row.severity);
  return {
    id: String(row.id),
    business_date: str(row.business_date),
    sighted_at: str(row.sighted_at),
    pest_type: str(row.pest_type),
    pest_type_label: FSSAI_PEST_TYPES.find((p) => p.key === str(row.pest_type))?.label || str(row.pest_type),
    evidence_kind: str(row.evidence_kind),
    evidence_kind_label: FSSAI_PEST_EVIDENCE_KINDS.find((k) => k.key === str(row.evidence_kind))?.label || str(row.evidence_kind),
    // NULL means NOT COUNTED and must never render as 0. "0 cockroaches seen" is
    // a different statement from "nobody counted them", and on a pest log the
    // difference is the whole report.
    count_seen: intOrNull(row.count_seen),
    severity: str(row.severity),
    severity_label: sev.label,
    severity_color: sev.color,
    location_label: str(row.location_label),
    department_id: str(row.department_id),
    department_name: str(row.department_name),
    device_id: str(row.device_id),
    device: str(row.device_id) && str(row.device_code)
      ? { id: str(row.device_id), code: str(row.device_code), kind: str(row.device_kind), location_label: str(row.device_location) }
      : null,
    run_id: str(row.run_id),
    response_id: str(row.response_id),
    service_id: str(row.service_id),
    service: str(row.service_id) && str(row.service_no)
      ? { id: str(row.service_id), service_no: str(row.service_no), business_date: str(row.service_date), status: str(row.service_status) }
      : null,
    description: str(row.description),
    immediate_action: str(row.immediate_action),
    ca_id: str(row.ca_id),
    ca: str(row.ca_id) && str(row.ca_number)
      ? {
        id: str(row.ca_id), ca_number: str(row.ca_number), status: str(row.ca_status),
        due_date: str(row.ca_due_date), owner_email: str(row.ca_owner_email), severity: str(row.ca_severity),
      }
      : null,
    status: voided ? 'void' : str(row.status),
    status_label: statusMeta.label,
    status_color: statusMeta.color,
    reported_by: str(row.reported_by),
    reported_name: str(row.reported_name),
    closed_at: str(row.closed_at),
    closed_by: str(row.closed_by),
    voided_at: str(row.voided_at),
    voided_by: str(row.voided_by),
    void_reason: str(row.void_reason),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    is_open: !voided && str(row.status) !== 'verified' && !str(row.closed_at),
    files,
    /** Active files only — a voided photograph stays on the record but frees its place. */
    active_file_count: files.filter((f: any) => !f.is_void).length,
    file_limit: PEST_ACTIVE_FILES_PER_RECORD,
  };
}

/**
 * May this person edit or photograph THIS sighting?
 *
 * The reporter, while it is still open — because the photograph is usually taken
 * two seconds after the row is saved, and a staff member who cannot attach it is
 * a staff member who will stop filing. Management always. Nobody once it is
 * closed or voided: at that point somebody else has read it.
 */
function canAmend(me: any, row: any): boolean {
  if (str(row.voided_at)) return false;
  if (canManageFssaiCa(me)) return true;
  if (str(row.closed_at)) return false;
  const mine = String(me.email || '').trim().toLowerCase();
  return !!mine && str(row.reported_by).trim().toLowerCase() === mine;
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const url = new URL(request.url);
    const today = fssaiToday();

    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(`${SELECT} WHERE g.id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That sighting is no longer in the register.' }, { status: 404 });
      const files = pestFilesFor(db, 'fssai_pest_sightings', [id], { withImage: true }).get(id) || [];
      return Response.json({
        sighting: shape(row, files),
        can_amend: canAmend(me, row),
        can_close: canManageFssaiCa(me),
        can_void: canManageFssaiCa(me),
        can_void_files: canVoidPestFiles(me),
        me: me.email,
        today,
      });
    }

    const where: string[] = [];
    const args: any[] = [];

    const from = isoDateOrBlank(url.searchParams.get('from'));
    const to = isoDateOrBlank(url.searchParams.get('to'));
    if (from) { where.push('g.business_date >= ?'); args.push(from); }
    if (to) { where.push('g.business_date <= ?'); args.push(to); }

    const pestType = str(url.searchParams.get('pest_type'));
    if (pestType) {
      if (!FSSAI_PEST_TYPES.some((p) => p.key === pestType)) {
        return Response.json({ error: `"${pestType}" is not a pest this register knows.` }, { status: 400 });
      }
      where.push('g.pest_type = ?'); args.push(pestType);
    }

    const severity = str(url.searchParams.get('severity'));
    if (severity) {
      if (!FSSAI_PEST_SEVERITIES.some((s) => s.key === severity)) {
        return Response.json({ error: `"${severity}" is not a severity.` }, { status: 400 });
      }
      where.push('g.severity = ?'); args.push(severity);
    }

    const status = str(url.searchParams.get('status'));
    if (status === 'void') where.push(`g.voided_at <> ''`);
    else if (status && status !== 'all') { where.push(`g.status = ? AND g.voided_at = ''`); args.push(status); }

    if (str(url.searchParams.get('open')) === '1') {
      where.push(`g.voided_at = '' AND g.closed_at = ''`);
    }

    const deptId = str(url.searchParams.get('department_id'));
    if (deptId) { where.push('g.department_id = ?'); args.push(deptId); }

    const deviceId = str(url.searchParams.get('device_id'));
    if (deviceId) { where.push('g.device_id = ?'); args.push(deviceId); }

    const q = str(url.searchParams.get('q'));
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      where.push(`(lower(g.location_label) LIKE ? OR lower(g.description) LIKE ?
                   OR lower(g.immediate_action) LIKE ? OR lower(g.reported_name) LIKE ?
                   OR lower(g.reported_by) LIKE ?)`);
      args.push(like, like, like, like, like);
    }

    const rows = db.prepare(
      `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
       ORDER BY g.business_date DESC, g.sighted_at DESC, g.created_at DESC, g.rowid DESC
       LIMIT ${LIST_LIMIT + 1}`,
    ).all(...args) as any[];
    const truncated = rows.length > LIST_LIMIT;
    const page = truncated ? rows.slice(0, LIST_LIMIT) : rows;
    const files = pestFilesFor(db, 'fssai_pest_sightings', page.map((r) => String(r.id)));

    const counts = db.prepare(
      `SELECT
         SUM(CASE WHEN voided_at = '' AND closed_at = '' THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN voided_at = '' AND closed_at <> '' THEN 1 ELSE 0 END) AS closed,
         SUM(CASE WHEN voided_at = '' AND severity = 'high' THEN 1 ELSE 0 END) AS infestation,
         SUM(CASE WHEN voided_at = '' AND business_date >= ? THEN 1 ELSE 0 END) AS last_30_days,
         SUM(CASE WHEN voided_at <> '' THEN 1 ELSE 0 END) AS void,
         COUNT(*) AS all_rows
       FROM fssai_pest_sightings`,
    ).get(
      // 30 days back, computed in SQL-free JS so the window is explicit in the
      // response rather than hidden in a date function.
      new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    ) as any;

    return Response.json({
      sightings: page.map((r) => shape(r, files.get(String(r.id)) || [])),
      counts: {
        open: Number(counts?.open) || 0,
        closed: Number(counts?.closed) || 0,
        infestation: Number(counts?.infestation) || 0,
        last_30_days: Number(counts?.last_30_days) || 0,
        void: Number(counts?.void) || 0,
        all: Number(counts?.all_rows) || 0,
      },
      can_report: true,
      can_close: canManageFssaiCa(me),
      can_void: canManageFssaiCa(me),
      is_management: isManagement(me),
      me: me.email,
      today,
      truncated,
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/pest/sightings failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the sightings register' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;

  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { body = {}; }
  const action = str(body.action);

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const today = fssaiToday();

    /* ── CREATE — open to EVERY signed-in user, deliberately ─────────────── */
    if (action === 'create') {
      const pestType = str(body.pest_type);
      if (!FSSAI_PEST_TYPES.some((p) => p.key === pestType)) {
        return Response.json({ error: 'What did you see? Pick one from the list.' }, { status: 400 });
      }
      const evidenceKind = str(body.evidence_kind);
      if (evidenceKind && !FSSAI_PEST_EVIDENCE_KINDS.some((k) => k.key === evidenceKind)) {
        return Response.json({ error: 'That is not something this register can record as evidence.' }, { status: 400 });
      }
      const severity = FSSAI_PEST_SEVERITIES.some((s) => s.key === str(body.severity)) ? str(body.severity) : 'low';
      const location = str(body.location_label).trim();
      if (location.length < 2) {
        return Response.json({ error: 'Where was it? "Behind the dry store" is enough — a sighting with no place cannot be acted on.' }, { status: 400 });
      }
      const businessDate = isoDateOrBlank(body.business_date) || today;
      if (businessDate > today) {
        return Response.json({ error: 'A sighting cannot be dated in the future.' }, { status: 400 });
      }

      // The department and the device are both read, never created (HARD RULE 4 /
      // owner §21). An id that does not resolve is refused by name rather than
      // stored as a dangling reference — these columns carry no FK, so nothing
      // else would catch it.
      const deptId = str(body.department_id);
      if (deptId) {
        const d = db.prepare(`SELECT id FROM departments WHERE id = ?`).get(deptId) as any;
        if (!d) return Response.json({ error: 'That department is not in the list.' }, { status: 400 });
      }
      const deviceId = str(body.device_id);
      if (deviceId) {
        const dev = db.prepare(`SELECT id FROM fssai_pest_devices WHERE id = ?`).get(deviceId) as any;
        if (!dev) return Response.json({ error: 'That monitoring point is not in the register.' }, { status: 400 });
      }

      const id = generateId();
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO fssai_pest_sightings
             (id, business_date, sighted_at, pest_type, evidence_kind, count_seen, severity,
              location_label, department_id, device_id, run_id, response_id, service_id,
              description, immediate_action, status, reported_by, reported_name,
              outlet_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted',?,?,?,?,?)`,
        ).run(
          id, businessDate, isoStampOrBlank(body.sighted_at) || now,
          pestType, evidenceKind, intOrNull(body.count_seen), severity,
          location.slice(0, 300), deptId, deviceId,
          str(body.run_id), str(body.response_id), str(body.service_id),
          str(body.description).slice(0, 4000), str(body.immediate_action).slice(0, 4000),
          me.email, me.name || '', outletId, now, now,
        );
        if (deviceId) {
          // A device that caught something was, by definition, looked at, so
          // last_checked_at moves forward (never back). It is NOT the monitoring
          // sheet: since 2026-10-14 the routine station-by-station check has its
          // own table (fssai_pest_device_checks, /api/fssai/pest/checks), which
          // also stamps this column, and whether a station is due is judged from
          // that table alone (pestStationCoverage) — a sighting is not a check.
          db.prepare(`UPDATE fssai_pest_devices SET last_checked_at = ?, updated_at = ? WHERE id = ? AND (last_checked_at = '' OR last_checked_at < ?)`)
            .run(now, now, deviceId, now);
        }
        fssaiAudit(db, {
          entity_table: 'fssai_pest_sightings', entity_id: id, action: 'create',
          after: { business_date: businessDate, pest_type: pestType, evidence_kind: evidenceKind, severity, location_label: location, device_id: deviceId },
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      })();
      fssaiAppAudit(db, {
        event_type: 'fssai_pest_sighting', entity_type: 'fssai_pest_sightings', entity_id: id,
        actor_email: me.email, after: { pest_type: pestType, severity, location_label: location },
        note: `${pestType} — ${location}`,
      });
      const row = db.prepare(`${SELECT} WHERE g.id = ?`).get(id) as any;
      return Response.json({
        sighting: shape(row),
        created: true,
        advice: severity === 'high'
          ? 'Marked as an infestation. Raise a corrective action against it now, with a name and a date — that is what closes it.'
          : 'Add a photograph if you can. A sighting with a picture is the one an inspector believes.',
      });
    }

    const id = str(body.id);
    if (!id) return Response.json({ error: 'Which sighting?' }, { status: 400 });
    const row = db.prepare(`SELECT * FROM fssai_pest_sightings WHERE id = ?`).get(id) as any;
    if (!row) return Response.json({ error: 'That sighting is no longer in the register.' }, { status: 404 });
    const voided = !!str(row.voided_at);

    /* ── VOID (§19) ──────────────────────────────────────────────────────── */
    if (action === 'void') {
      const out = voidP6Record(db, {
        table: 'fssai_pest_sightings', id, reason: str(body.reason), me: me as any, outlet_id: outletId,
      });
      if ('error' in out) return Response.json({ error: out.error }, { status: out.status });
      const after = db.prepare(`${SELECT} WHERE g.id = ?`).get(id) as any;
      return Response.json({ sighting: shape(after), voided: true });
    }

    /* ── FILES ───────────────────────────────────────────────────────────── */
    if (action === 'attach') {
      if (!canAmend(me, row)) {
        return Response.json({
          error: voided
            ? 'That sighting has been voided, so nothing more can be added to it.'
            : 'That sighting has been closed by a manager. Ask them to reopen it, or file a new sighting.',
        }, { status: 403 });
      }
      const out = db.transaction(() => attachPestFile(db, {
        entity_table: 'fssai_pest_sightings', entity_id: id,
        kind: str(body.kind) || 'photo', data_uri: str(body.data_uri),
        filename: str(body.filename), caption: str(body.caption),
        actor: { email: me.email, name: me.name }, outlet_id: outletId,
      }))();
      if ('error' in out) return Response.json({ error: out.error }, { status: out.status });
      return Response.json({ attachment: out.attachment });
    }

    if (action === 'void_file' || action === 'remove_file') {
      // DECISION (../_pest/files.ts): a photograph on a filed sighting is
      // VOIDED, never stripped. voidPestFile refuses (404) unless the file's own
      // entity_table/entity_id are THIS sighting, so no other record or register
      // can be reached through this id. The image stays; the void, its reason
      // and an fssai_audit_log row are added. 'remove_file' is the old name.
      const out = voidPestFile(db, {
        id: str(body.attachment_id), entity_table: 'fssai_pest_sightings', entity_id: id,
        reason: str(body.reason), me: me as any, outlet_id: outletId,
      });
      if ('error' in out) return Response.json({ error: out.error }, { status: out.status });
      return Response.json({ voided_file: out.voided });
    }

    /* ── RAISE A CORRECTIVE ACTION ───────────────────────────────────────── */
    if (action === 'raise_ca') {
      if (!canManageFssaiCa(me)) return Response.json({ error: 'Only a manager, head of department or administrator can raise a corrective action.' }, { status: 403 });
      if (voided) return Response.json({ error: 'That sighting has been voided.' }, { status: 409 });
      if (str(row.ca_id)) return Response.json({ error: 'A corrective action has already been raised for this sighting.' }, { status: 409 });
      const severity = FSSAI_CA_SEVERITIES.some((s) => s.key === str(body.severity))
        ? str(body.severity)
        // An infestation defaults to urgent, anything else to high. Neither is
        // final — the person raising it chooses, and this is only the suggestion
        // the form opens with.
        : (str(row.severity) === 'high' ? 'urgent' : 'high');
      const typeLabel = FSSAI_PEST_TYPES.find((p) => p.key === str(row.pest_type))?.label || str(row.pest_type);
      const out = db.transaction(() => {
        const caNumber = nextP6CaNumber(db, str(row.business_date) || today);
        return raiseP6CorrectiveAction(db, {
          table: 'fssai_pest_sightings', entity_id: id,
          title: str(body.title) || `${typeLabel} — ${str(row.location_label)}`,
          description: [
            `Raised from a pest sighting on ${str(row.business_date)} at ${str(row.location_label)}.`,
            `Reported by ${str(row.reported_name) || str(row.reported_by)}.`,
            str(row.evidence_kind) ? `What was seen: ${FSSAI_PEST_EVIDENCE_KINDS.find((k) => k.key === str(row.evidence_kind))?.label || str(row.evidence_kind)}.` : '',
            str(row.description) ? `Description: ${str(row.description)}` : '',
            str(row.immediate_action) ? `Done at the time: ${str(row.immediate_action)}` : '',
            str(body.description),
          ].filter(Boolean).join('\n'),
          severity, owner_email: str(body.owner_email),
          department_id: str(row.department_id), business_date: str(row.business_date) || today,
          me: { email: me.email, name: me.name }, outlet_id: outletId, ca_number: caNumber,
        });
      })();
      if ('error' in out) return Response.json({ error: out.error }, { status: out.status });
      const after = db.prepare(`${SELECT} WHERE g.id = ?`).get(id) as any;
      return Response.json({ sighting: shape(after), raised: out });
    }

    /* ── UPDATE — the reporter, while it is open; management always ──────── */
    if (action === 'update') {
      if (!canAmend(me, row)) {
        return Response.json({
          error: voided
            ? 'That sighting has been voided. A voided record is never edited — file a new one.'
            : 'That sighting has been closed. Only a manager can change it now.',
        }, { status: 403 });
      }
      const pestType = body.pest_type === undefined ? str(row.pest_type) : str(body.pest_type);
      if (!FSSAI_PEST_TYPES.some((p) => p.key === pestType)) {
        return Response.json({ error: 'That is not a pest this register knows.' }, { status: 400 });
      }
      const evidenceKind = body.evidence_kind === undefined ? str(row.evidence_kind) : str(body.evidence_kind);
      if (evidenceKind && !FSSAI_PEST_EVIDENCE_KINDS.some((k) => k.key === evidenceKind)) {
        return Response.json({ error: 'That is not something this register can record as evidence.' }, { status: 400 });
      }
      const severity = FSSAI_PEST_SEVERITIES.some((s) => s.key === str(body.severity)) ? str(body.severity) : str(row.severity);
      const location = (body.location_label === undefined ? str(row.location_label) : str(body.location_label)).trim();
      if (location.length < 2) return Response.json({ error: 'Where was it?' }, { status: 400 });

      const before = {
        pest_type: str(row.pest_type), evidence_kind: str(row.evidence_kind), severity: str(row.severity),
        count_seen: row.count_seen, location_label: str(row.location_label),
        description: str(row.description), immediate_action: str(row.immediate_action),
      };
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          `UPDATE fssai_pest_sightings
              SET pest_type = ?, evidence_kind = ?, count_seen = ?, severity = ?,
                  location_label = ?, department_id = ?, description = ?, immediate_action = ?,
                  sighted_at = ?, updated_at = ?
            WHERE id = ?`,
        ).run(
          pestType, evidenceKind,
          body.count_seen === undefined ? row.count_seen : intOrNull(body.count_seen),
          severity, location.slice(0, 300),
          body.department_id === undefined ? str(row.department_id) : str(body.department_id),
          str(body.description ?? row.description).slice(0, 4000),
          str(body.immediate_action ?? row.immediate_action).slice(0, 4000),
          body.sighted_at === undefined ? str(row.sighted_at) : isoStampOrBlank(body.sighted_at),
          now, id,
        );
        fssaiAudit(db, {
          entity_table: 'fssai_pest_sightings', entity_id: id, action: 'update',
          before, after: { pest_type: pestType, evidence_kind: evidenceKind, severity, location_label: location },
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      })();
      const after = db.prepare(`${SELECT} WHERE g.id = ?`).get(id) as any;
      return Response.json({ sighting: shape(after), updated: true });
    }

    /* ── LINK TO THE VISIT THAT DEALT WITH IT ────────────────────────────── */
    if (action === 'link_service') {
      if (!canManageFssaiCa(me)) return Response.json({ error: 'Only a manager or an administrator can link a sighting to a contractor’s visit.' }, { status: 403 });
      if (voided) return Response.json({ error: 'That sighting has been voided.' }, { status: 409 });
      const serviceId = str(body.service_id);
      if (serviceId) {
        const svc = db.prepare(`SELECT id, voided_at FROM fssai_pest_services WHERE id = ?`).get(serviceId) as any;
        if (!svc) return Response.json({ error: 'That pest control visit is not in the register.' }, { status: 400 });
        if (str(svc.voided_at)) return Response.json({ error: 'That visit has been voided, so a sighting cannot be filed against it.' }, { status: 409 });
      }
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(`UPDATE fssai_pest_sightings SET service_id = ?, updated_at = ? WHERE id = ?`)
          .run(serviceId, now, id);
        fssaiAudit(db, {
          entity_table: 'fssai_pest_sightings', entity_id: id, action: 'link_service',
          field: 'service_id', before: { service_id: str(row.service_id) }, after: { service_id: serviceId },
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      })();
      const after = db.prepare(`${SELECT} WHERE g.id = ?`).get(id) as any;
      return Response.json({ sighting: shape(after), linked: true });
    }

    /* ── CLOSE / REOPEN ──────────────────────────────────────────────────── */
    if (action === 'close' || action === 'reopen') {
      if (!canManageFssaiCa(me)) return Response.json({ error: 'Only a manager, head of department or administrator can close a sighting.' }, { status: 403 });
      if (voided) return Response.json({ error: 'That sighting has been voided.' }, { status: 409 });
      const now = new Date().toISOString();

      if (action === 'close') {
        if (str(row.closed_at)) return Response.json({ error: 'That sighting is already closed.' }, { status: 409 });
        // A sighting with an OPEN corrective action against it cannot be closed.
        // Closing it would be the one move that makes a pest file lie: the
        // sighting reads "dealt with" while the fix is still outstanding.
        if (str(row.ca_id)) {
          const ca = db.prepare(`SELECT status, ca_number FROM fssai_corrective_actions WHERE id = ?`).get(str(row.ca_id)) as any;
          const open = ca && !['verified', 'cancelled', 'void'].includes(String(ca.status || ''));
          if (open) {
            return Response.json({
              error: `Corrective action ${String(ca.ca_number || '')} is still open against this sighting. Close that first — otherwise the register says this was dealt with while the fix is outstanding.`,
            }, { status: 409 });
          }
        }
        const note = str(body.note ?? row.immediate_action).slice(0, 4000);
        db.transaction(() => {
          db.prepare(
            `UPDATE fssai_pest_sightings
                SET status = 'verified', closed_at = ?, closed_by = ?, immediate_action = ?, updated_at = ?
              WHERE id = ?`,
          ).run(now, me.email, note, now, id);
          fssaiAudit(db, {
            entity_table: 'fssai_pest_sightings', entity_id: id, action: 'close',
            before: { status: str(row.status), closed_at: '' },
            after: { status: 'verified', closed_at: now, closed_by: me.email },
            reason: str(body.note), actor: { email: me.email, name: me.name }, outlet_id: outletId,
          });
        })();
      } else {
        if (!str(row.closed_at)) return Response.json({ error: 'That sighting is already open.' }, { status: 409 });
        const reason = str(body.reason).trim();
        if (reason.length < 4) return Response.json({ error: 'Say in words why this sighting is being reopened.' }, { status: 400 });
        db.transaction(() => {
          db.prepare(
            `UPDATE fssai_pest_sightings
                SET status = 'submitted', closed_at = '', closed_by = '', updated_at = ?
              WHERE id = ?`,
          ).run(now, id);
          fssaiAudit(db, {
            entity_table: 'fssai_pest_sightings', entity_id: id, action: 'reopen',
            before: { status: str(row.status), closed_at: str(row.closed_at), closed_by: str(row.closed_by) },
            after: { status: 'submitted', closed_at: '', closed_by: '' },
            reason, actor: { email: me.email, name: me.name }, outlet_id: outletId,
          });
        })();
      }
      const after = db.prepare(`${SELECT} WHERE g.id = ?`).get(id) as any;
      return Response.json({ sighting: shape(after), closed: action === 'close' });
    }

    return Response.json({ error: `"${action || '(none)'}" is not something this screen can do.` }, { status: 400 });
  } catch (e: any) {
    console.error('POST /api/fssai/pest/sightings failed:', e);
    const msg = p6ConstraintMessage(e, '');
    if (msg) return Response.json({ error: msg }, { status: 409 });
    return Response.json({ error: e?.message || 'Could not save the sighting' }, { status: 500 });
  }
}
