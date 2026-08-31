import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { requireRole, getCurrentOutletId } from '@/lib/auth';
import {
  MAX_CATEGORY_LEN,
  sanitizeCategoryName,
  foldCategoryName,
  findMenuCategory,
} from '@/lib/menu-category';

/**
 * BULK-RENAME A MENU CATEGORY across every item that carries it.
 *
 * `menu_items.category` is a plain TEXT column holding the string; a rename is
 * therefore one UPDATE across `menu_items`. There is now also a
 * `menu_categories` MASTER — the list of names the item form offers — and this
 * route is the ONLY place allowed to move a name on both. It does so in ONE
 * transaction, so the master and the items can never disagree:
 * /api/menu-items/categories deliberately refuses a `name` change and points
 * back here. (Master rows carry an id that nothing else references, so a rename
 * there is a plain UPDATE, not a re-key.)
 *
 * ── IT REFUSES TO MERGE ─────────────────────────────────────────────────────
 * If the new name already belongs to another category — exactly, or ignoring
 * case — this route REFUSES with 409 and names the clash. It never folds the
 * two categories together. Merging is destructive in a way a rename is not:
 * once "beer" and "Beer" are one string there is no record of which items came
 * from where, and the sales reports that group live on `menu_items.category`
 * would silently combine two histories. If a merge is ever wanted it has to be
 * asked for and built deliberately; it is not something a mistyped rename
 * should do by accident.
 *
 * The one collision that IS allowed is re-casing the SAME category
 * ("Pizzas" -> "PIZZAS"): the clash query excludes the source category, so that
 * is a rename, not a self-merge.
 *
 * ── IT DOES NOT SCOPE TO is_active ──────────────────────────────────────────
 * `GET /api/menu-items` builds its `categories` list from `SELECT * FROM
 * menu_items` with no active filter, so leaving inactive rows on the old string
 * would make the old category REAPPEAR in the picker the moment the page
 * reloads. Every row moves, or the rename is a lie. (The recipes equivalent at
 * /api/recipes/rename-category does scope to is_active = 1; that is the right
 * call there and the wrong one here.)
 *
 * ── IT WRITES TO menu_items AND NOTHING ELSE ────────────────────────────────
 * Ten category strings (`beer`, `red-wine`, `gin`, `vodka`, …) exist as BOTH a
 * `menu_items.category` and a `store_category_map` key — but that map keys
 * `raw_materials.category`, a different column that happens to share text.
 * Cascading a menu rename into it would break liquor-store routing and QC
 * checker assignment. `sales.category` is likewise a frozen POS snapshot, not a
 * foreign key. Neither is touched.
 *
 * Blast radius of a successful rename (verified, not assumed):
 *   · `order_items` has NO category column — it snapshots `name` and `station`,
 *     so order history CANNOT be corrupted by this.
 *   · KDS / KOT routing / sticker-KOT / print bridge / the station→department
 *     recipe deduction are all station-keyed — untouched.
 *   · Reports that join live to `menu_items` relabel history. That is what a
 *     rename means and it is correct.
 *
 * ── IT ALSO MOVES THE MASTER ROW ────────────────────────────────────────────
 * `menu_categories` is the list the item form offers. A rename that moved the
 * items but not the master would leave the new name unpickable and the old one
 * still on offer — so the master row is renamed in the SAME transaction, and a
 * name already in the master (even one no item uses) is a 409 just like a name
 * already on items. A category that exists ONLY in the master, with no items
 * yet, is renameable: that is a freshly-added category being corrected, not the
 * "renamed or emptied by someone else" race the 404 is for.
 *
 * Body: { from: string, to: string }
 * 200 { renamed, from, to } · 400 bad input · 404 source gone · 409 name taken
 *
 * MAX_CATEGORY_LEN / sanitizeCategoryName / foldCategoryName live in
 * src/lib/menu-category.ts — shared, because the master routes and the CSV
 * importer now write category names too and a second copy would drift.
 */

