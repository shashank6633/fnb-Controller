/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, requireRole, getCurrentOutletId } from '@/lib/auth';
import {
  MAX_CATEGORY_LEN,
  sanitizeCategoryName,
  foldCategoryName,
  findMenuCategory,
  type MenuCategoryRow,
} from '@/lib/menu-category';

/**
 * MENU CATEGORY MASTER (/api/menu-items/categories).
 *
 * The list that decides WHAT AN ADMIN CAN PICK as a menu item's category. It
 * does NOT decide what an item stores: `menu_items.category` is still a plain
 * TEXT column holding the string, with no foreign key to here (see the
 * `menu_categories` block in src/lib/db.ts for why that is the whole point).
 *
 * GET    ?include_inactive=1 → { categories, orphans }
 *          Signed-in. Every user who can open the Menu Items page needs this to
 *          render the item form's dropdown, so it is no stricter than
 *          GET /api/menu-items, which the same page already calls.
 *          `categories` carry item_count (how many menu items actually use the
 *          name, matched case-insensitively) and `spellings` (the distinct
 *          strings those items store, when they are not all identical).
 *          `orphans` are category strings live on items that have NO master row
 *          — nothing offers them any more, but the items still carry them.
 *
 * POST   { name } → { category }                       Admin only. 409 on a
 *          name already in the master (exactly, or ignoring case).
 *
 * PUT    { id, is_active? , sort_order? } → { category }          Admin only.
 * PUT    { order: [id, …] }               → { reordered: n }      Admin only.
 *
 * THERE IS NO RENAME HERE, AND NO DELETE.
 *   · RENAME goes through POST /api/menu-items/rename-category — the one route
 *     that may touch menu_items.category. It moves the items and this master
 *     row in a single transaction, so the two can never disagree. A second
 *     rename path here would be able to rename the master while every item kept
 *     the old string, which is precisely the drift the master exists to end.
 *   · DELETE is deactivation (PUT is_active=0). Items already carrying the name
 *     KEEP it; the category simply stops being offered. Removing the row while
 *     items still used the string would leave those items pointing at nothing
 *     an admin can see or manage, and rewriting them instead is a rename.
 *
 * ADMIN, because that is what the rename control this sits beside requires
 * (/api/menu-items/rename-category calls requireRole('admin')) — checked, not
 * assumed. Deactivating a category changes what every admin may pick and what
 * the guest-facing menu can grow, which is the same blast radius. Sitting under
 * the /api/menu-items prefix also inherits the proxy's CSRF requirement
 * (proxy.ts CSRF_REQUIRED_PREFIXES matches by startsWith).
 */
export const dynamic = 'force-dynamic';

/** Master rows + how many items really use each name. The count is grouped
 *  case-insensitively because that is how the master identifies a name; the
 *  distinct spellings ride along so an admin can see when items disagree with
 *  the master about capitalisation (a CSV import can create that). */
