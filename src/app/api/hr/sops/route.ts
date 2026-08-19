/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageHr } from '@/lib/hr';
import { notifyHrEmployee } from '@/lib/hr-notify';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR SOP Library (/api/hr/sops) — Phase 5.
 * Contract: docs/HRMS_DECISIONS.md (§5 Phase 5 tables; owner spec §24:
 * publishing a version assigns it and archives the previously published one;
 * assignments always point at a VERSION, never the SOP head).
 *
 * ONE file covers SOPs + versions + assignments. Subaction protocol
 * (documented here because the task allows either body.action or querystring —
 * this route uses **body.action**, the advances-route idiom):
 *   POST  creates things   — action 'create' (default when absent) | 'add_version'
 *   PATCH transitions state — action 'update' | 'publish' | 'acknowledge' | 'view'
 *
 * GET  ?q=&category=&department_id=&include_inactive=1&page=&pageSize=
 *        → { rows, total, page, pageSize }
 *      Server-side pagination (default 25, cap 100). Each row is an hr_sops
 *      row + department_name / designation_name (LEFT JOINs — a dangling id
 *      degrades to blank, never drops the SOP) + version_count + `published`
 *      (the currently-published version or null) + `versions`: every version
 *      WITHOUT its body, each carrying completion stats
 *      { assigned, viewed, acknowledged }. Inactive SOPs are hidden unless
 *      include_inactive=1.
 * GET  ?id=<sop_id> → { sop }
 *      Full detail: the same shape but versions INCLUDE body and an
 *      `assignments` array (employee_name / employee_code LEFT-JOINed).
 *
 * POST action 'create' { title (required), category?, department_id?,
 *      designation_id? } → { sop }
 *      department_id / designation_id are validated to exist (400, named
 *      message); duplicate active title → 409. Content is NOT accepted here —
 *      add a version next.
 * POST action 'add_version' { sop_id, body (required), require_ack? (default
 *      1) } → { version }
 *      Inserts the next version number as a DRAFT inside one transaction
 *      (MAX(version)+1 cannot race a concurrent add).
 *
 * PATCH action 'update' { id, title?, category?, department_id?,
 *      designation_id?, is_active? } → { sop }
 *      Head-only edits; only keys present in the body are touched
 *      (is_active is the soft delete — versions/assignments are never
 *      deleted).
 * PATCH action 'publish' { version_id, assign_to?: { department_id?,
 *      designation_id?, employee_ids? } } → { sop }
 *      In ONE transaction: archives the SOP's currently-published version,
 *      publishes this one (draft OR archived — republishing an archived
 *      version is a deliberate rollback path), and creates
 *      hr_sop_assignments for the resolved employees, skipping pairs that
 *      already exist (INSERT OR IGNORE against UNIQUE(sop_version_id,
 *      employee_id)). assign_to criteria UNION; department_id matches the
 *      MAIN department OR the sub-department. "Active only" = employees not
 *      in an exit state (resigned/terminated/former) — probation/confirmed/
 *      notice-period staff must still read SOPs, and suspended staff get the
 *      assignment for their return. Unknown/exited employee_ids are silently
 *      skipped. Audited as hr.sop.publish.
 * PATCH action 'acknowledge' { assignment_id } → { assignment }
 *      Stamps acknowledged_at (and viewed_at when still empty — you cannot
 *      acknowledge unseen). Keep-first: an already-acknowledged assignment
 *      returns unchanged, never re-stamped. NOTE: self-service is DEFERRED
 *      (HRMS_DECISIONS §8.3) — any canManageHr caller acknowledges ON BEHALF
 *      of the employee; the audit event records who actually clicked.
 * PATCH action 'view' { assignment_id } → { assignment }
 *      Stamps viewed_at (keep-first). Read-tracking telemetry, not audited.
 *
 * Every verb (GET included — the proxy does not protect API GETs, §2.1) gates
 * on canManageHr from '@/lib/hr'. Errors return GENERIC messages only —
 * e.message can leak schema/PII for HR data. employee_id is ALWAYS
 * hr_employees.id; actor columns (assigned_by, published_by, created_by) are
 * ALWAYS me.email — never mixed.
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** Escape %/_/\ for a LIKE ... ESCAPE '\' pattern. */
function likeEscape(v: string): string {
  return v.replace(/[\\%_]/g, (m) => '\\' + m);
}

