import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  readDepartmentAreas, saveDepartmentAreas, cleanAreaLabel, newAreaKey,
  departmentAreaKeysInUse, AREA_LABEL_MAX, STORE_BUCKET_LABEL,
  type DepartmentArea,
} from '@/lib/department-areas';

/**
 * MANAGE AREAS — Settings → Departments (owner ruling #82, 2026-10-28).
 *
 * GET    /api/departments/areas            any signed-in user (Closing Stock
 *                                          needs the names); the list in order,
 *                                          each with the departments using it
 * POST   /api/departments/areas            admin — { label } adds an area
 * PUT    /api/departments/areas            admin — { key, expected_label,
 *                                          label?, active? } renames and/or
 *                                          switches on/off
 * DELETE /api/departments/areas?key=X&expected_label=Y
 *                                          admin — only while NO department
 *                                          (archived included) uses it; 409
 *                                          otherwise
 *
 * TWO ADMINS AT ONCE: PUT and DELETE take `expected_label`, the name the
 * caller's screen showed. If the area has been renamed since (or deleted), the
 * write is refused — 409 / 404, "Nothing was changed" — and the reply carries
 * the up-to-date list, so a stale screen can never rename over, switch or
 * delete a colleague's change while telling its user something else happened.
 * Every success reply carries the server's own before/after (`before`, `area`)
 * so the screen's message names what really changed. A caller that omits
 * expected_label (scripts) gets no stale check, only the before/after.
 *
 * The list lives in ONE settings row ('department_areas'); see
 * src/lib/department-areas.ts. This route writes ONLY that row (and the audit
 * trail) — never a department: a rename changes the label, and the departments
 * keep their key. CSRF: covered by the '/api/departments' prefix in
 * src/proxy.ts. Every write is in the append-only audit_events table.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Db = ReturnType<typeof getDb>;

interface DeptRef { id: string; name: string; is_active: boolean }

function departmentsByArea(db: Db): Map<string, DeptRef[]> {
  const out = new Map<string, DeptRef[]>();
  const rows = db.prepare(`
    SELECT id, name, COALESCE(is_active, 1) AS is_active, TRIM(COALESCE(area, '')) AS area
      FROM departments
     WHERE TRIM(COALESCE(area, '')) <> ''
     ORDER BY name
  `).all() as Array<{ id: string; name: string; is_active: number; area: string }>;
  for (const r of rows) {
    if (!out.has(r.area)) out.set(r.area, []);
    out.get(r.area)!.push({ id: String(r.id), name: String(r.name), is_active: Number(r.is_active) === 1 });
  }
  return out;
}

function payload(db: Db, isAdmin: boolean) {
  const list = readDepartmentAreas(db);
  const used = departmentsByArea(db);
  const listed = new Set(list.areas.map((a) => a.key));
  const withUse = (key: string) => {
    const ds = used.get(key) || [];
    return {
      department_count: ds.length,
      archived_department_count: ds.filter((d) => !d.is_active).length,
      departments: ds,
    };
  };
  return {
    areas: list.areas.map((a) => ({ ...a, ...withUse(a.key) })),
    // Values a department carries that are NOT in the list (from before the
    // list existed). Shown, never hidden, and named by their own value.
    unlisted: [...used.keys()].filter((k) => !listed.has(k)).sort().map((key) => ({ key, ...withUse(key) })),
    source: list.source,
    ignored_entries: list.ignored,
    can_manage: isAdmin,
  };
}

async function adminOr(): Promise<{ me: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>> } | Response> {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (me.role !== 'admin') {
    return Response.json({ error: 'Only an admin can change the list of areas.' }, { status: 403 });
  }
  return { me };
}

/** The note added to an audit row when the saved list could not be read. */
const unreadableNote = (source: string) =>
  source === 'unreadable' ? ' The saved list could not be read, so it was replaced starting from the five default areas.' : '';

const deptWord = (n: number) => `${n} department${n === 1 ? '' : 's'}`;
/** Closing Stock already shows "Store / Overall" for counts with no area; an
 *  area of the same name would put two identical cards side by side. */
const reservedLabel = (label: string) => label.toLowerCase() === STORE_BUCKET_LABEL.toLowerCase();
const RESERVED_MSG = `"${STORE_BUCKET_LABEL}" is the name Closing Stock already uses for counts with no area. Pick another name.`;
/** "its 2 departments keep it" with the verb agreeing, for audit notes. */
const keepers = (n: number) =>
  n === 0 ? 'no department uses it' : n === 1 ? 'its 1 department keeps it' : `its ${n} departments keep it`;

/** The name the caller's screen showed (PUT body / DELETE query), cleaned the
 *  same way stored names are; undefined when the caller did not send one. */
function expectedLabel(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : cleanAreaLabel(v);
}
/** Refusals for a screen that is out of date. Both say plainly that nothing
 *  happened; the handler attaches the up-to-date list to the reply. */
