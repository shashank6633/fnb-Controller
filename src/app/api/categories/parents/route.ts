import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  readCategoryParents, saveCategoryParents, cleanParentLabel, parentMatchKey, findParent,
  isReservedParentLabel, parentUsage, commonestSpelling, rewriteParentName, auditParentChange,
  PARENT_LABEL_MAX, type CategoryParent, type ParentUsage,
} from '@/lib/category-parents';

/**
 * MANAGE PARENTS — Inventory → Categories (owner ruling #87, 2026-10-28).
 *
 * GET    /api/categories/parents            any signed-in user (the Raw
 *                                           Materials item form needs the
 *                                           names); the list in order, each
 *                                           with how many sub-categories and
 *                                           items sit under it, plus every
 *                                           parent name items carry that is
 *                                           NOT in the list ("unlisted")
 * POST   /api/categories/parents            admin — { label } adds a parent
 * PUT    /api/categories/parents            admin — { expected_label, label?,
 *                                           active? } renames and/or switches
 *                                           a parent in the list on/off; OR
 *                                           { unlisted, label } renames a name
 *                                           items carry that is not in the list
 * DELETE /api/categories/parents?expected_label=X
 *                                           admin — only while NO item
 *                                           (switched-off items included) and
 *                                           NO placeholder sub-category uses
 *                                           it; 409 otherwise
 *
 * RENAME rewrites raw_materials.super_category and
 * category_placeholders.super_category from the old name (every case/space
 * spelling of it) to the new one — those two columns only — in the SAME
 * transaction as the list change and its audit row, which carries the counts.
 *
 * TWO ADMINS AT ONCE: PUT and DELETE name the parent by `expected_label`, the
 * name the caller's screen showed. If it has been renamed since (409) or is
 * gone (404), nothing happens and the reply carries the up-to-date list.
 *
 * The list lives in ONE settings row ('category_parents'); see
 * src/lib/category-parents.ts. The generic /api/settings refuses that key
 * (KEY_POLICY owner row). CSRF: the '/api/categories' prefix in src/proxy.ts.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Db = ReturnType<typeof getDb>;
type Result = { status: number; body: Record<string, unknown> };

const EMPTY_USE: ParentUsage = {
  spellings: new Map(), item_count: 0, inactive_item_count: 0, placeholder_count: 0, subcategories: new Set(),
  item_subcategories: new Set(), uncategorised_item_count: 0, placeholder_subcategories: new Set(), placeholders_without_items: 0,
};

const sortedNames = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));

function useOf(u: ParentUsage | undefined) {
  const x = u || EMPTY_USE;
  return {
    item_count: x.item_count,
    inactive_item_count: x.inactive_item_count,
    placeholder_count: x.placeholder_count,
    /** Of placeholder_count, how many have a name no item uses yet. */
    placeholders_without_items: x.placeholders_without_items,
    /** Every placeholder sub-category carrying it, by name. */
    placeholder_subcategories: sortedNames(x.placeholder_subcategories),
    subcategory_count: x.subcategories.size,
    subcategories: sortedNames(x.subcategories),
    /** Stored spellings, e.g. ["Bar", "bar"] — shown when more than the label. */
    spellings: [...x.spellings.keys()].sort(),
  };
}