function listCategories(db: ReturnType<typeof getDb>, includeInactive: boolean) {
  const rows = db.prepare(
    `SELECT * FROM menu_categories${includeInactive ? '' : ' WHERE is_active = 1'} ORDER BY sort_order ASC, name COLLATE NOCASE ASC`,
  ).all() as MenuCategoryRow[];

  // One pass over the items, folded in JS — the same fold the refusal messages
  // use, so what the screen calls "the same category" never disagrees with what
  // the rename dialog calls a clash.
  const used = db.prepare(
    `SELECT category AS name, COUNT(*) AS n FROM menu_items WHERE category IS NOT NULL AND TRIM(category) <> '' GROUP BY category`,
  ).all() as { name: string; n: number }[];
  const byFold = new Map<string, { total: number; spellings: Record<string, number> }>();
  for (const u of used) {
    const k = foldCategoryName(u.name);
    const e = byFold.get(k) || { total: 0, spellings: {} };
    e.total += Number(u.n) || 0;
    e.spellings[String(u.name)] = Number(u.n) || 0;
    byFold.set(k, e);
  }

  // CLAIMED IS BUILT FROM EVERY MASTER ROW, NOT FROM THE ROWS BEING RETURNED.
  // A DEACTIVATED category is still IN the master — retiring it stops it being
  // offered, it does not remove it — so its items are not orphans. Building this
  // from `rows` made GET without ?include_inactive=1 report every item of every
  // retired category as "live on items, absent from the master", the exact
  // opposite of what a retire means. Proven on a copy of the live DB: with a
  // retired category carrying 3 items, the unflagged GET listed all 3 as
  // orphans while the flagged GET listed none. Latent today (the item form
  // always passes the flag) but it is a wrong answer from a signed-in API.
  const claimed = new Set<string>(
    (db.prepare(`SELECT name FROM menu_categories`).all() as { name: string }[])
      .map((r) => foldCategoryName(r.name)),
  );
  const categories = rows.map((r) => {
    const k = foldCategoryName(r.name);
    const e = byFold.get(k);
    const spellings = e ? Object.keys(e.spellings) : [];
    return {
      ...r,
      item_count: e ? e.total : 0,
      // Only worth showing when the items do NOT all store exactly the master's
      // name — otherwise it is noise on all 47 rows.
      spellings: spellings.length && !(spellings.length === 1 && spellings[0] === r.name) ? spellings : [],
    };
  });

  // Live on items, absent from the master. Every seeded category starts matched,
  // so a row here means a string arrived some other way (a hand-made API call,
  // or a CSV category too long for the master).
  const orphans = [...byFold.entries()]
    .filter(([k]) => !claimed.has(k))
    .flatMap(([, e]) => Object.entries(e.spellings).map(([name, n]) => ({ name, item_count: n })))
    .sort((a, b) => b.item_count - a.item_count);

  return { categories, orphans };
}

