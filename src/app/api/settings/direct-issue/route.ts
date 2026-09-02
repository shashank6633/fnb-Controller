import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, requireRole } from '@/lib/auth';
import { listCategoryCheckers } from '@/lib/grn-qc';
import { diCatKey } from '@/lib/direct-issue';
import { isStoreMappedMaterial } from '@/lib/store-engine';

/**
 * DIRECT ISSUE ROUTING — which vendor deliveries bypass the central shelf.
 *
 *   GET /api/settings/direct-issue          → any signed-in user: the flag
 *       maps the receiving screens badge lines with ("→ Main Kitchen");
 *       an ADMIN additionally gets the full config (rules, category list,
 *       department picker) and can_edit.
 *   PUT /api/settings/direct-issue          → ADMIN only:
 *       { set: [{ rule_type: 'category'|'material', category?, material_id?,
 *                 department_id }], remove: [rule_id, …] }
 *       Upserts only what is sent — a partial save never clears the rest.
 *
 * WHAT A RULE MEANS (see src/lib/direct-issue.ts, the one resolver): on
 * receipt, the accepted quantity of a matching material posts to the chosen
 * DEPARTMENT's stock ledger instead of central stock. The GRN, vendor bill,
 * PINV, taxes and average_price stay exactly as they are today. Rules affect
 * FUTURE receipts only — stock already in central stays there until issued
 * normally. Item rules beat category rules.
 *
 * CATEGORY KEYS use the same catNorm fold as the QC map (lower-case, strip
 * space/hyphen/underscore), so every spelling of a shelf is ONE rule.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The owner's motivating set — surfaced prominently in the picker, NEVER
 *  pre-enabled (which goods bypass the shelf is his decision, not a seed).
 *  GAS & CHARCOAL may not exist as a raw-material category yet; it is listed
 *  anyway so the rule can be set before the first such material is created. */
const OWNER_FOCUS = [
  'DAIRY', 'ENGLISH VEGETABLES', 'FRUITS', 'GAS & CHARCOAL',
  'MEAT', 'POULTRY', 'SEAFOOD', 'VEGETABLES',
];

function loadRules(db: ReturnType<typeof getDb>) {
  return db.prepare(`
    SELECT r.id, r.rule_type, r.category_key, r.category_label, r.material_id,
           r.department_id, r.created_by, r.created_at, r.updated_at,
           d.name AS department_name, d.is_active AS department_active,
           rm.name AS material_name, rm.sku AS material_sku, rm.category AS material_category
    FROM direct_issue_rules r
    LEFT JOIN departments d ON d.id = r.department_id
    LEFT JOIN raw_materials rm ON rm.id = r.material_id
    ORDER BY r.rule_type, COALESCE(NULLIF(r.category_label, ''), rm.name)
  `).all() as any[];
}

/** The flag maps every receiving screen reads. Material ids beat categories —
 *  the same precedence the server-side resolver applies at receipt. */
