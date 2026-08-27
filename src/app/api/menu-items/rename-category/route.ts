import { getDb, logAuditEvent } from '@/lib/db';
import { requireRole, getCurrentOutletId } from '@/lib/auth';

/**
 * BULK-RENAME A MENU CATEGORY across every item that carries it.
 *
 * There is no `menu_categories` table. `menu_items.category` is a plain TEXT
 * column and the item form writes it as free text (`<input list="categories">`),
 * so a category exists only because items use it and vanishes when none do.
 * A rename is therefore one UPDATE across `menu_items` — nothing else.
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
 * Body: { from: string, to: string }
 * 200 { renamed, from, to } · 400 bad input · 404 source gone · 409 name taken
 */

/** Long enough for the longest live category (28 chars), short enough to stay
 *  legible in the category chips and the guest menu's section heading. */
const MAX_CATEGORY_LEN = 60;

/**
 * Clean an incoming category name before it is stored OR compared.
 *
 * `trim().toLowerCase()` alone is not enough: a name can carry characters that
 * take no space on screen, and those defeat the whole point of the refusal
 * below. Proven on a copy of the live DB before this existed — `beer` renamed
 * to `"breads" + U+200B` returned 200 and left `breads` (4 items) and a second
 * `breads` (24 items) side by side, indistinguishable in the picker, on the
 * guest QR menu and in the audit note. A lone U+200B passed the "cannot be
 * blank" guard and produced a category that renders as nothing; `beer` ->
 * `"beer" + U+200B` passed the "nothing to rename" guard and silently changed
 * the key while every surface still read `Renamed "beer" to "beer"`.
 *
 *   · NFC first, so `café` typed as e + U+0301 is the same string as `café`.
 *   · Every kind of whitespace (NBSP, U+3000, tab, newline) becomes one plain
 *     space — a category name is a heading, not a paragraph.
 *   · Format and control characters (U+200B/200C/200D/2060/00AD/180E/FEFF and
 *     friends — Unicode Cf and Cc) are removed outright. They are invisible, so
 *     nobody can have meant to type one.
 *
 * Identity on all 47 live category names (verified), so nothing existing moves.
 */
const SPACEY = /[\p{Zs}\t\n\r\f\v]+/gu;
const FORMAT_OR_CONTROL = /[\p{Cf}\p{Cc}]/gu;
function sanitizeCategoryName(s: unknown): string {
  return String(s ?? '')
    .normalize('NFC')
    .replace(SPACEY, ' ')
    .replace(FORMAT_OR_CONTROL, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** The comparison key for "does this name already exist?". Sanitised, then
 *  NFKC (folds compatibility look-alikes such as the ﬁ ligature) and lowercased
 *  — JS toLowerCase, never SQLite's LOWER(), which is ASCII-only and lets CAFÉ
 *  through against café. On the live all-ASCII category list this is exactly
 *  the old trim().toLowerCase(), so no existing name starts colliding. */
function foldCategoryName(s: unknown): string {
  return sanitizeCategoryName(s).normalize('NFKC').toLowerCase();
}

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
      if (count === 0) {
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

      // No is_active scoping — see the header. Every row on the old string moves.
      const res = db.prepare(
        `UPDATE menu_items SET category = ?, updated_at = datetime('now') WHERE category = ?`
      ).run(to, from);

      // Append-only audit, inside the transaction so it cannot survive a
      // rolled-back rename. logAuditEvent swallows its own errors and never
      // throws, so it cannot take the rename down with it.
      logAuditEvent(db, {
        event_type: 'menu_category.rename',
        entity_type: 'menu_category',
        entity_id: from,
        actor_email: actorEmail,
        outlet_id: outletId,
        before: { category: from, items: count },
        after: { category: to, items: res.changes },
        note: `Renamed menu category "${from}" to "${to}" across ${res.changes} menu item${res.changes === 1 ? '' : 's'} (active and inactive). menu_items only — no raw-material, store or sales row was touched.`,
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
