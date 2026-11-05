/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  canManageFssaiCa, fssaiToday, fssaiDocState, fssaiDocStateMeta, fssaiRecordStatusMeta,
  daysBetweenISO, isISODate,
  FSSAI_DOC_TYPES, FSSAI_DOC_STATES, FSSAI_DOC_REMINDER_DAYS, fssaiDocType,
} from '@/lib/fssai';
import { requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAppAudit, str } from '@/lib/fssai-server';
import {
  voidP6Record, p6ConstraintMessage, isoDateOrBlank, intOrNull,
} from '../p6-shared';
import {
  documentFilesFor, insertDocumentFile, voidDocumentFile, DOC_FILES_LIVE_LIMIT, type DocFile,
} from './files';
import { resolveFssaiCertificateHolder, fssaiDocumentHolders } from '@/lib/fssai-food-handlers';

/**
 * DOCUMENTS AND CERTIFICATES (owner §17). /api/fssai/documents
 *
 * The papers an inspector asks for first: the FSSAI licence, the trade licence,
 * the fire NOC, water-test reports, the pest-control contract, suppliers'
 * licences, staff medical fitness and training certificates, equipment
 * calibration certificates and AMCs.
 *
 * ── THE ONE RULE THIS ROUTE IS BUILT AROUND ─────────────────────────────────
 * THE EXPIRY STATE IS NOT STORED. It is derived by fssaiDocState() on every
 * single read, from expiry_date and the document's own reminder window. A stored
 * 'expiring' goes stale at midnight with nothing to wake it, and a licence
 * rendering "Valid" the day after it lapsed is the worst single row this module
 * could print. There is therefore no column to update, no sweep to forget to run,
 * and no way for the screen and the database to disagree.
 *
 * `last_reminder_at` is the ONE exception and it is about the NOTIFICATION, never
 * about the document: it exists so a renewal sweep does not alert daily for
 * thirty days. Nothing in this route writes it — the sweep is P7/P9's and has not
 * been built, which is stated on the screen rather than implied by silence.
 *
 * ── THE RENEWAL CHAIN ───────────────────────────────────────────────────────
 * Renewing does NOT edit the licence. It inserts a NEW row whose supersedes_id
 * points at the old one, bumps `version`, and sets the old row's is_active to 0.
 * The old row stays (§19), so the history of a licence number is readable and
 * "we were covered on the day you are asking about" is answerable. A renewal does
 * NOT inherit doc_code, because uq_fssai_doc_code is unique on
 * (outlet_id, doc_code) — see the note on doc_code below.
 *
 * ── MANAGEMENT, NOT ADMIN, AND THAT IS DELIBERATE ───────────────────────────
 * /fssai/documents is mgmtOnly in the catalog. The shell this replaces gave the
 * reason in words: admin-only would mean nobody can produce the licence unless
 * the owner is in the building. VOIDING still needs the §19 rule — management,
 * never the person who filed it, always with a reason.
 *
 *   GET  ?id=<id>                              one document, its files, its chain
 *   GET  [?state=&doc_type=&vendor_id=&person_email=&handler_id=&equipment_id=&q=&include_superseded=1]
 *   POST { action: 'create' | 'update' | 'renew' | 'void' | 'attach' | 'void_file' | 'remove_file', … }
 *
 * ── A PERSON'S CERTIFICATE (2026-10-14, Hyderabad #55 #56 #106 #107) ────────
 * Medical fitness, food-handler training and FoSTaC certificates are filed
 * against a FOOD HANDLER on the register (handler_id → fssai_food_handlers), who
 * does NOT need a login. Sending person_email alone still works for a login (the
 * Q18 fallback) and is linked to that person's register row when there is one.
 * The register and its coverage list live at /api/fssai/documents/food-handlers.
 *
 * ── FILES ARE VOIDED, NEVER STRIPPED (2026-10-14) ───────────────────────────
 * 'void_file' (and the old name 'remove_file', kept so the existing screen keeps
 * working) marks a mistaken scan VOID with a reason; the image stays in the row
 * and is listed under voided_files. Rules and the measured defect: ./files.ts.
 *
 * NO DELETE (§19).
 */
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 400;

/** The FSSAI licence's doc_type (FSSAI_DOC_TYPES). If that key were ever renamed
 *  the missing-licence warning would fire on every load — loud, never silent. */
const FSSAI_LICENCE_TYPE = 'fssai_licence';

/**
 * The register join is only written when the table exists — initializeSchema
 * swallows DDL errors per statement, so "the table is missing" is a state this
 * route must survive rather than 500 on (the house rule for a new table).
 */