/** SOP body cap — rich text, but not a dumping ground (photo-cap idiom). */
const MAX_BODY_CHARS = 500_000;

/**
 * Employees in these states never receive NEW assignments (see the publish
 * doc above). Deliberately NOT including 'suspended' — suspension pauses
 * punching, not employment.
 */
const EXITED_STATUSES = ['resigned', 'terminated', 'former'] as const;
const NOT_EXITED = `status NOT IN (${EXITED_STATUSES.map(() => '?').join(',')})`;

const SOP_SELECT = `
  SELECT s.*, d.name AS department_name, g.name AS designation_name
  FROM hr_sops s
  LEFT JOIN departments d ON d.id = s.department_id
  LEFT JOIN hr_designations g ON g.id = s.designation_id
`;

/**
 * Versions for a set of SOP ids, newest first, each with completion stats.
 * COUNT(a.id)/conditional SUMs over the LEFT JOIN give 0s for an unassigned
 * version, never NULLs. withBody=false is the list projection (a page of SOP
 * bodies does not belong in a table read).
 */
function versionsForSops(db: any, sopIds: string[], withBody: boolean): Map<string, any[]> {
  const map = new Map<string, any[]>();
  if (sopIds.length === 0) return map;
  const cols = withBody
    ? 'v.id, v.sop_id, v.version, v.body, v.status, v.require_ack, v.published_by, v.published_at, v.created_at'
    : 'v.id, v.sop_id, v.version, v.status, v.require_ack, v.published_by, v.published_at, v.created_at';
  const rows = db
    .prepare(
      `SELECT ${cols},
              COUNT(a.id) AS assigned,
              COALESCE(SUM(CASE WHEN a.viewed_at != '' THEN 1 ELSE 0 END), 0) AS viewed,
              COALESCE(SUM(CASE WHEN a.acknowledged_at != '' THEN 1 ELSE 0 END), 0) AS acknowledged
       FROM hr_sop_versions v
       LEFT JOIN hr_sop_assignments a ON a.sop_version_id = v.id
       WHERE v.sop_id IN (${sopIds.map(() => '?').join(',')})
       GROUP BY v.id
       ORDER BY v.version DESC, v.id`,
    )
    .all(...sopIds) as any[];
  for (const r of rows) {
    const list = map.get(r.sop_id);
    if (list) list.push(r);
    else map.set(r.sop_id, [r]);
  }
  return map;
}

/** Attach versions/version_count/published to a page of SOP head rows. */
function decorateSops(rows: any[], versionsBySop: Map<string, any[]>): void {
  for (const r of rows) {
    const versions = versionsBySop.get(r.id) ?? [];
    r.versions = versions;
    r.version_count = versions.length;
    r.published = versions.find((v) => v.status === 'published') ?? null;
  }
}

/**
 * Full single-SOP detail: head + every version (WITH body + stats) + each
 * version's assignments with LEFT-JOINed employee names (a dangling
 * employee_id degrades to blank, never drops the tracking row).
 */
function loadSop(db: any, id: string): any {
  const sop = db.prepare(`${SOP_SELECT} WHERE s.id = ?`).get(id) as any;
  if (!sop) return null;
  const versionsBySop = versionsForSops(db, [id], true);
  decorateSops([sop], versionsBySop);

  const versionIds = (sop.versions as any[]).map((v) => v.id);
  if (versionIds.length > 0) {
    const assignments = db
      .prepare(
        `SELECT a.*, e.full_name AS employee_name, e.employee_code AS employee_code
         FROM hr_sop_assignments a
         LEFT JOIN hr_employees e ON e.id = a.employee_id
         WHERE a.sop_version_id IN (${versionIds.map(() => '?').join(',')})
         ORDER BY e.full_name COLLATE NOCASE, a.id`,
      )
      .all(...versionIds) as any[];
    const byVersion = new Map<string, any[]>();
    for (const a of assignments) {
      const list = byVersion.get(a.sop_version_id);
      if (list) list.push(a);
      else byVersion.set(a.sop_version_id, [a]);
    }
    for (const v of sop.versions as any[]) v.assignments = byVersion.get(v.id) ?? [];
  }
  return sop;
}