export async function POST(req: Request) {
  // Admin only. The single-item menu-item writes (POST/PUT/DELETE on
  // /api/menu-items) carry no handler gate at all — they lean on the proxy,
  // which authenticates but never checks a role — so there is no local gate
  // worth mirroring. This rewrites the category on up to every item at once and
  // re-sorts the guest-facing QR menu, so it takes the gate the repo's other
  // bulk menu_items write uses (reports/menu-recipe-gap: "Admin only — stricter
  // than GET's management gate") and that /api/recipes/rename-category uses.
  // Sitting under the /api/menu-items prefix also inherits the proxy's CSRF
  // requirement (proxy.ts CSRF_REQUIRED_PREFIXES matches by startsWith).
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  try {
    const body = await req.json().catch(() => ({} as any));
    // `from` is matched against the stored column EXACTLY and is therefore NOT
    // trimmed. Trimming it aimed at the wrong row: `GET /api/menu-items` lists
    // "mains" and "mains " as two separate picker entries (POST/PUT on
    // /api/menu-items and the CSV importer all store `category` untrimmed), and
    // picking the padded one used to rename the OTHER category — a different
    // set of items moved, and the audit row recorded a source the admin never
    // chose. Proven on a fixture: from:"grills " (2 items) returned
    // {"renamed":3,"from":"grills"} and emptied "grills" instead. Matching the
    // raw string also makes a padded-only category renameable at all.
    const from = String(body?.from ?? '');
    const to = sanitizeCategoryName(body?.to);

    if (!from.trim()) return Response.json({ error: 'Pick the category you want to rename.' }, { status: 400 });
    if (!to) return Response.json({ error: 'Type the new category name — it cannot be blank. (Invisible characters do not count as a name.)' }, { status: 400 });
    if (to.length > MAX_CATEGORY_LEN) {
      return Response.json({
        error: `The new name is ${to.length} characters. Keep it to ${MAX_CATEGORY_LEN} or fewer so it still fits the category chips and the guest menu heading.`,
      }, { status: 400 });
    }
    if (from === to) {
      return Response.json({ error: `"${to}" is already the name of that category — there is nothing to rename.` }, { status: 400 });
    }

    const db = getDb();
    // Resolved BEFORE the transaction opens: better-sqlite3 is synchronous and
    // no `await` may appear inside a db.transaction() callback.
    const actorEmail = auth.user.email || '';
    const outletId = await getCurrentOutletId();

    // Check and update in ONE transaction. Splitting them would leave a window
    // where a second admin (or the CSV importer) creates the target name
    // between the check and the UPDATE, and the refusal would be bypassed —
    // the exact silent merge this route exists to prevent.
    const run = db.transaction(() => {
      const src = db.prepare('SELECT COUNT(*) AS n FROM menu_items WHERE category = ?').get(from) as any;
      const count = Number(src?.n || 0);
      // The master row for the source, matched on the EXACT string for the same
      // reason `from` is: a padded "mains " and a clean "mains" are two
      // different categories, and a NOCASE lookup would hand back the wrong one.
      //
      // COLLATE BINARY IS LOAD-BEARING, NOT DECORATION. `menu_categories.name`
      // is declared COLLATE NOCASE, and a bare `=` INHERITS THE COLUMN'S
      // COLLATION — so `WHERE name = ?` here was case-insensitive and did
      // precisely what the paragraph above says it must not. Proven on a copy
      // of the live DB: {"from":"BREADS","to":"BREADS-ZZ"} returned
      // 200 {"renamed":0} while the unrelated master row `breads` was renamed
      // out from under its 4 items — the 404 guard below was bypassed because
      // `srcMaster` wrongly matched, a live category silently stopped being
      // pickable, and the audit note said the entry "was renamed with them"
      // when the entry that moved was a different one. The explicit COLLATE on
      // the right operand overrides the column's implicit collation (SQLite
      // datatype rules §7.1), which is the only way to ask this column an
      // exact-string question.
      const srcMaster = db.prepare('SELECT * FROM menu_categories WHERE name = ? COLLATE BINARY').get(from) as { id: string; name: string; is_active: number } | undefined;
      if (count === 0 && !srcMaster) {
        return {
          ok: false as const,
          status: 404,
          error: `No menu items are in the category "${from}" any more — it may have just been renamed or emptied by someone else. Reload the page and pick again.`,
        };
      }

      // THE REFUSAL. `menu_items.category` has no COLLATE NOCASE and its index
      // is binary, so `=` alone would let "Beer" through against an existing
      // "beer"; the name is folded before comparing to make the check
      // case-insensitive as asked. `category <> ?` excludes the source, so
      // re-casing the same category is still a legal rename rather than a
      // collision with itself.
      //
      // The fold is done in JS, NOT in SQL. SQLite's LOWER() is ASCII-only:
      // LOWER('CAFÉ') is 'cafÉ', so an SQL-side check lets "CAFÉ" through
      // against an existing "café" and the two sit side by side — precisely the
      // case-duplicate this route exists to refuse. Verified on a copy of the
      // live DB: the SQL form returned 200 and created the pair. JS
      // toLowerCase() folds the full range, and it is the same call the dialog
      // uses client-side, so the two checks agree exactly.
      //
      // Both sides go through foldCategoryName, not just the new name: a
      // category already carrying an invisible character (POST /api/menu-items
      // and the CSV importer still write `category` as unchecked free text) has
      // to be seen for what it renders as, or renaming to the visible spelling
      // would recreate the twin from the other side.
      const foldKey = foldCategoryName;
      const wanted = foldKey(to);
      const clash = (db.prepare(`
        SELECT category AS name, COUNT(*) AS n
          FROM menu_items
         WHERE category <> ?
         GROUP BY category
         ORDER BY n DESC
      `).all(from) as any[]).find(r => foldKey(String(r.name)) === wanted);
      if (clash) {
        const n = Number(clash.n || 0);
        const sameText = String(clash.name) === to;
        return {
          ok: false as const,
          status: 409,
          error: `"${clash.name}" already exists (${n} item${n === 1 ? '' : 's'})${sameText ? '' : ' — the check ignores capitalisation'}. Renaming "${from}" to it would merge the two categories into one, which this tool will not do. Pick a name that is not already in use.`,
        };
      }

      // THE SAME REFUSAL, ON THE MASTER. A name can sit in `menu_categories`
      // with no item using it yet (just added, or deactivated after its items
      // moved away), and the items-only check above cannot see it. Without this
      // the UPDATE below would hit the master's UNIQUE COLLATE NOCASE index and
      // surface as a bare 500; worse, if it did not, the picker would end up
      // offering two rows that render identically. `id <> ` excludes the source
      // row so re-casing the same category stays legal, exactly as above.
      const masterClash = findMenuCategory(db, to);
      if (masterClash && (!srcMaster || masterClash.id !== srcMaster.id)) {
        const used = Number((db.prepare('SELECT COUNT(*) AS n FROM menu_items WHERE category = ? COLLATE NOCASE').get(masterClash.name) as { n?: number } | undefined)?.n || 0);
        return {
          ok: false as const,
          status: 409,
          error: `"${masterClash.name}" is already in the category list${masterClash.is_active ? '' : ' (deactivated)'}${used ? ` and ${used} item${used === 1 ? ' uses' : 's use'} it` : ' — no items use it yet'}. Renaming "${from}" to it would merge the two, which this tool will not do. Pick a name that is not already in use.`,
        };
      }

      // No is_active scoping — see the header. Every row on the old string moves.
      const res = db.prepare(
        `UPDATE menu_items SET category = ?, updated_at = datetime('now') WHERE category = ?`
      ).run(to, from);

      // The master moves WITH the items, in this same transaction. If the source
      // has no master row (a category that predates the master, or one whose
      // name is only on items) the new name is created instead, so the rename
      // always ends with the result pickable — never a rename into a category
      // nobody can choose. is_active is NOT touched either way: renaming a
      // retired category leaves it retired.
      let masterAction: 'renamed' | 'created' | 'none' = 'none';
      if (srcMaster) {
        db.prepare(`UPDATE menu_categories SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(to, srcMaster.id);
        masterAction = 'renamed';
      } else {
        const next = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM menu_categories`).get() as { n?: number } | undefined;
        db.prepare(`INSERT INTO menu_categories (id, name, sort_order) VALUES (?, ?, ?)`).run(generateId(), to, Number(next?.n || 0));
        masterAction = 'created';
      }

      // Append-only audit, inside the transaction so it cannot survive a
      // rolled-back rename. logAuditEvent swallows its own errors and never
      // throws, so it cannot take the rename down with it.
      logAuditEvent(db, {
        event_type: 'menu_category.rename',
        entity_type: 'menu_category',
        entity_id: from,
        actor_email: actorEmail,
        outlet_id: outletId,
        before: { category: from, items: count, master_id: srcMaster?.id || null },
        after: { category: to, items: res.changes, master: masterAction },
        note: `Renamed menu category "${from}" to "${to}" across ${res.changes} menu item${res.changes === 1 ? '' : 's'} (active and inactive); the category list entry was ${masterAction === 'renamed' ? 'renamed with them' : 'created so the new name stays pickable'}. menu_items and menu_categories only — no raw-material, store or sales row was touched.`,
      });

      return { ok: true as const, renamed: res.changes, from, to };
    });

    const result = run();
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ renamed: result.renamed, from: result.from, to: result.to });
  } catch (e: any) {
    console.error('[menu-items/rename-category]', e);
    return Response.json({ error: e?.message || 'Rename failed' }, { status: 500 });
  }
}
