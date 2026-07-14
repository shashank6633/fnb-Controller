/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { parseMentions } from '@/lib/tasks';

/**
 * Daily Checklists (/api/tasks/checklists).
 *
 * GET  /api/tasks/checklists?template_id=&date=&role=&department=
 *        → { templates:[{...tpl, items:[...]}], template, records:[...], date }
 *          Lists active templates (for the picker). When template_id is given,
 *          `template` is that template with items and `records` holds the
 *          daily_checklist_records already saved for that template+date.
 *
 * POST /api/tasks/checklists
 *        { template_id, date, department?, records:[{ item_id, result,
 *          comment?, image_url?, corrective_action?, create_task?,
 *          assignee_email?, assignee_name?, priority? }] }
 *        — OR a single record with those fields at the top level.
 *          Upserts one daily_checklist_record per (template_id,item_id,date).
 *          A 'fail' result with create_task truthy spawns a tasks row
 *          (source='checklist'), links it via created_task_id, writes
 *          task_status_history, and fans @mentions out to task_mentions +
 *          task_notifications. → { saved, created_task_ids }
 *
 * GET: any signed-in user (staff run their own checklists). POST: any signed-in
 * user may record; auto-created corrective tasks are visible to managers.
 */
export const dynamic = 'force-dynamic';

