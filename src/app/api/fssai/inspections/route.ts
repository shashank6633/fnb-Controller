/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  FSSAI_FINDING_SEVERITIES, FSSAI_FINDING_STATUSES, FSSAI_INSPECTION_KINDS, FSSAI_INSPECTION_STATUSES,
  fssaiFindingSeverityRank, fssaiToday, fssaiVoidRefusal, isISODate,
} from '@/lib/fssai';
import { requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAppAudit, str, constraintMessage } from '@/lib/fssai-server';
import { fssaiTableExists, intOr, whereAll, departmentNames } from '../_p9/lib';

/**
 * INSPECTIONS AND THEIR FINDINGS (/api/fssai/inspections) — owner §16, §18.
 *
 * ── WHAT THIS RECORDS, AND WHAT IT IS NOT ───────────────────────────────────
 * A visit that ACTUALLY HAPPENED, and somebody else's findings against clauses
 * we did not write. It is deliberately not folded into the checklist engine: a
 * run is OUR record of OUR questions, and these are THEIR observations with
 * THEIR score and THEIR grade, recorded as printed. A blank score means none was
 * given — never 0, which would be a mark the inspector did not award.
 *
 * ── THE FIX LIVES ONCE, AND NOT HERE ────────────────────────────────────────
 * fssai_inspection_findings.ca_id joins to fssai_corrective_actions, which is
 * where every fix and its check already live (owner §7 Q14's ruling). This route
 * therefore does NOT re-implement a fix: `response` is what we told the
 * authority, and the work itself hangs off the corrective action.
 *
 * ⚠️ AND IT CANNOT RAISE ONE. /api/fssai/corrective-actions states in its own
 * header that it is "the ONLY route that writes fssai_corrective_actions after
 * the raise" and that there is "no way to create one by hand" — the only raiser
 * is a failed checklist answer. So a finding can be ATTACHED to a corrective
 * action that already exists (the id is validated against the table before it is
 * stored), and raising one straight from a finding is a genuine gap that belongs
 * to P7, not a shortcut to take here by inserting a row from this file. It is
 * written up in this lane's report rather than worked around.
 *
 * ── THE TWO COUNTERS, AND WHY RECOMPUTING THEM IS NOT A HISTORY REWRITE ─────
 * finding_count and open_count on the inspection are recomputed from the
 * findings inside the same transaction as any change to them. That is correct
 * BECAUSE THEY ARE NOT A VERDICT: "how many points are still open" is a
 * statement about now, and it changes as points close. The frozen-at-write rule
 * (is_fail / min_used / max_used) applies to a judgement made against a standard
 * at a moment in time, and nothing in this file touches one.
 *
 *   GET  ?id=<inspection>       one visit, with every finding on it
 *   GET  [?status=&kind=&from=&to=&department_id=&q=]   the history
 *   POST { action: 'create'|'update'|'close'|'reopen'|'void'
 *                 |'add_finding'|'update_finding'|'close_finding'|'reopen_finding', … }
 *
 * MANAGEMENT ONLY, both verbs. This holds a regulator's findings about the
 * business; §7 Q10's default is that cross-department and inspection material is
 * management's. A manager must be able to open it during a visit, which is why
 * it is not admin-only. NO DELETE: a visit that should not have been recorded is
 * VOIDED with a reason, and the row stays (§19).
 */
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 300;

/**
 * MAY THE PERSON WHO RECORDED AN INSPECTION VOID IT? No (owner §7 Q23 option a).
 *
 * Here as a named constant rather than an inline `false` because it is a POLICY
 * the owner has not yet ruled on, and because its cost is real and worth being
 * able to pay off in one line: with a single management account, a visit that
 * account recorded cannot be voided until a second manager exists.
 */
const FSSAI_INSPECTION_VOID_ALLOWS_RECORDER = false;

const KINDS = FSSAI_INSPECTION_KINDS.map((k) => k.key);
const STATUSES = FSSAI_INSPECTION_STATUSES.map((s) => s.key);
const SEVERITIES = FSSAI_FINDING_SEVERITIES.map((s) => s.key);
const FINDING_STATUSES = FSSAI_FINDING_STATUSES.map((s) => s.key);

/** Management only, in one place, so the two verbs cannot drift apart. */
function mgmtOnly(me: any): Response | null {
  if (!isManagement(me)) {
    return Response.json(
      { error: 'Inspection records are management only. Ask a manager or an administrator to open this.' },
      { status: 403 },
    );
  }
  return null;
}

