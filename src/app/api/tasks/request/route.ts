/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageTasks, TASK_PRIORITIES, TASK_DEPARTMENTS } from '@/lib/tasks';
import { sendPushToUser } from '@/lib/push';

/**
 * Self-service repair / maintenance intake (/api/tasks/request) — REQUESTS slice.
 *
 * A DELIBERATELY RESTRICTED sibling of POST /api/tasks. The full task-create
 * endpoint stays gated to canManageTasks (admins / managers / HODs / store
 * managers); this one lets ANY signed-in employee raise a repair/maintenance
 * request that lands in the Maintenance team's queue for a manager to triage.
 *
 * It is NOT a general task-create: the caller supplies only a small,
 * whitelisted field set (title / description / category / priority /
 * department / optional photo). Everything that could grant privilege —
 * status, assignee, created_by, source, archive flag — is FORCED server-side.
 * The request is born status='assigned', source='request', created_by=<me>, so
 * a plain staff user can never author an arbitrary task, self-assign, or spoof
 * the creator.
 *
 * POST /api/tasks/request
 *   Body (all client-set status/assignee/created_by/source values are IGNORED):
 *     title*      required, trimmed, <= 200 chars
 *     description optional, trimmed, <= 4000 chars
 *     category    one of Repairs | Maintenance | Housekeeping | Safety
 *                 (default 'Repairs'; anything else falls back to the default)
 *     priority    low | medium | high | urgent (default 'medium')
 *     department  a TASK_DEPARTMENTS name (default 'Maintenance'; unknown → default)
 *     photo_url   optional — a data:image/*;base64 URI or an internal
 *                 /api/tasks/files/<id> url. Any other string is rejected (400).
 *   →  201 { ok: true, task: { id, title, status } }
 *
 * GET  /api/tasks/request  →  { rows: Task[] }
 *   The caller's OWN raised requests (tasks WHERE created_by = me AND
 *   source = 'request'), newest first — powers a "My Requests" view.
 *
 * Gate: any signed-in user (401 otherwise). CSRF on POST is enforced by
 * proxy.ts (/api/tasks prefix).
 */
export const dynamic = 'force-dynamic';

/** Categories a self-service request may use (subset of TASK_CATEGORIES). */
const REQUEST_CATEGORIES = new Set(['Repairs', 'Maintenance', 'Housekeeping', 'Safety']);
const DEFAULT_CATEGORY = 'Repairs';

const VALID_PRIORITIES = new Set(TASK_PRIORITIES.map((p) => p.key as string));
const DEFAULT_PRIORITY = 'medium';

/** Departments a request may target (validated against the shared vocabulary). */
const VALID_DEPARTMENTS = new Set<string>(TASK_DEPARTMENTS as readonly string[]);
const DEFAULT_DEPARTMENT = 'Maintenance';

/**
 * Hard cap on the encoded length of an inline data:image URI. ImageUpload
 * downscales its output to ~250KB of decoded bytes (≈341KB of base64 chars);
 * this 512KB ceiling clears that worst case with headroom while refusing to
 * store an arbitrarily large inline blob. Without it this endpoint — open to
 * EVERY authenticated staff user — would let a direct API caller INSERT a
 * multi-megabyte row into task_attachments (DB bloat / memory DoS), and it
 * would contradict the size caps ImageUpload and POST /api/tasks/files already
 * enforce.
 */
const MAX_INLINE_PHOTO_CHARS = 512 * 1024;

/**
 * Validate an optional photo reference. Returns:
 *   ''    → no photo supplied (fine),
 *   <str> → a safe, storable reference,
 *   null  → an invalid value the caller must not be allowed to store.
 * Only two shapes are trusted: an inline `data:image/<t>;base64,<payload>` URI
 * (what ImageUpload produces) and an internal `/api/tasks/files/<id>` url (what
 * POST /api/tasks/files returns). Arbitrary strings / external URLs are rejected
 * so a request can't smuggle a link to an off-site or non-image resource. An
 * inline data URI is additionally rejected once it exceeds MAX_INLINE_PHOTO_CHARS
 * so an oversized blob can't be stored verbatim.
 */