export async function GET(request: Request) {
  // Signed-in, not management: the item form's dropdown is useless without this
  // list, and GET /api/menu-items — which the very same page calls to render the
  // items — carries no role gate either. A stricter gate here would hand a
  // non-admin an empty dropdown and let them save an item with no category.
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const db = getDb();
    const includeInactive = new URL(request.url).searchParams.get('include_inactive') === '1';
    return Response.json(listCategories(db, includeInactive));
  } catch (e: any) {
    console.error('[GET /api/menu-items/categories]', e);
    return Response.json({ error: e?.message || 'Failed to load categories' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const name = sanitizeCategoryName(body?.name);
  if (!name) {
    return Response.json({ error: 'Type a category name — it cannot be blank. (Invisible characters do not count as a name.)' }, { status: 400 });
  }
  if (name.length > MAX_CATEGORY_LEN) {
    return Response.json({
      error: `That name is ${name.length} characters. Keep it to ${MAX_CATEGORY_LEN} or fewer so it still fits the category chips and the guest menu heading.`,
    }, { status: 400 });
  }

  // better-sqlite3 is synchronous — every await is resolved BEFORE the DB work.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const run = db.transaction(() => {
      // Check and insert in ONE transaction, or two admins adding the same name
      // at once would both pass the check and the second would hit the unique
      // index as a raw 500 instead of the 409 below.
      const clash = findMenuCategory(db, name);
      if (clash) {
        return {
          ok: false as const,
          status: 409,
          error: `"${clash.name}" is already in the category list${clash.is_active ? '' : ' (deactivated — reactivate it instead of adding a second one)'}. The check ignores capitalisation.`,
        };
      }
      const next = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM menu_categories`).get() as any;
      const id = generateId();
      db.prepare(`INSERT INTO menu_categories (id, name, sort_order) VALUES (?, ?, ?)`).run(id, name, Number(next?.n || 0));
      const category = db.prepare(`SELECT * FROM menu_categories WHERE id = ?`).get(id) as MenuCategoryRow;
      logAuditEvent(db, {
        event_type: 'menu_category.create',
        entity_type: 'menu_category',
        entity_id: id,
        actor_email: auth.user.email || '',
        outlet_id: outletId,
        after: category,
        note: `Added menu category "${name}". No menu item was changed — this only makes the name pickable.`,
      });
      return { ok: true as const, category };
    });
    const result = run();
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ category: result.category }, { status: 201 });
  } catch (e: any) {
    console.error('[POST /api/menu-items/categories]', e);
    return Response.json({ error: e?.message || 'Failed to add the category' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  // A rename must not sneak in through the update path — it would move the
  // master while every item kept the old string.
  if (body?.name !== undefined) {
    return Response.json({
      error: 'Renaming is done by POST /api/menu-items/rename-category, so the items and the category list move together.',
    }, { status: 400 });
  }

  const outletId = await getCurrentOutletId();
  const actorEmail = auth.user.email || '';

  try {
    const db = getDb();

    // ── Bulk reorder: { order: [id, …] } ─────────────────────────────────────
    if (Array.isArray(body?.order)) {
      const ids: string[] = body.order.map((x: any) => String(x || '')).filter(Boolean);
      if (ids.length === 0) return Response.json({ error: 'order must list at least one category id' }, { status: 400 });
      if (new Set(ids).size !== ids.length) return Response.json({ error: 'order lists the same category twice' }, { status: 400 });

      const run = db.transaction(() => {
        const known = new Set((db.prepare(`SELECT id FROM menu_categories`).all() as any[]).map((r) => String(r.id)));
        const missing = ids.filter((id) => !known.has(id));
        if (missing.length) {
          return {
            ok: false as const,
            status: 404,
            error: `${missing.length} of those categories no longer exist — someone else may have changed the list. Reload and try again.`,
          };
        }
        const upd = db.prepare(`UPDATE menu_categories SET sort_order = ?, updated_at = datetime('now') WHERE id = ?`);
        ids.forEach((id, i) => upd.run(i, id));
        return { ok: true as const, reordered: ids.length };
      });
      const result = run();
      if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
      return Response.json({ reordered: result.reordered, ...listCategories(db, true) });
    }

    // ── Single row: { id, is_active? , sort_order? } ──────────────────────────
    const id = String(body?.id || '').trim();
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
    const before = db.prepare(`SELECT * FROM menu_categories WHERE id = ?`).get(id) as MenuCategoryRow | undefined;
    if (!before) return Response.json({ error: 'That category is no longer in the list. Reload and try again.' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];
    if (body.is_active !== undefined) { sets.push('is_active = ?'); args.push(body.is_active ? 1 : 0); }
    if (body.sort_order !== undefined) {
      const n = Number(body.sort_order);
      if (!Number.isFinite(n)) return Response.json({ error: 'sort_order must be a number' }, { status: 400 });
      sets.push('sort_order = ?'); args.push(Math.trunc(n));
    }
    if (!sets.length) return Response.json({ error: 'Nothing to change' }, { status: 400 });

    args.push(id);
    db.prepare(`UPDATE menu_categories SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...args);
    const category = db.prepare(`SELECT * FROM menu_categories WHERE id = ?`).get(id) as MenuCategoryRow;

    if (body.is_active !== undefined && !!before.is_active !== !!category.is_active) {
      const n = (db.prepare(
        `SELECT COUNT(*) AS n FROM menu_items WHERE category = ? COLLATE NOCASE`,
      ).get(before.name) as any)?.n || 0;
      logAuditEvent(db, {
        event_type: category.is_active ? 'menu_category.reactivate' : 'menu_category.deactivate',
        entity_type: 'menu_category',
        entity_id: id,
        actor_email: actorEmail,
        outlet_id: outletId,
        before, after: category,
        note: category.is_active
          ? `Reactivated menu category "${category.name}" — it is offered in the item form again. No menu item was changed.`
          : `Deactivated menu category "${category.name}" — it is no longer offered in the item form. The ${n} menu item${n === 1 ? '' : 's'} already in it KEEP the category and stay on every menu and report; nothing was rewritten.`,
      });
    }
    return Response.json({ category });
  } catch (e: any) {
    console.error('[PUT /api/menu-items/categories]', e);
    return Response.json({ error: e?.message || 'Failed to update the category' }, { status: 500 });
  }
}