/**
 * The registers this route needs must exist.
 *
 * Wave 1 declared them and did not open the database read-write, so they arrive
 * on the next cold start — and initializeSchema swallows schema errors per block
 * (HARD RULE 7), so a missing table on a real server looks exactly like one that
 * was never declared. A route that says so is worth far more than a 500 reading
 * "no such table: fssai_inspections".
 */
function requireTables(db: any): Response | null {
  const missing = ['fssai_inspections', 'fssai_inspection_findings'].filter((t) => !fssaiTableExists(db, t));
  if (missing.length) {
    return Response.json(
      {
        error:
          'The inspection register has not been created in this copy of the database yet. ' +
          'Restart the application once and it will be there.',
        missing_tables: missing,
      },
      { status: 503 },
    );
  }
  return null;
}

/** 'INS-2026-0001' — the house allocator (the CA / PINV / GRN model). */
function nextInspectionNo(db: any, isoDate: string, outletId: string): string {
  const year = /^\d{4}-/.test(String(isoDate || '')) ? String(isoDate).slice(0, 4) : String(new Date().getFullYear());
  const last = db.prepare(
    `SELECT MAX(CAST(substr(inspection_no, length('INS-' || ? || '-') + 1) AS INTEGER)) AS n
       FROM fssai_inspections
      WHERE inspection_no LIKE 'INS-' || ? || '-%' AND outlet_id = ?`,
  ).get(year, year, outletId) as any;
  return `INS-${year}-${String((Number(last?.n) || 0) + 1).padStart(4, '0')}`;
}

/** Recompute the two counters from the findings. Caller is inside a transaction. */
function recountFindings(db: any, inspectionId: string): { finding_count: number; open_count: number } {
  const r = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status <> 'closed' THEN 1 ELSE 0 END) AS open
       FROM fssai_inspection_findings WHERE inspection_id = ?`,
  ).get(inspectionId) as any;
  const counts = { finding_count: intOr(r?.total), open_count: intOr(r?.open) };
  db.prepare(
    `UPDATE fssai_inspections SET finding_count = ?, open_count = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(counts.finding_count, counts.open_count, inspectionId);
  return counts;
}

function shapeInspection(row: any, deptMap: Map<string, string>, today: string) {
  const open = intOr(row.open_count);
  return {
    ...row,
    department_name: deptMap.get(String(row.department_id || '')) || '',
    // Their number, as given. NULL stays null — a blank score is not a zero mark.
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    score_max: row.score_max === null || row.score_max === undefined ? null : Number(row.score_max),
    finding_count: intOr(row.finding_count),
    open_count: open,
    reply_overdue: !!String(row.reply_due_date || '') && String(row.reply_due_date) < today && String(row.status) !== 'closed',
    is_editable: !['closed', 'void'].includes(String(row.status || '')),
  };
}