function validatePhotoUrl(raw: any): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\/api\/tasks\/files\/[A-Za-z0-9_-]+$/.test(s)) return s;
  // Reject SVG (image/svg+xml can carry inline scripts → stored-XSS if ever
  // rendered as a document); accept only raster image subtypes, size-capped.
  if (/^data:image\/svg/i.test(s)) return null;
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/.test(s)) {
    return s.length > MAX_INLINE_PHOTO_CHARS ? null : s;
  }
  return null;
}

/**
 * Resolve who should be notified of a new request.
 *
 * Preference order:
 *   1. Users who canManageTasks AND are tied to the Maintenance department —
 *      matched EITHER by users.department_id pointing at a department named
 *      "Maintenance", OR by the functional users.section = 'Maintenance'.
 *   2. If none resolve, fall back to ALL managers (every canManageTasks user)
 *      so a request never sits unseen — someone always triages.
 *
 * "canManageTasks" is evaluated the same way getCurrentUser resolves a session:
 * the assigned role's base_role / flags win when a role_id is set, else the
 * legacy per-user columns. De-duped by lowercase email; the requester is never
 * notified (they get the API success instead).
 */
function resolveRecipients(db: any, excludeEmail: string): { email: string; name: string }[] {
  const ex = String(excludeEmail || '').trim().toLowerCase();

  // Department ids named "Maintenance" (there may be several across outlets).
  let maintDeptIds: string[] = [];
  try {
    maintDeptIds = (db
      .prepare(`SELECT id FROM departments WHERE lower(name) = 'maintenance'`)
      .all() as { id: string }[])
      .map((r) => r.id)
      .filter(Boolean);
  } catch {
    maintDeptIds = [];
  }

  // Pull every active user with the columns needed to (a) resolve the effective
  // manage capability and (b) test Maintenance association. LEFT JOIN roles the
  // same way auth.getCurrentUser does.
  let users: any[] = [];
  try {
    users = db.prepare(`
      SELECT u.email AS email, u.name AS name, u.role AS role, u.role_id AS role_id,
             u.is_head_chef AS is_head_chef, u.is_store_manager AS is_store_manager,
             u.department_id AS department_id, u.section AS section,
             r.base_role AS role_base, r.is_head_chef AS role_head_chef,
             r.is_store_manager AS role_store
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = 1
    `).all() as any[];
  } catch {
    users = [];
  }

  const managers: { email: string; name: string; inMaint: boolean }[] = [];
  const seen = new Set<string>();
  const maintSet = new Set(maintDeptIds);

  for (const u of users) {
    const email = String(u.email || '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (key === ex || seen.has(key)) continue;

    // Effective tier + flags (mirror getCurrentUser): the role wins when a
    // role_id is set AND resolved to a non-empty base_role.
    const hasRole = !!u.role_id && !!u.role_base;
    const effRole = String((hasRole ? u.role_base : u.role) || '').toLowerCase();
    const effHeadChef = !!u.is_head_chef || (hasRole && !!u.role_head_chef);
    const effStore = !!u.is_store_manager || (hasRole && !!u.role_store);
    const manages = effRole === 'admin' || effRole === 'manager' || effHeadChef || effStore;
    if (!manages) continue;

    seen.add(key);
    const inMaint =
      (!!u.department_id && maintSet.has(u.department_id)) ||
      String(u.section || '').trim().toLowerCase() === 'maintenance';
    managers.push({ email, name: String(u.name || '').trim(), inMaint });
  }

  const maintenanceManagers = managers.filter((m) => m.inMaint);
  const chosen = maintenanceManagers.length ? maintenanceManagers : managers;
  return chosen.map(({ email, name }) => ({ email, name }));
}

/** Fire a best-effort web-push that never throws into the request. */
function firePush(db: any, email: string, payload: { title: string; body: string; url?: string }): void {
  try {
    if (!email) return;
    Promise.resolve()
      .then(() => sendPushToUser(db, email, payload))
      .catch(() => { /* never */ });
  } catch {
    /* never throw */
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  const title = String(body?.title ?? '').trim();
  if (!title) return Response.json({ error: 'title is required' }, { status: 400 });
  if (title.length > 200) return Response.json({ error: 'title must be 200 characters or fewer' }, { status: 400 });

  const description = String(body?.description ?? '').trim();
  if (description.length > 4000) {
    return Response.json({ error: 'description must be 4000 characters or fewer' }, { status: 400 });
  }

  // Whitelist category (default Repairs), priority (default medium), department
  // (default Maintenance). Unknown values fall back to the safe default rather
  // than erroring — a self-service form should be forgiving.
  const catIn = String(body?.category ?? '').trim();
  const category = REQUEST_CATEGORIES.has(catIn) ? catIn : DEFAULT_CATEGORY;

  const prioIn = String(body?.priority ?? '').trim();
  const priority = VALID_PRIORITIES.has(prioIn) ? prioIn : DEFAULT_PRIORITY;

  const deptIn = String(body?.department ?? '').trim();
  const department = VALID_DEPARTMENTS.has(deptIn) ? deptIn : DEFAULT_DEPARTMENT;

  // Optional photo — validated; an explicitly-bad value is a 400 (do not silently
  // drop, so the caller learns their attachment was not stored).
  const photoUrl = validatePhotoUrl(body?.photo_url);
  if (photoUrl === null) {
    return Response.json(
      { error: 'photo_url must be a data:image/* URI or an /api/tasks/files/<id> url' },
      { status: 400 },
    );
  }

  const meEmail = me.email || '';
  const meName = me.name || me.email || '';

  try {
    const db = getDb();
    const id = generateId();

    // FORCED server-side — none of these are honoured from the body.
    const status = 'assigned';
    const source = 'request';

    const recipients = resolveRecipients(db, meEmail);

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO tasks (
          id, title, description, category, department, priority, status,
          assignee_email, assignee_name, created_by, source, is_archived
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, 0)
      `).run(id, title, description, category, department, priority, status, meEmail, source);

      db.prepare(`
        INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note)
        VALUES (?, ?, '', ?, ?, ?)
      `).run(generateId(), id, status, meEmail, 'raised via request');

      if (photoUrl) {
        db.prepare(`
          INSERT INTO task_attachments (id, task_id, comment_id, kind, url, filename, created_by)
          VALUES (?, ?, '', 'image', ?, '', ?)
        `).run(generateId(), id, photoUrl, meEmail);
      }

      // Route to the Maintenance triage queue: one notification row per recipient.
      for (const r of recipients) {
        db.prepare(`
          INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
          VALUES (?, ?, 'request', ?, ?, ?, '/tasks/board')
        `).run(
          generateId(),
          r.email,
          `New repair request: ${title}`,
          `${meName || 'An employee'} raised a ${category.toLowerCase()} request.`,
          id,
        );
      }
    });
    tx();

    // Best-effort push AFTER the transaction commits (never throws).
    for (const r of recipients) {
      firePush(db, r.email, {
        title: `New repair request: ${title}`,
        body: `${meName || 'An employee'} raised a ${category.toLowerCase()} request.`,
        url: '/tasks/board',
      });
    }

    return Response.json({ ok: true, task: { id, title, status } }, { status: 201 });
  } catch (e: any) {
    console.error('POST /api/tasks/request failed:', e);
    return Response.json({ error: e?.message || 'Failed to raise request' }, { status: 500 });
  }
}

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM tasks
      WHERE lower(created_by) = lower(?) AND source = 'request'
      ORDER BY created_at DESC
    `).all(me.email || '') as any[];
    return Response.json({ rows });
  } catch (e: any) {
    console.error('GET /api/tasks/request failed:', e);
    return Response.json({ error: e?.message || 'Failed to load requests' }, { status: 500 });
  }
}
