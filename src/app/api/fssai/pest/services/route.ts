/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  canManageFssaiCa, fssaiToday, fssaiRecordStatusMeta, fssaiPestServiceStatusMeta,
  FSSAI_PEST_SERVICE_KINDS, FSSAI_PEST_SERVICE_STATUSES, FSSAI_CA_SEVERITIES,
} from '@/lib/fssai';
import { requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAppAudit, str } from '@/lib/fssai-server';
import {
  nextP6Number, voidP6Record, raiseP6CorrectiveAction, nextP6CaNumber, p6ConstraintMessage,
  isoDateOrBlank, isoStampOrBlank,
} from '../../p6-shared';
import {
  attachPestFile, voidPestFile, pestFilesFor, canVoidPestFiles, PEST_ACTIVE_FILES_PER_RECORD,
} from '../_pest/files';
import { normalisePestChemicals, readPestChemicals, requestMentionsChemicals } from '../_pest/chemicals';

/**
 * PEST CONTROL — THE CONTRACTOR'S VISITS (owner §7).
 * /api/fssai/pest/services
 *
 * ── WHAT THIS REGISTER IS FOR, AND THE ONE ROW THAT EARNS IT ────────────────
 * An inspector opening a pest file asks two questions: does a contract exist,
 * and was every visit under it actually made. The second is the one a schema
 * usually cannot answer. A table with only planned/completed leaves a visit that
 * did not happen sitting as "planned" for ever, or deleted — and §19 forbids the
 * second. So 'missed' is a first-class status here, it REFUSES to be set without
 * a reason in words, and a missed visit can raise a corrective action with an
 * owner and a date. That is the whole point of the module: not "did anything go
 * wrong", but "what did you do about it".
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * It does not own the SCHEDULE. Pest Control already exists as a
 * maintenance_schedules row in the Task Manager, alongside Water Filter
 * Inspection, and §7 Q2's provisional default is that FSSAI reads those visits
 * rather than asking anybody to type them twice. Nothing here writes
 * maintenance_schedules or maintenance_logs, and `next_due_date` on a completed
 * visit is this register's own forward note, not a second scheduler. When the
 * owner rules on Q2 the join can be added in one read; inventing a rival
 * schedule now could not be undone.
 *
 * (It once said here that it keeps no per-device check log because "device 7
 * checked, no activity" would be a checklist answer. SUPERSEDED 2026-10-14: the
 * authority's monitoring sheet is station by station, so it has its own table
 * and route — /api/fssai/pest/checks, table 33.)
 *
 * ── WHAT WAS APPLIED (#78) ──────────────────────────────────────────────────
 * chemicals_json is written through normalisePestChemicals (../_pest/
 * chemicals.ts), which also explains its three states: listed, none applied
 * (said in words), not recorded. A completed visit's list is a record: it is
 * never edited, but a list NOBODY recorded may be filled once from the job
 * sheet ('record_chemicals'), with an audit row.
 *
 * ── FILES ARE VOIDED, NEVER STRIPPED ────────────────────────────────────────
 * 'void_file' (and the old name 'remove_file', kept so a page left open across
 * a deploy cannot reach the old behaviour) goes to voidPestFile: the file must
 * belong to THIS visit, and it stays on the record marked void with its reason.
 * The decision is written in full in ../_pest/files.ts.
 *
 *   GET  ?id=<id>                          one visit, with its files and sightings
 *   GET  [?from=&to=&status=&vendor_id=&kind=&q=&due=1]   the register
 *   POST { action: 'create' | 'update' | 'complete' | 'miss' | 'cancel'
 *                 | 'void' | 'attach' | 'void_file' | 'remove_file'
 *                 | 'record_chemicals' | 'raise_ca', … }
 *
 * NO DELETE. A visit entered in error is VOIDED with a reason by somebody other
 * than the person who entered it (§19).
 */
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 300;

/** Who may record a contractor's visit: management, not every member of staff. */
function canRecordVisit(me: any): boolean {
  // The shell this screen replaces said it in words — "Logging a sighting will be
  // open to any staff member… Recording a contractor's visit is a management
  // job. Those are two different rights on one screen." Sightings are open; this
  // half is not, because the agency licence number and the chemical list on this
  // row are what an inspector reads first.
  return canManageFssaiCa(me);
}

const SELECT = `
  SELECT s.*,
         v.name AS vendor_master_name,
         d.title AS report_doc_title,
         c.title AS contract_doc_title,
         ca.ca_number AS ca_number, ca.status AS ca_status, ca.due_date AS ca_due_date,
         ca.owner_email AS ca_owner_email, ca.severity AS ca_severity
    FROM fssai_pest_services s
    LEFT JOIN vendors          v  ON v.id  = s.vendor_id
    LEFT JOIN fssai_documents  d  ON d.id  = s.document_id
    LEFT JOIN fssai_documents  c  ON c.id  = s.contract_doc_id
    LEFT JOIN fssai_corrective_actions ca ON ca.id = s.ca_id`;