function shapeFinding(row: any, deptMap: Map<string, string>, today: string) {
  return {
    ...row,
    department_name: deptMap.get(String(row.department_id || '')) || '',
    severity_rank: fssaiFindingSeverityRank(row.severity),
    overdue: String(row.status) !== 'closed' && !!String(row.due_date || '') && String(row.due_date) < today,
    sort_order: intOr(row.sort_order),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * GET
 * ══════════════════════════════════════════════════════════════════════════ */

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const deny = mgmtOnly(g.me);
  if (deny) return deny;

  try {
    const db = getDb();
    const gate = requireTables(db);
    if (gate) return gate;

    const url = new URL(request.url);
    const today = fssaiToday();
    const deptMap = departmentNames(db);

    /* ── ONE VISIT ──────────────────────────────────────────────────────── */
    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(`SELECT * FROM fssai_inspections WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That inspection no longer exists.' }, { status: 404 });
      const findings = db.prepare(
        `SELECT * FROM fssai_inspection_findings WHERE inspection_id = ? ORDER BY sort_order ASC, created_at ASC`,
      ).all(id) as any[];

      /* Every corrective action a finding points at, so the screen can show the
       * fix without a second round trip — and without re-implementing it. */
      const caIds = findings.map((f) => String(f.ca_id || '')).filter(Boolean);
      let actions: any[] = [];
      if (caIds.length && fssaiTableExists(db, 'fssai_corrective_actions')) {
        actions = db.prepare(
          `SELECT id, ca_number, title, status, severity, owner_email, due_date, action_taken, verified_by, verified_at
             FROM fssai_corrective_actions WHERE id IN (${caIds.map(() => '?').join(',')})`,
        ).all(...caIds) as any[];
      }

      /* The change-and-void trail for this one visit (§19). */
      const trail = db.prepare(
        `SELECT action, field, reason, actor_email, actor_name, created_at
           FROM fssai_audit_log
          WHERE entity_table = 'fssai_inspections' AND entity_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 50`,
      ).all(id) as any[];

      return Response.json({
        inspection: shapeInspection(row, deptMap, today),
        findings: findings.map((f) => shapeFinding(f, deptMap, today)),
        corrective_actions: actions,
        trail,
        today,
        vocab: {
          kinds: FSSAI_INSPECTION_KINDS, statuses: FSSAI_INSPECTION_STATUSES,
          severities: FSSAI_FINDING_SEVERITIES, finding_statuses: FSSAI_FINDING_STATUSES,
        },
      });
    }

    /* ── THE HISTORY ────────────────────────────────────────────────────── */
    /* ⚠️ NO DATE DEFAULT. RECON §7.2: "an inspection-history view defaults to
     * ALL records, and any date filter is a visible, deliberate choice." The
     * owner has already read a silently-windowed report as his books having been
     * lost; on an inspection history it would read as visits having vanished. */
    const from = str(url.searchParams.get('from'));
    const to = str(url.searchParams.get('to'));
    const status = str(url.searchParams.get('status'));
    const kind = str(url.searchParams.get('kind'));
    const departmentId = str(url.searchParams.get('department_id'));
    const q = str(url.searchParams.get('q')).trim().toLowerCase();

    const w = whereAll([
      isISODate(from) ? { sql: `i.business_date >= ?`, args: [from] } : null,
      isISODate(to) ? { sql: `i.business_date <= ?`, args: [to] } : null,
      status && status !== 'all'
        ? (status === 'active' ? { sql: `i.status <> 'void'`, args: [] } : { sql: `i.status = ?`, args: [status] })
        : null,
      kind ? { sql: `i.inspection_kind = ?`, args: [kind] } : null,
      departmentId ? { sql: `i.department_id = ?`, args: [departmentId] } : null,
      q
        ? {
            sql: `(lower(IFNULL(i.authority,'')) LIKE ? OR lower(IFNULL(i.inspector_name,'')) LIKE ?
                   OR lower(IFNULL(i.inspection_no,'')) LIKE ? OR lower(IFNULL(i.report_no,'')) LIKE ?
                   OR lower(IFNULL(i.scope,'')) LIKE ?)`,
            args: Array(5).fill(`%${q}%`),
          }
        : null,
    ]);

    const rows = db.prepare(
      `SELECT i.* FROM fssai_inspections i ${w.sql}
        ORDER BY i.business_date DESC, i.created_at DESC LIMIT ?`,
    ).all(...w.args, LIST_LIMIT + 1) as any[];
    const truncated = rows.length > LIST_LIMIT;
    const page = truncated ? rows.slice(0, LIST_LIMIT) : rows;

    const totals = db.prepare(
      `SELECT COUNT(*) AS visits,
              SUM(CASE WHEN status <> 'void' AND open_count > 0 THEN 1 ELSE 0 END) AS with_open,
              SUM(CASE WHEN status = 'void' THEN 1 ELSE 0 END) AS voided
         FROM fssai_inspections`,
    ).get() as any;

    return Response.json({
      inspections: page.map((r) => shapeInspection(r, deptMap, today)),
      truncated,
      filters_applied: {
        dates: isISODate(from) || isISODate(to) ? { from, to } : null,
        status: status || 'all',
        kind: kind || '',
        department_id: departmentId || '',
        q,
      },
      totals: {
        visits: intOr(totals?.visits),
        with_open_points: intOr(totals?.with_open),
        voided: intOr(totals?.voided),
      },
      departments: [...deptMap.entries()].map(([id2, name]) => ({ id: id2, name })),
      today,
      vocab: {
        kinds: FSSAI_INSPECTION_KINDS, statuses: FSSAI_INSPECTION_STATUSES,
        severities: FSSAI_FINDING_SEVERITIES, finding_statuses: FSSAI_FINDING_STATUSES,
      },
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/inspections failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the inspections' }, { status: 500 });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * POST
 * ══════════════════════════════════════════════════════════════════════════ */

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;

  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me as any;
  const deny = mgmtOnly(me);
  if (deny) return deny;

  let body: any = {};
  try { body = await request.json(); } catch { body = {}; }
  const action = str(body?.action);

  try {
    const db = getDb();
    const gate = requireTables(db);
    if (gate) return gate;

    const today = fssaiToday();
    const outletId = (await getCurrentOutletId()) || '';
    const actor = { email: me.email || '', name: me.name || '' };
    const deptMap = departmentNames(db);

    /* ══ CREATE ════════════════════════════════════════════════════════════ */
    if (action === 'create') {
      const businessDate = str(body?.business_date) || today;
      if (!isISODate(businessDate)) return Response.json({ error: 'Give the date of the visit as a real date.' }, { status: 400 });
      const kind = str(body?.inspection_kind) || 'internal';
      if (!KINDS.includes(kind)) return Response.json({ error: 'That is not a kind of inspection this app knows.' }, { status: 400 });
      const authority = str(body?.authority);
      const inspectorName = str(body?.inspector_name);
      if (!authority && !inspectorName) {
        return Response.json(
          { error: 'Say who inspected — the authority, the inspector’s name, or both. A visit with neither cannot be looked up later.' },
          { status: 400 },
        );
      }
      const replyDue = str(body?.reply_due_date);
      if (replyDue && !isISODate(replyDue)) return Response.json({ error: 'The reply deadline must be a real date.' }, { status: 400 });

      const score = body?.score === '' || body?.score === null || body?.score === undefined ? null : Number(body.score);
      const scoreMax = body?.score_max === '' || body?.score_max === null || body?.score_max === undefined ? null : Number(body.score_max);
      if (score !== null && !Number.isFinite(score)) return Response.json({ error: 'The score must be a number, or left blank.' }, { status: 400 });
      if (scoreMax !== null && !Number.isFinite(scoreMax)) return Response.json({ error: 'The score out of must be a number, or left blank.' }, { status: 400 });
      if (score !== null && scoreMax !== null && score > scoreMax) {
        return Response.json({ error: 'The score cannot be higher than the score it is out of.' }, { status: 400 });
      }

      const id = generateId();
      const requestedNo = str(body?.inspection_no);
      const statusIn = str(body?.status) || (businessDate > today ? 'planned' : 'in_progress');
      if (!STATUSES.includes(statusIn)) return Response.json({ error: 'That is not a state an inspection can be in.' }, { status: 400 });
      if (statusIn === 'void') return Response.json({ error: 'An inspection cannot be created already voided.' }, { status: 400 });

      const row = {
        id,
        inspection_no: requestedNo || nextInspectionNo(db, businessDate, outletId),
        inspection_kind: kind,
        authority,
        inspector_name: inspectorName,
        inspector_id_no: str(body?.inspector_id_no),
        business_date: businessDate,
        started_at: str(body?.started_at),
        finished_at: str(body?.finished_at),
        scope: str(body?.scope),
        department_id: str(body?.department_id),
        score, score_max: scoreMax,
        grade: str(body?.grade),
        outcome: str(body?.outcome),
        report_no: str(body?.report_no),
        document_id: str(body?.document_id),
        observations: str(body?.observations),
        our_response: str(body?.our_response),
        reply_due_date: replyDue,
        status: statusIn,
        accompanied_by: str(body?.accompanied_by) || String(me.email || ''),
      };

      try {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO fssai_inspections
               (id, inspection_no, inspection_kind, authority, inspector_name, inspector_id_no,
                business_date, started_at, finished_at, scope, department_id, score, score_max,
                grade, outcome, report_no, document_id, observations, our_response,
                finding_count, open_count, reply_due_date, status, accompanied_by, created_by, outlet_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
          ).run(
            row.id, row.inspection_no, row.inspection_kind, row.authority, row.inspector_name, row.inspector_id_no,
            row.business_date, row.started_at, row.finished_at, row.scope, row.department_id, row.score, row.score_max,
            row.grade, row.outcome, row.report_no, row.document_id, row.observations, row.our_response,
            row.reply_due_date, row.status, row.accompanied_by, String(me.email || ''), outletId,
          );
          fssaiAudit(db, { entity_table: 'fssai_inspections', entity_id: id, action: 'create', after: row, actor, outlet_id: outletId });
        })();
      } catch (e: any) {
        const msg = constraintMessage(e, '');
        if (msg || String(e?.message || '').includes('uq_fssai_insp_no')) {
          return Response.json({ error: `An inspection numbered ${row.inspection_no} already exists.` }, { status: 409 });
        }
        throw e;
      }

      fssaiAppAudit(db, {
        event_type: 'fssai_inspection_created', entity_type: 'fssai_inspections', entity_id: id,
        actor_email: String(me.email || ''), after: row, note: `${row.inspection_no} — ${row.authority || row.inspector_name}`,
      });

      const saved = db.prepare(`SELECT * FROM fssai_inspections WHERE id = ?`).get(id) as any;
      return Response.json({ inspection: shapeInspection(saved, deptMap, today), findings: [] });
    }

    /* Everything below needs an existing inspection or finding. */
    const id = str(body?.id);

    /* ══ UPDATE ════════════════════════════════════════════════════════════ */
    if (action === 'update') {
      if (!id) return Response.json({ error: 'Which inspection?' }, { status: 400 });
      const before = db.prepare(`SELECT * FROM fssai_inspections WHERE id = ?`).get(id) as any;
      if (!before) return Response.json({ error: 'That inspection no longer exists.' }, { status: 404 });
      if (String(before.status) === 'void') return Response.json({ error: 'That inspection has been voided. A voided record is never edited.' }, { status: 409 });
      if (String(before.status) === 'closed') {
        return Response.json(
          { error: 'That inspection is closed. Reopen it first — so the file shows that it was reopened, and by whom.' },
          { status: 409 },
        );
      }

      /* Only these fields. status is moved by close/reopen/void so that every
       * state change leaves its own audit row with its own reason, and
       * finding_count / open_count are derived, never sent by a caller. */
      const EDITABLE = [
        'inspection_kind', 'authority', 'inspector_name', 'inspector_id_no', 'business_date',
        'started_at', 'finished_at', 'scope', 'department_id', 'grade', 'outcome', 'report_no',
        'document_id', 'observations', 'our_response', 'reply_due_date', 'accompanied_by',
      ] as const;

      const next: any = {};
      for (const f of EDITABLE) if (body[f] !== undefined) next[f] = str(body[f]);
      if (body.score !== undefined) next.score = body.score === '' || body.score === null ? null : Number(body.score);
      if (body.score_max !== undefined) next.score_max = body.score_max === '' || body.score_max === null ? null : Number(body.score_max);

      if (next.business_date !== undefined && !isISODate(next.business_date)) {
        return Response.json({ error: 'The date of the visit must be a real date.' }, { status: 400 });
      }
      if (next.reply_due_date !== undefined && next.reply_due_date && !isISODate(next.reply_due_date)) {
        return Response.json({ error: 'The reply deadline must be a real date.' }, { status: 400 });
      }
      if (next.inspection_kind !== undefined && !KINDS.includes(next.inspection_kind)) {
        return Response.json({ error: 'That is not a kind of inspection this app knows.' }, { status: 400 });
      }
      if (next.score !== undefined && next.score !== null && !Number.isFinite(next.score)) {
        return Response.json({ error: 'The score must be a number, or left blank.' }, { status: 400 });
      }
      if (next.score_max !== undefined && next.score_max !== null && !Number.isFinite(next.score_max)) {
        return Response.json({ error: 'The score out of must be a number, or left blank.' }, { status: 400 });
      }
      const keys = Object.keys(next);
      if (!keys.length) return Response.json({ error: 'Nothing was changed.' }, { status: 400 });

      db.transaction(() => {
        db.prepare(
          `UPDATE fssai_inspections SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ).run(...keys.map((k) => next[k]), id);
        const changedBefore: any = {}; for (const k of keys) changedBefore[k] = before[k];
        fssaiAudit(db, {
          entity_table: 'fssai_inspections', entity_id: id, action: 'update',
          before: changedBefore, after: next, reason: str(body?.reason), actor, outlet_id: outletId,
        });
      })();

      const saved = db.prepare(`SELECT * FROM fssai_inspections WHERE id = ?`).get(id) as any;
      return Response.json({ inspection: shapeInspection(saved, deptMap, today) });
    }

    /* ══ CLOSE / REOPEN ════════════════════════════════════════════════════ */
    if (action === 'close' || action === 'reopen') {
      if (!id) return Response.json({ error: 'Which inspection?' }, { status: 400 });
      const before = db.prepare(`SELECT * FROM fssai_inspections WHERE id = ?`).get(id) as any;
      if (!before) return Response.json({ error: 'That inspection no longer exists.' }, { status: 404 });
      if (String(before.status) === 'void') return Response.json({ error: 'That inspection has been voided.' }, { status: 409 });

      if (action === 'close') {
        if (String(before.status) === 'closed') return Response.json({ error: 'That inspection is already closed.' }, { status: 409 });
        /* ⚠️ REFUSED WHILE A POINT IS STILL OPEN, and the refusal names the
         * number. Closing a visit with points outstanding is the one thing a
         * compliance file must not be able to say quietly — the next inspector
         * reads "closed" and finds the same problem. A point the authority did
         * not accept has its own finding status, 'not_accepted', for the case
         * where the point itself is settled without being fixed. */
        const openPoints = db.prepare(
          `SELECT COUNT(*) AS n FROM fssai_inspection_findings WHERE inspection_id = ? AND status <> 'closed'`,
        ).get(id) as any;
        if (intOr(openPoints?.n) > 0) {
          return Response.json(
            {
              error:
                `${intOr(openPoints?.n)} point${intOr(openPoints?.n) === 1 ? ' is' : 's are'} still open on this inspection. ` +
                'Close each one with what was done, or mark it as not accepted — then close the visit.',
              open_count: intOr(openPoints?.n),
            },
            { status: 409 },
          );
        }
        const note = str(body?.note);
        db.transaction(() => {
          db.prepare(
            `UPDATE fssai_inspections
                SET status = 'closed', closed_at = datetime('now'), closed_by = ?,
                    our_response = CASE WHEN ? <> '' THEN ? ELSE our_response END,
                    updated_at = datetime('now')
              WHERE id = ?`,
          ).run(String(me.email || ''), note, note, id);
          fssaiAudit(db, {
            entity_table: 'fssai_inspections', entity_id: id, action: 'close',
            before: { status: before.status }, after: { status: 'closed' }, reason: note, actor, outlet_id: outletId,
          });
        })();
      } else {
        if (String(before.status) !== 'closed') return Response.json({ error: 'That inspection is not closed.' }, { status: 409 });
        const reason = str(body?.reason);
        if (reason.trim().length < 4) {
          return Response.json({ error: 'Say in words why this inspection is being reopened — a reopen with no reason is not an audit trail.' }, { status: 400 });
        }
        db.transaction(() => {
          db.prepare(
            `UPDATE fssai_inspections SET status = 'open', closed_at = '', closed_by = '', updated_at = datetime('now') WHERE id = ?`,
          ).run(id);
          fssaiAudit(db, {
            entity_table: 'fssai_inspections', entity_id: id, action: 'reopen',
            before: { status: 'closed' }, after: { status: 'open' }, reason, actor, outlet_id: outletId,
          });
        })();
        recountFindings(db, id);
      }

      const saved = db.prepare(`SELECT * FROM fssai_inspections WHERE id = ?`).get(id) as any;
      return Response.json({ inspection: shapeInspection(saved, deptMap, today) });
    }

    /* ══ VOID ══════════════════════════════════════════════════════════════ */
    if (action === 'void') {
      if (!id) return Response.json({ error: 'Which inspection?' }, { status: 400 });
      const before = db.prepare(`SELECT * FROM fssai_inspections WHERE id = ?`).get(id) as any;
      const reason = str(body?.reason);
      /* The SHARED rule (§19 / §7 Q23): management only, never the person who
       * recorded it, always a reason in words. One helper so the eight record
       * lanes cannot each drop a different half of it. */
      const refusal = fssaiVoidRefusal(me, before, reason);
      if (refusal) return Response.json({ error: refusal }, { status: before ? 403 : 404 });
      /* ⚠️ NEVER THE PERSON WHO RECORDED IT, AND THERE IS NO ADMIN EXEMPTION.
       *
       * fssaiVoidRefusal enforces the management tier and the written reason,
       * but it cannot enforce the recorder half of the rule: its signature takes
       * only { status, voided_at } and does not know which column this table
       * uses for its author. So that half is applied here, against created_by.
       *
       * THE CONSEQUENCE, STATED RATHER THAN DISCOVERED: if one person is the
       * only management account and they recorded the visit, nobody can void it
       * until a second manager exists. That is owner §7 Q23 option (a) applied
       * literally — "never the person who wrote the record" — and it is the
       * SAFE direction, because the alternative is that the one person who might
       * want a finding to disappear is also the one who can remove it. One
       * constant reverses it if he would rather trade that away. */
      if (
        !FSSAI_INSPECTION_VOID_ALLOWS_RECORDER &&
        String(before.created_by || '').trim().toLowerCase() === String(me.email || '').trim().toLowerCase()
      ) {
        return Response.json(
          {
            error:
              'You recorded this inspection, so somebody else in management must void it. ' +
              'That separation is the point of the rule — a record and its cancellation should not be one person’s decision.',
          },
          { status: 403 },
        );
      }

      db.transaction(() => {
        db.prepare(
          `UPDATE fssai_inspections
              SET status = 'void', voided_at = datetime('now'), voided_by = ?, void_reason = ?, updated_at = datetime('now')
            WHERE id = ?`,
        ).run(String(me.email || ''), reason, id);
        fssaiAudit(db, {
          entity_table: 'fssai_inspections', entity_id: id, action: 'void',
          before: { status: before.status }, after: { status: 'void' }, reason, actor, outlet_id: outletId,
        });
      })();

      fssaiAppAudit(db, {
        event_type: 'fssai_inspection_voided', entity_type: 'fssai_inspections', entity_id: id,
        actor_email: String(me.email || ''), before: { status: before.status }, after: { status: 'void' }, note: reason,
      });

      const saved = db.prepare(`SELECT * FROM fssai_inspections WHERE id = ?`).get(id) as any;
      return Response.json({ inspection: shapeInspection(saved, deptMap, today) });
    }

    /* ══ A FINDING ═════════════════════════════════════════════════════════ */
    if (action === 'add_finding') {
      const inspectionId = str(body?.inspection_id);
      if (!inspectionId) return Response.json({ error: 'Which inspection does this point belong to?' }, { status: 400 });
      const insp = db.prepare(`SELECT * FROM fssai_inspections WHERE id = ?`).get(inspectionId) as any;
      if (!insp) return Response.json({ error: 'That inspection no longer exists.' }, { status: 404 });
      if (['void', 'closed'].includes(String(insp.status))) {
        return Response.json({ error: 'That inspection is closed or voided. Reopen it before adding a point.' }, { status: 409 });
      }
      const observation = str(body?.observation).trim();
      if (!observation) {
        return Response.json({ error: 'Write down what was observed. A point with no observation cannot be answered at the next visit.' }, { status: 400 });
      }
      const severity = str(body?.severity) || 'minor';
      if (!SEVERITIES.includes(severity)) return Response.json({ error: 'That is not a severity this app knows.' }, { status: 400 });
      const dueDate = str(body?.due_date);
      if (dueDate && !isISODate(dueDate)) return Response.json({ error: 'The deadline must be a real date.' }, { status: 400 });

      /* THE FIX LIVES ONCE. An id is accepted only if that corrective action
       * really exists — a dangling ca_id would render as a fix nobody can open. */
      const caId = str(body?.ca_id);
      if (caId) {
        if (!fssaiTableExists(db, 'fssai_corrective_actions')) {
          return Response.json({ error: 'Corrective actions are not available in this copy of the database yet.' }, { status: 503 });
        }
        const ca = db.prepare(`SELECT id FROM fssai_corrective_actions WHERE id = ?`).get(caId) as any;
        if (!ca) return Response.json({ error: 'That corrective action does not exist.' }, { status: 400 });
      }

      const fid = generateId();
      const nextOrder = intOr(
        (db.prepare(`SELECT MAX(sort_order) AS n FROM fssai_inspection_findings WHERE inspection_id = ?`).get(inspectionId) as any)?.n,
      ) + 1;
      const findingNo = str(body?.finding_no) || String(nextOrder);
      const row = {
        id: fid, inspection_id: inspectionId, finding_no: findingNo,
        clause_ref: str(body?.clause_ref), category: str(body?.category), severity,
        observation, department_id: str(body?.department_id) || String(insp.department_id || ''),
        location_label: str(body?.location_label), due_date: dueDate, ca_id: caId,
        response: str(body?.response), status: 'open', sort_order: nextOrder,
      };

      db.transaction(() => {
        db.prepare(
          `INSERT INTO fssai_inspection_findings
             (id, inspection_id, finding_no, clause_ref, category, severity, observation,
              department_id, location_label, due_date, ca_id, response, status, sort_order, outlet_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id, row.inspection_id, row.finding_no, row.clause_ref, row.category, row.severity, row.observation,
          row.department_id, row.location_label, row.due_date, row.ca_id, row.response, row.status, row.sort_order, outletId,
        );
        fssaiAudit(db, { entity_table: 'fssai_inspection_findings', entity_id: fid, action: 'create', after: row, actor, outlet_id: outletId });
        recountFindings(db, inspectionId);
        /* A visit that has raised a point is no longer merely "in progress". */
        if (['planned', 'in_progress'].includes(String(insp.status))) {
          db.prepare(`UPDATE fssai_inspections SET status = 'open', updated_at = datetime('now') WHERE id = ?`).run(inspectionId);
        }
      })();

      const saved = db.prepare(`SELECT * FROM fssai_inspection_findings WHERE id = ?`).get(fid) as any;
      const insp2 = db.prepare(`SELECT * FROM fssai_inspections WHERE id = ?`).get(inspectionId) as any;
      return Response.json({ finding: shapeFinding(saved, deptMap, today), inspection: shapeInspection(insp2, deptMap, today) });
    }

    if (action === 'update_finding' || action === 'close_finding' || action === 'reopen_finding') {
      if (!id) return Response.json({ error: 'Which point?' }, { status: 400 });
      const before = db.prepare(`SELECT * FROM fssai_inspection_findings WHERE id = ?`).get(id) as any;
      if (!before) return Response.json({ error: 'That point no longer exists.' }, { status: 404 });
      const insp = db.prepare(`SELECT * FROM fssai_inspections WHERE id = ?`).get(String(before.inspection_id)) as any;
      if (insp && String(insp.status) === 'void') {
        return Response.json({ error: 'That inspection has been voided.' }, { status: 409 });
      }

      const next: any = {};
      if (action === 'update_finding') {
        for (const f of ['finding_no', 'clause_ref', 'category', 'observation', 'department_id', 'location_label', 'due_date', 'response'] as const) {
          if (body[f] !== undefined) next[f] = str(body[f]);
        }
        if (body.severity !== undefined) {
          const sev = str(body.severity);
          if (!SEVERITIES.includes(sev)) return Response.json({ error: 'That is not a severity this app knows.' }, { status: 400 });
          next.severity = sev;
        }
        if (body.status !== undefined) {
          const st = str(body.status);
          if (!FINDING_STATUSES.includes(st)) return Response.json({ error: 'That is not a state a point can be in.' }, { status: 400 });
          next.status = st;
        }
        if (body.ca_id !== undefined) {
          const caId = str(body.ca_id);
          if (caId) {
            const ca = fssaiTableExists(db, 'fssai_corrective_actions')
              ? (db.prepare(`SELECT id FROM fssai_corrective_actions WHERE id = ?`).get(caId) as any)
              : null;
            if (!ca) return Response.json({ error: 'That corrective action does not exist.' }, { status: 400 });
          }
          next.ca_id = caId;
        }
        if (next.observation !== undefined && !String(next.observation).trim()) {
          return Response.json({ error: 'A point cannot be left with no observation.' }, { status: 400 });
        }
        if (next.due_date !== undefined && next.due_date && !isISODate(next.due_date)) {
          return Response.json({ error: 'The deadline must be a real date.' }, { status: 400 });
        }
      } else if (action === 'close_finding') {
        if (String(before.status) === 'closed') return Response.json({ error: 'That point is already closed.' }, { status: 409 });
        const response = str(body?.response).trim();
        /* CLOSING A POINT REQUIRES SAYING WHAT WAS DONE. "Closed" with nothing
         * beside it is how a compliance file becomes a list of ticks, and the
         * next inspector asks exactly this question. */
        if (response.length < 4) {
          return Response.json(
            { error: 'Say what was done about this point before closing it. A point closed with no answer is the first thing asked about at the next visit.' },
            { status: 400 },
          );
        }
        next.response = response;
        next.status = str(body?.not_accepted) === '1' ? 'not_accepted' : 'closed';
        next.closed_at = new Date().toISOString();
        next.closed_by = String(me.email || '');
      } else {
        if (!['closed', 'not_accepted'].includes(String(before.status))) {
          return Response.json({ error: 'That point is not closed.' }, { status: 409 });
        }
        const reason = str(body?.reason);
        if (reason.trim().length < 4) {
          return Response.json({ error: 'Say in words why this point is being reopened.' }, { status: 400 });
        }
        next.status = 'open';
        next.closed_at = '';
        next.closed_by = '';
      }

      const keys = Object.keys(next);
      if (!keys.length) return Response.json({ error: 'Nothing was changed.' }, { status: 400 });

      db.transaction(() => {
        db.prepare(
          `UPDATE fssai_inspection_findings SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ).run(...keys.map((k) => next[k]), id);
        const changedBefore: any = {}; for (const k of keys) changedBefore[k] = before[k];
        fssaiAudit(db, {
          entity_table: 'fssai_inspection_findings', entity_id: id,
          action: action === 'close_finding' ? 'close' : action === 'reopen_finding' ? 'reopen' : 'update',
          before: changedBefore, after: next, reason: str(body?.reason) || str(body?.response), actor, outlet_id: outletId,
        });
        recountFindings(db, String(before.inspection_id));
      })();

      const saved = db.prepare(`SELECT * FROM fssai_inspection_findings WHERE id = ?`).get(id) as any;
      const insp2 = db.prepare(`SELECT * FROM fssai_inspections WHERE id = ?`).get(String(before.inspection_id)) as any;
      return Response.json({
        finding: shapeFinding(saved, deptMap, today),
        inspection: insp2 ? shapeInspection(insp2, deptMap, today) : null,
      });
    }

    return Response.json(
      { error: 'That is not something this screen can do. Expected create, update, close, reopen, void, or one of the point actions.' },
      { status: 400 },
    );
  } catch (e: any) {
    console.error(`POST /api/fssai/inspections (${action}) failed:`, e);
    const friendly = constraintMessage(e, '');
    return Response.json({ error: friendly || e?.message || 'Could not save that' }, { status: 500 });
  }
}
