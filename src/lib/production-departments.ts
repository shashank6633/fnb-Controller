import type Database from 'better-sqlite3';
import { mainDeptOf } from './dept-hierarchy';

/**
 * WHICH DEPARTMENT A PRODUCTION BATCH WAS MADE FOR.
 *
 * One place that answers three questions, so the picker, the validator and the
 * read-back can never disagree about what an option is:
 *   listDepartmentOptions()   — what the dropdown offers
 *   resolveBatchDepartment()  — what a submitted choice means (or why it's invalid)
 *   batchDepartmentMap()      — what a saved batch shows
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ──────────────────────────────
 * A `departments` row is a MATERIAL-MOVEMENT object: it is a requisition target,
 * it holds department stock, it is a dept-consumption bucket and a variance
 * subject. Nothing in this file, and nothing in the routes that call it, ever
 * INSERTs, UPDATEs or DELETEs one. The picker READS `departments` and writes
 * only its id. The owner's "add a new line in drop down" lands in
 * `production_departments` — a production-only label list with no ledger and no
 * reachability from Central Store --issue--> Department Stock --recipe
 * consumption--> consumed. Making that button create a real department is the
 * change this file is shaped to prevent; the door for a real one is /departments.
 *
 * ── OPTION KEYS ───────────────────────────────────────────────────────────
 * Two sources share one <select>, so every option carries a namespaced key —
 * `dept:<id>` for a real department, `custom:<id>` for an extra line. A bare id
 * would be ambiguous the day the two tables both contain a row of that id, and
 * the namespace is also what lets the form round-trip a selection without a
 * second lookup. Server-side, the key is never trusted: parseOptionKey() only
 * splits it, and resolveBatchDepartment() re-reads the row it names.
 */

export interface DepartmentOption {
  /** `dept:<id>` or `custom:<id>` — the <select> value. */
  key: string;
  label: string;
  /** Which group heading this sits under (Kitchen / Bar / Operations / Other). */
  group: string;
  source: 'department' | 'custom';
  department_id: string | null;
  production_department_id: string | null;
}

export interface DepartmentOptionGroup {
  label: string;
  options: DepartmentOption[];
}

/** Resolved link written alongside a batch. */
export interface BatchDepartmentLink {
  department_id: string | null;
  production_department_id: string | null;
  label: string;
}

/** Heading for the production-only extra lines. */
export const CUSTOM_GROUP = 'Other (production only)';

/**
 * Group order. Kitchen and Bar lead because those are the two the owner named;
 * Operations follows because it is a real main department and hiding it would be
 * inventing a filter the DATA does not support — 'Akan Security', 'Akan Service'
 * and 'Akan Stationery' are all parented under KITCHEN in production, so any
 * "kitchen only" filter would have let them through anyway while dropping
 * Housekeeping. Show the truth and group it.
 */
const GROUP_ORDER = ['Kitchen', 'Bar', 'Operations'];

function groupRank(label: string): number {
  const i = GROUP_ORDER.indexOf(label);
  if (i >= 0) return i;
  return label === CUSTOM_GROUP ? 900 : 500;
}

export function parseOptionKey(key: string): { source: 'department' | 'custom'; id: string } | null {
  const s = String(key || '').trim();
  if (s.startsWith('dept:')) {
    const id = s.slice(5).trim();
    return id ? { source: 'department', id } : null;
  }
  if (s.startsWith('custom:')) {
    const id = s.slice(7).trim();
    return id ? { source: 'custom', id } : null;
  }
  return null;
}

interface DeptRowLite { id: string; name: string; parent_id: string | null; is_active: number }

/**
 * Every option the New Production Batch dropdown may offer, grouped.
 *
 * ACTIVE rows only, from both sources. An inactive department has been retired
 * by an admin on the Departments screen and must not come back as a production
 * choice; an inactive extra line is the deactivate-don't-delete state that keeps
 * old batches resolvable (same reason production_items deactivates).
 */
export function listDepartmentOptions(db: Database.Database): DepartmentOptionGroup[] {
  const byGroup = new Map<string, DepartmentOption[]>();
  const push = (group: string, opt: DepartmentOption) => {
    const arr = byGroup.get(group);
    if (arr) arr.push(opt); else byGroup.set(group, [opt]);
  };

  let depts: DeptRowLite[] = [];
  try {
    depts = db.prepare(
      `SELECT id, name, parent_id, is_active FROM departments WHERE is_active = 1 ORDER BY name COLLATE NOCASE`,
    ).all() as DeptRowLite[];
  } catch { depts = []; }

  for (const d of depts) {
    // mainDeptOf lifts a sub-department to its main; a main returns itself, and
    // an orphan (parent_id pointing nowhere) returns itself too — so it lands
    // under its own name rather than silently under Kitchen.
    const main = mainDeptOf(db, d.id);
    const group = main?.name || d.name;
    push(group, {
      key: `dept:${d.id}`,
      label: d.name,
      group,
      source: 'department',
      department_id: d.id,
      production_department_id: null,
    });
  }

  let extras: { id: string; name: string }[] = [];
  try {
    extras = db.prepare(
      `SELECT id, name FROM production_departments WHERE is_active = 1
        ORDER BY sort_order, name COLLATE NOCASE`,
    ).all() as { id: string; name: string }[];
  } catch { extras = []; }

  for (const e of extras) {
    push(CUSTOM_GROUP, {
      key: `custom:${e.id}`,
      label: e.name,
      group: CUSTOM_GROUP,
      source: 'custom',
      department_id: null,
      production_department_id: e.id,
    });
  }

  return [...byGroup.entries()]
    .map(([label, options]) => ({ label, options }))
    .sort((a, b) => groupRank(a.label) - groupRank(b.label) || a.label.localeCompare(b.label));
}