/** One assignment row with its employee names, or null. */
function loadAssignment(db: any, id: string): any {
  return db
    .prepare(
      `SELECT a.*, e.full_name AS employee_name, e.employee_code AS employee_code
       FROM hr_sop_assignments a
       LEFT JOIN hr_employees e ON e.id = a.employee_id
       WHERE a.id = ?`,
    )
    .get(id);
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;
    const db = getDb();

    // ---- single-SOP detail ----
    const id = s(sp.get('id'));
    if (id) {
      const sop = loadSop(db, id);
      if (!sop) return Response.json({ error: 'SOP not found' }, { status: 404 });
      return Response.json({ sop });
    }

    // ---- paginated list ----
    // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
    // SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    // ONE clause + params feeds both COUNT(*) and the page query, so total
    // and rows can never disagree.
    const clauses: string[] = [];
    const params: any[] = [];
    if (sp.get('include_inactive') !== '1') clauses.push('s.is_active = 1');
    const q = s(sp.get('q'));
    if (q) {
      clauses.push(`(s.title LIKE ? ESCAPE '\\' OR s.category LIKE ? ESCAPE '\\')`);
      const pat = `%${likeEscape(q)}%`;
      params.push(pat, pat);
    }
    const category = s(sp.get('category'));
    if (category) {
      clauses.push('s.category = ?');
      params.push(category);
    }
    const department_id = s(sp.get('department_id'));
    if (department_id) {
      clauses.push('s.department_id = ?');
      params.push(department_id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_sops s ${where}`)
      .get(...params) as { n: number };

    const rows = db
      .prepare(
        `${SOP_SELECT} ${where}
         ORDER BY s.title COLLATE NOCASE, s.id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as any[];

    // Version list + stats for the whole page in ONE grouped query (no body
    // in the list projection), grouped in memory — not a query per row.
    decorateSops(rows, versionsForSops(db, rows.map((r) => r.id), false));

    return Response.json({ rows, total: totalRow.n, page, pageSize });
  } catch (e) {
    console.error('[hr-sops] GET failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load SOPs' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    let body: any = {};
    try { body = await request.json(); } catch { /* handled by field checks below */ }

    const action = s(body?.action) || 'create';
    const db = getDb();

    // ---- create: the SOP head (content arrives via add_version) ----
    if (action === 'create') {
      const title = s(body?.title);
      if (!title) return Response.json({ error: 'SOP title is required' }, { status: 400 });
      const category = s(body?.category);

      // CREATE validates referenced rows exist (reads stay LEFT-JOIN
      // tolerant; writes do not get to invent departments/designations).
      const department_id = s(body?.department_id);
      if (department_id) {
        const dep = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id);
        if (!dep) {
          return Response.json({ error: 'Selected department was not found' }, { status: 400 });
        }
      }
      const designation_id = s(body?.designation_id);
      if (designation_id) {
        const des = db
          .prepare('SELECT id FROM hr_designations WHERE id = ?')
          .get(designation_id);
        if (!des) {
          return Response.json({ error: 'Selected designation was not found' }, { status: 400 });
        }
      }

      // No UNIQUE on hr_sops.title in the schema — the duplicate gate lives
      // here, scoped to ACTIVE SOPs (a retired SOP's title may be reused).
      const dup = db
        .prepare('SELECT id FROM hr_sops WHERE is_active = 1 AND title = ? COLLATE NOCASE')
        .get(title);
      if (dup) {
        return Response.json(
          { error: 'A SOP with this title already exists' },
          { status: 409 },
        );
      }

      const id = generateId();
      const record = { id, title, category, department_id, designation_id, created_by: me.email };
      const create = db.transaction(() => {
        db.prepare(
          `INSERT INTO hr_sops (id, title, category, department_id, designation_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, title, category, department_id, designation_id, me.email);
        logAuditEvent(db, {
          event_type: 'hr.sop.create',
          entity_type: 'hr_sop',
          entity_id: id,
          actor_email: me.email,
          after: record,
        });
      });
      create();

      return Response.json({ sop: loadSop(db, id) });
    }

    // ---- add_version: next number, always a DRAFT ----
    if (action === 'add_version') {
      const sop_id = s(body?.sop_id);
      if (!sop_id) return Response.json({ error: 'SOP id is required' }, { status: 400 });
      // `body.body` is the SOP content (rich text / markdown) — kept verbatim,
      // only the blank-check trims.
      const content = String(body?.body ?? '');
      if (!content.trim()) {
        return Response.json({ error: 'SOP content is required' }, { status: 400 });
      }
      if (content.length > MAX_BODY_CHARS) {
        return Response.json({ error: 'SOP content is too large' }, { status: 400 });
      }
      const require_ack = body?.require_ack === undefined ? 1 : body.require_ack ? 1 : 0;

      const sop = db.prepare('SELECT id, title FROM hr_sops WHERE id = ?').get(sop_id) as any;
      if (!sop) {
        return Response.json({ error: 'Selected SOP was not found' }, { status: 400 });
      }

      const id = generateId();
      // MAX(version)+1 and the INSERT share one transaction so two concurrent
      // adds cannot mint the same number (UNIQUE(sop_id, version) backstops).
      const create = db.transaction(() => {
        const next = db
          .prepare(
            'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM hr_sop_versions WHERE sop_id = ?',
          )
          .get(sop_id) as { v: number };
        db.prepare(
          `INSERT INTO hr_sop_versions (id, sop_id, version, body, status, require_ack)
           VALUES (?, ?, ?, ?, 'draft', ?)`,
        ).run(id, sop_id, next.v, content, require_ack);
        logAuditEvent(db, {
          event_type: 'hr.sop.version.add',
          entity_type: 'hr_sop_version',
          entity_id: id,
          actor_email: me.email,
          // body excluded — SOP content does not belong in audit_events.
          after: { sop_id, sop_title: sop.title, version: next.v, status: 'draft', require_ack },
        });
      });
      create();

      const version = db.prepare('SELECT * FROM hr_sop_versions WHERE id = ?').get(id);
      return Response.json({ version });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    console.error('[hr-sops] POST failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to save the SOP' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    let body: any = {};
    try { body = await request.json(); } catch { /* handled by field checks below */ }

    const action = s(body?.action);
    if (!['update', 'publish', 'acknowledge', 'view'].includes(action)) {
      return Response.json({ error: 'Unknown action' }, { status: 400 });
    }
    const db = getDb();

    // ---- update: head-only edits; only keys PRESENT in the body change ----
    if (action === 'update') {
      const id = s(body?.id);
      if (!id) return Response.json({ error: 'SOP id is required' }, { status: 400 });
      const row = db.prepare('SELECT * FROM hr_sops WHERE id = ?').get(id) as any;
      if (!row) return Response.json({ error: 'SOP not found' }, { status: 404 });

      const has = (k: string) => Object.prototype.hasOwnProperty.call(body ?? {}, k);
      const sets: string[] = [];
      const params: any[] = [];
      const after: any = {};

      if (has('title')) {
        const title = s(body.title);
        if (!title) return Response.json({ error: 'SOP title is required' }, { status: 400 });
        const dup = db
          .prepare(
            'SELECT id FROM hr_sops WHERE is_active = 1 AND title = ? COLLATE NOCASE AND id != ?',
          )
          .get(title, id);
        if (dup) {
          return Response.json(
            { error: 'A SOP with this title already exists' },
            { status: 409 },
          );
        }
        sets.push('title = ?');
        params.push(title);
        after.title = title;
      }
      if (has('category')) {
        const category = s(body.category);
        sets.push('category = ?');
        params.push(category);
        after.category = category;
      }
      if (has('department_id')) {
        const department_id = s(body.department_id);
        if (department_id) {
          const dep = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id);
          if (!dep) {
            return Response.json({ error: 'Selected department was not found' }, { status: 400 });
          }
        }
        sets.push('department_id = ?');
        params.push(department_id);
        after.department_id = department_id;
      }
      if (has('designation_id')) {
        const designation_id = s(body.designation_id);
        if (designation_id) {
          const des = db
            .prepare('SELECT id FROM hr_designations WHERE id = ?')
            .get(designation_id);
          if (!des) {
            return Response.json({ error: 'Selected designation was not found' }, { status: 400 });
          }
        }
        sets.push('designation_id = ?');
        params.push(designation_id);
        after.designation_id = designation_id;
      }
      if (has('is_active')) {
        // Soft delete only — versions and assignment history stay forever.
        const is_active = body.is_active ? 1 : 0;
        sets.push('is_active = ?');
        params.push(is_active);
        after.is_active = is_active;
      }
      if (sets.length === 0) {
        return Response.json({ error: 'Nothing to update' }, { status: 400 });
      }

      const update = db.transaction(() => {
        db.prepare(
          `UPDATE hr_sops SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ).run(...params, id);
        logAuditEvent(db, {
          event_type: 'hr.sop.update',
          entity_type: 'hr_sop',
          entity_id: id,
          actor_email: me.email,
          before: {
            title: row.title,
            category: row.category,
            department_id: row.department_id,
            designation_id: row.designation_id,
            is_active: row.is_active,
          },
          after,
        });
      });
      update();

      return Response.json({ sop: loadSop(db, id) });
    }

    // ---- publish: archive current + publish this + assign, in ONE txn ----
    if (action === 'publish') {
      const version_id = s(body?.version_id);
      if (!version_id) {
        return Response.json({ error: 'Version id is required' }, { status: 400 });
      }
      const version = db
        .prepare('SELECT * FROM hr_sop_versions WHERE id = ?')
        .get(version_id) as any;
      if (!version) return Response.json({ error: 'Version not found' }, { status: 404 });
      if (version.status === 'published') {
        return Response.json({ error: 'This version is already published' }, { status: 409 });
      }
      const sop = db
        .prepare('SELECT * FROM hr_sops WHERE id = ?')
        .get(version.sop_id) as any;
      if (!sop) return Response.json({ error: 'SOP not found' }, { status: 404 });
      if (!sop.is_active) {
        return Response.json(
          { error: 'This SOP is deactivated - reactivate it before publishing' },
          { status: 409 },
        );
      }

      // Resolve the assignment audience (UNION of the criteria). All reads —
      // done before db.transaction() per the no-await/no-surprises rule.
      const assign_to =
        body?.assign_to && typeof body.assign_to === 'object' ? body.assign_to : {};
      const employeeIds = new Set<string>();

      const dep_id = s(assign_to.department_id);
      if (dep_id) {
        const dep = db.prepare('SELECT id FROM departments WHERE id = ?').get(dep_id);
        if (!dep) {
          return Response.json({ error: 'Selected department was not found' }, { status: 400 });
        }
        const emps = db
          .prepare(
            `SELECT id FROM hr_employees
             WHERE (department_id = ? OR sub_department_id = ?) AND ${NOT_EXITED}`,
          )
          .all(dep_id, dep_id, ...EXITED_STATUSES) as any[];
        for (const e of emps) employeeIds.add(e.id);
      }

      const desig_id = s(assign_to.designation_id);
      if (desig_id) {
        const des = db.prepare('SELECT id FROM hr_designations WHERE id = ?').get(desig_id);
        if (!des) {
          return Response.json({ error: 'Selected designation was not found' }, { status: 400 });
        }
        const emps = db
          .prepare(`SELECT id FROM hr_employees WHERE designation_id = ? AND ${NOT_EXITED}`)
          .all(desig_id, ...EXITED_STATUSES) as any[];
        for (const e of emps) employeeIds.add(e.id);
      }

      if (assign_to.employee_ids !== undefined) {
        if (!Array.isArray(assign_to.employee_ids)) {
          return Response.json(
            { error: 'assign_to.employee_ids must be a list' },
            { status: 400 },
          );
        }
        const wanted = [...new Set(assign_to.employee_ids.map(s).filter(Boolean))] as string[];
        if (wanted.length > 0) {
          // Only real, non-exited employees make it in; unknown ids are
          // silently skipped (the picker feeds this — no need to hard-fail).
          const emps = db
            .prepare(
              `SELECT id FROM hr_employees
               WHERE id IN (${wanted.map(() => '?').join(',')}) AND ${NOT_EXITED}`,
            )
            .all(...wanted, ...EXITED_STATUSES) as any[];
          for (const e of emps) employeeIds.add(e.id);
        }
      }

      const insertAssignment = db.prepare(
        `INSERT OR IGNORE INTO hr_sop_assignments (id, sop_version_id, employee_id, assigned_by)
         VALUES (?, ?, ?, ?)`,
      );
      let assignmentsCreated = 0;
      const publish = db.transaction(() => {
        // 1. Archive whatever is currently published for this SOP.
        const archived = db
          .prepare(
            `UPDATE hr_sop_versions SET status = 'archived'
             WHERE sop_id = ? AND status = 'published' AND id != ?`,
          )
          .run(version.sop_id, version_id);

        // 2. Publish this version — status-guarded so a lost race (someone
        //    published it in between) rolls everything back as a 409.
        const claimed = db
          .prepare(
            `UPDATE hr_sop_versions
             SET status = 'published', published_by = ?, published_at = datetime('now')
             WHERE id = ? AND status != 'published'`,
          )
          .run(me.email, version_id);
        if (claimed.changes !== 1) throw new Error('SOP_VERSION_ALREADY_PUBLISHED');

        db.prepare(`UPDATE hr_sops SET updated_at = datetime('now') WHERE id = ?`).run(
          version.sop_id,
        );

        // 3. Assign — INSERT OR IGNORE skips pairs that already exist
        //    (UNIQUE(sop_version_id, employee_id)), so republishing an
        //    archived version never duplicates its tracking rows.
        for (const employee_id of employeeIds) {
          const res = insertAssignment.run(generateId(), version_id, employee_id, me.email);
          assignmentsCreated += res.changes;
        }

        logAuditEvent(db, {
          event_type: 'hr.sop.publish',
          entity_type: 'hr_sop_version',
          entity_id: version_id,
          actor_email: me.email,
          before: { status: version.status },
          after: {
            status: 'published',
            sop_id: version.sop_id,
            sop_title: sop.title,
            version: version.version,
            archived_previous: archived.changes,
            audience: employeeIds.size,
            assignments_created: assignmentsCreated,
            assign_to: {
              department_id: dep_id,
              designation_id: desig_id,
              employee_ids: Array.isArray(assign_to.employee_ids)
                ? assign_to.employee_ids.length
                : 0,
            },
          },
        });
      });
      try {
        publish();
      } catch (e) {
        if (e instanceof Error && e.message === 'SOP_VERSION_ALREADY_PUBLISHED') {
          return Response.json({ error: 'This version is already published' }, { status: 409 });
        }
        throw e;
      }

      // Durable notifications + push (best-effort, AFTER the transaction
      // committed — a notify failure must never fail the publish). One row per
      // assigned employee; employees without a linked login are silently
      // skipped inside notifyHrEmployee (contract D1).
      try {
        for (const employee_id of employeeIds) {
          notifyHrEmployee(db, employee_id, {
            kind: 'hr.sop.publish',
            title: `New SOP published: ${sop.title}`,
            body: version.require_ack
              ? `Version ${version.version} requires your acknowledgement.`
              : `Version ${version.version} is now available.`,
            href: '/hr/sops',
          });
        }
      } catch { /* best-effort */ }

      return Response.json({ sop: loadSop(db, version.sop_id) });
    }

    // ---- acknowledge / view: per-person tracking stamps (keep-first) ----
    const assignment_id = s(body?.assignment_id);
    if (!assignment_id) {
      return Response.json({ error: 'Assignment id is required' }, { status: 400 });
    }
    const assignment = db
      .prepare('SELECT * FROM hr_sop_assignments WHERE id = ?')
      .get(assignment_id) as any;
    if (!assignment) return Response.json({ error: 'Assignment not found' }, { status: 404 });

    if (action === 'view') {
      // Keep-first stamp; already-viewed is simply returned, never re-stamped.
      db.prepare(
        `UPDATE hr_sop_assignments SET viewed_at = datetime('now')
         WHERE id = ? AND viewed_at = ''`,
      ).run(assignment_id);
      return Response.json({ assignment: loadAssignment(db, assignment_id) });
    }

    // acknowledge — ON BEHALF by a canManageHr caller (self-service deferred,
    // HRMS_DECISIONS §8.3); acknowledging implies having viewed.
    const res = db
      .prepare(
        `UPDATE hr_sop_assignments
         SET acknowledged_at = datetime('now'),
             viewed_at = CASE WHEN viewed_at = '' THEN datetime('now') ELSE viewed_at END
         WHERE id = ? AND acknowledged_at = ''`,
      )
      .run(assignment_id);
    if (res.changes === 1) {
      logAuditEvent(db, {
        event_type: 'hr.sop.acknowledge',
        entity_type: 'hr_sop_assignment',
        entity_id: assignment_id,
        actor_email: me.email,
        before: { acknowledged_at: '' },
        after: {
          sop_version_id: assignment.sop_version_id,
          employee_id: assignment.employee_id,
          acknowledged: true,
        },
        note: 'Acknowledged on behalf of the employee (self-service deferred)',
      });
    }
    return Response.json({ assignment: loadAssignment(db, assignment_id) });
  } catch (e) {
    console.error('[hr-sops] PATCH failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update the SOP' }, { status: 500 });
  }
}
