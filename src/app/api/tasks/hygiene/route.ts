/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  HYGIENE_AREAS,
  canManageTasks,
  parseMentions,
  type HygieneAudit,
} from '@/lib/tasks';

/**
 * Hygiene Audits (/api/tasks/hygiene).
 *
 * GET  /api/tasks/hygiene?date=YYYY-MM-DD[&area=Kitchen]
 *        → { date, rows: HygieneAudit[], scores: { byArea: {[area]: AreaScore},
 *            overall: AreaScore } }
 *          AreaScore = { pass, fail, na, total, scored, score } where
 *          score = pass / (pass + fail) * 100 (na excluded), rounded to 1 dp.
 *
 * POST /api/tasks/hygiene  { date, audits: [{ area, item, result, image_url?,
 *        corrective_action? }] }  (also accepts a single flat audit object)
 *        → upserts one row per (area,item,date) (latest wins), and for every
 *          `fail` auto-creates a Hygiene task (source='hygiene') whose id is
 *          written back to the audit's created_task_id. @mentions in the
 *          corrective_action seed task_mentions + task_notifications.
 *        → { saved, created_tasks, rows, scores }
 *
 * Gate: GET = any signed-in user; POST = canManageTasks (admin / manager /
 * head chef / store manager). The API mirrors the server-side gate the page
 * enforces client-side.
 */
export const dynamic = 'force-dynamic';

const AREA_SET = new Set(HYGIENE_AREAS as readonly string[]);
const RESULTS = new Set(['pass', 'fail', 'na']);

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function isISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

interface AreaScore {
  pass: number;
  fail: number;
  na: number;
  total: number;
  scored: number; // pass + fail
  score: number;  // pass / scored * 100, 1 dp; 0 when scored === 0
}

function emptyScore(): AreaScore {
  return { pass: 0, fail: 0, na: 0, total: 0, scored: 0, score: 0 };
}

function finalize(s: AreaScore): AreaScore {
  s.scored = s.pass + s.fail;
  s.total = s.scored + s.na;
  s.score = s.scored > 0 ? Math.round((s.pass / s.scored) * 1000) / 10 : 0;
  return s;
}

/** Compute per-area + overall scores from a day's audit rows. */
function computeScores(rows: HygieneAudit[]) {
  const byArea: Record<string, AreaScore> = {};
  for (const area of HYGIENE_AREAS) byArea[area] = emptyScore();
  const overall = emptyScore();
  for (const r of rows) {
    const bucket = byArea[r.area] || (byArea[r.area] = emptyScore());
    if (r.result === 'pass') { bucket.pass++; overall.pass++; }
    else if (r.result === 'fail') { bucket.fail++; overall.fail++; }
    else { bucket.na++; overall.na++; }
  }
  for (const area of Object.keys(byArea)) finalize(byArea[area]);
  finalize(overall);
  return { byArea, overall };
}

