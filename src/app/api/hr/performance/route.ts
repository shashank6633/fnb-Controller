/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr, type HrKpi, type HrPerformanceReview } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Performance reviews (/api/hr/performance) — HRMS Phase 6.
 * Contract: docs/HRMS_DECISIONS.md. Reviews are IMMUTABLE once written —
 * there is deliberately no PUT/PATCH/DELETE here; a correction is a NEW
 * period entry (UNIQUE(employee_id, period, kind) enforces one per slot).
 *
 * GET  /api/hr/performance?employee_id=&period=&kind=&page=&pageSize=
 *        → { rows, total, page, pageSize }
 *      Server-side pagination (default 25, cap 100); COUNT(*) shares the
 *      WHERE. Rows LEFT JOIN hr_employees for employee_name / employee_code —
 *      a dangling employee_id degrades to blank, never drops the review.
 *
 * POST /api/hr/performance { employee_id, period, kind?, scores_json, remarks? }
 *        → { review }
 *      `overall` is computed SERVER-SIDE as the weight-weighted mean of the
 *      per-KPI scores against hr_kpis.weight (never trusted from the client).
 *      employee_id and every scores_json kpi_id are validated to exist (400
 *      with a named message — the mapping contract: refs validated on CREATE).
 *      409 on the UNIQUE(employee_id, period, kind) slot.
 *
 * Both verbs gate on canManageHr — the proxy does NOT guard API GETs; this
 * handler is the security boundary (HRMS §2.1). Error bodies are GENERIC on
 * 500 (never e.message).
 */
export const dynamic = 'force-dynamic';

/** All values hr_performance_reviews.kind accepts (db.ts column comment). */
const REVIEW_KINDS = ['monthly', 'quarterly', 'annual'] as const;
type ReviewKind = (typeof REVIEW_KINDS)[number];

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

interface ScoreEntry {
  kpi_id: string;
  score: number;
  note: string;
}

/**
 * Normalise a scores_json body value (array OR pre-stringified JSON) into
 * [{kpi_id, score, note}] rows. Returns a string error message when the shape
 * is invalid (kpi existence is checked separately, against the DB).
 */
