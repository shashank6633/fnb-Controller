import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canonNameInput } from '@/lib/name-canon';

// Disable any caching — the list changes immediately on import / edit and we want
// the browser to always see a fresh count.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Departments — Bar, Hot Kitchen, Cold Kitchen, Pastry, Bakery, etc.
 *
 * GET    /api/departments              → list (with member + open-req counts)
 * GET    /api/departments?id=X         → single
 * POST   /api/departments               admin-only
 *        body: { name, code?, description?, head_chef_user_id? }
 * PUT    /api/departments               admin-only
 *        409 when material_categories claims a category another MAIN department
 *        already owns (names the category and the owner; see the block below)
 * DELETE /api/departments?id=X          admin-only — soft-delete (is_active=0)
 */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (id) {
      const row = db.prepare(`
        SELECT d.*, u.name AS head_chef_name, u.email AS head_chef_email,
               hu.name AS head_user_name, hu.email AS head_user_email,
               p.name AS parent_name
        FROM departments d
        LEFT JOIN users u ON u.id = d.head_chef_user_id
        LEFT JOIN users hu ON hu.id = d.head_user_id
        LEFT JOIN departments p ON p.id = d.parent_id
        WHERE d.id = ?
      `).get(id);
      if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json({ department: row });
    }
    const rows = db.prepare(`
      SELECT d.*,
             u.name  AS head_chef_name,
             u.email AS head_chef_email,
             hu.name  AS head_user_name,
             hu.email AS head_user_email,
             p.name  AS parent_name,
             (SELECT COUNT(*) FROM users WHERE department_id = d.id AND is_active = 1) AS member_count,
             (SELECT COUNT(*) FROM requisitions
               WHERE department_id = d.id
                 AND status NOT IN ('fulfilled', 'cancelled', 'chef_rejected')) AS open_requisition_count
      FROM departments d
      LEFT JOIN users u ON u.id = d.head_chef_user_id
      LEFT JOIN users hu ON hu.id = d.head_user_id
      LEFT JOIN departments p ON p.id = d.parent_id
      ORDER BY (d.parent_id IS NOT NULL), d.is_active DESC, d.name ASC
    `).all();
    console.log(`[/api/departments GET] returning ${(rows as any[]).length} departments`);
    return Response.json({ departments: rows });
  } catch (e: any) {
    console.error('[/api/departments GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const db = getDb();
    const b = await request.json();
    if (!b.name || !String(b.name).trim()) {
      return Response.json({ error: 'name required' }, { status: 400 });
    }
    const id = generateId();
    db.prepare(`
      INSERT INTO departments (id, name, code, description, head_chef_user_id, head_user_id, parent_id, area, is_active, submission_windows, submission_grace_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, String(b.name).trim(), b.code || '', b.description || '', b.head_chef_user_id || null,
            b.head_user_id || null, b.parent_id || null,
            String(b.area || '').trim(),
            String(b.submission_windows || '').trim(),
            b.submission_grace_minutes != null ? Number(b.submission_grace_minutes) : 30);
    const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
    return Response.json({ department: row }, { status: 201 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const db = getDb();
    const b = await request.json();
    if (!b.id) return Response.json({ error: 'id required' }, { status: 400 });
    // material_categories: array of category names → JSON string. Empty array
    // or null clears the whitelist (= dept sees all materials).
    let matCatsJson: string | null | undefined;
    if (b.material_categories !== undefined) {
      if (Array.isArray(b.material_categories) && b.material_categories.length > 0) {
        /* ── A MATERIAL CATEGORY BELONGS TO EXACTLY ONE DEPARTMENT ──────────
         * Nothing refused an overlapping whitelist before, so two MAIN
         * departments could both claim "meat" (proven on a copy of the live
         * DB: Operations claiming Kitchen's "meat" saved 200) — and the PO
         * deviation router (src/lib/po-deviation-alert.ts) then cannot name a
         * single owner: it alerts EVERY claimant's heads and files a routing
         * gap for the admin on every such receipt. Refused at the ONLY door
         * that writes this column (this PUT; the POST above never binds it),
         * naming the clash and its owner so the fix is one screen away.
         *
         * The comparison key is the router's own fold (catKey =
         * trim().toLowerCase()) hardened with the invisible-character strip
         * (@/lib/name-canon) so a zero-width character cannot smuggle a
         * look-identical claim past this refusal. DEACTIVATED main departments
         * still count as owners — deactivation keeps the whitelist
         * (DELETE below is a soft-delete), reactivation is one tick, and this
         * check does not run on reactivation, so allowing the claim now would
         * plant a dormant collision. The 409 says so and names the remedy.
         * Checked against OTHER departments only (id <> b.id): re-saving a
         * department's own list is always legal. Measured on the live DB
         * 2026-09-02: zero collisions exist today, so nothing stored is
         * refused by this arriving.
         */
        const keyOf = (v: unknown) => canonNameInput(v).toLowerCase();
        const others = db.prepare(`
          SELECT id, name, is_active, material_categories
            FROM departments
           WHERE parent_id IS NULL AND id <> ?
        `).all(String(b.id)) as Array<{ id: string; name: string; is_active: number; material_categories: string | null }>;
        const ownerByCat = new Map<string, { id: string; name: string; is_active: number }>();
        for (const d of others) {
          try {
            const arr = JSON.parse(d.material_categories || '[]');
            if (Array.isArray(arr)) {
              for (const c of arr) {
                const k = keyOf(c);
                if (k && !ownerByCat.has(k)) ownerByCat.set(k, { id: d.id, name: d.name, is_active: d.is_active === null || d.is_active === undefined ? 1 : Number(d.is_active) });
              }
            }
          } catch { /* a malformed stored whitelist owns nothing — same reading as the router's */ }
        }
        for (const c of b.material_categories) {
          const k = keyOf(c);
          if (!k) continue;
          const owner = ownerByCat.get(k);
          if (owner) {
            const label = canonNameInput(c) || String(c);
            return Response.json({
              error: `Category "${label}" already belongs to ${owner.name}`
                + (owner.is_active ? '' : ' (a deactivated department — its whitelist still counts, because reactivating it is one tick)')
                + `. A material category can belong to exactly ONE department, or deviation alerts cannot name a single owner. `
                + `Nothing was saved. Remove "${label}" from ${owner.name}'s material list first, then add it here.`,
              conflict_category: label,
              conflict_department_id: owner.id,
              conflict_department: owner.name,
            }, { status: 409 });
          }
        }
        matCatsJson = JSON.stringify(b.material_categories);
      } else {
        matCatsJson = null;
      }
    }
    db.prepare(`
      UPDATE departments SET
        name              = COALESCE(?, name),
        code              = COALESCE(?, code),
        description       = COALESCE(?, description),
        area              = COALESCE(?, area),
        head_chef_user_id = ?,
        is_active         = COALESCE(?, is_active),
        submission_windows       = COALESCE(?, submission_windows),
        submission_grace_minutes = COALESCE(?, submission_grace_minutes),
        material_categories      = CASE WHEN ? = 1 THEN ? ELSE material_categories END,
        parent_id                = CASE WHEN ? = 1 THEN ? ELSE parent_id END,
        head_user_id             = CASE WHEN ? = 1 THEN ? ELSE head_user_id END,
        updated_at        = datetime('now')
      WHERE id = ?
    `).run(
      b.name ?? null, b.code ?? null, b.description ?? null,
      b.area ?? null,
      b.head_chef_user_id !== undefined ? b.head_chef_user_id : null,
      b.is_active != null ? (b.is_active ? 1 : 0) : null,
      b.submission_windows ?? null,
      b.submission_grace_minutes != null ? Number(b.submission_grace_minutes) : null,
      // CASE flag: 1 if caller explicitly sent material_categories, else 0 (keep old value)
      b.material_categories !== undefined ? 1 : 0,
      matCatsJson ?? null,
      // parent_id / head_user_id: CASE flag so they can be set OR cleared to NULL
      b.parent_id !== undefined ? 1 : 0,
      b.parent_id ?? null,
      b.head_user_id !== undefined ? 1 : 0,
      b.head_user_id ?? null,
      b.id,
    );
    const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(b.id);
    return Response.json({ department: row });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    db.prepare(`UPDATE departments SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    return Response.json({ success: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