/**
 * One visit as a screen reads it.
 *
 * `mgmt` gates the two DOCUMENT TITLES, not the rest: /fssai/documents is
 * mgmtOnly in the catalog, so joining a document's title onto a page every
 * signed-in user can open would hand the licence cupboard's contents to a staff
 * phone through the side door. The document IDs are useless without that screen,
 * so they go either way.
 */
function shape(row: any, opts: { mgmt: boolean; files?: any[] }) {
  const voided = !!str(row.voided_at);
  const statusMeta = voided ? fssaiRecordStatusMeta('void') : fssaiPestServiceStatusMeta(row.status);
  const chem = readPestChemicals(row.chemicals_json);
  const files = opts.files || [];
  return {
    id: String(row.id),
    service_no: str(row.service_no),
    vendor_id: str(row.vendor_id),
    // The vendor master wins when the row still points at a live vendor; the
    // frozen name is the fallback for an agency since deactivated or renamed.
    // RECON §5 row 2: match on ID, never on name.
    vendor_name: str(row.vendor_master_name) || str(row.vendor_name),
    vendor_name_at_record: str(row.vendor_name),
    vendor_renamed_since: !!str(row.vendor_master_name) && !!str(row.vendor_name)
      && str(row.vendor_master_name) !== str(row.vendor_name),
    agency_licence_no: str(row.agency_licence_no),
    technician_name: str(row.technician_name),
    service_kind: str(row.service_kind),
    service_kind_label: FSSAI_PEST_SERVICE_KINDS.find((k) => k.key === str(row.service_kind))?.label || str(row.service_kind),
    business_date: str(row.business_date),
    started_at: str(row.started_at),
    finished_at: str(row.finished_at),
    areas_covered: str(row.areas_covered),
    chemicals: chem.rows,
    /** 'listed' | 'none_applied' | 'not_recorded' — '[]' is NEVER "none". */
    chemicals_state: chem.state,
    chemicals_none_note: chem.none_note,
    /** A completed visit whose list nobody recorded may be filled once. */
    can_record_chemicals: !voided && str(row.status) === 'completed' && chem.state === 'not_recorded',
    findings: str(row.findings),
    recommendations: str(row.recommendations),
    report_no: str(row.report_no),
    document_id: str(row.document_id),
    document_title: opts.mgmt ? str(row.report_doc_title) : '',
    contract_doc_id: str(row.contract_doc_id),
    contract_doc_title: opts.mgmt ? str(row.contract_doc_title) : '',
    next_due_date: str(row.next_due_date),
    staff_witness: str(row.staff_witness),
    status: voided ? 'void' : str(row.status),
    status_label: statusMeta.label,
    status_color: statusMeta.color,
    missed_reason: str(row.missed_reason),
    ca_id: str(row.ca_id),
    ca: str(row.ca_id) && str(row.ca_number)
      ? {
        id: str(row.ca_id), ca_number: str(row.ca_number), status: str(row.ca_status),
        due_date: str(row.ca_due_date), owner_email: str(row.ca_owner_email), severity: str(row.ca_severity),
      }
      : null,
    note: str(row.note),
    voided_at: str(row.voided_at),
    voided_by: str(row.voided_by),
    void_reason: str(row.void_reason),
    created_by: str(row.created_by),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    /** Only a planned visit is still a plan. Once it happened, it is a record. */
    is_editable: !voided && str(row.status) === 'planned',
    files,
    /** Active files only — a voided file stays on the record but frees its place. */
    active_file_count: files.filter((f: any) => !f.is_void).length,
    file_limit: PEST_ACTIVE_FILES_PER_RECORD,
  };
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;
  const mgmt = isManagement(me);

  try {
    const db = getDb();
    const url = new URL(request.url);
    const today = fssaiToday();

    /* ══ ONE VISIT ══════════════════════════════════════════════════════════ */
    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That pest control visit no longer exists.' }, { status: 404 });
      const files = pestFilesFor(db, 'fssai_pest_services', [id], { withImage: true }).get(id) || [];
      // The sightings this visit dealt with, so "reported and acted on" reads in
      // one place. Oldest first: the order they were seen in is the story.
      const sightings = db.prepare(
        `SELECT id, business_date, sighted_at, pest_type, evidence_kind, severity,
                location_label, description, status, reported_by, reported_name, voided_at
           FROM fssai_pest_sightings
          WHERE service_id = ? ORDER BY business_date ASC, sighted_at ASC, rowid ASC`,
      ).all(id) as any[];
      return Response.json({
        service: shape(row, { mgmt, files }),
        sightings,
        can_record: canRecordVisit(me),
        can_void: canManageFssaiCa(me),
        can_void_files: canVoidPestFiles(me),
        me: me.email,
        today,
      });
    }

    /* ══ THE REGISTER ═══════════════════════════════════════════════════════ */
    const where: string[] = [];
    const args: any[] = [];

    const from = isoDateOrBlank(url.searchParams.get('from'));
    const to = isoDateOrBlank(url.searchParams.get('to'));
    if (from) { where.push('s.business_date >= ?'); args.push(from); }
    if (to) { where.push('s.business_date <= ?'); args.push(to); }

    const status = str(url.searchParams.get('status'));
    if (status === 'void') {
      where.push(`s.voided_at <> ''`);
    } else if (status && status !== 'all') {
      // A voided row is not "planned" any more, whatever its status column says.
      if (!FSSAI_PEST_SERVICE_STATUSES.some((x) => x.key === status)) {
        return Response.json({ error: `"${status}" is not a state a visit can be in.` }, { status: 400 });
      }
      where.push(`s.status = ? AND s.voided_at = ''`);
      args.push(status);
    }

    const vendorId = str(url.searchParams.get('vendor_id'));
    if (vendorId) { where.push('s.vendor_id = ?'); args.push(vendorId); }

    const kind = str(url.searchParams.get('kind'));
    if (kind) {
      if (!FSSAI_PEST_SERVICE_KINDS.some((k) => k.key === kind)) {
        return Response.json({ error: `"${kind}" is not a kind of visit.` }, { status: 400 });
      }
      where.push('s.service_kind = ?'); args.push(kind);
    }

    // Due or overdue: the forward-looking half of the register. A visit whose
    // next_due_date has passed with no later visit recorded is the thing the
    // screen must shout about.
    if (str(url.searchParams.get('due')) === '1') {
      where.push(`s.next_due_date <> '' AND s.next_due_date <= ? AND s.voided_at = ''`);
      args.push(today);
    }

    const q = str(url.searchParams.get('q'));
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      where.push(`(lower(s.service_no) LIKE ? OR lower(s.vendor_name) LIKE ? OR lower(IFNULL(v.name,'')) LIKE ?
                   OR lower(s.technician_name) LIKE ? OR lower(s.areas_covered) LIKE ?
                   OR lower(s.findings) LIKE ? OR lower(s.report_no) LIKE ?)`);
      args.push(like, like, like, like, like, like, like);
    }

    const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY s.business_date DESC, s.created_at DESC, s.rowid DESC
                 LIMIT ${LIST_LIMIT + 1}`;
    const rows = db.prepare(sql).all(...args) as any[];
    const truncated = rows.length > LIST_LIMIT;
    const page = truncated ? rows.slice(0, LIST_LIMIT) : rows;

    const fileCounts = pestFilesFor(db, 'fssai_pest_services', page.map((r) => String(r.id)));

    // The counts are over the WHOLE register, not the page — a tab that says
    // "Missed 0" because the first 300 rows happen to contain none is worse than
    // no number at all.
    const countRow = db.prepare(
      `SELECT
         SUM(CASE WHEN voided_at = '' AND status = 'planned'   THEN 1 ELSE 0 END) AS planned,
         SUM(CASE WHEN voided_at = '' AND status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN voided_at = '' AND status = 'missed'    THEN 1 ELSE 0 END) AS missed,
         SUM(CASE WHEN voided_at = '' AND status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
         SUM(CASE WHEN voided_at <> '' THEN 1 ELSE 0 END) AS void,
         SUM(CASE WHEN voided_at = '' AND next_due_date <> '' AND next_due_date <= ? THEN 1 ELSE 0 END) AS due,
         COUNT(*) AS all_rows
       FROM fssai_pest_services`,
    ).get(today) as any;

    return Response.json({
      services: page.map((r) => shape(r, { mgmt, files: fileCounts.get(String(r.id)) || [] })),
      counts: {
        planned: Number(countRow?.planned) || 0,
        completed: Number(countRow?.completed) || 0,
        missed: Number(countRow?.missed) || 0,
        cancelled: Number(countRow?.cancelled) || 0,
        void: Number(countRow?.void) || 0,
        due: Number(countRow?.due) || 0,
        all: Number(countRow?.all_rows) || 0,
      },
      can_record: canRecordVisit(me),
      can_void: canManageFssaiCa(me),
      can_void_files: canVoidPestFiles(me),
      me: me.email,
      today,
      truncated,
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/pest/services failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the pest control register' }, { status: 500 });
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

    /* ── CREATE ──────────────────────────────────────────────────────────── */
    if (action === 'create') {
      if (!canRecordVisit(me)) {
        return Response.json({ error: 'Recording a pest control visit is a manager’s job. Anyone can report a sighting — use the Sightings tab.' }, { status: 403 });
      }
      const businessDate = isoDateOrBlank(body.business_date) || today;
      // §7 Q9's provisional default is a 1-day backdate window on a CHECK. This
      // is not a check: a contractor's job sheet arrives days late as a matter of
      // routine, and refusing to file it would mean the visit is never recorded
      // at all. A FUTURE date is a different thing — that is a planned visit, and
      // it is allowed only while the status says so.
      const wantStatus = FSSAI_PEST_SERVICE_STATUSES.some((s) => s.key === str(body.status))
        ? str(body.status) : 'planned';
      if (wantStatus === 'void') {
        return Response.json({ error: 'A visit cannot be created as voided.' }, { status: 400 });
      }
      if (businessDate > today && wantStatus !== 'planned') {
        return Response.json({ error: `${businessDate} is in the future, so this visit can only be saved as planned.` }, { status: 400 });
      }
      const kind = FSSAI_PEST_SERVICE_KINDS.some((k) => k.key === str(body.service_kind))
        ? str(body.service_kind) : 'scheduled';

      const vendorId = str(body.vendor_id);
      let vendorName = str(body.vendor_name);
      if (vendorId) {
        const v = db.prepare(`SELECT name FROM vendors WHERE id = ?`).get(vendorId) as any;
        if (!v) return Response.json({ error: 'That pest control agency is not in the supplier list.' }, { status: 400 });
        // The name is FROZEN onto the row at write, beside the id. The id is the
        // join; the name is what the record said at the time, for the day the
        // agency is renamed or deactivated.
        vendorName = String(v.name || '');
      }
      if (!vendorId && !vendorName) {
        return Response.json({ error: 'Which agency came? Pick one from the supplier list, or type the name.' }, { status: 400 });
      }
      if (wantStatus === 'missed' && str(body.missed_reason).trim().length < 4) {
        return Response.json({ error: 'A missed visit needs a reason in words — that sentence is the single most useful line in a pest file.' }, { status: 400 });
      }
      // What was applied is a fact about a visit that HAPPENED. On a planned,
      // missed or cancelled visit it would be a list of things nobody sprayed,
      // so it is refused rather than silently dropped.
      const chem = normalisePestChemicals({
        chemicals: body.chemicals, none: body.chemicals_none, noneNote: body.chemicals_none_note, visitDate: businessDate,
      });
      if (!chem.ok) return Response.json({ error: chem.error }, { status: 400 });
      if (wantStatus !== 'completed' && chem.read.state !== 'not_recorded') {
        return Response.json({ error: 'Chemicals are recorded on a visit that happened. Save it as completed, or leave the chemicals for when it does.' }, { status: 400 });
      }

      const id = generateId();
      const now = new Date().toISOString();
      const run = db.transaction(() => {
        const serviceNo = nextP6Number(db, {
          table: 'fssai_pest_services', column: 'service_no', prefix: 'PST', isoDate: businessDate,
        });
        db.prepare(
          `INSERT INTO fssai_pest_services
             (id, service_no, vendor_id, vendor_name, agency_licence_no, technician_name,
              service_kind, business_date, started_at, finished_at, areas_covered,
              chemicals_json, findings, recommendations, report_no, document_id,
              contract_doc_id, next_due_date, staff_witness, status, missed_reason, note,
              created_by, outlet_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id, serviceNo, vendorId, vendorName, str(body.agency_licence_no), str(body.technician_name),
          kind, businessDate, isoStampOrBlank(body.started_at), isoStampOrBlank(body.finished_at),
          str(body.areas_covered).slice(0, 2000), chem.json,
          str(body.findings).slice(0, 8000), str(body.recommendations).slice(0, 8000),
          str(body.report_no), str(body.document_id), str(body.contract_doc_id),
          isoDateOrBlank(body.next_due_date), str(body.staff_witness),
          wantStatus, str(body.missed_reason).slice(0, 2000), str(body.note).slice(0, 4000),
          me.email, outletId, now, now,
        );
        fssaiAudit(db, {
          entity_table: 'fssai_pest_services', entity_id: id, action: 'create',
          after: {
            service_no: serviceNo, vendor_id: vendorId, vendor_name: vendorName, business_date: businessDate, status: wantStatus, service_kind: kind,
            chemicals_state: chem.read.state, chemicals: chem.read.rows.map((c) => c.name),
          },
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
        return serviceNo;
      });

      let serviceNo = '';
      try {
        serviceNo = run();
      } catch (e: any) {
        const msg = p6ConstraintMessage(e, 'That visit number is already taken. Try again.');
        if (msg) return Response.json({ error: msg }, { status: 409 });
        throw e;
      }
      fssaiAppAudit(db, {
        event_type: 'fssai_pest_service_create', entity_type: 'fssai_pest_services', entity_id: id,
        actor_email: me.email, after: { service_no: serviceNo, status: wantStatus }, note: vendorName,
      });
      const row = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as any;
      return Response.json({
        service: shape(row, { mgmt: isManagement(me) }),
        created: true,
        warnings: chem.warnings,
        advice: wantStatus === 'completed' && chem.read.state === 'not_recorded'
          ? 'Recorded — but it does not say what was applied yet. Fill in the chemicals from the job sheet; an inspector reads that list first.'
          : undefined,
      });
    }

    /* ── everything else needs the row ───────────────────────────────────── */
    const id = str(body.id);
    if (!id) return Response.json({ error: 'Which visit?' }, { status: 400 });
    const row = db.prepare(`SELECT * FROM fssai_pest_services WHERE id = ?`).get(id) as any;
    if (!row) return Response.json({ error: 'That pest control visit no longer exists.' }, { status: 404 });
    const voided = !!str(row.voided_at);

    /* ── VOID (§19) ──────────────────────────────────────────────────────── */
    if (action === 'void') {
      const out = voidP6Record(db, {
        table: 'fssai_pest_services', id, reason: str(body.reason),
        me: me as any, outlet_id: outletId,
      });
      if ('error' in out) return Response.json({ error: out.error }, { status: out.status });
      const after = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as any;
      return Response.json({ service: shape(after, { mgmt: isManagement(me) }), voided: true });
    }

    /* ── FILES ───────────────────────────────────────────────────────────── */
    if (action === 'attach') {
      // The job sheet belongs to whoever recorded the visit, so the gate is the
      // same as recording one. A voided row takes no new evidence.
      if (!canRecordVisit(me)) return Response.json({ error: 'Only a manager or an administrator can attach the contractor’s report.' }, { status: 403 });
      if (voided) return Response.json({ error: 'That visit has been voided, so nothing more can be added to it.' }, { status: 409 });
      const out = db.transaction(() => attachPestFile(db, {
        entity_table: 'fssai_pest_services', entity_id: id,
        kind: str(body.kind) || 'report', data_uri: str(body.data_uri),
        filename: str(body.filename), caption: str(body.caption),
        actor: { email: me.email, name: me.name }, outlet_id: outletId,
      }))();
      if ('error' in out) return Response.json({ error: out.error }, { status: out.status });
      return Response.json({ attachment: out.attachment });
    }

    if (action === 'void_file' || action === 'remove_file') {
      // DECISION (../_pest/files.ts): a file on a filed visit is VOIDED, never
      // stripped. voidPestFile reads the file's own entity_table/entity_id and
      // refuses (404) unless they are THIS visit — a file on a sighting, a
      // licence or any other record cannot be reached through this id. The
      // image stays; the void, its reason and an fssai_audit_log row are added.
      // 'remove_file' is the old name, kept so a stale page cannot strip.
      const out = voidPestFile(db, {
        id: str(body.attachment_id), entity_table: 'fssai_pest_services', entity_id: id,
        reason: str(body.reason), me: me as any, outlet_id: outletId,
      });
      if ('error' in out) return Response.json({ error: out.error }, { status: out.status });
      return Response.json({ voided_file: out.voided });
    }

    /* ── RAISE A CORRECTIVE ACTION ───────────────────────────────────────── */
    if (action === 'raise_ca') {
      if (!canManageFssaiCa(me)) return Response.json({ error: 'Only a manager, head of department or administrator can raise a corrective action.' }, { status: 403 });
      if (voided) return Response.json({ error: 'That visit has been voided.' }, { status: 409 });
      if (str(row.ca_id)) return Response.json({ error: 'A corrective action has already been raised for this visit.' }, { status: 409 });
      const severity = FSSAI_CA_SEVERITIES.some((s) => s.key === str(body.severity)) ? str(body.severity) : 'high';
      const out = db.transaction(() => {
        const caNumber = nextP6CaNumber(db, str(row.business_date) || today);
        return raiseP6CorrectiveAction(db, {
          table: 'fssai_pest_services', entity_id: id,
          title: str(body.title) || `Pest control visit ${str(row.service_no)} — ${str(row.status) === 'missed' ? 'missed' : 'follow-up'}`,
          description: [
            `Raised from pest control visit ${str(row.service_no) || id} on ${str(row.business_date)}.`,
            str(row.vendor_name) ? `Agency: ${str(row.vendor_name)}.` : '',
            str(row.missed_reason) ? `Why it did not happen: ${str(row.missed_reason)}` : '',
            str(row.findings) ? `Contractor's findings: ${str(row.findings)}` : '',
            str(body.description),
          ].filter(Boolean).join('\n'),
          severity, owner_email: str(body.owner_email),
          department_id: '', business_date: str(row.business_date) || today,
          me: { email: me.email, name: me.name }, outlet_id: outletId, ca_number: caNumber,
        });
      })();
      if ('error' in out) return Response.json({ error: out.error }, { status: out.status });
      const after = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as any;
      return Response.json({ service: shape(after, { mgmt: isManagement(me) }), raised: out });
    }

    /* ── the state changes ───────────────────────────────────────────────── */
    if (!canRecordVisit(me)) {
      return Response.json({ error: 'Only a manager or an administrator can change a pest control visit.' }, { status: 403 });
    }
    if (voided) {
      return Response.json({ error: 'That visit has been voided. A voided record is never edited — file a new one.' }, { status: 409 });
    }

    /* ── UPDATE — a PLANNED visit only ───────────────────────────────────── */
    if (action === 'update') {
      if (str(row.status) !== 'planned') {
        return Response.json({
          error: `This visit is marked ${fssaiPestServiceStatusMeta(row.status).label.toLowerCase()}, so it is a record of what happened rather than a plan. To correct it, void it with a reason and file the visit again.`,
        }, { status: 409 });
      }
      const businessDate = isoDateOrBlank(body.business_date) || str(row.business_date);
      const kind = FSSAI_PEST_SERVICE_KINDS.some((k) => k.key === str(body.service_kind))
        ? str(body.service_kind) : str(row.service_kind);
      const vendorId = body.vendor_id === undefined ? str(row.vendor_id) : str(body.vendor_id);
      let vendorName = body.vendor_name === undefined ? str(row.vendor_name) : str(body.vendor_name);
      if (vendorId && vendorId !== str(row.vendor_id)) {
        const v = db.prepare(`SELECT name FROM vendors WHERE id = ?`).get(vendorId) as any;
        if (!v) return Response.json({ error: 'That pest control agency is not in the supplier list.' }, { status: 400 });
        vendorName = String(v.name || '');
      }
      const before = {
        business_date: str(row.business_date), vendor_id: str(row.vendor_id), vendor_name: str(row.vendor_name),
        service_kind: str(row.service_kind), technician_name: str(row.technician_name),
        agency_licence_no: str(row.agency_licence_no), areas_covered: str(row.areas_covered),
        next_due_date: str(row.next_due_date), staff_witness: str(row.staff_witness), note: str(row.note),
      };
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          `UPDATE fssai_pest_services
              SET business_date = ?, vendor_id = ?, vendor_name = ?, agency_licence_no = ?,
                  technician_name = ?, service_kind = ?, started_at = ?, areas_covered = ?,
                  contract_doc_id = ?, next_due_date = ?, staff_witness = ?, note = ?, updated_at = ?
            WHERE id = ?`,
        ).run(
          businessDate, vendorId, vendorName, str(body.agency_licence_no ?? row.agency_licence_no),
          str(body.technician_name ?? row.technician_name), kind,
          body.started_at === undefined ? str(row.started_at) : isoStampOrBlank(body.started_at),
          str(body.areas_covered ?? row.areas_covered).slice(0, 2000),
          str(body.contract_doc_id ?? row.contract_doc_id),
          body.next_due_date === undefined ? str(row.next_due_date) : isoDateOrBlank(body.next_due_date),
          str(body.staff_witness ?? row.staff_witness), str(body.note ?? row.note).slice(0, 4000),
          now, id,
        );
        fssaiAudit(db, {
          entity_table: 'fssai_pest_services', entity_id: id, action: 'update',
          before, after: { business_date: businessDate, vendor_id: vendorId, vendor_name: vendorName, service_kind: kind },
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      })();
      const after = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as any;
      return Response.json({ service: shape(after, { mgmt: isManagement(me) }), updated: true });
    }

    /* ── COMPLETE — the visit happened ───────────────────────────────────── */
    if (action === 'complete') {
      if (str(row.status) === 'completed') {
        return Response.json({ error: 'That visit is already recorded as completed.' }, { status: 409 });
      }
      if (str(row.status) === 'cancelled') {
        return Response.json({ error: 'That visit was cancelled. If it went ahead after all, file it as a new visit so the file shows both.' }, { status: 409 });
      }
      const businessDate = isoDateOrBlank(body.business_date) || str(row.business_date);
      if (businessDate > today) {
        return Response.json({ error: `${businessDate} has not happened yet, so the visit cannot be marked completed.` }, { status: 400 });
      }
      const findings = str(body.findings ?? row.findings).slice(0, 8000);
      const nextDue = body.next_due_date === undefined ? str(row.next_due_date) : isoDateOrBlank(body.next_due_date);
      if (nextDue && nextDue < businessDate) {
        return Response.json({ error: 'The next visit cannot be due before this one happened.' }, { status: 400 });
      }
      // A body that says nothing about chemicals keeps what the row carries; one
      // that says something goes through the same normaliser as create.
      let chemJson = str(row.chemicals_json) || '[]';
      let chemWarnings: string[] = [];
      if (requestMentionsChemicals(body)) {
        const chem = normalisePestChemicals({
          chemicals: body.chemicals, none: body.chemicals_none, noneNote: body.chemicals_none_note, visitDate: businessDate,
        });
        if (!chem.ok) return Response.json({ error: chem.error }, { status: 400 });
        chemJson = chem.json;
        chemWarnings = chem.warnings;
      }
      const chemAfter = readPestChemicals(chemJson);
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          `UPDATE fssai_pest_services
              SET status = 'completed', business_date = ?, started_at = ?, finished_at = ?,
                  technician_name = ?, agency_licence_no = ?, areas_covered = ?, chemicals_json = ?,
                  findings = ?, recommendations = ?, report_no = ?, document_id = ?,
                  next_due_date = ?, staff_witness = ?, note = ?, missed_reason = '', updated_at = ?
            WHERE id = ?`,
        ).run(
          businessDate,
          body.started_at === undefined ? str(row.started_at) : isoStampOrBlank(body.started_at),
          body.finished_at === undefined ? str(row.finished_at) : isoStampOrBlank(body.finished_at),
          str(body.technician_name ?? row.technician_name), str(body.agency_licence_no ?? row.agency_licence_no),
          str(body.areas_covered ?? row.areas_covered).slice(0, 2000),
          chemJson,
          findings, str(body.recommendations ?? row.recommendations).slice(0, 8000),
          str(body.report_no ?? row.report_no), str(body.document_id ?? row.document_id),
          nextDue, str(body.staff_witness ?? row.staff_witness),
          str(body.note ?? row.note).slice(0, 4000), now, id,
        );
        fssaiAudit(db, {
          entity_table: 'fssai_pest_services', entity_id: id, action: 'complete',
          before: { status: str(row.status), findings: str(row.findings), next_due_date: str(row.next_due_date), chemicals_state: readPestChemicals(row.chemicals_json).state },
          after: {
            status: 'completed', business_date: businessDate, findings, next_due_date: nextDue,
            chemicals_state: chemAfter.state, chemicals: chemAfter.rows.map((c) => c.name),
          },
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      })();
      fssaiAppAudit(db, {
        event_type: 'fssai_pest_service_complete', entity_type: 'fssai_pest_services', entity_id: id,
        actor_email: me.email, before: { status: str(row.status) }, after: { status: 'completed' },
        note: str(row.service_no),
      });
      const after = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as any;
      return Response.json({
        service: shape(after, { mgmt: isManagement(me) }),
        completed: true,
        warnings: chemWarnings,
        advice: chemAfter.state === 'not_recorded'
          ? 'Recorded as completed — but it does not say what was applied yet. Fill in the chemicals from the job sheet.'
          : undefined,
      });
    }

    /* ── FILL A CHEMICALS LIST NOBODY RECORDED — once ────────────────────── */
    if (action === 'record_chemicals') {
      // A completed visit is a record; its chemicals, once stated, are not
      // edited (void and refile). The one thing allowed is to fill a list that
      // was never recorded — the job sheet arrives days after the visit as a
      // matter of routine. The UPDATE's WHERE re-checks the column, so two
      // managers filling it at once cannot overwrite each other.
      if (str(row.status) !== 'completed') {
        return Response.json({ error: 'Chemicals are recorded on a visit that happened. Mark the visit completed first.' }, { status: 409 });
      }
      const current = readPestChemicals(row.chemicals_json);
      if (current.state !== 'not_recorded') {
        return Response.json({
          error: 'This visit already says what was applied. A completed visit is a record — to correct it, void it with a reason and file it again.',
        }, { status: 409 });
      }
      const chem = normalisePestChemicals({
        chemicals: body.chemicals, none: body.chemicals_none, noneNote: body.chemicals_none_note, visitDate: str(row.business_date),
      });
      if (!chem.ok) return Response.json({ error: chem.error }, { status: 400 });
      if (chem.read.state === 'not_recorded') {
        return Response.json({ error: 'List at least one product, or say that nothing was applied and why.' }, { status: 400 });
      }
      const now = new Date().toISOString();
      const changed = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_pest_services SET chemicals_json = ?, updated_at = ? WHERE id = ? AND chemicals_json = ?`,
        ).run(chem.json, now, id, str(row.chemicals_json));
        if (res.changes !== 1) return false;
        fssaiAudit(db, {
          entity_table: 'fssai_pest_services', entity_id: id, action: 'record_chemicals', field: 'chemicals_json',
          before: { chemicals_state: 'not_recorded', chemicals_json: str(row.chemicals_json) },
          after: { chemicals_state: chem.read.state, chemicals: chem.read.rows, none_note: chem.read.none_note },
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
        return true;
      })();
      if (!changed) return Response.json({ error: 'Somebody else filled the chemicals a moment ago. Reload the visit.' }, { status: 409 });
      fssaiAppAudit(db, {
        event_type: 'fssai_pest_service_chemicals', entity_type: 'fssai_pest_services', entity_id: id,
        actor_email: me.email, after: { chemicals_state: chem.read.state, products: chem.read.rows.length }, note: str(row.service_no),
      });
      const after = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as any;
      return Response.json({ service: shape(after, { mgmt: isManagement(me) }), recorded: true, warnings: chem.warnings });
    }

    /* ── MISS — the row this register exists for ─────────────────────────── */
    if (action === 'miss') {
      if (str(row.status) === 'completed') {
        return Response.json({ error: 'That visit is recorded as completed. If that was wrong, void it with a reason — a completed visit is not quietly turned into a missed one.' }, { status: 409 });
      }
      const reason = str(body.missed_reason ?? body.reason).trim();
      if (reason.length < 4) {
        return Response.json({ error: 'Say in words why the visit did not happen. That sentence is what an inspector actually reads.' }, { status: 400 });
      }
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          `UPDATE fssai_pest_services SET status = 'missed', missed_reason = ?, updated_at = ? WHERE id = ?`,
        ).run(reason.slice(0, 2000), now, id);
        fssaiAudit(db, {
          entity_table: 'fssai_pest_services', entity_id: id, action: 'missed',
          before: { status: str(row.status), missed_reason: str(row.missed_reason) },
          after: { status: 'missed', missed_reason: reason },
          reason, actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      })();
      fssaiAppAudit(db, {
        event_type: 'fssai_pest_service_missed', entity_type: 'fssai_pest_services', entity_id: id,
        actor_email: me.email, before: { status: str(row.status) }, after: { status: 'missed' }, note: reason,
      });
      const after = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as any;
      return Response.json({
        service: shape(after, { mgmt: isManagement(me) }),
        missed: true,
        // Said out loud rather than done silently: a missed contract visit is the
        // commonest pest finding there is, and the register's job is to make the
        // next step obvious, not to invent an owner for it.
        advice: 'A missed contract visit is the most common pest-control finding there is. Raise a corrective action against it so the file shows who chased it and when.',
      });
    }

    /* ── CANCEL — the visit was called off, legitimately ─────────────────── */
    if (action === 'cancel') {
      if (str(row.status) === 'completed') {
        return Response.json({ error: 'That visit already happened, so it cannot be cancelled. To correct the record, void it with a reason.' }, { status: 409 });
      }
      if (str(row.status) === 'cancelled') {
        return Response.json({ error: 'That visit is already cancelled.' }, { status: 409 });
      }
      const reason = str(body.reason).trim();
      if (reason.length < 4) {
        return Response.json({ error: 'Say in words why the visit was called off — "cancelled" with no reason reads exactly like a missed visit somebody tidied away.' }, { status: 400 });
      }
      const now = new Date().toISOString();
      db.transaction(() => {
        // missed_reason carries it deliberately: the column is literally "why
        // the visit did not take place", and a second column for the same
        // sentence is the kind of near-duplicate this project has been bitten by.
        db.prepare(
          `UPDATE fssai_pest_services SET status = 'cancelled', missed_reason = ?, updated_at = ? WHERE id = ?`,
        ).run(reason.slice(0, 2000), now, id);
        fssaiAudit(db, {
          entity_table: 'fssai_pest_services', entity_id: id, action: 'cancelled',
          before: { status: str(row.status) }, after: { status: 'cancelled', missed_reason: reason },
          reason, actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      })();
      const after = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as any;
      return Response.json({ service: shape(after, { mgmt: isManagement(me) }), cancelled: true });
    }

    return Response.json({ error: `"${action || '(none)'}" is not something this screen can do.` }, { status: 400 });
  } catch (e: any) {
    console.error('POST /api/fssai/pest/services failed:', e);
    const msg = p6ConstraintMessage(e, '');
    if (msg) return Response.json({ error: msg }, { status: 409 });
    return Response.json({ error: e?.message || 'Could not save the pest control visit' }, { status: 500 });
  }
}

/* A DELETE handler is deliberately absent. §19: void with a reason, never
 * delete. Next.js returns 405 for a method a route file does not export, which
 * is the right answer and needs no code of ours. */