const GONE = (verb: 'changed' | 'deleted') => ({
  status: 404,
  body: { conflict: 'gone', error: `That area is not in the list any more — someone may have deleted it. Nothing was ${verb}.` },
});
const RENAMED = (now: string, verb: 'changed' | 'deleted') => ({
  status: 409,
  body: { conflict: 'renamed', error: `This area is now called "${now}" — someone changed it after this list was loaded. Nothing was ${verb}.` },
});

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    return Response.json(payload(db, me.role === 'admin'));
  } catch (e) {
    console.error('[/api/departments/areas GET]', e);
    return Response.json({ error: (e as Error)?.message || 'Could not read the areas.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const gate = await adminOr();
    if (gate instanceof Response) return gate;
    const { me } = gate;
    const b = await request.json().catch(() => ({}));
    const label = cleanAreaLabel(b?.label);
    if (!label) return Response.json({ error: 'Type a name for the new area.' }, { status: 400 });
    if (label.length > AREA_LABEL_MAX) {
      return Response.json({ error: `Keep the area name to ${AREA_LABEL_MAX} characters or fewer.` }, { status: 400 });
    }
    if (reservedLabel(label)) return Response.json({ error: `${RESERVED_MSG} Nothing was added.` }, { status: 400 });
    const db = getDb();
    let result: { status: number; body: Record<string, unknown> } | null = null;
    db.transaction(() => {
      const list = readDepartmentAreas(db);
      const dup = list.areas.find((a) => a.label.toLowerCase() === label.toLowerCase());
      if (dup) {
        result = { status: 409, body: { error: `There is already an area called "${dup.label}". Nothing was added.` } };
        return;
      }
      const taken = new Set<string>([...list.areas.map((a) => a.key), ...departmentAreaKeysInUse(db)]);
      const key = newAreaKey(label, taken);
      const sort = list.areas.reduce((m, a) => Math.max(m, a.sort), 0) + 10;
      const created: DepartmentArea = { key, label, active: true, sort };
      saveDepartmentAreas(db, [...list.areas, created]);
      logAuditEvent(db, {
        event_type: 'department_area.add',
        entity_type: 'department_area',
        entity_id: key,
        actor_email: me.email || '',
        before: list.source === 'unreadable' ? { unreadable_saved_list: list.raw } : null,
        after: created,
        note: `Area "${label}" added.` + unreadableNote(list.source),
      });
      result = { status: 201, body: { area: created } };
    })();
    const r = result as { status: number; body: Record<string, unknown> } | null;
    if (!r) return Response.json({ error: 'Could not add the area.' }, { status: 500 });
    // A refusal still carries the up-to-date list (e.g. a colleague just added
    // that name), so the screen shows what is really there.
    return Response.json({ ...r.body, ...payload(db, true) }, { status: r.status });
  } catch (e) {
    console.error('[/api/departments/areas POST]', e);
    return Response.json({ error: (e as Error)?.message || 'Could not add the area.' }, { status: 500 });
  }
}

/** 0/1 from a JSON body; undefined when absent; null for anything unreadable. */
function activeFlag(v: unknown): boolean | undefined | null {
  if (v === undefined) return undefined;
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return null;
}

export async function PUT(request: Request) {
  try {
    const gate = await adminOr();
    if (gate instanceof Response) return gate;
    const { me } = gate;
    const b = await request.json().catch(() => ({}));
    const key = String(b?.key ?? '').trim();
    if (!key) return Response.json({ error: 'Which area? (key is required)' }, { status: 400 });
    const wantsLabel = b?.label !== undefined;
    const label = wantsLabel ? cleanAreaLabel(b.label) : '';
    if (wantsLabel && !label) return Response.json({ error: 'The area name cannot be blank. Nothing was changed.' }, { status: 400 });
    if (wantsLabel && label.length > AREA_LABEL_MAX) {
      return Response.json({ error: `Keep the area name to ${AREA_LABEL_MAX} characters or fewer. Nothing was changed.` }, { status: 400 });
    }
    if (wantsLabel && reservedLabel(label)) {
      return Response.json({ error: `${RESERVED_MSG} Nothing was changed.` }, { status: 400 });
    }
    const active = activeFlag(b?.active);
    if (active === null) {
      return Response.json({ error: 'active must be true or false. Nothing was changed.' }, { status: 400 });
    }
    if (!wantsLabel && active === undefined) {
      return Response.json({ error: 'Nothing to change — send a new name or switch it on or off.' }, { status: 400 });
    }
    const expected = expectedLabel(b?.expected_label);

    const db = getDb();
    let result: { status: number; body: Record<string, unknown> } | null = null;
    db.transaction(() => {
      const list = readDepartmentAreas(db);
      const i = list.areas.findIndex((a) => a.key === key);
      if (i < 0) { result = GONE('changed'); return; }
      const before = list.areas[i];
      // Checked INSIDE the transaction that would write, against the saved list.
      if (expected !== undefined && expected !== before.label) { result = RENAMED(before.label, 'changed'); return; }
      if (wantsLabel) {
        const dup = list.areas.find((a) => a.key !== key && a.label.toLowerCase() === label.toLowerCase());
        if (dup) { result = { status: 409, body: { error: `There is already an area called "${dup.label}". Nothing was changed.` } }; return; }
      }
      const after: DepartmentArea = {
        ...before,
        label: wantsLabel ? label : before.label,
        active: active === undefined ? before.active : active,
      };
      const renamed = after.label !== before.label;
      const switched = after.active !== before.active;
      if (!renamed && !switched) { result = { status: 200, body: { changed: false, before, area: before } }; return; }
      const next = [...list.areas];
      next[i] = after;
      saveDepartmentAreas(db, next);
      const users = (db.prepare(`SELECT COUNT(*) AS n FROM departments WHERE TRIM(COALESCE(area, '')) = ?`)
        .get(key) as { n: number }).n;
      const parts: string[] = [];
      if (renamed) parts.push(`renamed from "${before.label}" to "${after.label}" (${keepers(users)})`);
      if (switched) {
        parts.push(after.active
          ? 'switched on — it can be picked for a department again'
          : `switched off — ${keepers(users)}; it can no longer be picked for another department`);
      }
      logAuditEvent(db, {
        event_type: renamed && switched ? 'department_area.update'
          : renamed ? 'department_area.rename'
          : after.active ? 'department_area.switch_on' : 'department_area.switch_off',
        entity_type: 'department_area',
        entity_id: key,
        actor_email: me.email || '',
        before: list.source === 'unreadable' ? { ...before, unreadable_saved_list: list.raw } : before,
        after,
        note: `Area "${after.label}" ${parts.join('; ')}.` + unreadableNote(list.source),
      });
      result = { status: 200, body: { changed: true, before, area: after } };
    })();
    const r = result as { status: number; body: Record<string, unknown> } | null;
    if (!r) return Response.json({ error: 'Could not change the area.' }, { status: 500 });
    return Response.json({ ...r.body, ...payload(db, true) }, { status: r.status });
  } catch (e) {
    console.error('[/api/departments/areas PUT]', e);
    return Response.json({ error: (e as Error)?.message || 'Could not change the area.' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const gate = await adminOr();
    if (gate instanceof Response) return gate;
    const { me } = gate;
    const q = new URL(request.url).searchParams;
    const key = String(q.get('key') ?? '').trim();
    if (!key) return Response.json({ error: 'Which area? (key is required)' }, { status: 400 });
    const expected = expectedLabel(q.get('expected_label') ?? undefined);
    const db = getDb();
    let result: { status: number; body: Record<string, unknown> } | null = null;
    db.transaction(() => {
      const list = readDepartmentAreas(db);
      const area = list.areas.find((a) => a.key === key);
      if (!area) { result = GONE('deleted'); return; }
      if (expected !== undefined && expected !== area.label) { result = RENAMED(area.label, 'deleted'); return; }
      // Counted INSIDE the transaction that removes it, so a department cannot
      // be given this area between the check and the delete.
      const using = db.prepare(`
        SELECT name, COALESCE(is_active, 1) AS is_active FROM departments
         WHERE TRIM(COALESCE(area, '')) = ? ORDER BY name
      `).all(key) as Array<{ name: string; is_active: number }>;
      if (using.length > 0) {
        const names = using.map((d) => d.name + (Number(d.is_active) === 1 ? '' : ' (archived)'));
        const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');
        result = {
          status: 409,
          body: {
            error: `"${area.label}" can't be deleted — ${deptWord(using.length)} still ${using.length === 1 ? 'uses' : 'use'} it (${shown}). `
              + `Switch it off instead, or move ${using.length === 1 ? 'that department' : 'those departments'} to another area first. Nothing was deleted.`,
            department_count: using.length,
          },
        };
        return;
      }
      saveDepartmentAreas(db, list.areas.filter((a) => a.key !== key));
      logAuditEvent(db, {
        event_type: 'department_area.delete',
        entity_type: 'department_area',
        entity_id: key,
        actor_email: me.email || '',
        before: list.source === 'unreadable' ? { ...area, unreadable_saved_list: list.raw } : area,
        after: null,
        note: `Area "${area.label}" deleted (no department used it).` + unreadableNote(list.source),
      });
      result = { status: 200, body: { deleted: key, area } };
    })();
    const r = result as { status: number; body: Record<string, unknown> } | null;
    if (!r) return Response.json({ error: 'Could not delete the area.' }, { status: 500 });
    return Response.json({ ...r.body, ...payload(db, true) }, { status: r.status });
  } catch (e) {
    console.error('[/api/departments/areas DELETE]', e);
    return Response.json({ error: (e as Error)?.message || 'Could not delete the area.' }, { status: 500 });
  }
}