/**
 * Validate a submitted department choice.
 *
 * Returns null for "no department" — the supported, unchanged state that every
 * batch created before this feature is in. Throws with a message meant for the
 * chef when the choice names something that is gone or retired, rather than
 * silently storing a dangling id (the `dangling` failure the station-department
 * map documents is exactly what a silent store produces).
 */
export function resolveBatchDepartment(
  db: Database.Database,
  input: { department_id?: unknown; production_department_id?: unknown; department_key?: unknown },
): BatchDepartmentLink | null {
  let departmentId = String(input?.department_id || '').trim();
  let customId = String(input?.production_department_id || '').trim();

  // A single namespaced key is what the form sends; the split ids are accepted
  // too so a script (or a tablet mid-rolling-deploy) can post either shape.
  const parsed = parseOptionKey(String(input?.department_key || ''));
  if (parsed) {
    if (parsed.source === 'department') departmentId = parsed.id;
    else customId = parsed.id;
  }

  if (departmentId && customId) {
    throw new Error('Pick one department — a department and a custom line cannot both be set.');
  }

  if (departmentId) {
    const row = db.prepare(
      `SELECT id, name, is_active FROM departments WHERE id = ?`,
    ).get(departmentId) as { id: string; name: string; is_active: number } | undefined;
    if (!row) throw new Error('Unknown department — refresh the department list and pick again.');
    if (!row.is_active) throw new Error(`"${row.name}" is no longer an active department — pick another.`);
    return { department_id: row.id, production_department_id: null, label: row.name };
  }

  if (customId) {
    const row = db.prepare(
      `SELECT id, name, is_active FROM production_departments WHERE id = ?`,
    ).get(customId) as { id: string; name: string; is_active: number } | undefined;
    if (!row) throw new Error('Unknown production department — refresh the list and pick again.');
    if (!row.is_active) throw new Error(`"${row.name}" is deactivated — reactivate it in Production Settings first.`);
    return { department_id: null, production_department_id: row.id, label: row.name };
  }

  return null;
}

/** Write (or clear) one batch's department link. Call inside the caller's transaction. */
export function saveBatchDepartment(
  db: Database.Database,
  batchId: string,
  link: BatchDepartmentLink | null,
): void {
  if (!link) {
    db.prepare(`DELETE FROM production_batch_departments WHERE batch_id = ?`).run(batchId);
    return;
  }
  db.prepare(
    `INSERT INTO production_batch_departments (batch_id, department_id, production_department_id, label)
     VALUES (?,?,?,?)
     ON CONFLICT(batch_id) DO UPDATE SET
       department_id = excluded.department_id,
       production_department_id = excluded.production_department_id,
       label = excluded.label,
       updated_at = datetime('now')`,
  ).run(batchId, link.department_id, link.production_department_id, link.label);
}

export interface BatchDepartmentView {
  department_id: string | null;
  production_department_id: string | null;
  department_key: string | null;
  /** Live name where the source row still exists, else the stored snapshot. */
  department_name: string;
  /** True when the linked row has been retired since the batch was made. */
  department_inactive: boolean;
}

/**
 * Department view for a set of batch ids, as a map.
 *
 * Resolves the LIVE name (so a department rename shows through, matching how a
 * production_items rename already propagates to item_name) and falls back to the
 * snapshot only when the source row has vanished — the case a batch printed
 * months ago must still be readable in.
 *
 * A batch with no row here returns nothing, and its caller renders exactly what
 * it rendered before this feature existed.
 */
export function batchDepartmentMap(
  db: Database.Database,
  batchIds: string[],
): Map<string, BatchDepartmentView> {
  const out = new Map<string, BatchDepartmentView>();
  const ids = batchIds.filter(Boolean);
  if (!ids.length) return out;

  interface JoinedRow {
    batch_id: string;
    department_id: string | null;
    production_department_id: string | null;
    label: string | null;
    dept_name: string | null;
    dept_active: number | null;
    custom_name: string | null;
    custom_active: number | null;
  }

  // Chunked to stay under SQLite's variable limit on a long list.
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    let rows: JoinedRow[] = [];
    try {
      rows = db.prepare(
        `SELECT pbd.batch_id, pbd.department_id, pbd.production_department_id, pbd.label,
                d.name  AS dept_name,  d.is_active  AS dept_active,
                pd.name AS custom_name, pd.is_active AS custom_active
           FROM production_batch_departments pbd
           LEFT JOIN departments d            ON d.id  = pbd.department_id
           LEFT JOIN production_departments pd ON pd.id = pbd.production_department_id
          WHERE pbd.batch_id IN (${ph})`,
      ).all(...chunk) as JoinedRow[];
    } catch { rows = []; }

    for (const r of rows) {
      const live = r.dept_name || r.custom_name || '';
      const active = r.department_id ? !!r.dept_active
        : r.production_department_id ? !!r.custom_active
        : true;
      out.set(r.batch_id, {
        department_id: r.department_id || null,
        production_department_id: r.production_department_id || null,
        department_key: r.department_id ? `dept:${r.department_id}`
          : r.production_department_id ? `custom:${r.production_department_id}`
          : null,
        department_name: live || String(r.label || ''),
        department_inactive: !active,
      });
    }
  }
  return out;
}

/** Convenience for a single batch. */
export function batchDepartment(db: Database.Database, batchId: string): BatchDepartmentView | null {
  return batchDepartmentMap(db, [batchId]).get(batchId) || null;
}