/** Area → task department mapping for auto-created corrective tasks. */
function departmentForArea(area: string): string {
  if (area === 'Kitchen') return 'Kitchen';
  if (area === 'Bar') return 'Bar';
  return 'Housekeeping'; // Restaurant, Washrooms
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const url = new URL(request.url);
    const date = url.searchParams.get('date') || todayISO();
    if (!isISODate(date)) return Response.json({ error: 'Invalid date' }, { status: 400 });
    const area = url.searchParams.get('area') || '';

    const db = getDb();
    let rows: HygieneAudit[];
    if (area && AREA_SET.has(area)) {
      rows = db.prepare(
        `SELECT * FROM hygiene_audits WHERE date = ? AND area = ? ORDER BY area, item`,
      ).all(date, area) as HygieneAudit[];
    } else {
      rows = db.prepare(
        `SELECT * FROM hygiene_audits WHERE date = ? ORDER BY area, item`,
      ).all(date) as HygieneAudit[];
    }
    // Scores always computed over the full day (all areas), independent of filter.
    const allRows = area
      ? (db.prepare(`SELECT * FROM hygiene_audits WHERE date = ?`).all(date) as HygieneAudit[])
      : rows;
    return Response.json({ date, rows, scores: computeScores(allRows) });
  } catch (e: any) {
    console.error('GET /api/tasks/hygiene failed:', e);
    return Response.json({ error: e?.message || 'Failed to load hygiene audits' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageTasks(me)) {
    return Response.json({ error: 'Not authorised to record hygiene audits' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  const date = String(body?.date || '').trim() || todayISO();
  if (!isISODate(date)) return Response.json({ error: 'Invalid date' }, { status: 400 });

  // Normalize to an array of audit inputs.
  const rawList: any[] = Array.isArray(body?.audits)
    ? body.audits
    : (body?.area || body?.item) ? [body] : [];
  if (rawList.length === 0) {
    return Response.json({ error: 'No audit items supplied' }, { status: 400 });
  }

  // Validate + clean each input.
  const clean: Array<{ area: string; item: string; result: string; image_url: string; corrective_action: string }> = [];
  for (const a of rawList) {
    const area = String(a?.area || '').trim();
    const item = String(a?.item || '').trim();
    const result = String(a?.result || '').trim().toLowerCase();
    if (!AREA_SET.has(area)) return Response.json({ error: `Invalid area: ${area || '(empty)'}` }, { status: 400 });
    if (!item) return Response.json({ error: 'Each audit needs an item' }, { status: 400 });
    if (!RESULTS.has(result)) return Response.json({ error: `Invalid result for ${item}: ${result || '(empty)'}` }, { status: 400 });
    clean.push({
      area,
      item,
      result,
      image_url: String(a?.image_url || '').trim(),
      corrective_action: String(a?.corrective_action || '').trim(),
    });
  }

  try {
    const db = getDb();
    const auditorName = me.name || me.email || '';
    let createdTasks = 0;

    const tx = db.transaction(() => {
      for (const a of clean) {
        // Upsert: latest result per (area,item,date) — remove any prior row.
        db.prepare(
          `DELETE FROM hygiene_audits WHERE date = ? AND area = ? AND item = ?`,
        ).run(date, a.area, a.item);

        let createdTaskId = '';
        if (a.result === 'fail') {
          createdTaskId = generateId();
          const dept = departmentForArea(a.area);
          const desc = a.corrective_action || `Corrective action required — hygiene audit failed for "${a.item}" in ${a.area}.`;
          db.prepare(
            `INSERT INTO tasks
               (id, title, description, category, department, priority, status,
                created_by, source, due_date)
             VALUES (?, ?, ?, 'Hygiene', ?, 'high', 'assigned', ?, 'hygiene', ?)`,
          ).run(createdTaskId, `Hygiene fail: ${a.item} (${a.area})`, desc, dept, me.email || '', date);

          // status history: '' -> assigned
          db.prepare(
            `INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note)
             VALUES (?, ?, '', 'assigned', ?, ?)`,
          ).run(generateId(), createdTaskId, me.email || '', 'Auto-created from hygiene audit fail');

          // @mentions in corrective action -> mentions + notifications
          const mentions = parseMentions(a.corrective_action);
          for (const token of mentions) {
            db.prepare(
              `INSERT INTO task_mentions
                 (id, task_id, comment_id, mentioned_email, mentioned_name, mentioned_by)
               VALUES (?, ?, '', ?, ?, ?)`,
            ).run(generateId(), createdTaskId, token, token, me.email || '');
            db.prepare(
              `INSERT INTO task_notifications
                 (id, recipient_email, kind, title, body, task_id, href)
               VALUES (?, ?, 'mention', ?, ?, ?, ?)`,
            ).run(
              generateId(), token, `Mentioned in hygiene corrective action`,
              `${auditorName} mentioned you: ${a.item} (${a.area})`,
              createdTaskId, `/tasks/hygiene?date=${date}`,
            );
          }
          createdTasks++;
        }

        const score = a.result === 'pass' ? 100 : 0;
        db.prepare(
          `INSERT INTO hygiene_audits
             (id, area, item, date, result, image_url, corrective_action,
              created_task_id, score, auditor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          generateId(), a.area, a.item, date, a.result, a.image_url,
          a.corrective_action, createdTaskId, score, auditorName,
        );
      }
    });
    tx();

    const rows = db.prepare(
      `SELECT * FROM hygiene_audits WHERE date = ? ORDER BY area, item`,
    ).all(date) as HygieneAudit[];
    return Response.json({
      saved: clean.length,
      created_tasks: createdTasks,
      date,
      rows,
      scores: computeScores(rows),
    });
  } catch (e: any) {
    console.error('POST /api/tasks/hygiene failed:', e);
    return Response.json({ error: e?.message || 'Failed to save hygiene audit' }, { status: 500 });
  }
}