function flagMaps(rules: any[]) {
  const materials: Record<string, string> = {};
  const categories: Record<string, string> = {};
  for (const r of rules) {
    if (!r.department_name) continue; // department deleted ⇒ rule is inert
    if (String(r.rule_type) === 'material' && r.material_id) {
      materials[String(r.material_id)] = String(r.department_name);
    } else if (String(r.rule_type) === 'category' && r.category_key) {
      categories[String(r.category_key)] = String(r.department_name);
    }
  }
  return { materials, categories };
}

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();

    let rules: any[] = [];
    try { rules = loadRules(db); } catch { rules = []; } // un-migrated DB reads as "no rules"
    const flags = flagMaps(rules);

    if (me.role !== 'admin') {
      // The badge payload only: which materials/category keys divert, and to
      // where. No config detail, no counts — receiving screens need names.
      return Response.json({ flags, can_edit: false });
    }

    // ── the admin's full picture ─────────────────────────────────────────────
    // Category list: every live shelf (same folded rows as the QC map, with
    // material counts and the store/TGBCL split), merged with the owner's
    // eight motivating categories so they are present even before any
    // material carries them.
    const catRows = listCategoryCheckers(db).map(r => ({
      category: r.category,
      category_key: r.category_key,
      material_count: r.material_count,
      central_reachable: r.central_reachable,
      focus: false,
    }));
    const have = new Set(catRows.map(r => r.category_key));
    for (const label of OWNER_FOCUS) {
      const key = diCatKey(label);
      const hit = catRows.find(r => r.category_key === key);
      if (hit) { hit.focus = true; continue; }
      if (!have.has(key)) {
        catRows.push({ category: label, category_key: key, material_count: 0, central_reachable: true, focus: true });
        have.add(key);
      }
    }

    const departments = db.prepare(`
      SELECT d.id, d.name, d.is_active, d.parent_id, p.name AS parent_name
      FROM departments d
      LEFT JOIN departments p ON p.id = d.parent_id
      ORDER BY d.is_active DESC, (d.parent_id IS NOT NULL), d.name
    `).all() as any[];

    return Response.json({
      flags,
      can_edit: true,
      rules,
      categories: catRows,
      departments,
    });
  } catch (e: any) {
    console.error('[/api/settings/direct-issue GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
  try {
    const db = getDb();
    const me = gate.user;
    const body = await request.json().catch(() => ({} as any));
    const set: any[] = Array.isArray(body?.set) ? body.set : [];
    const remove: string[] = Array.isArray(body?.remove) ? body.remove.map((x: any) => String(x)) : [];
    if (set.length === 0 && remove.length === 0) {
      return Response.json({ error: 'Nothing to change — send set[] and/or remove[].' }, { status: 400 });
    }

    // ── validate BEFORE the transaction, refusing the whole batch on the first
    //    bad entry: a half-applied routing change is worse than a refused one,
    //    because the receiver cannot see which half took effect. ──────────────
    const prepared: Array<{
      rule_type: 'category' | 'material';
      category_key: string; category_label: string;
      material_id: string; department_id: string;
    }> = [];
    for (const s of set) {
      const ruleType = String(s?.rule_type || '');
      const deptId = String(s?.department_id || '').trim();
      if (ruleType !== 'category' && ruleType !== 'material') {
        return Response.json({ error: `Unknown rule_type "${ruleType}" — use 'category' or 'material'.` }, { status: 400 });
      }
      const dept = db.prepare(`SELECT id, name, is_active FROM departments WHERE id = ?`).get(deptId) as any;
      if (!dept) {
        return Response.json({ error: 'Pick a destination department — the one sent does not exist.' }, { status: 400 });
      }
      if (!Number(dept.is_active)) {
        return Response.json({
          error: `"${dept.name}" is deactivated. Deliveries must not be routed onto a closed department's ledger — reactivate it on /departments first, or pick another destination.`,
        }, { status: 400 });
      }
      if (ruleType === 'material') {
        const matId = String(s?.material_id || '').trim();
        const mat = db.prepare(`SELECT id, name, category FROM raw_materials WHERE id = ?`).get(matId) as any;
        if (!mat) return Response.json({ error: 'Material not found for an item rule.' }, { status: 400 });
        if (isStoreMappedMaterial(db, matId)) {
          return Response.json({
            error: `"${mat.name}" is store-mapped (${mat.category}) — it is received on the store's own ledger and can never reach a central receipt, so a direct-issue rule on it would never fire. Nothing was saved.`,
          }, { status: 400 });
        }
        prepared.push({ rule_type: 'material', category_key: '', category_label: '', material_id: matId, department_id: deptId });
      } else {
        const label = String(s?.category || '').trim();
        const key = diCatKey(label);
        if (!key) return Response.json({ error: 'A category rule needs a category name.' }, { status: 400 });
        // A liquor/TGBCL category is received on the store ledger; a rule here
        // would be dead config that LOOKS live. Same catNorm both sides.
        const storeCats = db.prepare(`SELECT category FROM store_category_map`).all() as any[];
        if (storeCats.some(c => diCatKey(c.category) === key)) {
          return Response.json({
            error: `"${label}" is a store/TGBCL category — those deliveries live on the store ledger and never reach a central receipt, so a direct-issue rule on the category would never fire. Nothing was saved.`,
          }, { status: 400 });
        }
        prepared.push({ rule_type: 'category', category_key: key, category_label: label, material_id: '', department_id: deptId });
      }
    }

    const apply = db.transaction(() => {
      let removed = 0, upserted = 0;
      for (const id of remove) {
        removed += db.prepare(`DELETE FROM direct_issue_rules WHERE id = ?`).run(id).changes;
      }
      const upCat = db.prepare(`
        UPDATE direct_issue_rules
           SET department_id = ?, category_label = ?, updated_at = datetime('now')
         WHERE rule_type = 'category' AND category_key = ?
      `);
      const upMat = db.prepare(`
        UPDATE direct_issue_rules
           SET department_id = ?, updated_at = datetime('now')
         WHERE rule_type = 'material' AND material_id = ?
      `);
      const ins = db.prepare(`
        INSERT INTO direct_issue_rules (id, rule_type, category_key, category_label, material_id, department_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of prepared) {
        const hit = p.rule_type === 'category'
          ? upCat.run(p.department_id, p.category_label, p.category_key)
          : upMat.run(p.department_id, p.material_id);
        if (hit.changes === 0) {
          ins.run(generateId(), p.rule_type, p.category_key, p.category_label, p.material_id, p.department_id, me?.email || '');
        }
        upserted += 1;
      }
      return { removed, upserted };
    });
    const res = apply();

    const rules = loadRules(db);
    return Response.json({ success: true, ...res, rules, flags: flagMaps(rules) });
  } catch (e: any) {
    console.error('[/api/settings/direct-issue PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