/** Local YYYY-MM-DD (Asia/Kolkata is the app's operating tz; keep it simple/local). */
function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const url = new URL(request.url);
    const templateId = (url.searchParams.get('template_id') || '').trim();
    const role = (url.searchParams.get('role') || '').trim();
    const department = (url.searchParams.get('department') || '').trim();
    const date = (url.searchParams.get('date') || '').trim() || today();

    const db = getDb();

    // Picker list: active templates, optionally filtered by role/department.
    const where: string[] = ['is_active = 1'];
    const args: any[] = [];
    if (role) { where.push('role = ?'); args.push(role); }
    if (department) { where.push('department = ?'); args.push(department); }
    const tpls = db
      .prepare(`SELECT * FROM checklist_templates WHERE ${where.join(' AND ')} ORDER BY name ASC`)
      .all(...args) as any[];
    const itemsStmt = db.prepare(
      `SELECT * FROM checklist_items WHERE template_id = ? ORDER BY sort_order ASC, created_at ASC`,
    );
    const templates = tpls.map((t) => ({ ...t, items: itemsStmt.all(t.id) as any[] }));

    let template: any = null;
    let records: any[] = [];
    if (templateId) {
      template = templates.find((t) => t.id === templateId) || null;
      if (!template) {
        const raw = db.prepare(`SELECT * FROM checklist_templates WHERE id = ?`).get(templateId) as any;
        if (raw) template = { ...raw, items: itemsStmt.all(raw.id) as any[] };
      }
      records = db
        .prepare(`SELECT * FROM daily_checklist_records WHERE template_id = ? AND date = ? ORDER BY created_at ASC`)
        .all(templateId, date) as any[];
    }

    return Response.json({ templates, template, records, date });
  } catch (e: any) {
    console.error('GET /api/tasks/checklists failed:', e);
    return Response.json({ error: e?.message || 'Failed to load checklists' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const templateId = String(body?.template_id ?? '').trim();
  if (!templateId) return Response.json({ error: 'template_id required' }, { status: 400 });
  const date = String(body?.date ?? '').trim() || today();

  // Normalise to an array of records.
  const rows: any[] = Array.isArray(body?.records)
    ? body.records
    : (body?.item_id ? [body] : []);
  if (rows.length === 0) return Response.json({ error: 'No records to save' }, { status: 400 });

  const VALID = new Set(['pass', 'fail', 'na']);
  const actor = me.email || me.name || '';

  try {
    const db = getDb();
    const tpl = db.prepare(`SELECT * FROM checklist_templates WHERE id = ?`).get(templateId) as any;
    if (!tpl) return Response.json({ error: 'Template not found' }, { status: 404 });

    const findRec = db.prepare(
      `SELECT * FROM daily_checklist_records WHERE template_id = ? AND item_id = ? AND date = ?`,
    );
    const insRec = db.prepare(
      `INSERT INTO daily_checklist_records
         (id, template_id, item_id, date, result, comment, image_url, corrective_action,
          created_task_id, department, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updRec = db.prepare(
      `UPDATE daily_checklist_records
         SET result=?, comment=?, image_url=?, corrective_action=?, created_task_id=?, department=?, recorded_by=?
       WHERE id=?`,
    );
    const itemLabelStmt = db.prepare(`SELECT label FROM checklist_items WHERE id = ?`);

    const createdTaskIds: string[] = [];
    let saved = 0;

    const tx = db.transaction(() => {
      for (const r of rows) {
        const itemId = String(r?.item_id ?? '').trim();
        if (!itemId) continue;
        const result = String(r?.result ?? 'na').trim().toLowerCase();
        if (!VALID.has(result)) continue;
        const comment = String(r?.comment ?? '').trim();
        const imageUrl = String(r?.image_url ?? '').trim();
        const corrective = String(r?.corrective_action ?? '').trim();
        const department = String(r?.department ?? body?.department ?? tpl.department ?? '').trim();

        const existing = findRec.get(templateId, itemId, date) as any;
        let createdTaskId = existing?.created_task_id || '';

        // A failed item may spin off a corrective task.
        const wantTask = result === 'fail' && (r?.create_task ?? true) && !createdTaskId;
        if (wantTask) {
          const itemRow = itemLabelStmt.get(itemId) as any;
          const label = itemRow?.label || 'Checklist item';
          const assigneeEmail = String(r?.assignee_email ?? '').trim();
          const assigneeName = String(r?.assignee_name ?? '').trim();
          const priority = String(r?.priority ?? 'high').trim() || 'high';
          const status = assigneeEmail ? 'assigned' : 'draft';
          const title = `Checklist fail: ${label}`;
          const description = [corrective, comment].filter(Boolean).join('\n') || `Failed on ${tpl.name} (${date}).`;
          const taskId = generateId();
          db.prepare(
            `INSERT INTO tasks
               (id, title, description, category, department, priority, status,
                assignee_email, assignee_name, created_by, due_date,
                source, template_id, checklist_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'checklist', ?, '[]')`,
          ).run(
            taskId, title, description, tpl.category || 'Hygiene', department, priority, status,
            assigneeEmail, assigneeName, actor, date, templateId,
          );
          db.prepare(
            `INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note)
             VALUES (?, ?, '', ?, ?, ?)`,
          ).run(generateId(), taskId, status, actor, 'Auto-created from checklist fail');

          // Notify assignee.
          if (assigneeEmail) {
            db.prepare(
              `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
               VALUES (?, ?, 'assignment', ?, ?, ?, '/tasks/my')`,
            ).run(generateId(), assigneeEmail, `Task assigned: ${title}`, description, taskId);
          }

          // Fan @mentions from the corrective action / comment.
          const mentions = parseMentions(`${corrective} ${comment}`);
          for (const token of mentions) {
            db.prepare(
              `INSERT INTO task_mentions (id, task_id, mentioned_email, mentioned_name, mentioned_by)
               VALUES (?, ?, ?, ?, ?)`,
            ).run(generateId(), taskId, token, token, actor);
            db.prepare(
              `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
               VALUES (?, ?, 'mention', ?, ?, ?, '/tasks/my')`,
            ).run(generateId(), token, `Mentioned in: ${title}`, description, taskId);
          }
          createdTaskId = taskId;
          createdTaskIds.push(taskId);
        }

        if (existing) {
          updRec.run(result, comment, imageUrl, corrective, createdTaskId, department, actor, existing.id);
        } else {
          insRec.run(
            generateId(), templateId, itemId, date, result, comment, imageUrl, corrective,
            createdTaskId, department, actor,
          );
        }
        saved += 1;
      }
    });
    tx();

    return Response.json({ saved, created_task_ids: createdTaskIds });
  } catch (e: any) {
    console.error('POST /api/tasks/checklists failed:', e);
    return Response.json({ error: e?.message || 'Failed to save checklist' }, { status: 500 });
  }
}