function docSelect(db: any): string {
  const haveRegister = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='fssai_food_handlers'`).get();
  const haveVoid = !!db.prepare(`SELECT 1 FROM pragma_table_xinfo('fssai_attachments') WHERE name = 'status'`).get();
  const live = haveVoid ? `AND a.status <> 'void'` : '';
  return `
  SELECT d.*,
         dep.name AS department_name,
         v.name   AS vendor_name,
         prev.title AS supersedes_title, prev.expiry_date AS supersedes_expiry,
         prev.reference_no AS supersedes_reference_no,
         ${haveRegister ? `fh.full_name AS handler_name, fh.handler_no AS handler_no, fh.status AS handler_status,` : `'' AS handler_name, '' AS handler_no, '' AS handler_status,`}
         (SELECT COUNT(*) FROM fssai_attachments a
            WHERE a.entity_table = 'fssai_documents' AND a.entity_id = d.id ${live}) AS file_count,
         (SELECT COUNT(*) FROM fssai_attachments a
            WHERE a.entity_table = 'fssai_documents' AND a.entity_id = d.id ${haveVoid ? `AND a.status = 'void'` : 'AND 0'}) AS void_file_count,
         (SELECT nx.id FROM fssai_documents nx WHERE nx.supersedes_id = d.id
            ORDER BY nx.created_at DESC LIMIT 1) AS superseded_by_id
    FROM fssai_documents d
    LEFT JOIN departments     dep  ON dep.id  = d.department_id
    LEFT JOIN vendors         v    ON v.id    = d.vendor_id
    LEFT JOIN fssai_documents prev ON prev.id = d.supersedes_id
    ${haveRegister ? `LEFT JOIN fssai_food_handlers fh ON fh.id = d.handler_id AND d.handler_id <> ''` : ''}`;
}

function shape(row: any, todayISO: string, allFiles: DocFile[] = [], holderLabel = '') {
  const files = allFiles.filter((f) => !f.is_void);
  const voidedFiles = allFiles.filter((f) => f.is_void);
  const voided = !!str(row.voided_at);
  const expiry = str(row.expiry_date);
  const reminderDays = Number.isFinite(Number(row.reminder_days)) ? Number(row.reminder_days) : FSSAI_DOC_REMINDER_DAYS;
  // DERIVED, EVERY READ. Never a column (see the header).
  const state = fssaiDocState(expiry, todayISO, reminderDays);
  const stateMeta = fssaiDocStateMeta(state);
  const type = fssaiDocType(str(row.doc_type));
  const days = isISODate(expiry) ? daysBetweenISO(todayISO, expiry) : null;
  return {
    id: String(row.id),
    doc_code: str(row.doc_code),
    doc_type: str(row.doc_type),
    doc_type_label: type?.label || str(row.doc_type),
    /** 'outlet' | 'vendor' | 'person' | 'equipment' — which other field the form shows. */
    doc_scope: type?.scope || 'outlet',
    title: str(row.title),
    reference_no: str(row.reference_no),
    issuer: str(row.issuer),
    issued_on: str(row.issued_on),
    valid_from: str(row.valid_from),
    expiry_date: expiry,
    reminder_days: reminderDays,
    last_reminder_at: str(row.last_reminder_at),
    /** state, derived. 'no_expiry' for a blank date — never a green "Valid". */
    state,
    state_label: stateMeta.label,
    state_color: stateMeta.color,
    /** Negative = lapsed that many days ago. null = no expiry date recorded. */
    days_to_expiry: days !== null && Number.isFinite(days) ? days : null,
    owner_email: str(row.owner_email),
    department_id: str(row.department_id),
    department_name: str(row.department_name),
    vendor_id: str(row.vendor_id),
    vendor_name: str(row.vendor_name),
    person_email: str(row.person_email),
    /** fssai_food_handlers.id — the person a certificate belongs to, login or not. */
    handler_id: str(row.handler_id),
    handler_name: str(row.handler_name),
    handler_no: str(row.handler_no),
    handler_status: str(row.handler_status),
    /** Whose paper this is, in words, for any person-scope document ('' otherwise). */
    holder_label: holderLabel
      || (str(row.handler_name) ? `${str(row.handler_name)}${str(row.handler_no) ? ` (${str(row.handler_no)})` : ''}` : '')
      || str(row.person_email),
    equipment_id: str(row.equipment_id),
    supersedes_id: str(row.supersedes_id),
    supersedes: str(row.supersedes_id) && str(row.supersedes_title)
      ? {
        id: str(row.supersedes_id), title: str(row.supersedes_title),
        expiry_date: str(row.supersedes_expiry), reference_no: str(row.supersedes_reference_no),
      }
      : null,
    superseded_by_id: str(row.superseded_by_id),
    version: Number(row.version) || 1,
    notes: str(row.notes),
    status: voided ? 'void' : str(row.status),
    status_label: fssaiRecordStatusMeta(voided ? 'void' : str(row.status)).label,
    /** 0 once a renewal replaced it. The row is never deleted. */
    is_active: Number(row.is_active) === 1,
    voided_at: str(row.voided_at),
    voided_by: str(row.voided_by),
    void_reason: str(row.void_reason),
    created_by: str(row.created_by),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    /** LIVE files only. A voided scan is not a copy of the certificate. */
    file_count: Number(row.file_count) || 0,
    /** Voided scans: kept, image and all, listed under voided_files. */
    void_file_count: Number(row.void_file_count) || 0,
    files,
    voided_files: voidedFiles,
    file_limit: DOC_FILES_LIVE_LIMIT,
    is_editable: !voided && Number(row.is_active) === 1,
  };
}

/**
 * Validate the scope field a document type demands, and clear the three it does
 * not. Returns the refusal in words, or the four columns.
 *
 * Without this, a medical fitness certificate could carry a vendor id and a
 * supplier licence could carry a staff email, and the screen's "whose paper is
 * this" question would have four possible answers on every row.
 */
function resolveScope(
  db: any,
  docType: string,
  body: any,
  fallback: { vendor_id: string; person_email: string; handler_id: string; equipment_id: string; department_id: string },
): { error: string } | { vendor_id: string; person_email: string; handler_id: string; equipment_id: string; department_id: string } {
  const type = fssaiDocType(docType);
  const scope = type?.scope || 'outlet';
  const out = { vendor_id: '', person_email: '', handler_id: '', equipment_id: '', department_id: '' };

  out.department_id = body.department_id === undefined ? fallback.department_id : str(body.department_id);
  if (out.department_id) {
    const d = db.prepare(`SELECT id FROM departments WHERE id = ?`).get(out.department_id);
    if (!d) return { error: 'That department is not in the list.' };
  }

  if (scope === 'vendor') {
    out.vendor_id = body.vendor_id === undefined ? fallback.vendor_id : str(body.vendor_id);
    if (!out.vendor_id) return { error: `A ${type?.label || 'document'} belongs to a supplier. Pick which one.` };
    const v = db.prepare(`SELECT id FROM vendors WHERE id = ?`).get(out.vendor_id);
    if (!v) return { error: 'That supplier is not in the vendor list.' };
  } else if (scope === 'person') {
    // OWNER RULING Q18 (2026-10-14): the person is a FOOD HANDLER on the
    // register (handler_id), keyed on HRMS where HR is populated, else a login,
    // else the name alone — so a cook with no login can be covered. The email
    // stays as the fallback for a login: validated against the user list (a typo
    // cannot create a certificate belonging to nobody) and linked to that
    // person's register row when they have one. See resolveFssaiCertificateHolder.
    //
    // Which handler: the one the request names; else, when the request changes
    // the login, the one that login belongs to; else the one already on file.
    const emailIn = body.person_email === undefined ? undefined : str(body.person_email).trim().toLowerCase();
    const emailChanged = emailIn !== undefined && emailIn !== fallback.person_email.trim().toLowerCase();
    const handlerIn = body.handler_id !== undefined
      ? str(body.handler_id)
      : (emailChanged ? '' : fallback.handler_id);
    const who = resolveFssaiCertificateHolder(db, {
      handler_id: handlerIn,
      // A request that names the handler takes the login FROM the handler; the
      // old document's email must not be carried onto a different person.
      person_email: emailIn !== undefined ? emailIn : (body.handler_id !== undefined ? '' : fallback.person_email),
    });
    if ('error' in who) return { error: who.error };
    out.handler_id = who.handler_id;
    out.person_email = who.person_email;
  } else if (scope === 'equipment') {
    out.equipment_id = body.equipment_id === undefined ? fallback.equipment_id : str(body.equipment_id);
    if (!out.equipment_id) return { error: `A ${type?.label || 'document'} belongs to a piece of equipment. Pick which one.` };
    const eq = db.prepare(`SELECT id FROM fssai_equipment WHERE id = ?`).get(out.equipment_id);
    if (!eq) {
      // fssai_equipment holds 0 rows until the equipment register is populated.
      // Say so, rather than refusing with "not found" and leaving the user
      // hunting for a list that does not exist yet.
      return { error: 'The equipment register has no entry for that. Add the unit under Settings → Equipment first, then attach its certificate.' };
    }
  }
  return out;
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  // The catalog marks /fssai/documents mgmtOnly, but the catalog is VISIBILITY
  // and never security (canAccessPage fails open four ways, page_access is NULL
  // on 8 of 9 live users). This is the gate that holds. A staff phone gets 403
  // and the screen renders the house permission panel.
  if (!isManagement(me)) {
    return Response.json({ error: 'The licence and certificate cupboard is management only.' }, { status: 403 });
  }

  try {
    const db = getDb();
    const url = new URL(request.url);
    const today = fssaiToday();

    const SELECT = docSelect(db);
    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(`${SELECT} WHERE d.id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That document is no longer in the cupboard.' }, { status: 404 });
      // Live AND voided files, with their images: a voided scan is kept and shown as void.
      const files = documentFilesFor(db, [id], { withImage: true }).get(id) || [];
      const holder = fssaiDocumentHolders(db, [{ id, handler_id: row.handler_id, person_email: row.person_email }]).get(id);
      // The whole renewal chain, oldest first, so "were we covered in March" has
      // one answer on one screen. Bounded at 20 links: a licence renewed twenty
      // times is a long enough history for any inspection, and an unbounded walk
      // over a column with no FK is a loop waiting to happen.
      const chain: any[] = [];
      let cursor = str(row.supersedes_id);
      const seen = new Set<string>([String(row.id)]);
      while (cursor && chain.length < 20 && !seen.has(cursor)) {
        seen.add(cursor);
        const prev = db.prepare(
          `SELECT id, title, reference_no, issued_on, valid_from, expiry_date, version, is_active, voided_at
             FROM fssai_documents WHERE id = ?`,
        ).get(cursor) as any;
        if (!prev) break;
        chain.unshift(prev);
        cursor = '';
        const up = db.prepare(`SELECT supersedes_id FROM fssai_documents WHERE id = ?`).get(prev.id) as any;
        cursor = str(up?.supersedes_id);
      }
      return Response.json({
        document: shape(row, today, files, holder?.label || ''),
        chain,
        can_void: canManageFssaiCa(me),
        me: me.email,
        today,
      });
    }

    const where: string[] = [];
    const args: any[] = [];

    // Superseded rows are hidden by default and never deleted. A cupboard that
    // showed every version of every licence by default would bury the one that
    // is current, which is the one somebody is standing there asking for.
    if (str(url.searchParams.get('include_superseded')) !== '1') {
      where.push('d.is_active = 1');
    }
    if (str(url.searchParams.get('include_void')) !== '1') {
      where.push(`d.voided_at = ''`);
    }

    const docType = str(url.searchParams.get('doc_type'));
    if (docType) {
      if (!FSSAI_DOC_TYPES.some((t) => t.key === docType)) {
        return Response.json({ error: `"${docType}" is not a kind of document this cupboard holds.` }, { status: 400 });
      }
      where.push('d.doc_type = ?'); args.push(docType);
    }

    const vendorId = str(url.searchParams.get('vendor_id'));
    if (vendorId) { where.push('d.vendor_id = ?'); args.push(vendorId); }
    const personEmail = str(url.searchParams.get('person_email')).toLowerCase();
    if (personEmail) { where.push('lower(d.person_email) = ?'); args.push(personEmail); }
    const handlerId = str(url.searchParams.get('handler_id'));
    if (handlerId) { where.push('d.handler_id = ?'); args.push(handlerId); }
    const equipmentId = str(url.searchParams.get('equipment_id'));
    if (equipmentId) { where.push('d.equipment_id = ?'); args.push(equipmentId); }

    const q = str(url.searchParams.get('q'));
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      // The holder's name is searchable too — "Ravi's medical" is how it is asked for.
      where.push(`(lower(d.title) LIKE ? OR lower(d.reference_no) LIKE ? OR lower(d.issuer) LIKE ?
                   OR lower(d.doc_code) LIKE ? OR lower(d.notes) LIKE ? OR lower(IFNULL(v.name,'')) LIKE ?
                   OR lower(d.person_email) LIKE ? OR lower(IFNULL(handler_name,'')) LIKE ?)`);
      args.push(like, like, like, like, like, like, like, like);
    }

    const rows = db.prepare(
      `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
       ORDER BY
         -- A blank expiry sorts LAST, not first: '' < any date in SQLite, and a
         -- cupboard that opened with every undated paper would hide the licence
         -- that lapses on Friday.
         CASE WHEN d.expiry_date = '' THEN 1 ELSE 0 END ASC,
         d.expiry_date ASC, d.title ASC, d.rowid ASC
       LIMIT ${LIST_LIMIT + 1}`,
    ).all(...args) as any[];
    const truncated = rows.length > LIST_LIMIT;
    const page = truncated ? rows.slice(0, LIST_LIMIT) : rows;
    const files = documentFilesFor(db, page.map((r) => String(r.id)));
    const holders = fssaiDocumentHolders(db, page
      .filter((r) => fssaiDocType(str(r.doc_type))?.scope === 'person')
      .map((r) => ({ id: String(r.id), handler_id: r.handler_id, person_email: r.person_email })));
    let shaped = page.map((r) => shape(r, today, files.get(String(r.id)) || [], holders.get(String(r.id))?.label || ''));

    // The STATE filter has to be applied here, in JS, and not in SQL — because
    // the state is not a column. That is the cost of the decision in the header
    // and it is the right trade: a SQL filter would need a stored state, and a
    // stored state is the thing that goes stale at midnight.
    const state = str(url.searchParams.get('state'));
    if (state && state !== 'all') {
      if (!FSSAI_DOC_STATES.some((s) => s.key === state)) {
        return Response.json({ error: `"${state}" is not a state a document can be in.` }, { status: 400 });
      }
      shaped = shaped.filter((d) => d.state === state);
    }

    // The counts are derived over every live row, not over the page, for the same
    // reason the pest register's are: a tile reading "Expired 0" because the first
    // 400 rows happened to contain none is worse than no tile.
    const allLive = db.prepare(
      `SELECT expiry_date, reminder_days FROM fssai_documents WHERE is_active = 1 AND voided_at = ''`,
    ).all() as any[];
    const counts = { expired: 0, expiring: 0, valid: 0, no_expiry: 0, all: allLive.length };
    for (const r of allLive) {
      const s = fssaiDocState(
        str(r.expiry_date), today,
        Number.isFinite(Number(r.reminder_days)) ? Number(r.reminder_days) : FSSAI_DOC_REMINDER_DAYS,
      );
      counts[s] += 1;
    }

    // THE FIRST PAPER AN INSPECTOR ASKS FOR. Worked out over every live row and
    // NEVER over the filtered page: with the Kind filter on "Fire NOC" the
    // licence must not look missing, and a missing licence must not hide behind
    // a filter. Before this, nothing anywhere said when no licence was filed at
    // all — the counts read "0 lapsed" and the screen looked healthy.
    const licenceRows = db.prepare(
      `SELECT id, title, reference_no, expiry_date, reminder_days
         FROM fssai_documents
        WHERE doc_type = ? AND is_active = 1 AND voided_at = ''`,
    ).all(FSSAI_LICENCE_TYPE) as any[];
    const licenceStates = licenceRows.map((r) => ({
      id: String(r.id), title: str(r.title), reference_no: str(r.reference_no), expiry_date: str(r.expiry_date),
      state: fssaiDocState(
        str(r.expiry_date), today,
        Number.isFinite(Number(r.reminder_days)) ? Number(r.reminder_days) : FSSAI_DOC_REMINDER_DAYS,
      ),
    }));
    // The one to name on the screen: one still in force if there is one, the
    // latest-expiring among those, else the most recently lapsed.
    const inForce = licenceStates.filter((l) => l.state !== 'expired');
    const pick = (inForce.length ? inForce : licenceStates)
      .slice().sort((a, b) => (b.expiry_date || '9999-12-31').localeCompare(a.expiry_date || '9999-12-31'))[0] || null;
    const licence = {
      /** false = no live fssai_licence row at all. The screen's loudest warning. */
      on_file: licenceStates.length > 0,
      /** false when every licence on file has lapsed. */
      in_force: inForce.length > 0,
      current: pick
        ? { ...pick, days_to_expiry: isISODate(pick.expiry_date) ? daysBetweenISO(today, pick.expiry_date) : null }
        : null,
    };

    return Response.json({
      documents: shaped,
      counts,
      licence,
      doc_types: FSSAI_DOC_TYPES,
      states: FSSAI_DOC_STATES,
      default_reminder_days: FSSAI_DOC_REMINDER_DAYS,
      can_void: canManageFssaiCa(me),
      me: me.email,
      today,
      truncated,
      /* Said out loud so nobody infers it from a blank screen: the state is live
       * on every read, but NOTHING WAKES THE SYSTEM UP to tell anybody. §7 Q7 is
       * unruled and the sweep belongs to a later phase. */
      reminders_sent: false,
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/documents failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the documents' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;

  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;
  if (!isManagement(me)) {
    return Response.json({ error: 'The licence and certificate cupboard is management only.' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { body = {}; }
  const action = str(body.action);

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const today = fssaiToday();
    const SELECT = docSelect(db);

    /* ── CREATE ──────────────────────────────────────────────────────────── */
    if (action === 'create' || action === 'renew') {
      const isRenew = action === 'renew';
      let prev: any = null;
      if (isRenew) {
        prev = db.prepare(`SELECT * FROM fssai_documents WHERE id = ?`).get(str(body.id)) as any;
        if (!prev) return Response.json({ error: 'The document being renewed is no longer in the cupboard.' }, { status: 404 });
        if (str(prev.voided_at)) return Response.json({ error: 'That document was voided, so it cannot be renewed. File the new one as a new document.' }, { status: 409 });
        if (Number(prev.is_active) !== 1) {
          const nx = db.prepare(`SELECT id, title FROM fssai_documents WHERE supersedes_id = ? ORDER BY created_at DESC LIMIT 1`).get(prev.id) as any;
          return Response.json({
            error: nx
              ? 'That version has already been renewed. Renew the current one instead.'
              : 'That document is no longer the current version.',
          }, { status: 409 });
        }
      }

      const docType = str(body.doc_type) || (prev ? str(prev.doc_type) : '');
      if (!FSSAI_DOC_TYPES.some((t) => t.key === docType)) {
        return Response.json({ error: 'What kind of document is this? Pick one from the list.' }, { status: 400 });
      }
      // title is NOT NULL with no default on this table. A paper with no name is
      // a paper nobody can find in the cupboard.
      const title = (str(body.title) || (prev ? str(prev.title) : '')).trim();
      if (title.length < 3) {
        return Response.json({ error: 'Give the document a name — what you would call it if somebody asked for it.' }, { status: 400 });
      }

      const scope = resolveScope(db, docType, body, {
        vendor_id: prev ? str(prev.vendor_id) : '',
        person_email: prev ? str(prev.person_email) : '',
        // A renewal is the same person's next certificate.
        handler_id: prev ? str(prev.handler_id) : '',
        equipment_id: prev ? str(prev.equipment_id) : '',
        department_id: prev ? str(prev.department_id) : '',
      });
      if ('error' in scope) return Response.json({ error: scope.error }, { status: 400 });

      const issuedOn = isoDateOrBlank(body.issued_on);
      const validFrom = isoDateOrBlank(body.valid_from);
      const expiry = isoDateOrBlank(body.expiry_date);
      if (expiry && validFrom && expiry < validFrom) {
        return Response.json({ error: 'The expiry date is before the date the document becomes valid.' }, { status: 400 });
      }
      if (expiry && issuedOn && expiry < issuedOn) {
        return Response.json({ error: 'The expiry date is before the date the document was issued.' }, { status: 400 });
      }
      // A RENEWAL whose expiry is not later than the one it replaces is almost
      // always a typo, and the cost of the typo is a licence the file believes
      // lapsed. Refused rather than warned.
      if (isRenew && expiry && str(prev.expiry_date) && expiry <= str(prev.expiry_date)) {
        return Response.json({
          error: `This renewal expires on ${expiry}, which is not after the ${str(prev.expiry_date)} it replaces. Check the date.`,
        }, { status: 400 });
      }

      const reminderDays = intOrNull(body.reminder_days);
      if (reminderDays !== null && (reminderDays < 0 || reminderDays > 365)) {
        return Response.json({ error: 'The reminder window has to be between 0 and 365 days.' }, { status: 400 });
      }
      const ownerEmail = str(body.owner_email ?? (prev ? prev.owner_email : '')).trim().toLowerCase();
      if (ownerEmail) {
        const u = db.prepare(`SELECT email FROM users WHERE lower(email) = ?`).get(ownerEmail) as any;
        if (!u) return Response.json({ error: 'That is not somebody on the staff list — pick who is responsible for renewing this.' }, { status: 400 });
      }

      // doc_code is NOT allocated here. It is the stable key for a seeded or
      // well-known document (db.ts's own words), which makes it P8's namespace,
      // and uq_fssai_doc_code is unique on (outlet_id, doc_code) so a renewal
      // could not inherit one anyway. '' is the default and the partial index
      // allows any number of blanks.
      const docCode = str(body.doc_code);

      const id = generateId();
      const now = new Date().toISOString();
      try {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO fssai_documents
               (id, doc_code, doc_type, title, reference_no, issuer, issued_on, valid_from,
                expiry_date, reminder_days, owner_email, department_id, vendor_id, person_email,
                equipment_id, supersedes_id, version, notes, status, is_active,
                created_by, outlet_id, created_at, updated_at, handler_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted',1,?,?,?,?,?)`,
          ).run(
            id, docCode, docType, title.slice(0, 300),
            str(body.reference_no ?? (prev ? prev.reference_no : '')).slice(0, 200),
            str(body.issuer ?? (prev ? prev.issuer : '')).slice(0, 200),
            issuedOn, validFrom, expiry,
            reminderDays === null ? (prev ? Number(prev.reminder_days) || FSSAI_DOC_REMINDER_DAYS : FSSAI_DOC_REMINDER_DAYS) : reminderDays,
            ownerEmail, scope.department_id, scope.vendor_id, scope.person_email, scope.equipment_id,
            isRenew ? String(prev.id) : '',
            isRenew ? (Number(prev.version) || 1) + 1 : 1,
            str(body.notes).slice(0, 4000),
            me.email, outletId, now, now, scope.handler_id,
          );
          if (isRenew) {
            // The old row is retired, NOT deleted and NOT voided: it was a real,
            // valid licence for a real period, and §19's void is for a record
            // entered in error. is_active = 0 means "superseded".
            db.prepare(`UPDATE fssai_documents SET is_active = 0, updated_at = ? WHERE id = ?`).run(now, prev.id);
            fssaiAudit(db, {
              entity_table: 'fssai_documents', entity_id: String(prev.id), action: 'superseded',
              field: 'is_active', before: { is_active: 1, expiry_date: str(prev.expiry_date) },
              after: { is_active: 0, superseded_by: id, new_expiry_date: expiry },
              actor: { email: me.email, name: me.name }, outlet_id: outletId,
            });
          }
          fssaiAudit(db, {
            entity_table: 'fssai_documents', entity_id: id, action: isRenew ? 'renew' : 'create',
            after: {
              doc_type: docType, title, reference_no: str(body.reference_no), expiry_date: expiry,
              supersedes_id: isRenew ? String(prev.id) : '', version: isRenew ? (Number(prev.version) || 1) + 1 : 1,
              vendor_id: scope.vendor_id, person_email: scope.person_email, handler_id: scope.handler_id,
              equipment_id: scope.equipment_id,
            },
            actor: { email: me.email, name: me.name }, outlet_id: outletId,
          });
        })();
      } catch (e: any) {
        const msg = p6ConstraintMessage(e, '');
        if (msg) return Response.json({ error: msg }, { status: 409 });
        throw e;
      }
      fssaiAppAudit(db, {
        event_type: isRenew ? 'fssai_document_renew' : 'fssai_document_create',
        entity_type: 'fssai_documents', entity_id: id, actor_email: me.email,
        after: { doc_type: docType, title, expiry_date: expiry }, note: title,
      });
      const row = db.prepare(`${SELECT} WHERE d.id = ?`).get(id) as any;
      return Response.json({
        document: shape(row, today),
        created: !isRenew,
        renewed: isRenew,
        advice: expiry ? '' : 'No expiry date recorded. This document will sit under "No expiry" and nothing will ever warn you about it — add the date if it has one.',
      });
    }

    const id = str(body.id);
    if (!id) return Response.json({ error: 'Which document?' }, { status: 400 });
    const row = db.prepare(`SELECT * FROM fssai_documents WHERE id = ?`).get(id) as any;
    if (!row) return Response.json({ error: 'That document is no longer in the cupboard.' }, { status: 404 });
    const voided = !!str(row.voided_at);

    /* ── VOID (§19) ──────────────────────────────────────────────────────── */
    if (action === 'void') {
      const out = voidP6Record(db, {
        table: 'fssai_documents', id, reason: str(body.reason), me: me as any, outlet_id: outletId,
      });
      if ('error' in out) return Response.json({ error: out.error }, { status: out.status });
      const after = db.prepare(`${SELECT} WHERE d.id = ?`).get(id) as any;
      return Response.json({ document: shape(after, today), voided: true });
    }

    /* ── FILES — the scan or photograph of the paper itself ──────────────── */
    if (action === 'attach') {
      if (voided) return Response.json({ error: 'That document has been voided, so nothing more can be added to it.' }, { status: 409 });
      const out = db.transaction(() => insertDocumentFile(db, {
        document_id: id,
        kind: str(body.kind) || 'certificate', purpose: str(body.purpose), data_uri: str(body.data_uri),
        filename: str(body.filename), caption: str(body.caption),
        actor: { email: me.email, name: me.name }, outlet_id: outletId,
      }))();
      if ('error' in out) return Response.json({ error: out.error }, { status: out.status });
      return Response.json({ attachment: out.attachment });
    }

    /* ── VOID A FILE — never strip it ─────────────────────────────────────────
     * DECISION (2026-10-14), documented in full in ./files.ts: a mistaken scan is
     * VOIDED — status 'void' + who + when + why, an fssai_audit_log row, and the
     * image KEPT in the row and still listed (voided_files). The file must be on
     * THIS document: a file id from any other record or register is refused 404,
     * exactly like a missing one. 'remove_file' is the old name for the same act,
     * kept so the existing screen's button lands here and nowhere else; it no
     * longer removes anything. */
    if (action === 'void_file' || action === 'remove_file') {
      const out = voidDocumentFile(db, {
        document_id: id, attachment_id: str(body.attachment_id),
        reason: str(body.reason), me: me as any, outlet_id: outletId,
      });
      if ('error' in out) return Response.json({ error: out.error }, { status: out.status });
      return Response.json({
        voided: out.voided,
        // The old key, for the screen that still reads it. Same object: the file
        // was voided and KEPT, not removed.
        removed: out.voided,
        message: 'Scan voided. It stays on the document, marked void, with your reason.',
      });
    }

    /* ── UPDATE — correct the details on the CURRENT version ─────────────── */
    if (action === 'update') {
      if (voided) {
        return Response.json({ error: 'That document has been voided. A voided record is never edited — file it again.' }, { status: 409 });
      }
      if (Number(row.is_active) !== 1) {
        return Response.json({
          error: 'That is an older version, kept because it was valid at the time. Edit the current one instead — rewriting history is what the renewal chain exists to avoid.',
        }, { status: 409 });
      }
      const docType = body.doc_type === undefined ? str(row.doc_type) : str(body.doc_type);
      if (!FSSAI_DOC_TYPES.some((t) => t.key === docType)) {
        return Response.json({ error: 'That is not a kind of document this cupboard holds.' }, { status: 400 });
      }
      const title = (body.title === undefined ? str(row.title) : str(body.title)).trim();
      if (title.length < 3) return Response.json({ error: 'Give the document a name.' }, { status: 400 });

      const scope = resolveScope(db, docType, body, {
        vendor_id: str(row.vendor_id), person_email: str(row.person_email), handler_id: str(row.handler_id),
        equipment_id: str(row.equipment_id), department_id: str(row.department_id),
      });
      if ('error' in scope) return Response.json({ error: scope.error }, { status: 400 });
      // RE-POINTING A CERTIFICATE AT A DIFFERENT PERSON needs a reason, like moving
      // an expiry date: it changes who the register says is covered. Linking a
      // certificate that belonged to nobody on the register ('' → a person) is a
      // correction and needs none.
      const holderMoved = (!!str(row.handler_id) && scope.handler_id !== str(row.handler_id))
        || (!str(row.handler_id) && !!str(row.person_email) && scope.person_email !== str(row.person_email).toLowerCase());

      const issuedOn = body.issued_on === undefined ? str(row.issued_on) : isoDateOrBlank(body.issued_on);
      const validFrom = body.valid_from === undefined ? str(row.valid_from) : isoDateOrBlank(body.valid_from);
      const expiry = body.expiry_date === undefined ? str(row.expiry_date) : isoDateOrBlank(body.expiry_date);
      if (expiry && validFrom && expiry < validFrom) {
        return Response.json({ error: 'The expiry date is before the date the document becomes valid.' }, { status: 400 });
      }
      const reminderDays = intOrNull(body.reminder_days);
      if (reminderDays !== null && (reminderDays < 0 || reminderDays > 365)) {
        return Response.json({ error: 'The reminder window has to be between 0 and 365 days.' }, { status: 400 });
      }
      const ownerEmail = (body.owner_email === undefined ? str(row.owner_email) : str(body.owner_email)).trim().toLowerCase();
      if (ownerEmail && ownerEmail !== str(row.owner_email).toLowerCase()) {
        const u = db.prepare(`SELECT email FROM users WHERE lower(email) = ?`).get(ownerEmail) as any;
        if (!u) return Response.json({ error: 'That is not somebody on the staff list.' }, { status: 400 });
      }

      // MOVING AN EXPIRY DATE IS THE ONE CHANGE THAT NEEDS A REASON. Every other
      // field is a correction; this one changes whether the file says the
      // restaurant was covered, and §19 wants the reason for a change recorded.
      const expiryMoved = expiry !== str(row.expiry_date);
      const reason = str(body.reason).trim();
      if (expiryMoved && str(row.expiry_date) && reason.length < 4) {
        return Response.json({
          error: `This moves the expiry date from ${str(row.expiry_date)} to ${expiry || '(none)'}. Say in words why — that date decides whether the file says you were covered.`,
        }, { status: 400 });
      }
      if (holderMoved && reason.length < 4) {
        return Response.json({
          error: 'This moves the certificate to a different person. Say in words why — it changes who the register says is covered.',
        }, { status: 400 });
      }

      const before = {
        doc_type: str(row.doc_type), title: str(row.title), reference_no: str(row.reference_no),
        issuer: str(row.issuer), issued_on: str(row.issued_on), valid_from: str(row.valid_from),
        expiry_date: str(row.expiry_date), reminder_days: Number(row.reminder_days),
        owner_email: str(row.owner_email), vendor_id: str(row.vendor_id),
        person_email: str(row.person_email), handler_id: str(row.handler_id), equipment_id: str(row.equipment_id),
        department_id: str(row.department_id), notes: str(row.notes),
      };
      const now = new Date().toISOString();
      try {
        db.transaction(() => {
          db.prepare(
            `UPDATE fssai_documents
                SET doc_code = ?, doc_type = ?, title = ?, reference_no = ?, issuer = ?,
                    issued_on = ?, valid_from = ?, expiry_date = ?, reminder_days = ?,
                    owner_email = ?, department_id = ?, vendor_id = ?, person_email = ?,
                    equipment_id = ?, notes = ?, updated_at = ?, handler_id = ?
              WHERE id = ?`,
          ).run(
            body.doc_code === undefined ? str(row.doc_code) : str(body.doc_code),
            docType, title.slice(0, 300),
            str(body.reference_no ?? row.reference_no).slice(0, 200),
            str(body.issuer ?? row.issuer).slice(0, 200),
            issuedOn, validFrom, expiry,
            reminderDays === null ? Number(row.reminder_days) || FSSAI_DOC_REMINDER_DAYS : reminderDays,
            ownerEmail, scope.department_id, scope.vendor_id, scope.person_email, scope.equipment_id,
            str(body.notes ?? row.notes).slice(0, 4000), now, scope.handler_id, id,
          );
          fssaiAudit(db, {
            entity_table: 'fssai_documents', entity_id: id, action: 'update',
            field: expiryMoved ? 'expiry_date' : holderMoved ? 'handler_id' : '',
            before, after: {
              doc_type: docType, title, reference_no: str(body.reference_no ?? row.reference_no),
              expiry_date: expiry, owner_email: ownerEmail,
              vendor_id: scope.vendor_id, person_email: scope.person_email, handler_id: scope.handler_id,
              equipment_id: scope.equipment_id,
            },
            reason, actor: { email: me.email, name: me.name }, outlet_id: outletId,
          });
        })();
      } catch (e: any) {
        const msg = p6ConstraintMessage(e, '');
        if (msg) return Response.json({ error: msg }, { status: 409 });
        throw e;
      }
      const after = db.prepare(`${SELECT} WHERE d.id = ?`).get(id) as any;
      return Response.json({ document: shape(after, today), updated: true });
    }

    return Response.json({ error: `"${action || '(none)'}" is not something this screen can do.` }, { status: 400 });
  } catch (e: any) {
    console.error('POST /api/fssai/documents failed:', e);
    const msg = p6ConstraintMessage(e, '');
    if (msg) return Response.json({ error: msg }, { status: 409 });
    return Response.json({ error: e?.message || 'Could not save the document' }, { status: 500 });
  }
}