function parseScores(v: unknown): ScoreEntry[] | string {
  let arr: unknown = v;
  if (typeof v === 'string') {
    try { arr = JSON.parse(v); } catch { return 'Scores must be valid JSON'; }
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    return 'At least one KPI score is required';
  }
  const out: ScoreEntry[] = [];
  const seen = new Set<string>();
  for (const row of arr) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return 'Each score must be an object with kpi_id and score';
    }
    const kpi_id = s((row as any).kpi_id);
    if (!kpi_id) return 'Each score needs a kpi_id';
    if (seen.has(kpi_id)) return 'The same KPI appears more than once';
    seen.add(kpi_id);
    const score = Number(String((row as any).score ?? '').trim());
    if (!Number.isFinite(score) || score < 0) {
      return 'Each score must be a number of 0 or more';
    }
    out.push({ kpi_id, score, note: s((row as any).note) });
  }
  return out;
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }
  try {
    const sp = new URL(request.url).searchParams;

    // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
    // SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    const clauses: string[] = [];
    const params: any[] = [];
    const employee_id = s(sp.get('employee_id'));
    if (employee_id) { clauses.push('r.employee_id = ?'); params.push(employee_id); }
    const period = s(sp.get('period'));
    if (period) { clauses.push('r.period = ?'); params.push(period); }
    const kind = s(sp.get('kind'));
    if (kind) { clauses.push('r.kind = ?'); params.push(kind); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const db = getDb();
    // The SAME clause+params feed the page query and its COUNT(*), so total
    // and rows can never disagree.
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_performance_reviews r ${where}`)
      .get(...params) as { n: number };

    const rows = db
      .prepare(
        `SELECT r.*, e.full_name AS employee_name, e.employee_code
           FROM hr_performance_reviews r
           LEFT JOIN hr_employees e ON e.id = r.employee_id
           ${where}
          ORDER BY r.period DESC, r.created_at DESC, r.id
          LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as any[];

    return Response.json({ rows, total: totalRow.n, page, pageSize });
  } catch (e) {
    console.error('GET /api/hr/performance failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load performance reviews' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  const employee_id = s(body?.employee_id);
  if (!employee_id) return Response.json({ error: 'Employee is required' }, { status: 400 });

  const period = s(body?.period);
  if (!period) return Response.json({ error: 'Review period is required' }, { status: 400 });

  const kind = body?.kind !== undefined && s(body.kind) !== '' ? s(body.kind) : 'monthly';
  if (!REVIEW_KINDS.includes(kind as ReviewKind)) {
    return Response.json(
      { error: 'Invalid review kind (expected monthly, quarterly or annual)' },
      { status: 400 },
    );
  }

  const scores = parseScores(body?.scores_json);
  if (typeof scores === 'string') {
    return Response.json({ error: scores }, { status: 400 });
  }

  const remarks = s(body?.remarks);

  // better-sqlite3 is synchronous — resolve every await BEFORE touching the DB.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();

    // Mapping contract: employee_id → hr_employees.id, validated on CREATE.
    const emp = db.prepare(`SELECT id FROM hr_employees WHERE id = ?`).get(employee_id) as any;
    if (!emp) return Response.json({ error: 'Selected employee was not found' }, { status: 400 });

    // Every scored kpi_id → hr_kpis.id, validated on CREATE. Deactivated KPIs
    // remain scoreable — deactivation hides pickers, it does not void history.
    const kpis: HrKpi[] = [];
    for (const entry of scores) {
      const kpi = db.prepare(`SELECT * FROM hr_kpis WHERE id = ?`).get(entry.kpi_id) as HrKpi | undefined;
      if (!kpi) {
        return Response.json({ error: 'A scored KPI was not found' }, { status: 400 });
      }
      kpis.push(kpi);
    }

    // Friendly pre-check on the UNIQUE(employee_id, period, kind) slot; the
    // constraint below is the authority against races.
    const dupe = db
      .prepare(
        `SELECT id FROM hr_performance_reviews WHERE employee_id = ? AND period = ? AND kind = ?`,
      )
      .get(employee_id, period, kind) as any;
    if (dupe) {
      return Response.json(
        { error: 'A review for that employee, period and kind already exists — record corrections as a new period entry' },
        { status: 409 },
      );
    }

    // overall = weight-weighted mean of the scores against hr_kpis.weight,
    // computed HERE (never trusted from the client). Weights are > 0 by the
    // KPI route's rule; if legacy rows ever sum to 0, fall back to the plain
    // mean rather than dividing by zero.
    let weightSum = 0;
    let weighted = 0;
    for (let i = 0; i < scores.length; i++) {
      const w = Number(kpis[i].weight) > 0 ? Number(kpis[i].weight) : 0;
      weightSum += w;
      weighted += w * scores[i].score;
    }
    const overall = weightSum > 0
      ? Math.round((weighted / weightSum) * 100) / 100
      : Math.round((scores.reduce((a, b) => a + b.score, 0) / scores.length) * 100) / 100;

    const id = generateId();
    const scores_json = JSON.stringify(scores);
    try {
      db.prepare(
        `INSERT INTO hr_performance_reviews (
           id, employee_id, period, kind, scores_json, overall, remarks, reviewed_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, employee_id, period, kind, scores_json, overall, remarks, me.email);
    } catch (e: any) {
      if (String(e?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return Response.json(
          { error: 'A review for that employee, period and kind already exists — record corrections as a new period entry' },
          { status: 409 },
        );
      }
      throw e;
    }

    const review = db
      .prepare(
        `SELECT r.*, e.full_name AS employee_name, e.employee_code
           FROM hr_performance_reviews r
           LEFT JOIN hr_employees e ON e.id = r.employee_id
          WHERE r.id = ?`,
      )
      .get(id) as HrPerformanceReview;

    logAuditEvent(db, {
      event_type: 'hr.performance.review',
      entity_type: 'hr_performance_review',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      after: review,
    });
    return Response.json({ review });
  } catch (e) {
    console.error('POST /api/hr/performance failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to record the review' }, { status: 500 });
  }
}