function payload(db: Db, isAdmin: boolean) {
  const list = readCategoryParents(db);
  const usage = parentUsage(db);
  const listed = new Set(list.parents.map((p) => parentMatchKey(p.label)));
  return {
    parents: list.parents.map((p) => {
      const u = usage.get(parentMatchKey(p.label));
      // Why Delete is refused, with steps that actually free it (the Delete
      // button's tooltip) — the same text the DELETE 409 sends.
      return { ...p, ...useOf(u), delete_blocked: deleteBlocked(p.label, u, p.active !== false) };
    }),
    // Parent names items or placeholders carry that are NOT in the list. Shown,
    // never hidden, named by the spelling most of them carry.
    unlisted: [...usage.entries()]
      .filter(([k]) => !listed.has(k))
      .map(([, u]) => ({ label: commonestSpelling(u), ...useOf(u) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    source: list.source,
    ignored_entries: list.ignored,
    can_manage: isAdmin,
  };
}

async function adminOr(): Promise<{ me: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>> } | Response> {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (me.role !== 'admin') {
    return Response.json({ error: 'Only an admin can change the list of parent categories.' }, { status: 403 });
  }
  return { me };
}

const unreadableNote = (source: string) =>
  source === 'unreadable' ? ' The saved list could not be read, so it was replaced starting from the 16 default parents.' : '';

const itemWord = (n: number) => `${n} item${n === 1 ? '' : 's'}`;
const phWord = (n: number) => `${n} placeholder sub-categor${n === 1 ? 'y' : 'ies'}`;
/** "3 items", "1 placeholder sub-category", "2 items and 1 placeholder sub-category". */
const holders = (items: number, placeholders: number) =>
  [items ? itemWord(items) : '', placeholders ? phWord(placeholders) : ''].filter(Boolean).join(' and ') || 'nothing';
/** "its 1 item keeps it" / "its 3 items keep it" / "no item uses it". */
const keepers = (n: number) =>
  n === 0 ? 'no item uses it' : n === 1 ? 'its 1 item keeps it' : `its ${n} items keep it`;
const RESERVED_MSG = 'That name is what the screens already show for "no parent". Pick another name.';

/** '"A", "B" and "C"' — at most `max` names, then "and N more". */
function quotedList(names: string[], max: number): string {
  const q = names.slice(0, max).map((n) => `"${n}"`);
  if (names.length > max) return `${q.join(', ')} and ${names.length - max} more`;
  return q.length > 1 ? `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}` : (q[0] ?? '');
}

/**
 * Why a parent can't be deleted, with the steps that ACTUALLY free it — or
 * null when nothing uses it. Shown as the Delete button's tooltip (GET payload,
 * `delete_blocked`) and sent as the DELETE 409, so the two always agree.
 *
 * The holders are named apart because each is freed a different way:
 *  - items in a sub-category: "Move to parent" + Save (POST /api/categories
 *    `assign` = UPDATE raw_materials ... WHERE category = ?, every item of the
 *    leaf, switched-off ones included);
 *  - items with NO sub-category: not listed on Inventory → Categories at all,
 *    so only the Raw Materials item form changes their parent;
 *  - placeholder sub-categories: "Move to parent" does NOT move them (assign
 *    touches raw_materials only — unchanged, owner's call); adding the same
 *    name again under another parent with "Add a new sub-category" does (POST
 *    `create` upserts category_placeholders.super_category).
 */
function deleteBlocked(label: string, u: ParentUsage | undefined, active = true): string | null {
  if (!u || (u.item_count === 0 && u.placeholder_count === 0)) return null;
  const held: string[] = [];
  if (u.item_count) {
    held.push(itemWord(u.item_count) + (u.inactive_item_count ? ` (${u.inactive_item_count} switched off)` : ''));
  }
  if (u.placeholder_count) held.push(phWord(u.placeholder_count));
  const steps: string[] = [];
  const itemSubs = sortedNames(u.item_subcategories);
  if (itemSubs.length) {
    steps.push(`move ${itemSubs.length === 1 ? 'the sub-category' : 'the sub-categories'} ${quotedList(itemSubs, 6)} `
      + 'to another parent with "Move to parent", then Save');
  }
  if (u.uncategorised_item_count) {
    steps.push(`give the ${itemWord(u.uncategorised_item_count)} with no sub-category another parent in the Raw Materials item form`);
  }
  const phSubs = sortedNames(u.placeholder_subcategories);
  if (phSubs.length) {
    steps.push(`add the placeholder sub-categor${phSubs.length === 1 ? 'y' : 'ies'} ${quotedList(phSubs, 10)} `
      + 'again under another parent with "Add a new sub-category", typing the name exactly as shown '
      + '("Move to parent" does not move a placeholder sub-category)');
  }
  return `"${label}" can't be deleted — ${held.join(' and ')} still ${u.item_count + u.placeholder_count === 1 ? 'uses' : 'use'} it. `
    // An already switched-off parent: advising "switch it off" would do nothing.
    + (active
      ? (steps.length ? `Switch it off instead, or free it first: ${steps.join('; ')}.` : 'Switch it off instead.')
      : (steps.length ? `It is already switched off; to delete it, free it first: ${steps.join('; ')}.` : 'It is already switched off, so new items cannot pick it.'));
}

/** Plain-English check of a typed name; null when it is fine. */
function nameProblem(label: string, verb: 'added' | 'changed'): string | null {
  if (!label) return verb === 'added' ? 'Type a name for the new parent.' : 'The parent name cannot be blank. Nothing was changed.';
  if (label.length > PARENT_LABEL_MAX) return `Keep the parent name to ${PARENT_LABEL_MAX} characters or fewer. Nothing was ${verb}.`;
  if (isReservedParentLabel(label)) return `${RESERVED_MSG} Nothing was ${verb}.`;
  return null;
}

/** The parent the caller's screen named, exactly; or the refusal for a stale screen. */
function locate(list: CategoryParent[], expected: string, verb: 'changed' | 'deleted'):
  { i: number } | Result {
  const i = list.findIndex((p) => p.label === expected);
  if (i >= 0) return { i };
  const near = findParent(list, expected);
  if (near) {
    return {
      status: 409,
      body: { conflict: 'renamed', error: `This parent is now called "${near.label}" — someone changed it after this list was loaded. Nothing was ${verb}.` },
    };
  }
  return {
    status: 404,
    body: { conflict: 'gone', error: `"${expected}" is not in the list any more — someone may have renamed or deleted it. Nothing was ${verb}.` },
  };
}

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    return Response.json(payload(db, me.role === 'admin'));
  } catch (e) {
    console.error('[/api/categories/parents GET]', e);
    return Response.json({ error: (e as Error)?.message || 'Could not read the parent categories.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const gate = await adminOr();
    if (gate instanceof Response) return gate;
    const { me } = gate;
    const b = await request.json().catch(() => ({}));
    const label = cleanParentLabel(b?.label);
    const bad = nameProblem(label, 'added');
    if (bad) return Response.json({ error: bad }, { status: 400 });
    const db = getDb();
    let result: Result | null = null;
    db.transaction(() => {
      const list = readCategoryParents(db);
      const dup = findParent(list.parents, label);
      if (dup) {
        result = {
          status: 409,
          body: { error: `There is already a parent called "${dup.label}"${dup.active ? '' : ' (switched off)'}. Nothing was added.` },
        };
        return;
      }
      const sort = list.parents.reduce((m, p) => Math.max(m, p.sort), 0) + 10;
      const created: CategoryParent = { label, active: true, sort };
      saveCategoryParents(db, [...list.parents, created]);
      // Items that already carried this name (it was "not in the list") now
      // count under it. Nothing on them is rewritten.
      const u = parentUsage(db).get(parentMatchKey(label));
      const already = u?.item_count ?? 0;
      auditParentChange(db, {
        event_type: 'category_parent.add',
        entity_id: label,
        actor_email: me.email || '',
        before: list.source === 'unreadable' ? { unreadable_saved_list: list.raw } : null,
        after: { ...created, items_already_carrying_it: already, placeholders_already_carrying_it: u?.placeholder_count ?? 0 },
        note: `Parent category "${label}" added`
          + (already ? ` (${itemWord(already)} already carried this name and now count under it).` : '.')
          + unreadableNote(list.source),
      });
      result = { status: 201, body: { parent: created, items_already_carrying_it: already } };
    })();
    const r = result as Result | null;
    if (!r) return Response.json({ error: 'Could not add the parent.' }, { status: 500 });
    return Response.json({ ...r.body, ...payload(db, true) }, { status: r.status });
  } catch (e) {
    console.error('[/api/categories/parents POST]', e);
    return Response.json({ error: (e as Error)?.message || 'Could not add the parent. Nothing was added.' }, { status: 500 });
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
    if (b?.unlisted !== undefined) return renameUnlisted(me.email || '', b);

    const expected = cleanParentLabel(b?.expected_label);
    if (!expected) return Response.json({ error: 'Which parent? (expected_label is required) Nothing was changed.' }, { status: 400 });
    const wantsLabel = b?.label !== undefined;
    const label = wantsLabel ? cleanParentLabel(b.label) : '';
    if (wantsLabel) {
      const bad = nameProblem(label, 'changed');
      if (bad) return Response.json({ error: bad }, { status: 400 });
    }
    const active = activeFlag(b?.active);
    if (active === null) return Response.json({ error: 'active must be true or false. Nothing was changed.' }, { status: 400 });
    if (!wantsLabel && active === undefined) {
      return Response.json({ error: 'Nothing to change — send a new name or switch it on or off.' }, { status: 400 });
    }

    const db = getDb();
    let result: Result | null = null;
    db.transaction(() => {
      const list = readCategoryParents(db);
      const at = locate(list.parents, expected, 'changed');
      if ('status' in at) { result = at; return; }
      const before = list.parents[at.i];
      const fromKey = parentMatchKey(before.label);
      if (wantsLabel) {
        const dup = list.parents.find((p, j) => j !== at.i && parentMatchKey(p.label) === parentMatchKey(label));
        if (dup) {
          result = { status: 409, body: { error: `There is already a parent called "${dup.label}"${dup.active ? '' : ' (switched off)'}. Nothing was changed.` } };
          return;
        }
        // A name items carry that is NOT in the list: renaming onto it would
        // silently mix two groups of items. Folding them together is done from
        // that name's own row (Rename on the "not in the list" row).
        if (parentMatchKey(label) !== fromKey) {
          const theirs = parentUsage(db).get(parentMatchKey(label));
          if (theirs && (theirs.item_count > 0 || theirs.placeholder_count > 0)) {
            const name = commonestSpelling(theirs);
            result = {
              status: 409,
              body: {
                error: `${holders(theirs.item_count, theirs.placeholder_count)} already ${theirs.item_count + theirs.placeholder_count === 1 ? 'carries' : 'carry'} the parent "${name}", which is not in the list. Renaming "${before.label}" to that name would mix the two groups together. `
                  + `To bring them together, rename the "${name}" row (in use, not in the list) to "${before.label}" instead. Nothing was changed.`,
              },
            };
            return;
          }
        }
      }
      const after: CategoryParent = {
        ...before,
        label: wantsLabel ? label : before.label,
        active: active === undefined ? before.active : active,
      };
      const renamed = after.label !== before.label;
      const switched = after.active !== before.active;
      if (!renamed && !switched) { result = { status: 200, body: { changed: false, before, parent: before } }; return; }
      const next = [...list.parents];
      next[at.i] = after;
      saveCategoryParents(db, next);
      const counts = renamed ? rewriteParentName(db, fromKey, after.label) : null;
      const use = parentUsage(db).get(parentMatchKey(after.label));
      const items = use?.item_count ?? 0;
      const parts: string[] = [];
      if (renamed && counts) {
        parts.push(`renamed from "${before.label}" to "${after.label}" — ${itemWord(counts.items_updated)} and `
          + `${phWord(counts.placeholders_updated)} moved to the new name`);
      }
      if (switched) {
        parts.push(after.active
          ? 'switched on — it can be picked again'
          : `switched off — ${keepers(items)}; it can no longer be picked as a new choice`);
      }
      auditParentChange(db, {
        event_type: renamed && switched ? 'category_parent.update'
          : renamed ? 'category_parent.rename'
          : after.active ? 'category_parent.switch_on' : 'category_parent.switch_off',
        entity_id: before.label,
        actor_email: me.email || '',
        before: list.source === 'unreadable' ? { ...before, unreadable_saved_list: list.raw } : before,
        after: counts ? { ...after, ...counts } : after,
        note: `Parent category "${after.label}" ${parts.join('; ')}.` + unreadableNote(list.source),
      });
      result = { status: 200, body: { changed: true, before, parent: after, ...(counts ? { counts } : {}) } };
    })();
    const r = result as Result | null;
    if (!r) return Response.json({ error: 'Could not change the parent.' }, { status: 500 });
    return Response.json({ ...r.body, ...payload(db, true) }, { status: r.status });
  } catch (e) {
    console.error('[/api/categories/parents PUT]', e);
    return Response.json({ error: (e as Error)?.message || 'Could not change the parent. Nothing was changed.' }, { status: 500 });
  }
}

/**
 * Rename a parent name items carry that is NOT in the list. Rewrites the same
 * two columns as a rename. When the new name is a parent in the list, its
 * items join that parent (spelled as the list spells it) — the way to fold an
 * old name such as "Liquor" into "Bar". The list itself is not changed.
 */
function renameUnlisted(actor: string, b: Record<string, unknown>): Response {
  const from = cleanParentLabel(b?.unlisted);
  if (!from) return Response.json({ error: 'Which name? (unlisted is required) Nothing was changed.' }, { status: 400 });
  const label = cleanParentLabel(b?.label);
  const bad = nameProblem(label, 'changed');
  if (bad) return Response.json({ error: bad }, { status: 400 });
  const db = getDb();
  let result: Result | null = null;
  db.transaction(() => {
    const list = readCategoryParents(db);
    const fromKey = parentMatchKey(from);
    const inList = findParent(list.parents, from);
    if (inList) {
      result = {
        status: 409,
        body: { conflict: 'listed', error: `"${inList.label}" is in the list now — someone added it after this list was loaded. Use Rename on its row. Nothing was changed.` },
      };
      return;
    }
    const u = parentUsage(db).get(fromKey);
    if (!u || (u.item_count === 0 && u.placeholder_count === 0)) {
      result = { status: 404, body: { conflict: 'gone', error: `No item carries the parent "${from}" any more. Nothing was changed.` } };
      return;
    }
    const target = findParent(list.parents, label);
    const to = target ? target.label : label;
    if (target && !target.active) {
      result = {
        status: 409,
        body: { error: `The parent "${target.label}" is switched off, so nothing new can be put under it. Switch it on first, or pick another name. Nothing was changed.` },
      };
      return;
    }
    const counts = rewriteParentName(db, fromKey, to);
    if (counts.items_updated === 0 && counts.placeholders_updated === 0) {
      result = { status: 200, body: { changed: false, to } };
      return;
    }
    const before = { label: commonestSpelling(u), item_count: u.item_count, placeholder_count: u.placeholder_count };
    auditParentChange(db, {
      event_type: 'category_parent.rename_unlisted',
      entity_id: before.label,
      actor_email: actor,
      before,
      after: { label: to, joined_listed_parent: !!target, ...counts },
      note: `Parent name "${before.label}" (not in the list) renamed to "${to}" on ${itemWord(counts.items_updated)} and `
        + phWord(counts.placeholders_updated)
        + (target ? ` — they now sit under the listed parent "${to}".` : ` — "${to}" is not in the list either.`),
    });
    result = { status: 200, body: { changed: true, from: before.label, to, joined_listed_parent: !!target, counts } };
  })();
  const r = result as Result | null;
  if (!r) return Response.json({ error: 'Could not rename it.' }, { status: 500 });
  return Response.json({ ...r.body, ...payload(db, true) }, { status: r.status });
}

export async function DELETE(request: Request) {
  try {
    const gate = await adminOr();
    if (gate instanceof Response) return gate;
    const { me } = gate;
    const q = new URL(request.url).searchParams;
    const expected = cleanParentLabel(q.get('expected_label'));
    if (!expected) return Response.json({ error: 'Which parent? (expected_label is required) Nothing was deleted.' }, { status: 400 });
    const db = getDb();
    let result: Result | null = null;
    db.transaction(() => {
      const list = readCategoryParents(db);
      const at = locate(list.parents, expected, 'deleted');
      if ('status' in at) { result = at; return; }
      const parent = list.parents[at.i];
      // Counted INSIDE the transaction that removes it, so an item cannot be
      // given this parent between the check and the delete.
      const u = parentUsage(db).get(parentMatchKey(parent.label));
      const blocked = deleteBlocked(parent.label, u, parent.active !== false);
      if (u && blocked) {
        result = {
          status: 409,
          body: {
            error: `${blocked} Nothing was deleted.`,
            item_count: u.item_count,
            placeholder_count: u.placeholder_count,
          },
        };
        return;
      }
      saveCategoryParents(db, list.parents.filter((_, j) => j !== at.i));
      auditParentChange(db, {
        event_type: 'category_parent.delete',
        entity_id: parent.label,
        actor_email: me.email || '',
        before: list.source === 'unreadable' ? { ...parent, unreadable_saved_list: list.raw } : parent,
        after: null,
        note: `Parent category "${parent.label}" deleted (no item or sub-category used it).` + unreadableNote(list.source),
      });
      result = { status: 200, body: { deleted: parent.label, parent } };
    })();
    const r = result as Result | null;
    if (!r) return Response.json({ error: 'Could not delete the parent.' }, { status: 500 });
    return Response.json({ ...r.body, ...payload(db, true) }, { status: r.status });
  } catch (e) {
    console.error('[/api/categories/parents DELETE]', e);
    return Response.json({ error: (e as Error)?.message || 'Could not delete the parent. Nothing was deleted.' }, { status: 500 });
  }
}
